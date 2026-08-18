import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  GoogleGenAI,
  Type,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Schema,
} from '@google/genai'
import { z } from 'zod'
import { mergeCandidates } from '@/core/candidates'
import type { Clip } from '@/core/edl'
import {
  parseDetailResponse,
  parseJsonResponse,
  parseScoreResponse,
  shortlistFromScores,
  type ScoredWindow,
} from '@/core/gemini/parse'
import {
  detailPrompt,
  detailWindowsJson,
  scorePrompt,
  scoreWindowsJson,
} from '@/core/gemini/prompts'
import {
  buildWindows,
  clipCountTargets,
  mergeOverlappingWindows,
  type Transcript,
  type Word,
} from '@/core/transcript'
import { getClips, getDb, getProject, replaceClips } from '@/server/db'
import { candidatesPath, placeSidecar } from '@/server/paths'

/**
 * L'étape `candidates` : deux passes Gemini sur le transcript, et le lot de
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
 */

/** `gemini-3.1-flash-lite`, surchargeable par `GEMINI_MODEL`. */
const MODÈLE_PAR_DÉFAUT = 'gemini-3.1-flash-lite'

/**
 * La taille des lots de notation, surchargeable par `SCORE_BATCH`.
 *
 * Un lot trop grand dilue l'attention du modèle sur 8 × 90 secondes de prose ;
 * un lot trop petit multiplie les appels et, surtout, multiplie les échelles :
 * chaque lot est noté dans un appel séparé, et c'est le barème ancré du prompt
 * qui les rend comparables.
 */
const LOT_NOTATION_PAR_DÉFAUT = 8

/**
 * Trois tentatives, et l'attente double à chaque échec : 5 s puis 10 s.
 *
 * L'échelle est celle d'openshorts (`5 * 2^(n-1)`), qui monterait à 20 s à une
 * quatrième tentative — elle n'y va pas, et c'est délibéré : au-delà de trois
 * essais, un service qui ne répond pas ne répondra pas dans la minute, et
 * l'appelant a une chaîne de quarante minutes derrière lui à ne pas bloquer.
 */
const TENTATIVES = 3

/**
 * Le délai au-delà duquel un appel est abandonné, en millisecondes.
 *
 * Deux minutes est large : mesuré sur une émission de 109 minutes, les quinze
 * appels du repérage complet ont tenu en 35 secondes à eux tous. La valeur ne
 * sert donc pas à serrer la performance, seulement à garantir qu'un appel
 * rendra la main.
 */
const DÉLAI_APPEL_MS = 120_000

/**
 * Le filtre de contenu a refusé. **Ne jamais réessayer** : le refus est
 * déterministe, la même charge est rejetée à chaque fois (vérifié en production
 * chez openshorts le 23 juillet 2026 — une vidéo de stand-up revenait
 * `PROHIBITED_CONTENT` en 300 ms à tous les essais), et des réglages de sécurité
 * permissifs ne le lèvent pas. Relancer ne fait que brûler du quota et du temps,
 * et cache à l'utilisateur la vraie raison.
 */
export class GeminiBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeminiBlockedError'
  }
}

/**
 * Les fins de génération qui **ne sont pas** un refus. Tout le reste en est un.
 *
 * **Énoncé à l'envers, et c'est la leçon de la liste de modules natifs
 * d'`eslint.config.mjs` : une liste noire tenue à la main est fausse le jour où
 * on l'écrit.** La version précédente énumérait six raisons de refus reprises
 * d'openshorts et manquait déjà `MODEL_ARMOR`, `IMAGE_PROHIBITED_CONTENT` et
 * `IMAGE_RECITATION` — et il en manquerait d'autres à la prochaine version de
 * l'API. Une raison de refus non reconnue est le pire des cas : la réponse passe
 * pour normale, son corps vide est classé passager, la charge est relancée trois
 * fois pour quinze secondes d'attente, et l'erreur finale ment sur la cause.
 * (relevé par Aristarque)
 *
 * `STOP` est la fin normale. Les trois raisons d'outillage ne peuvent pas se
 * produire — cette étape ne déclare aucun outil — mais si elles arrivaient, ce
 * serait un défaut de notre côté et non un refus de contenu, donc elles ne
 * doivent pas porter un message qui accuse la vidéo. L'absence de raison est
 * normale aussi : tous les modèles ne la renseignent pas.
 *
 * **`MAX_TOKENS` n'est pas ici** : voir `leverSiBloquée`.
 */
const FINS_SANS_REFUS = new Set([
  '',
  'FINISH_REASON_UNSPECIFIED',
  'STOP',
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
])

