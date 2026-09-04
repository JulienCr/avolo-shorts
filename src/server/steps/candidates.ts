import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { mergeCandidates, overlapSeconds, OVERLAP_TOLERANCE_SECONDS } from '@/core/candidates'
import { redactKeys } from '@/core/errors'
import type { Clip, Segment } from '@/core/edl'
import type { MoreClipsReport } from '@/lib/api'
import {
  parseDetailResponse,
  parseScoreResponse,
  parseSweepResponse,
  shortlistFromScores,
  type DetailClip,
  type ScoredWindow,
} from '@/core/gemini/parse'
import {
  detailPrompt,
  detailWindowsJson,
  scorePrompt,
  scoreWindowsJson,
  sweepPrompt,
} from '@/core/gemini/prompts'
import {
  buildWindows,
  clipCountTargets,
  mergeOverlappingWindows,
  speechSeconds,
  shortlistSize,
  usableSegments,
  wholeTranscriptWithAnchors,
  type Transcript,
  type TxSegment,
  type Window,
  type Word,
} from '@/core/transcript'
import { getClips, getDb, getProject, getSettings, replaceClips } from '@/server/db'
import { createCallFromSettings } from '@/server/llm/registry'
import {
  GeminiBlockedError,
  callWithRetry,
  isTransient,
  leverIfBlocked,
  quotaDelay,
  wait,
} from '@/server/llm/retry'
import type { JsonSchema, LlmCall, LlmCallConfig, LlmMode } from '@/server/llm/types'
import { candidatesPath, placeSidecar } from '@/server/paths'

// Réexportés pour la couture de `tests/server/candidates.test.ts`, qui
// importe ces cinq noms d'ici, sous `callGemini` pour `callWithRetry`.
export { GeminiBlockedError, isTransient, leverIfBlocked, quotaDelay, callWithRetry as callGemini }

/**
 * L'étape `candidates` : deux passes sur le transcript, auprès du fournisseur
 * réglé pour le repérage (Gemini, OpenAI ou Ollama), et le lot de
 * propositions qui en sort.
 *
 * C'est le seul endroit du repérage qui touche au réseau. Tout ce qui décide
 * quelque chose — les prompts, l'analyse des réponses, la présélection, le
 * calage sur les mots, la fusion des passes — vit dans `src/core/` et se teste
 * sans clé d'API. Ici on enchaîne, on relance, et on écrit.
 *
 * Cette source ne voit pas le jeu physique, par construction (spec §7). Les
 * quatre autres pourvoyeurs — mouvement des corps, cartouches de jeu,
 * resserrement du cadre, densité des tours de parole — et le reclassement en
 * vision sont l'itération 2.
 *
 * **Ce fichier garde ses identifiants français accentués — `clientByDefault`,
 * `SCHEMA_NOTATION`, `SCHEMA_DETAIL`, `DELAY_CALL_MS`, etc.** La règle de
 * langue de `CLAUDE.md` veut le code en anglais ; les balayer ici est le
 * travail de l'issue #73, pas celui de cette PR, qui les a touchés sans les
 * renommer pour ne pas gonfler son diff. Le module neuf qu'elle ajoute,
 * `src/server/llm/**`, lui, est écrit en anglais dès sa première ligne : rien
 * n'y avait de dette à hériter.
 */

/**
 * La taille des lots de notation, surchargeable par `SCORE_BATCH`.
 *
 * Un lot trop grand dilue l'attention du modèle sur 8 × 90 secondes de prose ;
 * un lot trop petit multiplie les appels et, surtout, multiplie les échelles :
 * chaque lot est noté dans un appel séparé, et c'est le barème ancré du prompt
 * qui les rend comparables.
 *
 * **Huit reste le défaut alors même que c'est la taille qui déclenche le
 * filtre**, et c'est un choix mesuré, pas une omission. Sur `2025-06-15-cqlp`,
 * 83 fenêtres, le 18 août 2026 :
 *
 * | Taille du lot | Refus |
 * |---|---|
 * | 8 | 4 lots sur 11, soit 32 fenêtres |
 * | 4 (sur les 32 refusées) | 3 lots sur 8, soit 12 fenêtres |
 * | 2 (sur les 12 restantes) | 3 lots sur 6, soit 6 fenêtres |
 * | 1 (sur les 32 refusées) | **aucun** |
 *
 * Baisser le défaut à 4 ne ferait donc que déplacer le problème en doublant les
 * appels et en doublant les barèmes. Ce qui le règle est `recover`, qui ne
 * recoupe que ce qui a été refusé.
 */
const BATCH_NOTATION_BY_DEFAULT = 8

/**
 * Ce que la récupération s'autorise à dépenser, en multiple du premier passage.
 *
 * Recouper un lot refusé coûte au pire `2k - 2` requêtes pour k fenêtres — 14
 * pour un lot de 8 dont chaque fenêtre serait refusée seule. Mesuré sur
 * `2025-06-15-cqlp`, la réalité est bien plus douce : 20 appels de récupération
 * pour 11 de premier passage, soit 1,8 fois. Le facteur 3 laisse donc de la
 * marge à une émission plus dure tout en bornant le cas pathologique, qui
 * compte : le palier gratuit de `gemini-3.1-flash-lite` plafonne à **15 requêtes
 * par minute**, et une descente sans bornes y passerait dix minutes à se faire
 * refuser. Ce qui reste hors budget est compté comme non noté, et dit.
 *
 * Le budget se compte en **requêtes**, relances comprises : c'est l'unité que le
 * quota facture, et la seule qui rende le plafond vrai quand le service tangue.
 *
 * **Le compte est passé en Tier 1 le 18 août 2026, soit environ 300 requêtes par
 * minute au lieu de 15. Cette borne reste, et ce paragraphe est là pour qu'on ne
 * la retire pas en constatant que le quota a reculé.** Un plafond plus haut n'est
 * pas un plafond absent, et le quota n'a jamais été la seule raison : une
 * descente sans bornes dépense aussi du temps et de l'argent sur une émission
 * que le fournisseur refuse en bloc. Ce qu'un palier payant change, c'est la
 * fréquence des attentes de `quotaDelay`, pas leur utilité.
 */
const RECOVERY_MAX = 3

/**
 * Le plafond de sortie, posé **explicitement** plutôt que laissé au modèle.
 *
 * Aucun n'était posé : le défaut du fournisseur s'appliquait, sans que personne
 * ici sache lequel. Tant que la passe de détail rendait 6 à 12 clips, la
 * question ne se posait pas ; le dimensionnement sur la durée de parole la pose
 * — une source de trois heures en demande 26 à 39, soit environ 5 000 jetons à
 * ~130 par clip (deux descriptions, un titre, une accroche, quatre nombres).
 *
 * **Une troncature est le pire des échecs ici** : `leverIfBlocked` classe
 * `MAX_TOKENS` en erreur passagère, donc la charge repart trois fois, à
 * température 0,9, pour se faire tronquer pareil — et le message final accuse le
 * réseau. Seize mille laisse de la marge à une source de six heures sans jamais
 * approcher ce que le modèle sait produire.
 */
const OUTPUT_CAP = 16_384

/**
 * Le délai au-delà duquel un appel est abandonné, en millisecondes.
 *
 * Deux minutes est large : mesuré sur une émission de 109 minutes, les quinze
 * appels du repérage complet ont tenu en 35 secondes à eux tous. La valeur ne
 * sert donc pas à serrer la performance, seulement à garantir qu'un appel
 * rendra la main.
 */
const DELAY_CALL_MS = 120_000

/**
 * Le mode d'appel : les deux passes n'ont ni le même schéma ni la même
 * température. Alias de `LlmMode` (`@/server/llm/types`) — voir sa doc pour la
 * raison de garder ce nom-ci ici plutôt que de le faire disparaître.
 */
export type ModeGemini = LlmMode

/**
 * Un appel au modèle. Injectable : c'est la seule couture entre cette étape et
 * le réseau, et c'est par elle que les tests passent des réponses figées.
 *
 * **Alias de `LlmCall`** (`@/server/llm/types`), qui porte désormais le
 * contrat réel — plus typé sur `GenerateContentResponse`, mais sur `LlmResponse`,
 * une forme volontairement plus large que Gemini, OpenAI et Ollama savent
 * tous remplir. Le nom `CallGemini` reste : le retirer aurait demandé de
 * réécrire les quelque 80 réponses figées de `tests/server/candidates.test.ts`
 * pour un gain nul, puisque `GenerateContentResponse` s'assigne déjà
 * structurellement à `LlmResponse`.
 */
export type CallGemini = LlmCall

/**
 * Les deux schémas du repérage, dans le vocabulaire commun aux trois
 * fournisseurs (`JsonSchema`, `@/server/llm/types`).
 *
 * **Déplacés depuis leur forme Gemini (`Type.OBJECT`, …) vers cette forme
 * générique** : c'est le geste qui généralise la couture — chaque fournisseur
 * les convertit ensuite vers ce qu'il attend, `createGeminiCall` vers
 * l'énumération `Type`, OpenAI et Ollama les exercent tels quels puisque
 * `JsonSchema` est déjà écrit dans leur vocabulaire.
 */
