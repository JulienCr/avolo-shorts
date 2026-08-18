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
import { caviarderClés } from '@/core/erreurs'
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
  type Window,
  type Word,
} from '@/core/transcript'
import { getClips, getDb, getProject, replaceClips } from '@/server/db'
import { candidatesPath, placeSidecar } from '@/server/paths'
import { exigerSecret } from '@/server/secrets'

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
 * appels et en doublant les barèmes. Ce qui le règle est `récupérer`, qui ne
 * recoupe que ce qui a été refusé.
 */
const LOT_NOTATION_PAR_DÉFAUT = 8

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
 * fréquence des attentes de `délaiDeQuota`, pas leur utilité.
 */
const RÉCUPÉRATION_MAX = 3

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
 * Le filtre de contenu a refusé. **Ne jamais réessayer la même charge** : le
 * refus est déterministe, la même charge est rejetée à chaque fois (vérifié en
 * production chez openshorts le 23 juillet 2026 — une vidéo de stand-up revenait
 * `PROHIBITED_CONTENT` en 300 ms à tous les essais). Relancer à l'identique ne
 * fait que brûler du quota et du temps, et cache à l'utilisateur la vraie
 * raison.
 *
 * **Deux choses ont été mesurées le 18 août 2026 sur `2025-06-15-cqlp`, et elles
 * séparent ce qui est inutile de ce qui marche.**
 *
 * Inutile : poser `safetySettings` à `OFF` sur les quatre catégories
 * configurables (`HARASSMENT`, `HATE_SPEECH`, `SEXUALLY_EXPLICIT`,
 * `DANGEROUS_CONTENT`). Les quatre lots refusés le sont restés, tous les quatre,
 * à l'identique. Le refus arrive en `promptFeedback.blockReason` avec
 * **`safetyRatings` absent** — ni sur le prompt, ni sur le candidat : ce n'est
 * pas une catégorie configurable qui a mordu, c'est le filtre non configurable
 * du fournisseur, celui que l'API ne laisse pas régler. Inutile de reposer la
 * question sous forme de réglage.
 *
 * Ce qui marche : **envoyer autre chose**. Les 32 fenêtres perdues dans ces
 * quatre lots passent toutes, une par une. Le refus porte sur la charge
 * assemblée, pas sur une fenêtre coupable — voir `récupérer`.
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
 * L'attente au-delà de laquelle on **renonce** au lieu d'attendre.
 *
 * Une minute et demie couvre la fenêtre glissante d'un quota par minute ;
 * au-delà, quelle que soit la limite qui parle — horaire, journalière, un
 * ralentissement plus long —, l'attendre immobiliserait la chaîne pour une durée
 * que cette étape n'a pas à décider seule.
 *
 * **C'est un seuil de renoncement, pas un raccourcissement.** La première
 * version plafonnait l'attente à cette valeur puis relançait quand même : un
 * `retryDelay` d'une heure devenait 90 secondes, la requête repartait très avant
 * la fin du quota, échouait, et le repérage brûlait ses trois essais et trois
 * minutes pour arriver au même endroit. Raccourcir une attente qu'on sait
 * insuffisante ne rend service à personne. (relevé par Copilot)
 */
const ATTENTE_QUOTA_MAX_MS = 90_000

/**
 * Le délai que Google demande dans un 429, en millisecondes, ou `null`.
 *
 * **Sans lui, la relance exponentielle est trop courte pour servir à quelque
 * chose sur un dépassement de quota.** Le palier gratuit de
 * `gemini-3.1-flash-lite` plafonne à 15 requêtes par minute, et le corps du 429
 * dit exactement combien attendre — `"retryDelay":"54s"` là où les trois
 * tentatives n'attendent que 5 s puis 10 s. Le repérage échouait donc pour de
 * bon sur une limite qui se lève toute seule en moins d'une minute, et la
 * récupération des lots refusés triple précisément le nombre d'appels.
 *
 * Le motif est cherché dans le message brut parce que c'est tout ce que le SDK
 * laisse : `@google/genai` recopie le corps JSON de la réponse dans le message
 * de l'exception, sans exposer `RetryInfo` autrement.
 */
