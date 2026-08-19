import { z } from 'zod'
import type { Clip } from '@/core/edl'
import { snapToWords, type Window, type Word } from '@/core/transcript'

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
  /**
   * Faux quand la fenêtre n'a **pas** été notée et qu'on lui a posé un zéro de
   * réconciliation.
   *
   * Le zéro seul ne suffisait pas à tenir la promesse « classée dernière » : une
   * fenêtre que le modèle a réellement jugée nulle porte le même 0, et le
   * départage chronologique mêlait alors les deux — une fenêtre antérieure
   * jamais évaluée pouvait prendre la place, à la coupure, d'une fenêtre
   * évaluée. Ce drapeau les sépare. (relevé par Copilot)
   */
  notée: boolean
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
  // Le prompt la demande depuis toujours ; elle était lue et jetée. C'est elle
  // qui reclasse deux réponses concaténées — voir `DetailClip`.
  //
  // **`catch` et pas seulement `optional` : une note illisible ne coûte pas la
  // proposition.** Une note en chaîne ou un `null` sont exactement le genre
  // d'entrée hostile que ce fichier attend, et sans ce repli le champ faisait
  // échouer le `safeParse` de l'entrée entière : un clip aux bornes parfaitement
  // valides était jeté, et compté comme illisible, pour une note accessoire.
  // C'était une régression — avant cette PR, le champ n'était pas lu du tout.
  // (relevé par Copilot et Aristarque)
  predicted_score: z.number().optional().catch(undefined),
  video_description_for_tiktok: z.string().optional(),
  video_description_for_instagram: z.string().optional(),
  video_title_for_youtube_short: z.string().optional(),
})

/**
 * Un clip proposé, et la note que le modèle lui a donnée.
 *
 * **La note vit à côté du clip, jamais dedans.** `Clip` est ce que la base
 * porte et ce que l'interface édite ; une estimation de viralité rendue par un
 * appel n'y a pas sa place, et elle ressortirait dans `candidates.json` comme si
 * elle décrivait le clip monté. Elle ne sert qu'une fois, à départager des
 * propositions — voir le plafond de `détailler`.
 *
 * `scored` sépare une note absente d'une note nulle, exactement comme `notée` le
 * fait pour les fenêtres : `predicted_score` est facultatif dans la réponse, et
 * un clip que le modèle n'a pas noté ne doit pas passer devant un clip qu'il a
 * noté zéro.
 */
export type DetailClip = {
  clip: Clip
  /** Entier de 0 à 100. Une note hors barème y est ramenée, pas jetée. */
  predictedScore: number
  /** Faux quand la réponse ne portait pas de `predicted_score` lisible. */
  scored: boolean
}

/** La liste sous une clé, ou `null` si la réponse n'en porte pas. */
function liste(brut: unknown, clé: string): unknown[] | null {
  if (typeof brut !== 'object' || brut === null) return null
  const valeur = (brut as Record<string, unknown>)[clé]
  return Array.isArray(valeur) ? valeur : null
}