const SCHEMA_NOTATION: JsonSchema = {
  type: 'object',
  properties: {
    windows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          start: { type: 'number' },
          end: { type: 'number' },
          score: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['id', 'start', 'end', 'score', 'reason'],
      },
    },
  },
  required: ['windows'],
}

const SCHEMA_DETAIL: JsonSchema = {
  type: 'object',
  properties: {
    shorts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          source_window_id: { type: 'string' },
          predicted_score: { type: 'integer' },
          video_description_for_tiktok: { type: 'string' },
          video_description_for_instagram: { type: 'string' },
          video_title_for_youtube_short: { type: 'string' },
          viral_hook_text: { type: 'string' },
          viral_hook_badge: { type: 'string' },
        },
        required: [
          'start',
          'end',
          'source_window_id',
          'predicted_score',
          'video_description_for_tiktok',
          'video_description_for_instagram',
          'video_title_for_youtube_short',
          'viral_hook_text',
          // `viral_hook_badge` est **absent d'ici, et c'est la décision** :
          // toutes les émissions ne portent pas de rubrique numérotée, et
          // l'exiger pousserait le modèle à en inventer une par clip plutôt
          // qu'à s'abstenir. Voir `HOOK_BADGE_BRIEF`.
        ],
      },
    },
  },
  required: ['shorts'],
}

/**
 * `SCHEMA_DETAIL` without `source_window_id`: the sweep pass submits the
 * whole show in one call, so there is no window to name.
 */
const SCHEMA_SWEEP: JsonSchema = {
  type: 'object',
  properties: {
    shorts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          predicted_score: { type: 'integer' },
          video_description_for_tiktok: { type: 'string' },
          video_description_for_instagram: { type: 'string' },
          video_title_for_youtube_short: { type: 'string' },
          viral_hook_text: { type: 'string' },
          viral_hook_badge: { type: 'string' },
        },
        required: [
          'start',
          'end',
          'predicted_score',
          'video_description_for_tiktok',
          'video_description_for_instagram',
          'video_title_for_youtube_short',
          'viral_hook_text',
        ],
      },
    },
  },
  required: ['shorts'],
}

/**
 * La configuration d'un appel, indépendante du fournisseur qui l'exécutera.
 *
 * **La notation est précise, le détail est créatif.** 0,2 pour noter — la tâche
 * est un jugement calibré, et la variabilité y est du bruit. 0,9 pour détailler —
 * l'étape écrit des accroches et des descriptions, et les horodatages qu'elle
 * rend sont de toute façon validés puis calés sur les mots juste après.
 *
 * `switch` exhaustif plutôt qu'un ternaire, pour que `'hook'` et
 * `'correction'` (`LlmMode`) ne tombent pas dans la branche de notation par
 * défaut. Ce fichier ne configure que le repérage : les deux autres modes
 * n'y sont atteignables qu'à un défaut de câblage — `hook.ts` et
 * `transcript-correction.ts` configurent chacun leur propre appel.
 */
function configuration(mode: ModeGemini): LlmCallConfig {
  switch (mode) {
    case 'score':
      return { schema: SCHEMA_NOTATION, temperature: 0.2, maxOutputTokens: OUTPUT_CAP }
    case 'detail':
      return { schema: SCHEMA_DETAIL, temperature: 0.9, maxOutputTokens: OUTPUT_CAP }
    case 'sweep':
      // Same temperature as `detail`: the same creative task, over the
      // whole show instead of one window.
      return { schema: SCHEMA_SWEEP, temperature: 0.9, maxOutputTokens: OUTPUT_CAP }
    case 'hook':
    case 'correction':
      throw new Error(
        `configuration(mode) du repérage appelée avec le mode '${mode}' : ce fichier ne configure que le repérage.`,
      )
  }
}

/**
 * Retire une clé d'API d'un message avant de le journaliser.
 *
 * **Le motif vit dans `@/core/errors`** depuis qu'il sert aussi à la frontière
 * HTTP : le message d'une erreur de repérage traverse `status.json` puis le
 * champ `error` de `GET /api/projects/:id`, et ne passait par aucun caviardage
 * sur ce chemin-là. Deux copies du même motif auraient vieilli séparément.
 * (relevé par Aristarque)
 */
export const redact = redactKeys

/**
 * Le client par défaut : le fournisseur et le modèle réglés pour l'usage
 * « repérage » (`ai.selectionProvider`, `ai.selectionModel`), construit au
 * moment de servir — c'est là que la clé se lit, jamais avant.
 *
 * **Ce qui restait vrai avant cette PR le reste : un délai fini, et le signal
 * qui coupe vraiment la requête en vol.** `DELAY_CALL_MS` et `signal` sont
 * désormais des paramètres de `createCallFromSettings`
 * (`@/server/llm/registry`), qui les fait traverser jusqu'au client du
 * fournisseur choisi — chacun des trois porte la même propriété (voir
 * `src/server/llm/gemini.ts`, `openai.ts`, `ollama.ts`). Un arrêt demandé
 * pendant un appel de notation ne doit pas attendre la fin du lot en cours,
 * et c'est une propriété du fournisseur, pas de ce fichier.
 *
 * Les relances, le backoff et le filtre de sécurité vivent dans
 * `@/server/llm/retry` (`callWithRetry`), extraits d'ici pour leur deuxième
 * appelant, la correction du transcript.
 */
function clientByDefault(db: Database.Database, signal?: AbortSignal): CallGemini {
  return createCallFromSettings(db, 'selection', {
    signal,
    timeoutMs: DELAY_CALL_MS,
    config: configuration,
  })
}

const SCHEMA_WORD = z.object({ word: z.string(), start: z.number(), end: z.number() })

const SCHEMA_TRANSCRIPT = z.object({
  /** WhisperX pose la langue détectée à la racine. */
  language: z.string().optional(),
  segments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      text: z.string(),
      words: z.array(z.unknown()).optional(),
    }),
  ),
})

/** Le transcript lu sur le disque, plus la langue que WhisperX a détectée. */
export type TranscriptLu = Transcript & { language: string }

/**
 * Lit et valide le transcript du sidecar.
 *
 * **Un mot sans horodatage est écarté, pas fatal.** WhisperX en émet — les
 * chiffres et la ponctuation ressortent régulièrement sans alignement — et
 * refuser le transcript entier pour un mot non aligné jetterait vingt minutes de
 * GPU. Ces mots ne servent qu'à `snapToWords`, qui cherche des frontières : un
 * mot sans frontière n'en est pas une.
 */
export function lireTranscript(file: string): TranscriptLu {
  // **Le chemin va au journal, jamais dans l'erreur levée.** Il porte
  // l'arborescence du montage Google Drive, et cette erreur peut finir dans le
  // corps d'une réponse HTTP — `resolveSource` a posé la règle et la commente
  // déjà. (relevé par Aristarque)
  //
  // La lecture et l'analyse JSON sont dans le `try`, pas seulement la
  // validation : un `ENOENT` de `readFileSync` porte le chemin absolu dans son
  // propre message et contournait la rédaction faite juste en dessous.
  // (relevé par Copilot)
  let cause: string
  try {
    const lu = SCHEMA_TRANSCRIPT.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
    if (lu.success) return sinceSchema(lu.data)
    cause = lu.error.message
  } catch (error) {
    // Le NOM de l'erreur, pas son message : un `ENOENT` de `readFileSync` écrit
    // le chemin absolu dans son message, et c'est précisément ce qui ne doit pas
    // sortir d'ici.
    cause = error instanceof Error ? error.name : 'erreur inconnue'
  }
  console.error(`Transcript illisible : ${file}`)
  throw new Error(`Transcript illisible dans le sidecar : ${cause}`)
}

function sinceSchema(data: z.infer<typeof SCHEMA_TRANSCRIPT>): TranscriptLu {
  return {
    language: data.language ?? 'unknown',
    segments: data.segments.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
      words: (s.words ?? []).flatMap((m): Word[] => {
        const word = SCHEMA_WORD.safeParse(m)
        return word.success ? [word.data] : []
      }),
    })),
  }
}

export type DetectionOptions = {
  db?: Database.Database
  /** La couture réseau. Les tests en passent une qui rend des réponses figées. */
  call?: CallGemini
  sleep?: (ms: number) => Promise<void>
  /**
   * Appelé chaque fois qu'un lot a été traité, avec le bilan à jour.
   *
   * **Sans lui, le décompte n'existe qu'une fois la passe finie.** Le lanceur
   * n'écrit `status.json` qu'au changement d'étape, donc avant le premier appel
   * au modèle et plus jamais avant la fin : l'écran, qui interroge toutes les
   * deux secondes, verrait `repérage: null` pendant toute la notation — c'est
   * l'information la plus utile, absente exactement pendant qu'elle se
   * construit. (relevé par Codex et Copilot)
   *
   * Le bilan passé est **celui qui vit**, muté au fil de l'eau : le lire tout de
   * suite, ne pas le garder.
   */
  onSummary?: (summary: SummaryNotation) => void
  /**
   * L'arrêt demandé (`POST /api/projects/:id/stop`).
   *
   * **Ce que l'arrêt laisse derrière lui est propre.** `candidates.json` n'est
   * écrit qu'à la toute fin de la passe, donc une passe coupée en son milieu ne
   * laisse aucun artefact : `readingPresence` verra l'étape comme à faire, et la
   * reprise la refera entièrement.
   */
  signal?: AbortSignal
}

