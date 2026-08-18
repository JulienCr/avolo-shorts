import { z } from 'zod'
import type { Clip } from '@/core/edl'
import { shortlistSize, snapToWords, type Window, type Word } from '@/core/transcript'

/**
 * Ce que Gemini rend, transformé en ce que le reste du projet manipule.
 *
 * Tout ce fichier part du principe que **la réponse est une entrée hostile**.
 * Le schéma structuré de l'API contraint la forme, il ne la garantit pas : une
 * fenêtre simplement omise, un identifiant inventé, une note à 130, un `start`
 * textuel — les quatre ont été vus en production. Chacun se traite sans jeter le
 * reste du lot, parce qu'une passe de repérage coûte une minute d'appel après
 * quarante minutes de pipeline.
 */

/** Une fenêtre notée, réconciliée : toute fenêtre soumise en a une. */
export type ScoredWindow = {
  id: string
  /** Entier de 0 à 100. Une note hors barème y est ramenée, pas jetée. */
  score: number
  reason: string
}

// `z.number()` refuse `NaN` et l'infini, et `JSON.parse` ne sait de toute façon
// pas les produire : les deux passes plus bas n'ont donc pas à s'en garder.
const SCHÉMA_NOTE = z.object({
  id: z.string(),
  score: z.number(),
  reason: z.string().optional(),
})

const SCHÉMA_CLIP = z.object({
  start: z.number(),
  end: z.number(),
  video_description_for_tiktok: z.string().optional(),
  video_description_for_instagram: z.string().optional(),
  video_title_for_youtube_short: z.string().optional(),
})

/** La liste sous une clé, ou une liste vide si la réponse n'en porte pas. */
function liste(brut: unknown, clé: string): unknown[] {
  if (typeof brut !== 'object' || brut === null) return []
  const valeur = (brut as Record<string, unknown>)[clé]
  return Array.isArray(valeur) ? valeur : []
}

/**
 * Donne une note à chaque fenêtre soumise, et signale celles que Gemini a
 * sautées. Porté de `openshorts/clip_selection.py:108`.
 *
 * « Score EVERY window » est une consigne, pas une garantie : le schéma de
 * réponse accepte n'importe quelle longueur de liste, donc une fenêtre
 * simplement omise disparaîtrait du classement et n'atteindrait jamais la passe
 * de détail. Ce qui n'est pas noté finit **dernier plutôt que dehors**, de sorte
 * que `shortlistSize` reste la seule chose qui retire de la matière.
 *
 * **La réconciliation se fait contre CE lot**, jamais contre la liste globale :
 * un identifiant halluciné qui se trouve appartenir à un autre lot serait sinon
 * accepté comme s'il avait été noté, et masquerait l'omission réelle derrière
 * une note inventée.
 *
 * Rendu `{ scored, missing }`. `scored` porte **toutes** les fenêtres soumises,
 * celles qui manquent avec une note de 0 ; `missing` ne porte que leurs
 * identifiants, pour que l'appelant puisse le dire.
 */
export function parseScoreResponse(
  raw: unknown,
  windows: Window[],
): { scored: ScoredWindow[]; missing: string[] } {
  const soumises = new Set(windows.map((w) => w.id))
  const vues = new Set<string>()
  const scored: ScoredWindow[] = []

  for (const entrée of liste(raw, 'windows')) {
    const lu = SCHÉMA_NOTE.safeParse(entrée)
    if (!lu.success) continue
    const { id, score, reason } = lu.data
    // Inconnue : une hallucination, pas une omission. Déjà vue : le premier avis
    // fait foi — le second n'apporte rien qu'un doublon dans le classement.
    if (!soumises.has(id) || vues.has(id)) continue
    vues.add(id)
    // Ramenée dans le barème plutôt que jetée : une note à 130 dit que le modèle
    // a trouvé la fenêtre excellente, et la jeter perdrait précisément la
    // fenêtre qu'il classait première.
    scored.push({
      id,
      score: Math.min(100, Math.max(0, Math.round(score))),
      reason: reason ?? '',
    })
  }

  const missing = windows.map((w) => w.id).filter((id) => !vues.has(id))
  for (const id of missing) scored.push({ id, score: 0, reason: 'non notée' })
  return { scored, missing }
}

/**
 * Les fenêtres qui atteignent la passe de détail : le haut du panier, à hauteur
 * de `shortlistSize`.
 *
 * Les notes égales sont départagées par l'ordre des fenêtres, qui est
 * chronologique — `Array.prototype.sort` est stable, et `parseScoreResponse`
 * rend les fenêtres notées dans l'ordre de la réponse puis les omises dans
 * l'ordre du lot.
 *
 * Le repli sur les premières fenêtres couvre le cas où la notation n'a rien
 * rendu d'exploitable : mieux vaut détailler les 90 premières secondes que de ne
 * rien proposer du tout après quarante minutes de pipeline.
 *
 * openshorts coupait la liste triée à la cible *avant* d'écarter les
 * identifiants inconnus, si bien qu'une hallucination dans le haut du panier
 * mangeait une place. Ici les inconnues sont déjà tombées à l'analyse, et la
 * boucle compte les fenêtres réelles.
 */
export function shortlistFromScores(scored: ScoredWindow[], windows: Window[]): Window[] {
  const cible = shortlistSize(windows.length)
  const parId = new Map(windows.map((w) => [w.id, w]))
  const retenues: Window[] = []
  const vues = new Set<string>()

  for (const note of [...scored].sort((a, b) => b.score - a.score)) {
    if (retenues.length >= cible) break
    const fenêtre = parId.get(note.id)
    if (fenêtre === undefined || vues.has(note.id)) continue
    vues.add(note.id)
    retenues.push(fenêtre)
  }

  return retenues.length > 0 ? retenues : windows.slice(0, cible)
}