/**
 * Les fins qui sont un refus de contenu **nommé**, et qui méritent donc de le
 * dire à l'utilisateur.
 *
 * Cette liste-ci peut vieillir sans conséquence, et c'est ce qui la distingue de
 * celle qu'elle a remplacée : **elle ne décide pas du comportement, seulement du
 * message**. Une fin anormale absente d'ici échoue quand même, tout aussi vite,
 * avec un texte qui dit simplement que la génération s'est arrêtée. `OTHER` est
 * précisément ce cas : c'est une catégorie fourre-tout, pas un signal de
 * politique, et annoncer « le fournisseur refuse ce matériel » y serait faux.
 * (relevé par Copilot)
 */
const REFUS_DE_CONTENU = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
  'MODEL_ARMOR',
])

/**
 * Ce qui vaut la peine d'être réessayé : les pannes et les surcharges du
 * service, les coupures réseau, et les corps de réponse inexploitables.
 *
 * Les quatre derniers marqueurs viennent de l'analyse et ne sont pas
 * cosmétiques : Gemini rend régulièrement un 200 au corps vide, et la même
 * charge passe à l'essai suivant (openshorts, production du 22 juillet 2026 —
 * la relance a récupéré toutes les occurrences observées).
 *
 * `502`, `504` et `DEADLINE_EXCEEDED` manquaient : ce sont des passerelles et
 * des délais, aussi passagers que le `503`, et ils échouaient au premier essai
 * (relevé par Copilot). Les trois erreurs réseau brutes sont là parce que rien
 * ne garantit que le SDK les enveloppe dans un message portant un code
 * (relevé par Aristarque) — une coupure d'une seconde faisait sinon échouer un
 * lot de notation entier.
 *
 * La comparaison ignore la casse : `Deadline` et `DEADLINE_EXCEEDED` sont le
 * même incident écrit par deux couches différentes, et se souvenir de quelle
 * couche parle n'est pas un service à rendre au lecteur.
 */
const MARQUEURS_PASSAGERS = [
  '429',
  '500',
  '502',
  '503',
  '504',
  'unavailable',
  'resource_exhausted',
  'internal',
  'overloaded',
  'deadline',
  'econnreset',
  'etimedout',
  'fetch failed',
  'empty response body',
  'did not contain a json object',
  'did not contain a "shorts" array',
  'failed to parse gemini json response',
  'truncated (max_tokens)',
  'operation was aborted',
  'aborted due to timeout',
]

/**
 * Les erreurs qui ne se reconnaissent qu'à leur **nom**, parce que leur message
 * ne porte aucun code.
 *
 * `DÉLAI_APPEL_MS` s'applique par `AbortSignal.timeout` dans
 * `@google/genai@2.17.1`, et l'exception qui en sort dit « This operation was
 * aborted » — pas un chiffre, pas un mot-clé de service. Le délai qu'on venait
 * d'ajouter pour *entrer* dans la politique de relance en sortait donc au
 * premier essai, ce qui est exactement le contraire du but. Rien ici n'expose de
 * signal d'annulation à l'appelant, donc un abandon ne peut venir que du délai.
 * (relevé par Copilot)
 */
const NOMS_PASSAGERS = new Set(['AbortError', 'TimeoutError'])

/** Le mode d'appel : les deux passes n'ont ni le même schéma ni la même température. */
export type ModeGemini = 'score' | 'detail'

/**
 * Un appel au modèle. Injectable : c'est la seule couture entre cette étape et
 * le réseau, et c'est par elle que les tests passent des réponses figées.
 */
export type AppelGemini = (prompt: string, mode: ModeGemini) => Promise<GenerateContentResponse>

const SCHÉMA_NOTATION: Schema = {
  type: Type.OBJECT,
  properties: {
    windows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          start: { type: Type.NUMBER },
          end: { type: Type.NUMBER },
          score: { type: Type.INTEGER },
          reason: { type: Type.STRING },
        },
        required: ['id', 'start', 'end', 'score', 'reason'],
      },
    },
  },
  required: ['windows'],
}

const SCHÉMA_DÉTAIL: Schema = {
  type: Type.OBJECT,
  properties: {
    shorts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          start: { type: Type.NUMBER },
          end: { type: Type.NUMBER },
          source_window_id: { type: Type.STRING },
          predicted_score: { type: Type.INTEGER },
          video_description_for_tiktok: { type: Type.STRING },
          video_description_for_instagram: { type: Type.STRING },
          video_title_for_youtube_short: { type: Type.STRING },
          viral_hook_text: { type: Type.STRING },
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
        ],
      },
    },
  },
  required: ['shorts'],
}