/**
 * Ce qu'une passe de notation a jugé, et surtout **ce qu'elle n'a pas jugé**.
 *
 * Une fenêtre non notée n'est pas une fenêtre mal notée : elle finit dernière au
 * classement, donc dehors dès que la présélection mord. C'était jusqu'ici la
 * seule perte de la chaîne dont absolument rien ne parlait — ni le journal, ni
 * `status.json`, ni l'interface —, et sur `2025-06-15-cqlp` elle valait un tiers
 * de l'émission.
 */
export type SummaryNotation = {
  /**
   * Les fenêtres que la passe avait à noter — le total prévu, pas le nombre de
   * fenêtres effectivement soumises. La nuance porte l'invariant : une passe
   * interrompue en a soumis moins, et ce sont justement les non soumises que
   * `neverNoted` doit continuer de nommer. (relevé par Copilot)
   */
  windows: number
  /** Celles qui portent une note du modèle. */
  noted: number
  /**
   * Celles qui n'en portent aucune : refusées par le filtre, omises par une
   * réponse, ou **pas encore soumises quand la passe s'est interrompue**.
   *
   * L'invariant tient à tout instant, y compris au milieu d'une passe et après
   * une panne : `notées + neverNoted.length === fenêtres`. Il ne tenait pas
   * quand la liste se remplissait au fil des refus — une erreur réseau sortait
   * de la boucle, et le bilan annonçait « 2 fenêtres sur 4 jugées » avec une
   * liste de perdues vide, c'est-à-dire un décompte de perte qui ne localisait
   * pas la perte. La liste part donc pleine et se vide de ce qui est noté.
   * (relevé par Copilot)
   */
  neverNoted: string[]
  /**
   * Celles que le filtre refuse **seules**, lot réduit à elles. Distinctes des
   * précédentes : là, le refus vise bien cette fenêtre-là et pas l'assemblage.
   */
  rejected: string[]
  /**
   * Les **requêtes** de notation, refus, relances et récupération comprises.
   *
   * Les requêtes et non les lots : `callGemini` réessaie jusqu'à trois fois
   * une erreur passagère, et c'est la requête qui consomme le quota — 15 par
   * minute sur le palier gratuit. Compter les lots sous-estimait exactement le
   * nombre dont on se sert pour raisonner sur ce plafond. (relevé par Copilot)
   */
  calls: number
  /** Les lots refusés, toutes profondeurs de découpe confondues. */
  batchesRejected: number
  /** Les lots auxquels le modèle a répondu. */
  batchesResponded: number
  /**
   * La part de l'étendue du transcript couverte par les fenêtres notées, entre
   * 0 et 1.
   *
   * **L'union des intervalles, pas leur somme**, et l'écart n'est pas
   * théorique : `buildWindows` chevauche deux fenêtres consécutives d'environ
   * 30 secondes, et le dernier lot est plus court que les autres. Une somme
   * compterait les recouvrements deux fois et annoncerait presque toute
   * l'émission jugée là où un sixième lui manque.
   *
   * **Le dénominateur est l'étendue du transcript** — premier mot au dernier —,
   * jamais la durée de l'émission : le silence n'est pas de la matière qu'on
   * aurait omis de juger. C'est le chiffre que la spec §7.2 demande
   * explicitement, « la seule mesure qui réponde à la question que Julien se
   * pose ».
   */
  coverage: number
}

/** Un intervalle de temps, en secondes. */
export type Extent = { start: number; end: number }

/**
 * La part de `étendue` que couvrent `intervalles`, entre 0 et 1.
 *
 * **Une union, pas une somme.** Les fenêtres de notation se chevauchent
 * délibérément de 30 secondes pour qu'aucun moment ne soit coupé en deux ;
 * additionner leurs durées compterait ces 30 secondes deux fois.
 *
 * Chaque intervalle est **écrêté** à l'étendue avant d'être fusionné : une
 * fenêtre se cale sur des segments, dont la fin dépasse le dernier mot aligné,
 * et sans écrêtage la part dépasserait 1 — l'écran annoncerait 104 %.
 *
 * Une étendue vide rend 0 plutôt qu'une division par zéro : il n'y avait pas de
 * matière, donc aucune part n'en a été jugée.
 *
 * Le résultat est arrondi au dix-millième. `status.json` se relit à l'œil, et
 * `0.8363443145589798` n'y apprend rien de plus que `0.8363`.
 *
 * Pure, et exportée pour être testée sur ses cas limites : ils ne se rencontrent
 * pas dans une passe complète.
 */