/**
 * L'identifiant d'un clip : **le projet et les bornes, jamais un compteur**.
 *
 * C'est ce qui rend réelle la garantie « un clip écarté ne revient pas »
 * (`src/core/candidates.ts`). Un `clip_01` renuméroté à chaque passe la rend
 * inopérante dans les deux sens : la proposition qu'on vient de refuser revient
 * sous un nouvel identifiant, et une proposition sans rapport hérite du refus
 * prononcé sur le `clip_01` de la passe précédente. Le préfixe du projet donne
 * du même geste l'unicité pour toute la base que `clips.id` exige
 * (`src/server/db.ts`).
 *
 * Les bornes sont écrites en **millisecondes entières**, qui est exactement la
 * précision que `snapToWords` produit : l'identifiant est donc une fonction
 * fidèle des bornes, sans arrondi qui ferait collapser deux propositions
 * distinctes ou diverger deux passes sur les mêmes bornes. Le rembourrage à neuf
 * chiffres couvre 277 heures et fait tomber l'ordre lexicographique des
 * identifiants sur l'ordre chronologique, qui est le tri par défaut de
 * `getClips`.
 *
 * L'identifiant hérite des caractères du projet — les noms de replays portent
 * accents et espaces, et c'est voulu (`projectIdFromSource`). Les routes qui le
 * portent dans un chemin (`GET`/`PATCH /api/clips/:id`) l'encodent donc, comme
 * elles encodent déjà l'identifiant de projet.
 */
function clipId(projectId: string, start: number, end: number): string {
  const ms = (s: number) => String(Math.round(s * 1000)).padStart(9, '0')
  return `${projectId}_${ms(start)}-${ms(end)}`
}

/**
 * Les clips proposés par la passe de détail, calés sur les mots et rendus en
 * candidats prêts pour `mergeCandidates`.
 *
 * Chaque clip sort avec **un seul segment**. La délimitation est le travail de
 * cette passe ; le raccourcissement par le milieu vient après, à la main, dans
 * l'écran de clip (spec §8). Et **rien ne plafonne la durée** : une vanne de 90
 * secondes sort entière.
 *
 * Un clip dont les bornes calées sortent du média est **écarté, pas rattrapé** :
 * `snapToWords` rend l'entrée brute du modèle quand aucune paire valide ne tient
 * dans la vidéo, précisément pour que l'erreur se voie ici. La borner en
 * silence produirait un clip que personne n'a proposé.
 */
export function parseDetailResponse(
  raw: unknown,
  words: Word[],
  videoDuration: number,
  projectId: string,
): Clip[] {
  const clips: Clip[] = []

  for (const entrée of liste(raw, 'shorts')) {
    const lu = SCHÉMA_CLIP.safeParse(entrée)
    if (!lu.success) continue
    const { start, end } = lu.data
    const [début, fin] = snapToWords(start, end, words, videoDuration)
    if (début < 0 || fin > videoDuration || fin <= début) continue

    clips.push({
      id: clipId(projectId, début, fin),
      projectId,
      segments: [{ start: début, end: fin }],
      // `auto` laisse le cadrage décider : le ratio se choisit par clip, et le
      // modèle n'a rien vu de l'image pour en juger.
      ratio: 'auto',
      cropX: 0.5,
      captions: true,
      branding: true,
      title: lu.data.video_title_for_youtube_short ?? '',
      // Une seule description ici, là où le prompt en demande deux. Elles ont la
      // même nature — une accroche puis des mots-dièse — et `Clip` n'a qu'un
      // champ ; le repli sur celle de TikTok évite de rendre un clip muet
      // lorsque le modèle n'en a rempli qu'une.
      description:
        lu.data.video_description_for_instagram ||
        lu.data.video_description_for_tiktok ||
        '',
      status: 'candidate',
      // Le numéro de passe appartient au lot, pas au clip : `mergeCandidates`
      // le pose.
      pass: 0,
    })
  }

  return clips
}

/**
 * Le corps de la réponse, en objet.
 *
 * Avec un `responseMimeType` JSON et un schéma, le texte devrait déjà être du
 * JSON nu. « Devrait » : openshorts a vu passer des clôtures de code et du
 * bavardage autour de l'objet, et la réparation coûte quinze lignes contre une
 * passe de repérage perdue.
 *
 * Les messages d'erreur sont ceux d'openshorts, et **ce n'est pas cosmétique** :
 * la relance de `src/server/steps/candidates.ts` les reconnaît comme passagers.
 * Gemini rend régulièrement un 200 au corps vide, et la même charge passe à
 * l'essai suivant.
 */
export function parseJsonResponse(text: string): unknown {
  const nettoyé = retirerClôtures(text ?? '')
  if (nettoyé === '') throw new Error('Gemini returned an empty response body.')

  const début = nettoyé.indexOf('{')
  const fin = nettoyé.lastIndexOf('}')
  const objet = début !== -1 && fin > début ? nettoyé.slice(début, fin + 1) : ''
  if (objet === '') throw new Error('Gemini response did not contain a JSON object.')

  try {
    return JSON.parse(objet)
  } catch (erreur) {
    throw new Error(`Failed to parse Gemini JSON response: ${String(erreur)}`)
  }
}

/** Retire les ``` que le modèle ajoute parfois malgré le mime type demandé. */
function retirerClôtures(text: string): string {
  const nettoyé = text.trim()
  if (!nettoyé.startsWith('```')) return nettoyé
  const lignes = nettoyé.split('\n').slice(1)
  if (lignes.at(-1)?.trim() === '```') lignes.pop()
  return lignes.join('\n').trim()
}