/**
 * La configuration d'un appel.
 *
 * **La notation est précise, le détail est créatif.** 0,2 pour noter — la tâche
 * est un jugement calibré, et la variabilité y est du bruit. 0,9 pour détailler —
 * l'étape écrit des accroches et des descriptions, et les horodatages qu'elle
 * rend sont de toute façon validés puis calés sur les mots juste après.
 */
function configuration(mode: ModeGemini): GenerateContentConfig {
  return {
    responseMimeType: 'application/json',
    responseSchema: mode === 'detail' ? SCHÉMA_DÉTAIL : SCHÉMA_NOTATION,
    temperature: mode === 'detail' ? 0.9 : 0.2,
    candidateCount: 1,
  }
}

/**
 * Lève quand l'API n'a pas rendu une réponse complète — refus de contenu, ou
 * troncature.
 *
 * Les deux se distinguent, et pas seulement dans le message. **Un refus est
 * définitif et n'est jamais réessayé ; une troncature est un accident et se
 * réessaie.** `MAX_TOKENS` passait ici pour une fin normale : une sortie
 * structurée coupée en plein tableau ne parse en général pas, donc elle
 * retombait sur la relance par hasard — mais si le JSON se refermait quand
 * même, un lot partiel était accepté et `replaceClips` remplaçait la passe
 * précédente par ce fragment, sans un mot. (relevé par Copilot)
 */
export function leverSiBloquée(réponse: GenerateContentResponse): void {
  const raison = réponse.promptFeedback?.blockReason
  if (raison) {
    throw new GeminiBlockedError(
      `Gemini a bloqué le contenu de cette vidéo (${String(raison)}). Les règles d'usage du fournisseur refusent ce matériel : il ne peut pas être analysé.`,
    )
  }
  for (const candidat of réponse.candidates ?? []) {
    const fin = String(candidat.finishReason ?? '').toUpperCase()
    if (fin === 'MAX_TOKENS') {
      // Une erreur ordinaire, pas un `GeminiBlockedError` : le message est dans
      // les marqueurs passagers, donc l'appel repart.
      throw new Error('Gemini response was truncated (MAX_TOKENS): the answer is incomplete.')
    }
    if (FINS_SANS_REFUS.has(fin)) continue
    if (REFUS_DE_CONTENU.has(fin)) {
      throw new GeminiBlockedError(
        `Gemini a bloqué sa réponse pour cette vidéo (${fin}). Les règles d'usage du fournisseur refusent ce matériel : il ne peut pas être analysé.`,
      )
    }
    // Anormale mais pas nommée. Elle échoue tout de suite — le message n'est pas
    // dans les marqueurs passagers — sans se faire passer pour un refus de
    // contenu, qui accuserait la vidéo à tort. (relevé par Copilot)
    throw new Error(
      `Gemini a interrompu sa génération (${fin}) : ce n'est pas une fin normale et rien ne dit qu'un nouvel essai ferait mieux.`,
    )
  }
}

export function estPassagère(erreur: unknown): boolean {
  if (erreur instanceof Error && NOMS_PASSAGERS.has(erreur.name)) return true
  const bas = (erreur instanceof Error ? erreur.message : String(erreur)).toLowerCase()
  return MARQUEURS_PASSAGERS.some((marqueur) => bas.includes(marqueur))
}

/**
 * Retire une clé d'API d'un message avant de le journaliser.
 *
 * Vérifié sur `@google/genai@2.17.1` : `generateContent` passe la clé dans
 * l'en-tête `x-goog-api-key`, jamais dans l'URL — le seul `?key=` du paquet sert
 * au WebSocket de génération musicale, que rien ici n'appelle. Le caviardage est
 * donc une ceinture par-dessus des bretelles, et il coûte une ligne : ce dépôt
 * est public, ses journaux se recopient dans des rapports, et la version du SDK
 * bougera. (relevé par Aristarque)
 */
