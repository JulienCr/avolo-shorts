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
 * `STOP` et `MAX_TOKENS` sont des fins normales. Les trois raisons d'outillage
 * ne peuvent pas se produire — cette étape ne déclare aucun outil — mais si
 * elles arrivaient, ce serait un défaut de notre côté et non un refus de
 * contenu, donc elles ne doivent pas porter un message qui accuse la vidéo.
 * L'absence de raison est normale aussi : tous les modèles ne la renseignent pas.
 */
const FINS_SANS_REFUS = new Set([
  '',
  'FINISH_REASON_UNSPECIFIED',
  'STOP',
  'MAX_TOKENS',
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
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
]

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

/** Lève quand l'API a refusé de répondre pour des raisons de contenu. */
export function leverSiBloquée(réponse: GenerateContentResponse): void {
  const raison = réponse.promptFeedback?.blockReason
  if (raison) {
    throw new GeminiBlockedError(
      `Gemini a bloqué le contenu de cette vidéo (${String(raison)}). Les règles d'usage du fournisseur refusent ce matériel : il ne peut pas être analysé.`,
    )
  }
  for (const candidat of réponse.candidates ?? []) {
    const fin = String(candidat.finishReason ?? '').toUpperCase()
    if (!FINS_SANS_REFUS.has(fin)) {
      throw new GeminiBlockedError(
        `Gemini a interrompu sa réponse pour cette vidéo (${fin}) : la génération s'est arrêtée sur autre chose qu'une fin normale. C'est déterministe, la relance ne servirait à rien.`,
      )
    }
  }
}

function estPassagère(message: string): boolean {
  const bas = message.toLowerCase()
  return MARQUEURS_PASSAGERS.some((marqueur) => bas.includes(marqueur))
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
      if (tentative >= TENTATIVES || !estPassagère(message)) throw erreur
      const attente = 5000 * 2 ** (tentative - 1)
      console.warn(
        `Gemini, erreur passagère (essai ${tentative}/${TENTATIVES}), nouvelle tentative dans ${attente / 1000} s : ${message.slice(0, 150)}`,
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
  const ai = new GoogleGenAI({ apiKey })
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
  const brut: unknown = JSON.parse(fs.readFileSync(fichier, 'utf8'))
  const lu = SCHÉMA_TRANSCRIPT.safeParse(brut)
  if (!lu.success) {
    // Le chemin va au journal, pas dans l'erreur. Il porte l'arborescence du
    // montage Google Drive, et cette erreur peut finir dans le corps d'une
    // réponse HTTP — `resolveSource` a posé la règle et la commente déjà.
    // (relevé par Aristarque)
    console.error(`Transcript illisible : ${fichier}`)
    throw new Error(`Transcript illisible dans le sidecar : ${lu.error.message}`)
  }
  return {
    language: lu.data.language ?? 'unknown',
    segments: lu.data.segments.map((s) => ({
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
  const passe = 1 + Math.max(0, ...existants.map((c) => c.pass))
  const clips = mergeCandidates(existants, propositions, passe)
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

/**
 * `candidates.json` : l'artefact dont la présence fait sauter l'étape
 * (`planSteps`). La base fait autorité sur le contenu ; ce fichier est ce que le
 * graphe regarde, et il se relit à l'œil quand quelque chose cloche.
 */
function écrireArtefact(projectId: string, clips: Clip[]): void {
  const fichier = candidatesPath(projectId)
  fs.mkdirSync(path.dirname(fichier), { recursive: true })
  fs.writeFileSync(fichier, `${JSON.stringify(clips, null, 2)}\n`, 'utf8')
}