export function partCovered(intervals: readonly Extent[], extent: Extent): number {
  const total = extent.end - extent.start
  if (!(total > 0)) return 0

  const clipped = intervals
    .map((i) => ({
      start: Math.max(i.start, extent.start),
      end: Math.min(i.end, extent.end),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)

  let covered = 0
  let current: Extent | null = null
  for (const i of clipped) {
    if (current === null || i.start > current.end) {
      if (current !== null) covered += current.end - current.start
      current = { ...i }
    } else if (i.end > current.end) {
      current.end = i.end
    }
  }
  if (current !== null) covered += current.end - current.start

  return Math.round((covered / total) * 10_000) / 10_000
}

/**
 * L'étendue du transcript : du premier mot aligné au dernier.
 *
 * **Pas la durée de l'émission**, et c'est le dénominateur qui donne son sens à
 * la couverture : une émission qui commence par cinq minutes de silence n'a pas
 * cinq minutes de matière non jugée. Les mots arrivent en général ordonnés, mais
 * on ne le suppose pas — un transcript vient du disque.
 */
export function transcriptExtent(words: readonly Word[]): Extent {
  if (words.length === 0) return { start: 0, end: 0 }
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const word of words) {
    if (word.start < start) start = word.start
    if (word.end > end) end = word.end
  }
  return end > start ? { start, end } : { start: 0, end: 0 }
}

/**
 * Le bilan de la dernière notation de chaque projet.
 *
 * **En mémoire, dans ce processus, comme la table `inCurrent` du lanceur.** Le
 * bilan décrit une exécution, pas un artefact : le relire après un redémarrage
 * de Next décrirait un travail que personne n'a fait dans ce processus.
 *
 * C'est la jonction prévue avec `status.json` : `src/server/run.ts` appartient à
 * une autre tâche, et il lui suffit d'appeler `lastSummary(projectId)` au
 * moment d'écrire le statut pour que la perte remonte jusqu'à l'interface. Tant
 * que ce raccord n'est pas fait, elle est dans le journal, ce qui est déjà
 * infiniment plus que rien.
 */
const summaries = new Map<string, SummaryNotation>()

/**
 * Le bilan de la dernière notation de ce projet, ou `null`.
 *
 * **Il décrit une notation tentée, pas une notation réussie**, et l'appelant ne
 * peut pas déduire l'un de l'autre. Le bilan est posé avant le premier appel et
 * se remplit au fil de l'eau : une exécution qui échoue en cours de route — le
 * réseau, le quota, un refus de toute la vidéo — en laisse un partiel, qui dit
 * exactement ce qui avait été jugé au moment de la panne. C'est ce qu'on veut
 * d'un décompte de perte, et ce serait un contresens dans un rapport de succès.
 *
 * Ce qui dit si la passe a abouti vit ailleurs et le dit déjà : `status.json`
 * porte `error` et `finishedAt`. Le raccord à venir dans `writeStatus` doit
 * donc lire les deux, jamais ce bilan seul. (relevé par Aristarque)
 */
export function lastSummary(projectId: string): SummaryNotation | null {
  return summaries.get(projectId) ?? null
}

/**
 * Oublie le bilan d'un projet, **avant** qu'une exécution qui vise le repérage
 * ne commence.
 *
 * `runCandidates` fait déjà ce nettoyage à sa première ligne, mais trop tard
 * pour le lanceur : une exécution qui vise `candidates` peut passer une demi-heure
 * dans la transcription avant d'y arriver, et pendant tout ce temps `status.json`
 * publierait le décompte de la passe précédente comme s'il décrivait celle-ci.
 * Le lanceur appelle donc ceci dès qu'il retient un plan qui contient l'étape.
 */
export function forgetSummary(projectId: string): void {
  summaries.delete(projectId)
}

/** The sweep pass's ("+N clips") own report — orthogonal to `summaries` above. */
const moreClipsReports = new Map<string, MoreClipsReport>()

/** The last "+N clips" report for this project, or `null` if none ran here. */
export function lastMoreClipsReport(projectId: string): MoreClipsReport | null {
  return moreClipsReports.get(projectId) ?? null
}

/** Same role as `forgetSummary`, for the sweep pass's own report. */
export function forgetMoreClipsReport(projectId: string): void {
  moreClipsReports.delete(projectId)
}

/**
 * Le repérage complet d'un projet, de bout en bout.
 *
 * L'ordre compte, et un point en particulier : **les cibles de nombre de clips
 * se calculent avant la fusion**, sur le nombre de fenêtres retenues. Fusionner
 * remanie la charge utile, cela ne sélectionne pas moins de matière ; faire
 * dépendre le plancher du nombre de blocs le ferait bouger parce que deux
 * fenêtres se trouvent voisines, alors qu'il repose sur une mesure de rétention
 * (voir `clipCountTargets`).
 *
 * Rendu : la liste complète des clips du projet après fusion — travail humain
 * compris, puisque c'est elle qui fait autorité en base.
 */
export async function runCandidates(
  projectId: string,
  options: DetectionOptions = {},
): Promise<Clip[]> {
  // **Le bilan de la passe précédente tombe à la toute première ligne**, avant
  // même la base et le client. Il n'est posé qu'une fois le transcript lu et les
  // fenêtres construites : une exécution qui échoue avant — clé d'API absente,
  // projet inconnu, durée manquante, transcript illisible — laissait sinon
  // `lastSummary` répondre le décompte d'une passe antérieure, sans rien qui
  // permette de voir qu'il est périmé, et le raccord à venir dans `writeStatus`
  // aurait recopié ce chiffre dans `status.json`.
  //
  // La première version de ce nettoyage était posée trois lignes plus bas, donc
  // *après* `clientByDefault()`, qui lève quand `GEMINI_API_KEY` manque : elle
  // ratait précisément l'échec le plus banal. Un nettoyage conditionné à ce que
  // rien n'ait échoué avant lui ne nettoie rien. (relevé par Copilot)
  summaries.delete(projectId)
  // A fresh windowed pass replaces every still-`candidate` clip, so a sweep
  // pass's own report — describing an earlier, now superseded run — goes
  // stale with it.
  moreClipsReports.delete(projectId)

  const db = options.db ?? getDb()
  const call = options.call ?? clientByDefault(db, options.signal)
  const sleep = options.sleep ?? wait

  const project = getProject(db, projectId)
  if (!project) throw new Error(`Projet inconnu : ${projectId}`)
  if (project.durationSec === null) {
    throw new Error(
      `Le projet ${projectId} n'a pas de durée : l'ingestion (ffprobe) doit passer avant le repérage.`,
    )
  }
  const duration = project.durationSec

  const placement = placeSidecar(project.sourcePath, projectId)
  const transcript = lireTranscript(placement.transcript)
  const words: Word[] = transcript.segments.flatMap((s) => s.words)

  // 1. Le fenêtrage : 90 secondes, chevauchées de 30, calées sur les phrases.
  const windows = buildWindows(transcript, duration)
  console.log(`Repérage ${projectId} : ${windows.length} fenêtre(s) à noter.`)

  // **Deux mesures voisines, et elles ne sont pas interchangeables.**
  // `étendue` va du premier mot aligné au dernier : c'est le dénominateur de la
  // couverture, celui qui dit quelle part du *déroulé* a été jugée.
  // `speechSec` est l'union des segments qui portent de la prose : c'est la
  // matière, celle qui dit combien de clips l'émission peut donner. Sur les deux
  // émissions du dépôt, la seconde vaut 79 à 80 % de la première.
  const extent = transcriptExtent(words)
  const speechSec = speechSeconds(transcript)
  const settings = getSettings(db)

  // 2. La notation, par lots, puis la récupération de ce que le filtre refuse.
  const { noted, summary } = await noteWindows(
    windows,
    {
      projectId,
      language: transcript.language,
      videoDuration: duration,
      extent,
      call,
      sleep,
      signal: options.signal,
    },
    options.onSummary,
  )

  // 3. La présélection, puis la fusion — et les cibles AVANT la fusion.
  const kept = shortlistFromScores(
    noted,
    windows,
    shortlistSize(speechSec, windows.length, settings),
  )
  const [minClips, maxClips] = clipCountTargets(speechSec, settings)
  const blocks = mergeOverlappingWindows(kept, transcript)
  console.log(
    `Présélection : ${kept.length} fenêtre(s) → ${blocks.length} bloc(s) de détail, ` +
      `cible ${minClips}-${maxClips} clip(s) pour ${(speechSec / 60).toFixed(1)} min de parole ` +
      `(un clip toutes les ${settings.minutesPerClip} min).`,
  )

  // **La relecture des clips, faite une seule fois et jamais avant l'attente
  // réseau.** `PATCH /api/clips/:id` reste ouverte pendant qu'une exécution de
  // fond tourne : une décision prise pendant les appels de détail — garder,
  // écarter, éditer — ne figure pas dans un instantané pris avant eux.
  //
  // Deux endroits en ont besoin, et **c'est la même lecture qui doit les
  // servir** : le plafond du détail, qui ne veut compter que des propositions
  // qui survivront, et la fusion des passes, qui décide ce que la base gardera.
  // Deux lectures distinctes rouvriraient entre elles la fenêtre que celle-ci
  // ferme. Elle est différée parce que le plafond, quand il est réglé, est le
  // premier à la demander — c'est-à-dire juste après les appels.
  // (relevé par Codex)
  let freshClips: Clip[] | null = null
  const readFreshClips = (): Clip[] => (freshClips ??= getClips(db, projectId))

  // 4. Le détail, sur la liste fusionnée et ancrée. Le calage sur les mots se
  //    fait DANS la relance, pour qu'une enveloppe cassée soit réessayée au lieu
  //    de ressortir en « zéro clip » — ce qui effacerait les propositions non
  //    traitées et écrirait l'artefact. (relevé par Copilot)
  const propositions = await detail(kept, {
    projectId,
    transcript,
    words,
    duration,
    minClips,
    maxClips,
    capAbsolute: settings.maximumClips,
    idsTaken: () =>
      new Set(readFreshClips().filter((c) => c.status !== 'candidate').map((c) => c.id)),
    call,
    sleep,
    signal: options.signal,
  })

  // 5. La fusion des passes, puis l'écriture.
  //
  // **Lus après l'attente réseau, et jamais avant.** Fusionner sur un
  // instantané pris avant les appels reviendrait à traiter comme un candidat un
  // clip dont quelqu'un vient de décider, et `replaceClips` effacerait ensuite
  // la décision. C'est très exactement la garantie « une nouvelle passe n'écrase
  // jamais un travail humain » (spec §5), qu'une lecture hissée trop haut
  // suffisait à défaire. (relevé par Codex et Copilot)
  const existing = readFreshClips()
  // `reduce` et non `Math.max(...tableau)` : la liste fait la taille du projet
  // entier, et l'étalement finirait par dépasser la pile. (relevé par Aristarque)
  const past = 1 + existing.reduce((top, c) => Math.max(top, c.pass), 0)
  const clips = mergeCandidates(existing, propositions, past)
  // **Le marqueur tombe avant la mutation et ne réapparaît qu'après.** Le graphe
  // ne regarde que la présence du fichier : laisser l'ancien en place pendant
  // qu'on change la base ferait passer une exécution interrompue pour terminée,
  // avec un artefact qui décrit l'état d'avant. (relevé par Copilot)
  eraseArtifact(projectId)
  replaceClips(db, projectId, clips)
  writeArtifact(projectId, clips)
  console.log(
    `Passe ${past} : ${propositions.length} proposition(s), ${clips.length} clip(s)` +
      `, ${summary.noted}/${summary.windows} fenêtre(s) jugée(s).`,
  )
  return clips
}

/** `SCORE_BATCH`, jamais moins de 1 : une valeur illisible ne fait pas échouer le travail. */
function batchSize(): number {
  const raw = Number.parseInt(process.env.SCORE_BATCH ?? '', 10)
  return Number.isFinite(raw) && raw >= 1 ? raw : BATCH_NOTATION_BY_DEFAULT
}

/**
 * L'état d'une notation en cours : ce qui est noté, ce qui ne l'est pas, et le
 * bilan qui les compte.
 *
 * `notNoted` est la source de vérité et `bilan.neverNoted` en est le reflet
 * sérialisable, réécrit à chaque changement. Deux listes tenues séparément
 * finiraient par diverger, et c'est le décompte de perte qui mentirait.
 */
type Slate = {
  summary: SummaryNotation
  /** Les fenêtres sans note. Pleine au départ, elle se vide de ce qui est noté. */
  notNoted: Set<string>
  /** Les notes rassemblées, réconciliation comprise. */
  noted: ScoredWindow[]
  /**
   * L'étendue de chaque fenêtre, par identifiant. `notNoted` ne porte que des
   * identifiants ; la couverture, elle, se calcule sur des intervalles.
   */
  extents: Map<string, Extent>
  /** L'étendue du transcript, dénominateur de la couverture. */
  transcript: Extent
  /** Prévenu après chaque lot traité. Voir `DetectionOptions.onSummary`. */
  publish?: (summary: SummaryNotation) => void
}

/**
 * Ce qu'il reste à dépenser en récupération, **en requêtes réseau**.
 *
 * Mutable et partagé avec la couture qui appelle le modèle, parce que c'est le
 * seul endroit qui voie les requêtes réelles : `callGemini` en émet jusqu'à
 * trois pour un même sous-lot quand la première est passagère. Débité par
 * sous-lot, le plafond annoncé valait trois fois plus en 429 — c'est-à-dire
 * exactement dans la situation qu'il est censé borner. (relevé par Copilot et Codex)
 */
type Budget = { remaining: number }

/** Ce dont la notation a besoin, et rien de plus. */
type ContextNotation = {
  projectId: string
  language: string
  videoDuration: number
  /** L'étendue du transcript : le dénominateur de `couverture`. */
  extent: Extent
  call: CallGemini
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
}

/**
 * La notation complète : un passage par lots, puis la récupération de ce que le
 * filtre a refusé.
 *
 * **Les deux phases sont séparées, et l'ordre a une raison.** Le premier passage
 * dit quels lots tombent ; la récupération ne recoupe que ceux-là, et ne coûte
 * donc rien sur une émission que le filtre laisse passer. Entremêler les deux
 * ferait payer la découpe avant de savoir s'il y a quelque chose à découper.
 */
async function noteWindows(
  windows: Window[],
  ctx: ContextNotation,
  onSummary?: (summary: SummaryNotation) => void,
): Promise<{ noted: ScoredWindow[]; summary: SummaryNotation }> {
  const size = batchSize()
  const batches: Window[][] = []
  for (let i = 0; i < windows.length; i += size) batches.push(windows.slice(i, i + size))

  // **La liste des non notées part pleine.** Toute fenêtre est non jugée tant
  // qu'une réponse ne la juge pas, y compris celles qu'une panne empêchera même
  // de soumettre : c'est ce qui rend le bilan honnête à l'instant où il est lu,
  // et pas seulement à la fin. (relevé par Copilot)
  const slate: Slate = {
    noted: [],
    notNoted: new Set(windows.map((f) => f.id)),
    extents: new Map(windows.map((f) => [f.id, { start: f.start, end: f.end }])),
    transcript: ctx.extent,
    publish: onSummary,
    summary: {
      windows: windows.length,
      noted: 0,
      neverNoted: windows.map((f) => f.id),
      rejected: [],
      calls: 0,
      batchesRejected: 0,
      batchesResponded: 0,
      // Rien n'est noté avant le premier appel : la couverture part de zéro et
      // grandit avec les réponses, comme le reste du bilan.
      coverage: 0,
    },
  }
  const { summary } = slate
  summaries.set(ctx.projectId, summary)

  try {
    return await noteAndRecover(batches, ctx, slate)
  } finally {
    // **Dans un `finally`, et c'est tout l'intérêt.** Le bilan promis « au
    // journal à chaque passe » ne sortait que par le chemin heureux : un refus
    // total lève, une panne réseau se propage, et la perte redevenait
    // silencieuse exactement quand elle est la plus grande. Un décompte qui
    // n'apparaît que lorsque tout va bien ne sert à rien. (relevé par Copilot)
    logSummary(summary)
  }
}

/** Le corps de la notation, sorti pour que son appelant tienne le `finally`. */
async function noteAndRecover(
  batches: Window[][],
  ctx: ContextNotation,
  slate: Slate,
): Promise<{ noted: ScoredWindow[]; summary: SummaryNotation }> {
  const { summary, noted } = slate
  const rejected: Window[][] = []
  for (const batch of batches) {
    const lu = await noteABatch(batch, ctx, slate)
    if (lu === null) rejected.push(batch)
    else sort(lu, slate)
    // **Après le lot entier, pas dans `ranger`.** Un lot refusé ne range rien et
    // change pourtant le bilan — `lotsRefusés`, `appels` —, et c'est justement le
    // chiffre qu'on veut voir monter en direct.
    slate.publish?.(summary)
  }

  const budget = batches.length * RECOVERY_MAX
  if (rejected.length > 0) {
    const inSet = rejected.reduce((n, batch) => n + batch.length, 0)
    console.warn(
      `${rejected.length} lot(s) refusés par le filtre, ${inSet} fenêtre(s) ; on les recoupe.`,
    )
    await recover(rejected, ctx, slate, budget)
  }

  // Rien n'a répondu, découpe comprise : là seulement, c'est la vidéo. On le dit
  // avec l'erreur qui ne se réessaie pas, plutôt que de détailler un panier vide.
  //
  // **Le verdict se prononce APRÈS la récupération, et c'est la mesure du 18
  // août 2026 qui l'impose** : le filtre refuse la concentration de matière dans
  // une charge, pas une fenêtre coupable, donc « tous les lots ont été refusés »
  // ne dit rien de la vidéo tant qu'on n'a pas essayé de plus petites charges.
  // Condamner une émission entière sur des lots de huit, c'est exactement
  // l'erreur que ce fichier vient de corriger, en plus grand. Le budget de
  // `récupérer` borne ce que cette prudence peut coûter.
  //
  // **Et le message dit lequel des deux cas s'est produit, parce qu'ils ne
  // s'affirment pas au même prix.** Le budget peut s'épuiser avant qu'une seule
  // fenêtre ait été soumise seule : 11 lots de 8 tous refusés dépensent 22
  // appels sur les demi-lots et 11 sur les quarts, et la descente s'arrête là.
  // Prétendre alors que le refus va « jusqu'à la fenêtre seule » serait affirmer
  // un essai qu'on n'a pas fait — la faute même que cette PR corrige, d'un étage
  // plus haut. Le second message ne conclut donc rien sur le matériel : il dit
  // ce qui a été tenté, ce qui reste inconnu, et le levier qui reste
  // (`SCORE_BATCH`, qui fait entrer moins de matière par charge dès le premier
  // passage). (relevé par Copilot, Codex et Aristarque)
  //
  // **Le compte des lots, pas celui des notes.** Un lot qui répond en omettant
  // toutes ses fenêtres est une réponse dégradée mais utilisable — c'est le sens
  // de la réconciliation de `parseScoreResponse` —, et la confondre avec un
  // refus transformait ce repli en échec définitif dès qu'un seul lot était
  // bloqué. (relevé par Codex)
  if (summary.batchesRejected > 0 && summary.batchesResponded === 0) {
    const untilToWindowOnly = summary.rejected.length === summary.windows
    throw new GeminiBlockedError(
      untilToWindowOnly
        ? `Le fournisseur a refusé les ${summary.batchesRejected} lot(s) de notation de cette vidéo, jusqu'à la fenêtre seule. Les règles d'usage du fournisseur refusent ce matériel : il ne peut pas être analysé.`
        : `Le fournisseur a refusé les ${summary.batchesRejected} lot(s) de notation de cette vidéo, et le budget de récupération (${budget} appel(s)) s'est épuisé avant d'avoir pu soumettre chaque fenêtre seule : ${summary.rejected.length} sur ${summary.windows} ${summary.rejected.length > 1 ? "l'ont été" : "l'a été"}. Aucune fenêtre n'a donc été jugée, et rien ne dit encore si c'est le matériel ou la charge qui est refusé. Baisser SCORE_BATCH fait entrer moins de matière par appel dès le premier passage.`,
    )
  }

  return { noted, summary }
}

/**
 * Le bilan au journal.
 *
 * **La perte est dite, chiffrée et nommée.** Sans cela, un tiers d'une émission
 * pouvait sortir du classement sans aucune trace : les fenêtres non notées
 * finissent dernières, donc dehors dès que la présélection mord, et le repérage
 * se terminait « avec succès ». Les identifiants sont listés, pas seulement
 * comptés — c'est ce qui permet d'aller regarder le transcript à l'endroit exact
 * de ce qui n'a pas été jugé.
 */
function logSummary(summary: SummaryNotation): void {
  console.log(
    `Notation : ${summary.noted}/${summary.windows} fenêtre(s) jugée(s) en ${summary.calls} requête(s).`,
  )
  if (summary.neverNoted.length === 0) return
  console.warn(
    `${summary.neverNoted.length} fenêtre(s) sur ${summary.windows} n'ont jamais été notées ; ` +
      `classées dernières : ${summary.neverNoted.join(', ')}.` +
      (summary.rejected.length > 0
        ? ` Dont ${summary.rejected.length} refusée(s) seule(s) par le filtre : ${summary.rejected.join(', ')}.`
        : ''),
  )
}

/**
 * Un lot noté, ou `null` si le filtre l'a refusé.
 *
 * Seul le refus de contenu rend `null` : c'est le seul échec dont on sache quoi
 * faire d'autre que d'abandonner. Tout le reste remonte et fait échouer le
 * repérage, comme avant.
 */
async function noteABatch(
  batch: Window[],
  ctx: ContextNotation,
  { summary }: Slate,
  budget?: Budget,
): Promise<{ scored: ScoredWindow[]; missing: string[] } | null> {
  // Compté **dans** la couture réseau, pas avant l'appel : `callGemini`
  // réessaie jusqu'à trois fois, et c'est chaque requête qui coûte du quota —
  // donc chaque requête, et non chaque sous-lot, qui débite le budget.
  const count: CallGemini = (prompt, mode) => {
    summary.calls += 1
    if (budget !== undefined) budget.remaining -= 1
    return ctx.call(prompt, mode)
  }
  let raw: unknown
  try {
    raw = await callWithRetry(
      count,
      scorePrompt({
        language: ctx.language,
        videoDuration: ctx.videoDuration,
        windowsJson: scoreWindowsJson(batch),
      }),
      'score',
      { sleep: ctx.sleep, signal: ctx.signal },
    )
  } catch (error) {
    if (!(error instanceof GeminiBlockedError)) throw error
    summary.batchesRejected += 1
    return null
  }
  summary.batchesResponded += 1
  return parseScoreResponse(raw, batch)
}

/**
 * Recoupe les lots refusés en deux, et recommence sur les moitiés qui tombent
 * encore.
 *
 * **C'est la seule façon mesurée de récupérer le matériel refusé, et elle ne
 * viole pas la règle « un refus ne se réessaie jamais » : on n'envoie pas la
 * même requête, on en envoie une autre.** Sur `2025-06-15-cqlp`, le 18 août
 * 2026, la descente rend 32 fenêtres sur 32 — 4 lots de 8 refusés, puis 3
 * demi-lots de 4, puis 3 paires, puis plus rien : chacune des 32 fenêtres passe
 * seule. Le filtre ne vise donc pas une fenêtre coupable qu'il faudrait trouver,
 * il vise la **concentration** de matière dans une seule charge, et sept
 * fenêtres innocentes tombaient avec la huitième.
 *
 * Ce que la descente coûte : 20 appels pour ces 4 lots, contre 11 pour le
 * premier passage entier. Ce qu'elle rapporte : les 32 fenêtres perdues portent
 * précisément l'humour transgressif de l'émission — la vanne des photos de
 * pieds, la scène du psy et de la bouteille, celle du vieux misogyne. Les
 * écarter en silence, c'était écarter le haut du panier.
 *
 * **La descente est en largeur, pas en profondeur, et c'est ce que le budget
 * rend visible.** Un appel à la profondeur d rapporte au plus k/2^d fenêtres :
 * le moins cher par fenêtre est donc toujours la découpe la moins profonde, quel
 * que soit le lot d'où elle vient. En profondeur, un budget serré s'épuisait sur
 * la première branche et abandonnait des lots voisins qu'un seul appel aurait
 * suffi à sauver.
 *
 * Ce que le budget ne paie pas est compté comme non noté, jamais avalé.
 */
async function recover(
  rejected: Window[][],
  ctx: ContextNotation,
  slate: Slate,
  cap: number,
): Promise<void> {
  const file = [...rejected]
  const budget: Budget = { remaining: cap }
  while (file.length > 0) {
    const batch = file.shift()!
    // Une fenêtre seule et toujours refusée : il n'y a plus rien à recouper, et
    // c'est bien elle que le filtre vise. Le cas ne s'est pas produit sur
    // l'émission mesurée ; il reste possible sur une autre.
    if (batch.length === 1) {
      slate.summary.rejected.push(batch[0].id)
      abandon(batch, slate, 'fenêtre refusée par le filtre')
      slate.publish?.(slate.summary)
      continue
    }

    const middle = Math.ceil(batch.length / 2)
    for (const half of [batch.slice(0, middle), batch.slice(middle)]) {
      // Le budget se lit avant chaque sous-lot et se débite dans la couture, à
      // chaque requête. Il peut donc finir légèrement négatif — les relances
      // d'un sous-lot déjà engagé ne s'interrompent pas au milieu —, d'au plus
      // `ATTEMPTS - 1` requêtes. C'est borné et connu, là où un débit par
      // sous-lot laissait le dépassement croître avec le nombre de branches.
      if (budget.remaining <= 0) {
        abandon(half, slate, 'lot refusé, budget de récupération épuisé')
        continue
      }
      const lu = await noteABatch(half, ctx, slate, budget)
      if (lu === null) file.push(half)
      else sort(lu, slate)
      slate.publish?.(slate.summary)
    }
  }
}

/**
 * Un lot dont on ne tirera rien : dernier au classement, et compté comme tel.
 *
 * Il reste dans `notNoted` — il n'en est jamais sorti — donc rien n'a à l'y
 * remettre. Ce qui s'ajoute ici est seulement l'entrée de classement qui le fait
 * finir dernier plutôt que dehors.
 */
function abandon(batch: Window[], slate: Slate, reason: string): void {
  for (const window of batch) {
    slate.noted.push({ id: window.id, score: 0, reason: reason, noted: false })
  }
}

/** Range un lot lu, en séparant ce qui porte une note de ce qui n'en porte pas. */
function sort(lu: { scored: ScoredWindow[]; missing: string[] }, slate: Slate): void {
  const { summary, notNoted } = slate
  slate.noted.push(...lu.scored)
  const omitted = new Set(lu.missing)
  for (const note of lu.scored) {
    if (omitted.has(note.id)) continue
    // `delete` rend faux sur une fenêtre déjà notée : le compte suit le retrait
    // effectif, jamais la longueur du lot, pour qu'un identifiant vu deux fois
    // ne compte pas deux jugements.
    if (notNoted.delete(note.id)) summary.noted += 1
  }
  summary.neverNoted = [...notNoted]
  // Recalculée **ici et nulle part ailleurs** : c'est le seul endroit où
  // `notNoted` rétrécit, donc le seul où la couverture change. La déduire
  // ailleurs ferait une seconde autorité sur le même chiffre.
  summary.coverage = partCovered(
    [...slate.extents].filter(([id]) => !notNoted.has(id)).map(([, extent]) => extent),
    slate.transcript,
  )
}

/** Ce dont la passe de détail a besoin, une fois les blocs choisis. */
type ContextDetail = {
  projectId: string
  transcript: TranscriptLu
  words: Word[]
  duration: number
  minClips: number
  maxClips: number
  /** `maximumClips` tel qu'il est réglé — `0` quand il ne l'est pas. */
  capAbsolute: number
  /**
   * Les `id` que `mergeCandidates` écartera de toute façon : ceux des clips
   * portant une décision humaine. Ne sert qu'au plafond, qui doit compter des
   * propositions qui survivront.
   *
   * **Une fonction, appelée après les appels réseau et jamais avant.** Quelqu'un
   * peut écarter un candidat pendant que la requête de détail est en vol ; un
   * instantané pris avant elle traite encore cet identifiant comme disponible.
   * La proposition consommait alors un créneau du plafond, `mergeCandidates` la
   * jetait juste après sur la relecture fraîche, et la passe rendait moins de
   * clips que le maximum réglé. C'est la relecture de `runCandidates` qui répond
   * ici, la même que celle de la fusion. (relevé par Codex)
   */
  idsTaken: () => ReadonlySet<string>
  call: CallGemini
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
}

/**
 * La passe de détail, avec la même parade que la notation contre le filtre.
 *
 * **Elle était un appel unique sans recours**, et c'était tenable tant que la
 * présélection plafonnait à 24 fenêtres. Le dimensionnement sur la durée de
 * parole l'ouvre — 32 fenêtres pour une émission de 1 h 51, 52 pour trois
 * heures —, et le refus mesuré porte sur la **concentration** de matière dans
 * une charge, pas sur une fenêtre coupable (voir `GeminiBlockedError`). Élargir
 * la charge sans lui donner de recours reviendrait à troquer six clips contre
 * une étape qui échoue.
 *
 * La parade est celle de `récupérer`, et elle ne viole pas plus qu'elle la règle
 * « un refus ne se réessaie jamais » : on n'envoie pas la même requête, on en
 * envoie une autre. La descente va jusqu'au bloc seul parce qu'un seul niveau ne
 * suffit pas — mesuré sur `2025-06-15-cqlp`, il a fallu descendre des lots de 8
 * aux demi-lots, puis aux paires, puis aux unités.
 *
 * **Un bloc refusé seul est abandonné, pas fatal.** Perdre une région sur vingt
 * vaut infiniment mieux que de perdre l'émission. Le verdict ne tombe qu'à la
 * fin et seulement si *rien* n'a répondu : c'est la leçon déjà écrite dans
 * `noteWindows`, où « tous les lots ont été refusés » ne dit rien de la
 * vidéo tant qu'on n'a pas essayé de plus petites charges.
 *
 * **Pas de budget, contrairement à `récupérer`, et ce n'est pas un oubli.** La
 * descente est un arbre binaire sur un ensemble de blocs **fixe** : elle coûte
 * au pire `2k - 1` appels pour k blocs, et s'arrête d'elle-même. `récupérer`, où
 * les moitiés refusées retournent dans une file, n'a pas cette garantie — c'est
 * ce qui lui vaut son plafond. En poser un ici aurait donné soit une borne
 * arbitraire, soit — avec le facteur de `récupérer`, `3k` — une branche que rien
 * ne peut atteindre, et un message d'erreur prudent pour un cas qui n'existe
 * pas. Le coût du pire cas reste visible : 60 blocs tous refusés font 119
 * appels, ce qui est cher et borné.
 *
 * **Ce que la découpe coûte, et qui est assumé.** Le prompt demande de ne jamais
 * rendre deux clips qui racontent la même chose « même entre fenêtres
 * différentes » ; deux moitiés appelées séparément ne peuvent plus se comparer.
 * Cela ne se produit qu'en cas de refus, et `mergeCandidates` dédoublonne
 * ensuite sur les bornes.
 */
async function detail(kept: Window[], ctx: ContextDetail): Promise<Clip[]> {
  const slate: SlateDetail = { rejected: [], succeeded: 0 }
  const propositions = await descend(
    kept,
    { min: ctx.minClips, max: ctx.maxClips },
    ctx,
    slate,
  )

  if (slate.rejected.length > 0) {
    console.warn(
      `Détail : ${slate.rejected.length} fenêtre(s) refusée(s) seule(s) par le filtre ` +
        `et abandonnée(s) : ${slate.rejected.join(', ')}.`,
    )
  }
  // Rien n'a **répondu**, découpe comprise : là seulement, c'est la vidéo.
  //
  // **Le compte des réponses, jamais celui des clips.** `parseDetailResponse`
  // tient `shorts: []` pour une réponse valide — « aucun moment exploitable
  // ici » —, donc une moitié qui répond vide pendant que l'autre est refusée
  // laisse la liste vide sans qu'aucun refus global n'ait eu lieu. Compter les
  // clips faisait alors échouer toute l'étape en accusant la vidéo d'un refus
  // qu'elle n'a pas subi. (relevé par Codex et Copilot)
  if (slate.succeeded === 0 && slate.rejected.length > 0) {
    // **Le message n'affirme ici que ce qui a bel et bien été essayé**, parce
    // que la descente va toujours jusqu'au bout — voir le paragraphe sur son
    // coût. C'est ce qui la dispense du budget de `récupérer`, et donc de la
    // formule prudente que ce dernier a dû se donner après coup.
    throw new GeminiBlockedError(
      `Le fournisseur a refusé la passe de détail de cette vidéo, jusqu'à la fenêtre seule (${slate.rejected.length} fenêtre(s)). ` +
        `Les règles d'usage du fournisseur refusent ce matériel : il ne peut pas être détaillé.`,
    )
  }

  // **Classer d'abord, dédoublonner ensuite, plafonner en dernier.** Les trois
  // gestes se suivent dans cet ordre parce que chacun a besoin du précédent : le
  // classement décide qui mérite un créneau, le dédoublonnage décide qui en
  // consomme un, la coupe compte.
  const clips = rankProposals(propositions)

  // **Le plafond absolu se tient ici, à la fin, et pas seulement dans la
  // consigne.** Une découpe éclate la cible entre les branches, et une part qui
  // s'arrondit à zéro est relevée à un pour ne pas abandonner de région : la
  // somme des consignes peut donc dépasser le plafond que l'utilisateur a posé.
  // Le prompt n'est de toute façon qu'une consigne — ni le modèle ni
  // `parseDetailResponse` ne l'imposent. Ce qui rend `maximumClips` vrai est
  // cette coupe-ci. (relevé par Copilot)
  //
  // Le plafond **réglé**, jamais la cible proportionnelle : sans réglage, rendre
  // plus que la cible est une bonne nouvelle — le repérage vise le rappel
  // (spec §7) — et couper là abandonnerait du matériau que personne n'a demandé
  // d'abandonner.
  if (ctx.capAbsolute <= 0) return clips

  // **Dédoublonner avant de plafonner, jamais l'inverse.** Deux horodatages
  // bruts différents peuvent se caler sur le même clip — c'est le métier de
  // `snapToWords` —, et un clip qui heurte une décision humaine sera de toute
  // façon écarté par `mergeCandidates`. Plafonner d'abord laissait ces
  // condamnés consommer le quota : `[A, A, B]` à deux devenait `[A, A]`, puis un
  // seul candidat, et B disparaissait alors que le plafond l'autorisait.
  // (relevé par Codex)
  const seen = new Set(ctx.idsTaken())
  const unique = clips.filter((clip) => !seen.has(clip.id) && seen.add(clip.id))

  if (unique.length <= ctx.capAbsolute) return unique
  // **Et la coupe se dit.** Une troncature silencieuse est le défaut que ce
  // dépôt passe son temps à corriger ailleurs ; celle-ci nomme ce qu'elle
  // écarte, et ne survient que si quelqu'un a réglé un plafond.
  const discarded = unique.slice(ctx.capAbsolute)
  console.warn(
    `Détail : ${discarded.length} proposition(s) au-delà du plafond réglé de ${ctx.capAbsolute} clip(s), ` +
      `écartée(s) : ${discarded.map((c) => c.id).join(', ')}.`,
  )
  return unique.slice(0, ctx.capAbsolute)
}

/**
 * Proposals reordered by predicted score, best first. Ties break on arrival
 * order, since a content refusal can split `descend` into several calls whose
 * branches carry no meaningful cross-order.
 *
 * `detail` runs this over its full result, so it only reorders
 * `candidates.json`. `runMoreClips` slices the result to `count`: there, this
 * ranking decides which proposals survive.
 */
function rankProposals(proposals: readonly DetailClip[]): Clip[] {
  return proposals
    .map((proposal, arrival) => ({ proposal, arrival }))
    .sort(
      (a, b) =>
        Number(b.proposal.scored) - Number(a.proposal.scored) ||
        b.proposal.predictedScore - a.proposal.predictedScore ||
        a.arrival - b.arrival,
    )
    .map(({ proposal }) => proposal.clip)
}

/**
 * Ce que la descente ramène en plus des clips.
 *
 * `réussis` compte les **réponses**, pas les clips : voir le verdict de
 * `détailler`, que cette distinction sépare d'un faux refus.
 *
 * `refusés` ne porte que des blocs soumis **seuls** et refusés : la descente
 * n'abandonne rien d'autre, donc tout ce qui y figure a bel et bien été essayé.
 */
type SlateDetail = { rejected: string[]; succeeded: number }

/**
 * Un lot de blocs, recoupé en deux tant que le filtre refuse.
 *
 * **La cible se partage, elle ne se recalcule pas.** Chaque appel reçoit
 * l'intervalle qui lui revient. La version précédente recalculait un prorata
 * depuis la racine et arrondissait chaque enfant indépendamment ; surtout, elle
 * perdait le plafond dès le premier appel, sans même de découpe :
 * `Math.max(min + 1, …)` transformait une cible plafonnée à `[10, 10]` en
 * `[10, 11]`. (relevé par Copilot)
 *
 * **Ce que le partage ne garantit pas, et pourquoi.** Une part qui s'arrondit à
 * zéro est relevée à un, si bien que la somme des plafonds enfants peut dépasser
 * celui du parent d'une unité par moitié concernée. C'est un choix : l'inverse —
 * ne pas soumettre la moitié dont la part est nulle — abandonnerait une région
 * entière de l'émission pour respecter à la lettre un nombre qui n'est de toute
 * façon qu'une consigne de prompt, que ni le modèle ni `parseDetailResponse`
 * n'imposent. Un premier essai le faisait, et perdait deux blocs sur huit dès le
 * cas de test le plus banal.
 */
async function descend(
  batch: Window[],
  target: { min: number; max: number },
  ctx: ContextDetail,
  slate: SlateDetail,
): Promise<DetailClip[]> {
  if (batch.length === 0) return []

  const max = Math.max(1, target.max)
  const min = Math.min(Math.max(1, target.min), max)
  // **La fusion se refait à chaque étage, sur le lot courant.** C'est ce qui
  // permet à la descente de porter sur des fenêtres et non sur des blocs déjà
  // fusionnés : un bloc réunit tous les voisins qui se chevauchent, donc sur de
  // la parole continue il en réunit beaucoup, et la présélection élargie que
  // cette PR introduit le grossit encore. Descendre sur les blocs abandonnait
  // ainsi une région entière au premier refus, sans jamais réduire la charge —
  // c'est-à-dire sans traiter la concentration de matière que ce garde-fou
  // existe précisément pour traiter. (relevé par Codex)
  const blocks = mergeOverlappingWindows(batch, ctx.transcript)

  try {
    const clips = await callWithRetry(
      ctx.call,
      detailPrompt({
        language: ctx.transcript.language,
        videoDuration: ctx.duration,
        windowsJson: detailWindowsJson(blocks, ctx.transcript),
        minClips: min,
        maxClips: max,
      }),
      'detail',
      {
        sleep: ctx.sleep,
        signal: ctx.signal,
        analyze: (raw) =>
          parseDetailResponse(raw, {
            words: ctx.words,
            videoDuration: ctx.duration,
            projectId: ctx.projectId,
            blocks: blocks,
          }),
      },
    )
    // Compté ici, sur la réponse, et non sur `clips.length` plus haut : une
    // réponse vide reste une réponse.
    slate.succeeded += 1
    return clips
  } catch (error) {
    if (!(error instanceof GeminiBlockedError)) throw error
    // Une fenêtre seule et toujours refusée : il n'y a plus rien à recouper, et
    // c'est bien elle que le filtre vise. La fenêtre est l'unité minimale du
    // repérage — la couper plus fin sortirait du contrat de `buildWindows`.
    if (batch.length === 1) {
      slate.rejected.push(batch[0].id)
      return []
    }
    const middle = Math.ceil(batch.length / 2)
    // Le partage se fait par soustraction, jamais par deux arrondis : la somme
    // rend alors exactement ce que le parent avait, au relèvement à un près
    // documenté ci-dessus.
    const share = (total: number): [number, number] => {
      const toLeft = Math.round((total * middle) / batch.length)
      return [toLeft, total - toLeft]
    }
    const [maxG, maxD] = share(max)
    const [minG, minD] = share(min)
    const left = await descend(
      batch.slice(0, middle),
      { min: minG, max: maxG },
      ctx,
      slate,
    )
    const right = await descend(batch.slice(middle), { min: minD, max: maxD }, ctx, slate)
    return [...left, ...right]
  }
}

/** Retire le marqueur avant de toucher à la base. */
function eraseArtifact(projectId: string): void {
  fs.rmSync(candidatesPath(projectId), { force: true })
}

/**
 * `candidates.json` : l'artefact dont la présence fait sauter l'étape
 * (`planSteps`). La base fait autorité sur le contenu ; ce fichier est ce que le
 * graphe regarde, et il se relit à l'œil quand quelque chose cloche.
 *
 * **Écrit à côté puis renommé.** Un `writeFileSync` interrompu laisse un fichier
 * tronqué, que le graphe compte pourtant comme une étape faite ; le renommage
 * est atomique sur le même système de fichiers, donc le marqueur n'existe qu'une
 * fois complet. (relevé par Copilot)
 */
function writeArtifact(projectId: string, clips: Clip[]): void {
  const file = candidatesPath(projectId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const provisional = `${file}.${process.pid}.tmp`
  fs.writeFileSync(provisional, `${JSON.stringify(clips, null, 2)}\n`, 'utf8')
  fs.renameSync(provisional, file)
}

// ---------------------------------------------------------------------------
// The "+N clips" sweep pass (`POST /api/projects/:id/candidates/more`).
// ---------------------------------------------------------------------------

export type MoreClipsOptions = {
  db?: Database.Database
  call?: CallGemini
  sleep?: (ms: number) => Promise<void>
  /** Called after each round, so `status.json` can show live progress. */
  onSummary?: (report: MoreClipsReport) => void
  signal?: AbortSignal
}

/** What `sweepDescend` reports in addition to the clips it found. */
type SweepSlate = { rejected: number; succeeded: number }

/** What the sweep pass needs at every depth of its own `descend`. */
type ContextSweep = {
  projectId: string
  transcript: TranscriptLu
  words: Word[]
  duration: number
  call: CallGemini
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
}

/**
 * The sweep pass's own `descend`: on a content-filter refusal, split the
 * segment slice in two and recurse, exactly as the windowed detail pass
 * does over its window list — same worst case, same reason a budget would
 * either sit unreachable or be arbitrary (see `descend`'s own doc).
 */
async function sweepDescend(
  segments: readonly TxSegment[],
  target: { min: number; max: number },
  ctx: ContextSweep,
  taken: readonly Segment[],
  slate: SweepSlate,
): Promise<DetailClip[]> {
  if (segments.length === 0) return []
  const max = Math.max(1, target.max)
  const min = Math.min(Math.max(1, target.min), max)

  try {
    const clips = await callWithRetry(
      ctx.call,
      sweepPrompt({
        language: ctx.transcript.language,
        videoDuration: ctx.duration,
        transcriptText: wholeTranscriptWithAnchors(segments, taken),
        minClips: min,
        maxClips: max,
      }),
      'sweep',
      {
        sleep: ctx.sleep,
        signal: ctx.signal,
        label: 'la recherche de clips supplémentaires',
        analyze: (raw) =>
          parseSweepResponse(raw, {
            words: ctx.words,
            videoDuration: ctx.duration,
            projectId: ctx.projectId,
            segments,
          }),
      },
    )
    slate.succeeded += 1
    return clips
  } catch (error) {
    if (!(error instanceof GeminiBlockedError)) throw error
    if (segments.length === 1) {
      slate.rejected += 1
      return []
    }
    const middle = Math.ceil(segments.length / 2)
    const share = (total: number): [number, number] => {
      const toLeft = Math.round((total * middle) / segments.length)
      return [toLeft, total - toLeft]
    }
    const [maxL, maxR] = share(max)
    const [minL, minR] = share(min)
    const left = await sweepDescend(segments.slice(0, middle), { min: minL, max: maxL }, ctx, taken, slate)
    const right = await sweepDescend(segments.slice(middle), { min: minR, max: maxR }, ctx, taken, slate)
    return [...left, ...right]
  }
}

/**
 * The "+N clips" pass: the whole transcript in one call, with already-taken
 * stretches marked `[PRIS]`, instead of re-running the windowed pass — see
 * `docs/lessons.md`. Up to `RECOVERY_MAX` rounds, each asking only for what
 * is still missing and marking what it just found as taken too.
 *
 * Returning fewer than `count` is a correct outcome, reported rather than
 * thrown; only a round with no response at all is fatal, and only when the
 * whole pass never got one — see `sweepDescend`.
 */
export async function runMoreClips(
  projectId: string,
  count: 5 | 10,
  options: MoreClipsOptions = {},
): Promise<Clip[]> {
  moreClipsReports.delete(projectId)

  const db = options.db ?? getDb()
  const call = options.call ?? clientByDefault(db, options.signal)
  const sleep = options.sleep ?? wait

  const project = getProject(db, projectId)
  if (!project) throw new Error(`Projet inconnu : ${projectId}`)
  if (project.durationSec === null) {
    throw new Error(
      `Le projet ${projectId} n'a pas de durée : l'ingestion (ffprobe) doit passer avant le repérage.`,
    )
  }
  const duration = project.durationSec

  const placement = placeSidecar(project.sourcePath, projectId)
  const transcript = lireTranscript(placement.transcript)
  const words: Word[] = transcript.segments.flatMap((s) => s.words)
  const segments = usableSegments(transcript)
  const ctx: ContextSweep = { projectId, transcript, words, duration, call, sleep, signal: options.signal }

  const slate: SweepSlate = { rejected: 0, succeeded: 0 }
  const accepted: DetailClip[] = []
  let exhausted = false

  for (let round = 1; round <= RECOVERY_MAX; round += 1) {
    const deficit = count - accepted.length
    if (deficit <= 0) break

    // Read after every network call this pass has made, never before:
    // `PATCH /api/clips/:id` stays open while this step runs, so a decision
    // made mid-round must be visible to the round that follows it.
    const humans = getClips(db, projectId).filter((c) => c.status !== 'candidate')
    const taken: Clip[] = [...humans, ...accepted.map((a) => a.clip)]
    const takenSegments = taken.flatMap((c) => c.segments)

    const proposals = await sweepDescend(segments, { min: deficit, max: deficit + 2 }, ctx, takenSegments, slate)
    const keptThisRound = proposals.filter((p) =>
      taken.every((tc) => overlapSeconds(p.clip.segments, tc.segments) <= OVERLAP_TOLERANCE_SECONDS),
    )
    if (keptThisRound.length === 0) {
      exhausted = true
      break
    }
    // Dedupe against what earlier rounds already accepted before the deficit
    // is recomputed: a repeated id would otherwise inflate `accepted.length`
    // and stop recovery short of `count`.
    const seenIds = new Set(accepted.map((a) => a.clip.id))
    for (const proposal of keptThisRound) {
      if (seenIds.has(proposal.clip.id)) continue
      seenIds.add(proposal.clip.id)
      accepted.push(proposal)
    }

    const progress: MoreClipsReport = { requested: count, added: Math.min(accepted.length, count), exhausted: false }
    moreClipsReports.set(projectId, progress)
    options.onSummary?.(progress)
  }

  // Nothing answered, descent included: only there is it the material, not
  // the ask — same reasoning as `detail`'s own verdict.
  if (slate.succeeded === 0 && slate.rejected > 0) {
    throw new GeminiBlockedError(
      `Le fournisseur a refusé la recherche de clips supplémentaires pour cette vidéo, jusqu'au segment ` +
        `seul (${slate.rejected} segment(s)). Les règles d'usage du fournisseur refusent ce matériel.`,
    )
  }

  // `accepted` is already unique by id — each round dedupes against it before
  // pushing. Rank still runs unconditionally, ahead of the cut, since this
  // caller's `.slice(0, count)` makes it the thing that decides survivors.
  const capped = rankProposals(accepted).slice(0, count)

  const report: MoreClipsReport = { requested: count, added: capped.length, exhausted }
  moreClipsReports.set(projectId, report)
  options.onSummary?.(report)

  const existing = getClips(db, projectId)
  const past = 1 + existing.reduce((top, c) => Math.max(top, c.pass), 0)
  const clips = mergeCandidates(existing, capped, past)
  eraseArtifact(projectId)
  replaceClips(db, projectId, clips)
  writeArtifact(projectId, clips)
  console.log(
    `+${count} clips ${projectId} : ${report.added} proposition(s) acceptée(s), exhausted=${report.exhausted}.`,
  )
  return clips
}