export function caviarder(message: string): string {
  return message.replace(/([?&](?:key|api_?key)=)[^&\s"']+/gi, '$1[caviardé]')
}

const attendre = (ms: number): Promise<void> =>
  new Promise((résoudre) => {
    setTimeout(résoudre, ms)
  })

/**
 * Un appel, avec sa politique de relance et son analyse.
 *
 * **Toute l'analyse vit DANS la boucle de relance, délibérément.** Un 200 au
 * corps vide lève ici et non à l'appel, et c'est exactement le cas qu'il faut
 * réessayer. C'est aussi pourquoi `analyser` est un paramètre plutôt qu'un geste
 * de l'appelant : la passe de détail refuse une enveloppe sans tableau `shorts`,
 * et cette réponse cassée doit être réessayée — analysée après coup, elle
 * ressortirait en « zéro clip », c'est-à-dire en passe réussie qui efface les
 * propositions non traitées. (relevé par Copilot)
 */
export async function appelerGemini<T = unknown>(
  appel: AppelGemini,
  prompt: string,
  mode: ModeGemini,
  options: {
    sleep?: (ms: number) => Promise<void>
    analyser?: (brut: unknown) => T
  } = {},
): Promise<T> {
  const sleep = options.sleep ?? attendre
  const analyser = options.analyser ?? ((brut: unknown) => brut as T)
  for (let tentative = 1; ; tentative += 1) {
    try {
      const réponse = await appel(prompt, mode)
      leverSiBloquée(réponse)
      return analyser(parseJsonResponse(réponse.text ?? ''))
    } catch (erreur) {
      // Un refus de contenu ne se réessaie jamais : voir `GeminiBlockedError`.
      if (erreur instanceof GeminiBlockedError) throw erreur
      const message = erreur instanceof Error ? erreur.message : String(erreur)
      if (tentative >= TENTATIVES || !estPassagère(erreur)) throw erreur
      const attente = 5000 * 2 ** (tentative - 1)
      console.warn(
        `Gemini, erreur passagère (essai ${tentative}/${TENTATIVES}), nouvelle tentative dans ${attente / 1000} s : ${caviarder(message).slice(0, 150)}`,
      )
      await sleep(attente)
    }
  }
}

/** Le client par défaut. Construit à l'appel : la clé se lit au moment de servir. */
function clientParDéfaut(): AppelGemini {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY n'est pas définie. Voir .env.example.")
  }
  const modèle = process.env.GEMINI_MODEL || MODÈLE_PAR_DÉFAUT
  // **Un délai fini, sans quoi la politique de relance ne borne rien.** Une
  // requête qui n'aboutit ni ne casse n'atteint jamais le `catch`, et immobilise
  // la chaîne entière — trois tentatives ne servent à rien si la première ne
  // rend jamais la main. (relevé par Copilot)
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: DÉLAI_APPEL_MS } })
  return (prompt, mode) =>
    ai.models.generateContent({ model: modèle, contents: prompt, config: configuration(mode) })
}

const SCHÉMA_MOT = z.object({ word: z.string(), start: z.number(), end: z.number() })

const SCHÉMA_TRANSCRIPT = z.object({
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
export function lireTranscript(fichier: string): TranscriptLu {
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
    const lu = SCHÉMA_TRANSCRIPT.safeParse(JSON.parse(fs.readFileSync(fichier, 'utf8')))
    if (lu.success) return depuisSchéma(lu.data)
    cause = lu.error.message
  } catch (erreur) {
    // Le NOM de l'erreur, pas son message : un `ENOENT` de `readFileSync` écrit
    // le chemin absolu dans son message, et c'est précisément ce qui ne doit pas
    // sortir d'ici.
    cause = erreur instanceof Error ? erreur.name : 'erreur inconnue'
  }
  console.error(`Transcript illisible : ${fichier}`)
  throw new Error(`Transcript illisible dans le sidecar : ${cause}`)
}

function depuisSchéma(données: z.infer<typeof SCHÉMA_TRANSCRIPT>): TranscriptLu {
  return {
    language: données.language ?? 'unknown',
    segments: données.segments.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
      words: (s.words ?? []).flatMap((m): Word[] => {
        const mot = SCHÉMA_MOT.safeParse(m)
        return mot.success ? [mot.data] : []
      }),
    })),
  }
}