export function délaiDeQuota(message: string): number | null {
  const trouvé = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message)
  if (trouvé === null) return null
  // `ceil` et non `round` : la seule erreur qui coûte quelque chose ici est
  // d'attendre **moins** que demandé, ce qui rejoue la requête dans la fenêtre
  // encore fermée et brûle un essai sur trois. Arrondir au-dessus ne peut donc
  // que faire attendre une milliseconde de trop, y compris si la conversion en
  // flottant dépassait l'entier d'un cheveu. (relevé par Aristarque)
  //
  // **Rendu tel quel, sans plafond.** Ce que le fournisseur demande est un fait ;
  // ce qu'on accepte d'attendre est une décision, et elle se prend dans
  // `appelerGemini` avec `ATTENTE_QUOTA_MAX_MS`. Les mêler ici faisait rendre un
  // délai raccourci qu'on relançait ensuite comme s'il suffisait.
  return Math.ceil(Number(trouvé[1]) * 1000)
}

/**
 * Retire une clé d'API d'un message avant de le journaliser.
 *
 * **Le motif vit dans `@/core/erreurs`** depuis qu'il sert aussi à la frontière
 * HTTP : le message d'une erreur de repérage traverse `status.json` puis le
 * champ `error` de `GET /api/projects/:id`, et ne passait par aucun caviardage
 * sur ce chemin-là. Deux copies du même motif auraient vieilli séparément.
 * (relevé par Aristarque)
 */
export const caviarder = caviarderClés

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
      // Un quota qui ne se libère pas dans le délai qu'on s'autorise n'est plus
      // une pointe passagère : on rend la main tout de suite plutôt que de
      // relancer avant l'heure et de brûler les essais restants.
      const quota = délaiDeQuota(message)
      if (quota !== null && quota > ATTENTE_QUOTA_MAX_MS) {
        // Le message dit ce qu'on sait — le délai demandé — et ce qu'on décide —
        // ne pas l'attendre. **Il ne diagnostique pas la limite** : `retryDelay`
        // donne un délai minimal recommandé, dont on ne peut pas déduire s'il
        // s'agit d'un quota journalier, horaire ou d'un autre ralentissement. En
        // nommer un serait affirmer ce qu'on n'a pas établi, exactement comme le
        // faisait le verdict de `noterLesFenêtres` avant sa correction.
        // (relevé par Copilot)
        throw new Error(
          `Gemini refuse la requête pour dépassement de quota et demande d'attendre ${Math.round(quota / 1000)} s, ` +
            `soit plus que les ${ATTENTE_QUOTA_MAX_MS / 1000} s que cette étape accepte d'attendre. ` +
            `Le repérage s'arrête plutôt que de relancer avant le délai demandé.`,
        )
      }
      // Le délai demandé l'emporte quand il est plus long : sur un quota par
      // minute, l'escalier de 5 s puis 10 s repart toujours trop tôt.
      const attente = Math.max(5000 * 2 ** (tentative - 1), quota ?? 0)
      console.warn(
        `Gemini, erreur passagère (essai ${tentative}/${TENTATIVES}), nouvelle tentative dans ${attente / 1000} s : ${caviarder(message).slice(0, 150)}`,
      )
      await sleep(attente)
    }
  }
}