/**
 * Donne une note à chaque fenêtre soumise, et signale celles que Gemini a
 * sautées. Porté de `openshorts/clip_selection.py:108`.
 *
 * « Score EVERY window » est une consigne, pas une garantie : le schéma de
 * réponse accepte n'importe quelle longueur de liste, donc une fenêtre
 * simplement omise disparaîtrait du classement et n'atteindrait jamais la passe
 * de détail. Ce qui n'est pas noté finit **dernier plutôt que dehors**, de sorte
 * que la présélection reste la seule chose qui retire de la matière.
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

  // La passe de notation est **tolérante par construction**, et c'est ce qui la
  // distingue de la passe de détail : une réponse inexploitable laisse toutes
  // les fenêtres non notées, elles finissent dernières, et `shortlistFromScores`
  // se rabat sur les premières. Le résultat est dégradé, jamais destructeur.
  for (const entrée of liste(raw, 'windows') ?? []) {
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
      notée: true,
    })
  }

  const missing = windows.map((w) => w.id).filter((id) => !vues.has(id))
  for (const id of missing) {
    scored.push({ id, score: 0, reason: 'non notée', notée: false })
  }
  return { scored, missing }
}

/**
 * Les fenêtres qui atteignent la passe de détail : le haut du panier, à hauteur
 * de `cible`.
 *
 * **La cible arrive en argument plutôt que d'être calculée ici.** Elle se déduit
 * de la durée de parole et des réglages (`shortlistSize`), deux choses que cette
 * fonction n'a pas et n'a pas à connaître : elle trie et coupe, elle ne
 * dimensionne pas.
 *
 * **Les notes égales sont départagées par la position de la fenêtre dans le
 * lot, qui est chronologique — et par un comparateur explicite, pas par la
 * stabilité du tri.** Le tri stable préserve l'ordre de `scored`, qui est celui
 * de la RÉPONSE : Gemini rend les fenêtres dans l'ordre qu'il veut, les notes
 * entières à égalité sont fréquentes, et une égalité qui tombe pile sur la
 * coupure de la présélection admettait alors une fenêtre tardive en écartant
 * une fenêtre antérieure, sans que rien ne le décide. (relevé par Codex et
 * Copilot)
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
export function shortlistFromScores(
  scored: ScoredWindow[],
  windows: Window[],
  cible: number,
): Window[] {
  const parId = new Map(windows.map((w) => [w.id, w]))
  // La position dans le lot. Une note dont l'identifiant est inconnu prend le
  // rang de queue — elle est écartée deux lignes plus bas de toute façon, et un
  // `Infinity` ferait un `NaN` dans la soustraction, ce qui casse le tri.
  const rang = new Map(windows.map((w, i) => [w.id, i]))
  const positionDe = (id: string): number => rang.get(id) ?? windows.length
  const retenues: Window[] = []
  const vues = new Set<string>()

  // Une fenêtre notée passe **toujours** devant une fenêtre non notée, même
  // quand la note vaut 0 : « classée dernière » n'était vrai que tant qu'aucune
  // fenêtre n'était réellement notée 0. (relevé par Copilot)
  const triées = [...scored].sort(
    (a, b) =>
      Number(b.notée) - Number(a.notée) ||
      b.score - a.score ||
      positionDe(a.id) - positionDe(b.id),
  )
  for (const note of triées) {
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
 *
 * Un clip qui ne recoupe **aucun** bloc présélectionné est écarté lui aussi : le
 * modèle n'a lu que le texte de ces blocs, donc des bornes sans le moindre
 * recouvrement ne viennent pas d'une lecture mais d'une invention, et elles
 * contourneraient les deux passes que toute cette conception sert à enchaîner.
 * (relevé par Copilot)
 *
 * **Le contrôle demande un recouvrement, pas un confinement**, et la nuance est
 * délibérée. Le prompt demande au modèle de prendre `end` au marqueur de la
 * phrase *suivante*, et `snapToWords` ajoute jusqu'à une demi-seconde de
 * silence : une borne dépasse donc régulièrement le bord du bloc de peu, sans
 * rien avoir d'inventé. Exiger le confinement demanderait une tolérance que
 * personne n'a arrêtée, et écarterait en silence de vrais clips — le défaut
 * exact que ce projet remplace. L'objectif de cet étage est le rappel, pas la
 * précision (spec §7) : Julien trie ensuite.
 *
 * **Lève quand l'enveloppe est illisible**, au lieu de rendre une liste vide.
 * Les deux se ressemblent et ne veulent pas dire la même chose : « le modèle n'a
 * rien trouvé » est une réponse, « la réponse n'a pas de tableau `shorts` » est
 * une panne. Confondues, une réponse cassée passait pour une passe réussie —
 * `mergeCandidates` effaçait les propositions non traitées et `candidates.json`
 * s'écrivait, ce que le graphe lit ensuite comme une étape à jour. Le message
 * est reconnu comme passager par la relance de l'étape, donc l'appel est
 * réessayé avant que quoi que ce soit ne s'écrive. (relevé par Copilot)
 *
 * **Un lot non vide dont aucune entrée ne passe le schéma lève pour la même
 * raison.** Six propositions toutes illisibles ne veulent pas dire « aucun
 * moment trouvé », elles veulent dire que la réponse est cassée, et sans ce
 * contrôle elles ressortaient en liste vide comme un `shorts: []` légitime. Le
 * compte porte sur les entrées **structurellement** exploitables, pas sur les
 * clips retenus : un clip écarté pour être hors média ou hors bloc a bel et bien
 * été lu, et c'est un jugement, pas une panne. (relevé par Copilot)
 *
 * **L'ordre du tableau `shorts` n'est pas un classement, et la note en est
 * un.** Le prompt demande au modèle de rendre ses clips du meilleur au moins
 * bon, mais cet ordre n'est vrai qu'à l'intérieur d'une réponse : quand le
 * filtre force la passe de détail à se découper, deux réponses se concatènent et
 * leurs ordres ne se comparent plus. `predicted_score` ressort donc ici, pour
 * que `détailler` puisse reclasser avant de plafonner. (relevé par Codex)
 *
 * @throws si `raw` ne porte pas de tableau `shorts`, ou si aucune entrée d'un
 * lot non vide n'est lisible.
 */
export function parseDetailResponse(
  raw: unknown,
  contexte: {
    /** Les mots du transcript, vérité terrain du calage. */
    words: Word[]
    videoDuration: number
    projectId: string
    /** Les blocs soumis à la passe de détail, après fusion des fenêtres. */
    blocks: Window[]
  },
): DetailClip[] {
  const { words, videoDuration, projectId, blocks } = contexte
  const proposées = liste(raw, 'shorts')
  if (proposées === null) {
    throw new Error('Gemini response did not contain a "shorts" array.')
  }
  const clips: DetailClip[] = []
  let lisibles = 0

  for (const entrée of proposées) {
    const lu = SCHÉMA_CLIP.safeParse(entrée)
    if (!lu.success) continue
    lisibles += 1
    const { start, end, predicted_score: score } = lu.data
    const [début, fin] = snapToWords(start, end, words, videoDuration)
    if (début < 0 || fin > videoDuration || fin <= début) continue
    if (!blocks.some((b) => début < b.end && fin > b.start)) continue

    clips.push({
      // Ramenée dans le barème plutôt que jetée, comme la note d'une fenêtre :
      // un 130 dit que le modèle tient ce clip pour excellent.
      predictedScore: score === undefined ? 0 : Math.min(100, Math.max(0, Math.round(score))),
      scored: score !== undefined,
      clip: {
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
        // Une seule description ici, là où le prompt en demande deux. Elles ont
        // la même nature — une accroche puis des mots-dièse — et `Clip` n'a
        // qu'un champ ; le repli sur celle de TikTok évite de rendre un clip
        // muet lorsque le modèle n'en a rempli qu'une.
        description:
          lu.data.video_description_for_instagram ||
          lu.data.video_description_for_tiktok ||
          '',
        status: 'candidate',
        // Le numéro de passe appartient au lot, pas au clip : `mergeCandidates`
        // le pose.
        pass: 0,
      },
    })
  }

  if (proposées.length > 0 && lisibles === 0) {
    throw new Error('Gemini response did not contain a "shorts" array with any readable entry.')
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