export type RepérageOptions = {
  db?: Database.Database
  /** La couture réseau. Les tests en passent une qui rend des réponses figées. */
  appel?: AppelGemini
  sleep?: (ms: number) => Promise<void>
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
  options: RepérageOptions = {},
): Promise<Clip[]> {
  const db = options.db ?? getDb()
  const appel = options.appel ?? clientParDéfaut()
  const sleep = options.sleep ?? attendre

  const projet = getProject(db, projectId)
  if (!projet) throw new Error(`Projet inconnu : ${projectId}`)
  if (projet.durationSec === null) {
    throw new Error(
      `Le projet ${projectId} n'a pas de durée : l'ingestion (ffprobe) doit passer avant le repérage.`,
    )
  }
  const durée = projet.durationSec

  const placement = placeSidecar(projet.sourcePath, projectId)
  const transcript = lireTranscript(placement.transcript)
  const mots: Word[] = transcript.segments.flatMap((s) => s.words)

  // 1. Le fenêtrage : 90 secondes, chevauchées de 30, calées sur les phrases.
  const fenêtres = buildWindows(transcript, durée)
  console.log(`Repérage ${projectId} : ${fenêtres.length} fenêtre(s) à noter.`)

  // 2. La notation, par lots. Chaque lot est réconcilié contre LUI-MÊME : une
  //    fenêtre omise doit finir dernière, pas dehors.
  const taille = tailleDeLot()
  const notées: ScoredWindow[] = []
  const nonNotées: string[] = []
  for (let i = 0; i < fenêtres.length; i += taille) {
    const lot = fenêtres.slice(i, i + taille)
    const réponse = await appelerGemini(
      appel,
      scorePrompt({
        language: transcript.language,
        videoDuration: durée,
        windowsJson: scoreWindowsJson(lot),
      }),
      'score',
      { sleep },
    )
    const { scored, missing } = parseScoreResponse(réponse, lot)
    notées.push(...scored)
    nonNotées.push(...missing)
  }
  if (nonNotées.length > 0) {
    console.warn(`${nonNotées.length} fenêtre(s) sont revenues sans note ; classées dernières.`)
  }

  // 3. La présélection, puis la fusion — et les cibles AVANT la fusion.
  const retenues = shortlistFromScores(notées, fenêtres)
  const [minClips, maxClips] = clipCountTargets(retenues.length)
  const blocs = mergeOverlappingWindows(retenues, transcript)
  console.log(`Présélection : ${retenues.length} fenêtre(s) → ${blocs.length} bloc(s) de détail.`)

  // 4. Le détail : un seul appel, sur la liste fusionnée et ancrée. Le calage
  //    sur les mots se fait DANS la relance, pour qu'une enveloppe cassée soit
  //    réessayée au lieu de ressortir en « zéro clip » — ce qui effacerait les
  //    propositions non traitées et écrirait l'artefact. (relevé par Copilot)
  const propositions = await appelerGemini(
    appel,
    detailPrompt({
      language: transcript.language,
      videoDuration: durée,
      windowsJson: detailWindowsJson(blocs, transcript),
      minClips,
      maxClips,
    }),
    'detail',
    {
      sleep,
      analyser: (brut) =>
        parseDetailResponse(brut, {
          words: mots,
          videoDuration: durée,
          projectId,
          blocks: blocs,
        }),
    },
  )

  // 5. La fusion des passes, puis l'écriture.
  const existants = getClips(db, projectId)
  // `reduce` et non `Math.max(...tableau)` : la liste fait la taille du projet
  // entier, et l'étalement finirait par dépasser la pile. (relevé par Aristarque)
  const passe = 1 + existants.reduce((haut, c) => Math.max(haut, c.pass), 0)
  const clips = mergeCandidates(existants, propositions, passe)
  // **Le marqueur tombe avant la mutation et ne réapparaît qu'après.** Le graphe
  // ne regarde que la présence du fichier : laisser l'ancien en place pendant
  // qu'on change la base ferait passer une exécution interrompue pour terminée,
  // avec un artefact qui décrit l'état d'avant. (relevé par Copilot)
  effacerArtefact(projectId)
  replaceClips(db, projectId, clips)
  écrireArtefact(projectId, clips)
  console.log(`Passe ${passe} : ${propositions.length} proposition(s), ${clips.length} clip(s).`)
  return clips
}

/** `SCORE_BATCH`, jamais moins de 1 : une valeur illisible ne fait pas échouer le travail. */
function tailleDeLot(): number {
  const brut = Number.parseInt(process.env.SCORE_BATCH ?? '', 10)
  return Number.isFinite(brut) && brut >= 1 ? brut : LOT_NOTATION_PAR_DÉFAUT
}

/** Retire le marqueur avant de toucher à la base. */
function effacerArtefact(projectId: string): void {
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
function écrireArtefact(projectId: string, clips: Clip[]): void {
  const fichier = candidatesPath(projectId)
  fs.mkdirSync(path.dirname(fichier), { recursive: true })
  const provisoire = `${fichier}.${process.pid}.tmp`
  fs.writeFileSync(provisoire, `${JSON.stringify(clips, null, 2)}\n`, 'utf8')
  fs.renameSync(provisoire, fichier)
}