/** Le client par défaut. Construit à l'appel : la clé se lit au moment de servir. */
function clientParDéfaut(): AppelGemini {
  // `exigerSecret` et non `process.env` : il refuse aussi une variable restée à
  // l'état d'adresse `op://…`, que le SDK enverrait comme clé pour se faire
  // répondre 401. Voir `@/server/secrets`.
  const apiKey = exigerSecret('GEMINI_API_KEY')
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
 * Ce qu'une passe de notation a jugé, et surtout **ce qu'elle n'a pas jugé**.
 *
 * Une fenêtre non notée n'est pas une fenêtre mal notée : elle finit dernière au
 * classement, donc dehors dès que la présélection mord. C'était jusqu'ici la
 * seule perte de la chaîne dont absolument rien ne parlait — ni le journal, ni
 * `status.json`, ni l'interface —, et sur `2025-06-15-cqlp` elle valait un tiers
 * de l'émission.
 */
export type BilanNotation = {
  /**
   * Les fenêtres que la passe avait à noter — le total prévu, pas le nombre de
   * fenêtres effectivement soumises. La nuance porte l'invariant : une passe
   * interrompue en a soumis moins, et ce sont justement les non soumises que
   * `jamaisNotées` doit continuer de nommer. (relevé par Copilot)
   */
  fenêtres: number
  /** Celles qui portent une note du modèle. */
  notées: number
  /**
   * Celles qui n'en portent aucune : refusées par le filtre, omises par une
   * réponse, ou **pas encore soumises quand la passe s'est interrompue**.
   *
   * L'invariant tient à tout instant, y compris au milieu d'une passe et après
   * une panne : `notées + jamaisNotées.length === fenêtres`. Il ne tenait pas
   * quand la liste se remplissait au fil des refus — une erreur réseau sortait
   * de la boucle, et le bilan annonçait « 2 fenêtres sur 4 jugées » avec une
   * liste de perdues vide, c'est-à-dire un décompte de perte qui ne localisait
   * pas la perte. La liste part donc pleine et se vide de ce qui est noté.
   * (relevé par Copilot)
   */
  jamaisNotées: string[]
  /**
   * Celles que le filtre refuse **seules**, lot réduit à elles. Distinctes des
   * précédentes : là, le refus vise bien cette fenêtre-là et pas l'assemblage.
   */
  refusées: string[]
  /**
   * Les **requêtes** de notation, refus, relances et récupération comprises.
   *
   * Les requêtes et non les lots : `appelerGemini` réessaie jusqu'à trois fois
   * une erreur passagère, et c'est la requête qui consomme le quota — 15 par
   * minute sur le palier gratuit. Compter les lots sous-estimait exactement le
   * nombre dont on se sert pour raisonner sur ce plafond. (relevé par Copilot)
   */
  appels: number
  /** Les lots refusés, toutes profondeurs de découpe confondues. */
  lotsRefusés: number
  /** Les lots auxquels le modèle a répondu. */
  lotsRépondus: number
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
  couverture: number
}

/** Un intervalle de temps, en secondes. */
export type Étendue = { start: number; end: number }

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
export function partCouverte(intervalles: readonly Étendue[], étendue: Étendue): number {
  const total = étendue.end - étendue.start
  if (!(total > 0)) return 0

  const écrêtés = intervalles
    .map((i) => ({
      start: Math.max(i.start, étendue.start),
      end: Math.min(i.end, étendue.end),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)

  let couvert = 0
  let courant: Étendue | null = null
  for (const i of écrêtés) {
    if (courant === null || i.start > courant.end) {
      if (courant !== null) couvert += courant.end - courant.start
      courant = { ...i }
    } else if (i.end > courant.end) {
      courant.end = i.end
    }
  }
  if (courant !== null) couvert += courant.end - courant.start

  return Math.round((couvert / total) * 10_000) / 10_000
}

/**
 * L'étendue du transcript : du premier mot aligné au dernier.
 *
 * **Pas la durée de l'émission**, et c'est le dénominateur qui donne son sens à
 * la couverture : une émission qui commence par cinq minutes de silence n'a pas
 * cinq minutes de matière non jugée. Les mots arrivent en général ordonnés, mais
 * on ne le suppose pas — un transcript vient du disque.
 */
export function étendueDuTranscript(mots: readonly Word[]): Étendue {
  if (mots.length === 0) return { start: 0, end: 0 }
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const mot of mots) {
    if (mot.start < start) start = mot.start
    if (mot.end > end) end = mot.end
  }
  return end > start ? { start, end } : { start: 0, end: 0 }
}

/**
 * Le bilan de la dernière notation de chaque projet.
 *
 * **En mémoire, dans ce processus, comme la table `enCours` du lanceur.** Le
 * bilan décrit une exécution, pas un artefact : le relire après un redémarrage
 * de Next décrirait un travail que personne n'a fait dans ce processus.
 *
 * C'est la jonction prévue avec `status.json` : `src/server/run.ts` appartient à
 * une autre tâche, et il lui suffit d'appeler `dernierBilan(projectId)` au
 * moment d'écrire le statut pour que la perte remonte jusqu'à l'interface. Tant
 * que ce raccord n'est pas fait, elle est dans le journal, ce qui est déjà
 * infiniment plus que rien.
 */
const bilans = new Map<string, BilanNotation>()

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
 * porte `error` et `finishedAt`. Le raccord à venir dans `écrireStatut` doit
 * donc lire les deux, jamais ce bilan seul. (relevé par Aristarque)
 */
export function dernierBilan(projectId: string): BilanNotation | null {
  return bilans.get(projectId) ?? null
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
export function oublierBilan(projectId: string): void {
  bilans.delete(projectId)
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
  // **Le bilan de la passe précédente tombe à la toute première ligne**, avant
  // même la base et le client. Il n'est posé qu'une fois le transcript lu et les
  // fenêtres construites : une exécution qui échoue avant — clé d'API absente,
  // projet inconnu, durée manquante, transcript illisible — laissait sinon
  // `dernierBilan` répondre le décompte d'une passe antérieure, sans rien qui
  // permette de voir qu'il est périmé, et le raccord à venir dans `écrireStatut`
  // aurait recopié ce chiffre dans `status.json`.
  //
  // La première version de ce nettoyage était posée trois lignes plus bas, donc
  // *après* `clientParDéfaut()`, qui lève quand `GEMINI_API_KEY` manque : elle
  // ratait précisément l'échec le plus banal. Un nettoyage conditionné à ce que
  // rien n'ait échoué avant lui ne nettoie rien. (relevé par Copilot)
  bilans.delete(projectId)

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

  // 2. La notation, par lots, puis la récupération de ce que le filtre refuse.
  const { notées, bilan } = await noterLesFenêtres(fenêtres, {
    projectId,
    language: transcript.language,
    videoDuration: durée,
    étendue: étendueDuTranscript(mots),
    appel,
    sleep,
  })

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
  console.log(
    `Passe ${passe} : ${propositions.length} proposition(s), ${clips.length} clip(s)` +
      `, ${bilan.notées}/${bilan.fenêtres} fenêtre(s) jugée(s).`,
  )
  return clips
}

/** `SCORE_BATCH`, jamais moins de 1 : une valeur illisible ne fait pas échouer le travail. */
function tailleDeLot(): number {
  const brut = Number.parseInt(process.env.SCORE_BATCH ?? '', 10)
  return Number.isFinite(brut) && brut >= 1 ? brut : LOT_NOTATION_PAR_DÉFAUT
}

/**
 * L'état d'une notation en cours : ce qui est noté, ce qui ne l'est pas, et le
 * bilan qui les compte.
 *
 * `nonNotées` est la source de vérité et `bilan.jamaisNotées` en est le reflet
 * sérialisable, réécrit à chaque changement. Deux listes tenues séparément
 * finiraient par diverger, et c'est le décompte de perte qui mentirait.
 */
type Ardoise = {
  bilan: BilanNotation
  /** Les fenêtres sans note. Pleine au départ, elle se vide de ce qui est noté. */
  nonNotées: Set<string>
  /** Les notes rassemblées, réconciliation comprise. */
  notées: ScoredWindow[]
  /**
   * L'étendue de chaque fenêtre, par identifiant. `nonNotées` ne porte que des
   * identifiants ; la couverture, elle, se calcule sur des intervalles.
   */
  étendues: Map<string, Étendue>
  /** L'étendue du transcript, dénominateur de la couverture. */
  transcript: Étendue
}

/**
 * Ce qu'il reste à dépenser en récupération, **en requêtes réseau**.
 *
 * Mutable et partagé avec la couture qui appelle le modèle, parce que c'est le
 * seul endroit qui voie les requêtes réelles : `appelerGemini` en émet jusqu'à
 * trois pour un même sous-lot quand la première est passagère. Débité par
 * sous-lot, le plafond annoncé valait trois fois plus en 429 — c'est-à-dire
 * exactement dans la situation qu'il est censé borner. (relevé par Copilot et Codex)
 */
type Budget = { restant: number }

/** Ce dont la notation a besoin, et rien de plus. */
type ContexteNotation = {
  projectId: string
  language: string
  videoDuration: number
  /** L'étendue du transcript : le dénominateur de `couverture`. */
  étendue: Étendue
  appel: AppelGemini
  sleep: (ms: number) => Promise<void>
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
async function noterLesFenêtres(
  fenêtres: Window[],
  ctx: ContexteNotation,
): Promise<{ notées: ScoredWindow[]; bilan: BilanNotation }> {
  const taille = tailleDeLot()
  const lots: Window[][] = []
  for (let i = 0; i < fenêtres.length; i += taille) lots.push(fenêtres.slice(i, i + taille))

  // **La liste des non notées part pleine.** Toute fenêtre est non jugée tant
  // qu'une réponse ne la juge pas, y compris celles qu'une panne empêchera même
  // de soumettre : c'est ce qui rend le bilan honnête à l'instant où il est lu,
  // et pas seulement à la fin. (relevé par Copilot)
  const ardoise: Ardoise = {
    notées: [],
    nonNotées: new Set(fenêtres.map((f) => f.id)),
    étendues: new Map(fenêtres.map((f) => [f.id, { start: f.start, end: f.end }])),
    transcript: ctx.étendue,
    bilan: {
      fenêtres: fenêtres.length,
      notées: 0,
      jamaisNotées: fenêtres.map((f) => f.id),
      refusées: [],
      appels: 0,
      lotsRefusés: 0,
      lotsRépondus: 0,
      // Rien n'est noté avant le premier appel : la couverture part de zéro et
      // grandit avec les réponses, comme le reste du bilan.
      couverture: 0,
    },
  }
  const { bilan } = ardoise
  bilans.set(ctx.projectId, bilan)

  try {
    return await noterEtRécupérer(lots, ctx, ardoise)
  } finally {
    // **Dans un `finally`, et c'est tout l'intérêt.** Le bilan promis « au
    // journal à chaque passe » ne sortait que par le chemin heureux : un refus
    // total lève, une panne réseau se propage, et la perte redevenait
    // silencieuse exactement quand elle est la plus grande. Un décompte qui
    // n'apparaît que lorsque tout va bien ne sert à rien. (relevé par Copilot)
    journaliserBilan(bilan)
  }
}

/** Le corps de la notation, sorti pour que son appelant tienne le `finally`. */
async function noterEtRécupérer(
  lots: Window[][],
  ctx: ContexteNotation,
  ardoise: Ardoise,
): Promise<{ notées: ScoredWindow[]; bilan: BilanNotation }> {
  const { bilan, notées } = ardoise
  const refusés: Window[][] = []
  for (const lot of lots) {
    const lu = await noterUnLot(lot, ctx, ardoise)
    if (lu === null) refusés.push(lot)
    else ranger(lu, ardoise)
  }

  const budget = lots.length * RÉCUPÉRATION_MAX
  if (refusés.length > 0) {
    const enJeu = refusés.reduce((n, lot) => n + lot.length, 0)
    console.warn(
      `${refusés.length} lot(s) refusés par le filtre, ${enJeu} fenêtre(s) ; on les recoupe.`,
    )
    await récupérer(refusés, ctx, ardoise, budget)
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
  if (bilan.lotsRefusés > 0 && bilan.lotsRépondus === 0) {
    const jusquÀLaFenêtreSeule = bilan.refusées.length === bilan.fenêtres
    throw new GeminiBlockedError(
      jusquÀLaFenêtreSeule
        ? `Gemini a refusé les ${bilan.lotsRefusés} lot(s) de notation de cette vidéo, jusqu'à la fenêtre seule. Les règles d'usage du fournisseur refusent ce matériel : il ne peut pas être analysé.`
        : `Gemini a refusé les ${bilan.lotsRefusés} lot(s) de notation de cette vidéo, et le budget de récupération (${budget} appel(s)) s'est épuisé avant d'avoir pu soumettre chaque fenêtre seule : ${bilan.refusées.length} sur ${bilan.fenêtres} ${bilan.refusées.length > 1 ? "l'ont été" : "l'a été"}. Aucune fenêtre n'a donc été jugée, et rien ne dit encore si c'est le matériel ou la charge qui est refusé. Baisser SCORE_BATCH fait entrer moins de matière par appel dès le premier passage.`,
    )
  }

  return { notées, bilan }
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
function journaliserBilan(bilan: BilanNotation): void {
  console.log(
    `Notation : ${bilan.notées}/${bilan.fenêtres} fenêtre(s) jugée(s) en ${bilan.appels} requête(s).`,
  )
  if (bilan.jamaisNotées.length === 0) return
  console.warn(
    `${bilan.jamaisNotées.length} fenêtre(s) sur ${bilan.fenêtres} n'ont jamais été notées ; ` +
      `classées dernières : ${bilan.jamaisNotées.join(', ')}.` +
      (bilan.refusées.length > 0
        ? ` Dont ${bilan.refusées.length} refusée(s) seule(s) par le filtre : ${bilan.refusées.join(', ')}.`
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
async function noterUnLot(
  lot: Window[],
  ctx: ContexteNotation,
  { bilan }: Ardoise,
  budget?: Budget,
): Promise<{ scored: ScoredWindow[]; missing: string[] } | null> {
  // Compté **dans** la couture réseau, pas avant l'appel : `appelerGemini`
  // réessaie jusqu'à trois fois, et c'est chaque requête qui coûte du quota —
  // donc chaque requête, et non chaque sous-lot, qui débite le budget.
  const compter: AppelGemini = (prompt, mode) => {
    bilan.appels += 1
    if (budget !== undefined) budget.restant -= 1
    return ctx.appel(prompt, mode)
  }
  let brut: unknown
  try {
    brut = await appelerGemini(
      compter,
      scorePrompt({
        language: ctx.language,
        videoDuration: ctx.videoDuration,
        windowsJson: scoreWindowsJson(lot),
      }),
      'score',
      { sleep: ctx.sleep },
    )
  } catch (erreur) {
    if (!(erreur instanceof GeminiBlockedError)) throw erreur
    bilan.lotsRefusés += 1
    return null
  }
  bilan.lotsRépondus += 1
  return parseScoreResponse(brut, lot)
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
async function récupérer(
  refusés: Window[][],
  ctx: ContexteNotation,
  ardoise: Ardoise,
  plafond: number,
): Promise<void> {
  const file = [...refusés]
  const budget: Budget = { restant: plafond }
  while (file.length > 0) {
    const lot = file.shift()!
    // Une fenêtre seule et toujours refusée : il n'y a plus rien à recouper, et
    // c'est bien elle que le filtre vise. Le cas ne s'est pas produit sur
    // l'émission mesurée ; il reste possible sur une autre.
    if (lot.length === 1) {
      ardoise.bilan.refusées.push(lot[0].id)
      abandonner(lot, ardoise, 'fenêtre refusée par le filtre')
      continue
    }

    const milieu = Math.ceil(lot.length / 2)
    for (const moitié of [lot.slice(0, milieu), lot.slice(milieu)]) {
      // Le budget se lit avant chaque sous-lot et se débite dans la couture, à
      // chaque requête. Il peut donc finir légèrement négatif — les relances
      // d'un sous-lot déjà engagé ne s'interrompent pas au milieu —, d'au plus
      // `TENTATIVES - 1` requêtes. C'est borné et connu, là où un débit par
      // sous-lot laissait le dépassement croître avec le nombre de branches.
      if (budget.restant <= 0) {
        abandonner(moitié, ardoise, 'lot refusé, budget de récupération épuisé')
        continue
      }
      const lu = await noterUnLot(moitié, ctx, ardoise, budget)
      if (lu === null) file.push(moitié)
      else ranger(lu, ardoise)
    }
  }
}

/**
 * Un lot dont on ne tirera rien : dernier au classement, et compté comme tel.
 *
 * Il reste dans `nonNotées` — il n'en est jamais sorti — donc rien n'a à l'y
 * remettre. Ce qui s'ajoute ici est seulement l'entrée de classement qui le fait
 * finir dernier plutôt que dehors.
 */
function abandonner(lot: Window[], ardoise: Ardoise, raison: string): void {
  for (const fenêtre of lot) {
    ardoise.notées.push({ id: fenêtre.id, score: 0, reason: raison, notée: false })
  }
}

/** Range un lot lu, en séparant ce qui porte une note de ce qui n'en porte pas. */
function ranger(lu: { scored: ScoredWindow[]; missing: string[] }, ardoise: Ardoise): void {
  const { bilan, nonNotées } = ardoise
  ardoise.notées.push(...lu.scored)
  const omises = new Set(lu.missing)
  for (const note of lu.scored) {
    if (omises.has(note.id)) continue
    // `delete` rend faux sur une fenêtre déjà notée : le compte suit le retrait
    // effectif, jamais la longueur du lot, pour qu'un identifiant vu deux fois
    // ne compte pas deux jugements.
    if (nonNotées.delete(note.id)) bilan.notées += 1
  }
  bilan.jamaisNotées = [...nonNotées]
  // Recalculée **ici et nulle part ailleurs** : c'est le seul endroit où
  // `nonNotées` rétrécit, donc le seul où la couverture change. La déduire
  // ailleurs ferait une seconde autorité sur le même chiffre.
  bilan.couverture = partCouverte(
    [...ardoise.étendues].filter(([id]) => !nonNotées.has(id)).map(([, étendue]) => étendue),
    ardoise.transcript,
  )
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
