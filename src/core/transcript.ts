/**
 * Le transcript : ses types, le fenêtrage qui alimente le repérage, les ancres
 * `[SECONDS]` qui donnent au modèle des positions réelles, et le calage des
 * bornes rendues sur les frontières de mots.
 *
 * Tout ce fichier est porté de `openshorts/clip_selection.py`, 557 lignes de
 * stdlib pur déjà éprouvées en production. Les commentaires reprennent les
 * docstrings d'origine : chaque constante y est justifiée par une mesure, et
 * plusieurs de ces justifications contredisent ce qui vient spontanément.
 *
 * **La modification volontaire qui compte : `snapToWords` n'a plus de plancher
 * ni de plafond de durée.** Voir sa documentation — c'est le défaut qui a motivé
 * tout le projet.
 *
 * Un second écart, structurant : **`shortlistSize` et `clipCountTargets` ne
 * viennent plus de la source.** Leurs plafonds plats donnaient la même consigne
 * à une capsule de dix minutes et à un live de deux heures ; ils se calculent
 * désormais sur la durée de parole et sur `SelectionDimensions`. L'écart
 * d'arrondi avec le `round` de Python qui était documenté ici a disparu avec la
 * formule qui le portait.
 *
 * Les deux surcharges d'environnement d'openshorts (`CLIP_SHORTLIST_MAX`,
 * `CLIP_TARGET_MIN`/`MAX`, pour ses campagnes A/B) ne sont toujours pas
 * portées : elles lisent `process.env`, ce que la frontière de pureté de
 * `src/core` interdit — un calcul qui dépend de l'environnement qui l'exécute
 * n'est pas reproductible en test. Le réglage passe par `SelectionDimensions`,
 * que l'appelant lit en base et **transmet** : la valeur est configurable sans
 * que le calcul cesse d'être pur.
 */

export type Word = { word: string; start: number; end: number }
export type TxSegment = { start: number; end: number; text: string; words: Word[] }
export type Transcript = { segments: TxSegment[] }

/**
 * Une fenêtre de notation : une tranche de transcript soumise au repérage.
 *
 * `segFrom`/`segTo` sont son étendue dans les segments **utilisables** du
 * transcript, les deux bornes incluses. Indexer plutôt que trimballer la prose
 * est ce qui permettra plus tard de fusionner deux fenêtres qui se chevauchent
 * sans que leurs phrases communes apparaissent deux fois.
 *
 * Une étendue **vide** s'écrit `segTo < segFrom` : c'est la fenêtre de repli du
 * transcript vide, qui n'indexe rien.
 */
export type Window = {
  id: string
  start: number
  end: number
  text: string
  segFrom: number
  segTo: number
}

/** Arrondi à la milliseconde, comme le `round(x, 3)` de la source. */
function round3(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/**
 * Les segments non vides du transcript, dans l'ordre.
 *
 * `segFrom`/`segTo` indexent **cette** liste, pas `tx.segments`. C'est pourquoi
 * la fonction est privée et pourquoi `buildWindows` et `windowTextWithAnchors`
 * en dérivent toutes deux la même : deux filtres différents feraient désigner
 * deux choses différentes par le même index, et la prose ressortirait décalée
 * d'un cran sans que rien ne le signale.
 *
 * Un segment sans prose est écarté : le transcript en porte (WhisperX émet des
 * segments vides sur les silences), et une fenêtre n'a rien à en faire. Aucune
 * garde ici contre un `tx` ou un `text` absents : le type est le contrat, et la
 * validation d'un JSON venu du disque appartient à la frontière qui le lit.
 */
function usableSegments(tx: Transcript): TxSegment[] {
  return tx.segments.filter((s) => s.text.trim() !== '')
}

/**
 * Construit les fenêtres de notation, **calées sur les frontières de segments**,
 * pour qu'une phrase — et le plus souvent un moment drôle — ne soit jamais
 * coupée en deux au milieu d'une fenêtre.
 *
 * Une fenêtre grossit segment par segment jusqu'à approcher `windowSeconds`
 * (jusqu'à 1,25 fois pour le segment de clôture), et la suivante démarre au
 * premier segment commençant après `fin - overlapSeconds`, elle aussi sur une
 * frontière. Le chevauchement est délibéré : c'est ce qui garantit qu'aucun
 * moment n'est coupé en deux entre deux fenêtres.
 *
 * `i = max(k, i + 1)` garantit la progression : sans lui, un segment plus long
 * que la fenêtre boucle à l'infini.
 */
export function buildWindows(
  tx: Transcript,
  videoDuration: number,
  windowSeconds = 90,
  overlapSeconds = 30,
): Window[] {
  const segments = usableSegments(tx)
  const windows: Window[] = []
  const n = segments.length
  let windowIndex = 1
  let i = 0

  while (i < n) {
    const wStart = segments[i].start
    let j = i
    // On étend tant que le segment SUIVANT tient sous un plafond tolérant, de
    // sorte que la fenêtre se referme sur une frontière proche de
    // `windowSeconds`.
    while (j + 1 < n && segments[j + 1].end - wStart <= windowSeconds * 1.25) {
      j += 1
      if (segments[j].end - wStart >= windowSeconds) break
    }
    const wEnd = segments[j].end
    windows.push({
      id: `window_${String(windowIndex).padStart(3, '0')}`,
      start: round3(wStart),
      end: round3(wEnd),
      text: segments.slice(i, j + 1).map((s) => s.text).join(' '),
      segFrom: i,
      segTo: j,
    })
    windowIndex += 1

    if (j >= n - 1) break
    const target = wEnd - overlapSeconds
    let k = i + 1
    while (k <= j && segments[k].start < target) k += 1
    i = Math.max(k, i + 1)
  }

  if (windows.length === 0) {
    windows.push({
      id: 'window_001',
      start: 0,
      end: round3(videoDuration),
      text: '',
      // Aucun segment à indexer : une étendue vide, pas un index qui pointerait
      // sur un segment absent.
      segFrom: 0,
      segTo: -1,
    })
  }
  return windows
}

/**
 * Trie chronologiquement et fusionne les fenêtres dont les étendues se touchent
 * ou se chevauchent. Porté de `openshorts/clip_selection.py:215`.
 *
 * `buildWindows` chevauche délibérément deux fenêtres consécutives d'environ
 * 30 secondes pour qu'aucun moment ne soit coupé en deux. C'est juste pour la
 * notation et faux pour la passe de détail : deux fenêtres voisines qui
 * survivent toutes deux à la présélection donnent les mêmes phrases deux fois au
 * modèle, sous une consigne qui lui demande de travailler *chaque* fenêtre. Des
 * clips en double en sont le résultat prévisible, et la seule chose qui s'y
 * opposait était une ligne DIVERSITY dans le prompt.
 *
 * **La fusion passe par les index de segments, jamais par de la chirurgie sur le
 * texte joint** : reconstruire depuis `segments[segFrom..segTo]` de l'union est
 * ce qui garantit que la prose commune apparaît exactement une fois.
 *
 * Le bloc survivant garde l'identifiant de la PREMIÈRE fenêtre — les
 * identifiants n'existent que pour que le modèle les renvoie dans
 * `source_window_id`, personne ne les résout.
 *
 * La fonction ne modifie ni le tableau reçu ni les fenêtres qu'il porte.
 */
export function mergeOverlappingWindows(windows: Window[], tx: Transcript): Window[] {
  if (windows.length === 0) return []
  const segments = usableSegments(tx)

  const ordonnées = [...windows].sort((a, b) => a.start - b.start || a.end - b.end)
  const fusionnées: Window[] = []
  for (const source of ordonnées) {
    // Une copie : la fenêtre de l'appelant n'est jamais modifiée en place.
    const fenêtre = { ...source }
    const précédente = fusionnées.at(-1)
    if (précédente === undefined || fenêtre.start > précédente.end) {
      fusionnées.push(fenêtre)
      continue
    }

    // `max` et non `fenêtre.end` : une fenêtre entièrement contenue dans la
    // précédente raccourcirait le bloc au lieu de s'y fondre.
    précédente.end = round3(Math.max(précédente.end, fenêtre.end))
    const étendues = [précédente, fenêtre].filter((w) => w.segTo >= w.segFrom)
    if (étendues.length === 2) {
      précédente.segFrom = Math.min(...étendues.map((w) => w.segFrom))
      précédente.segTo = Math.max(...étendues.map((w) => w.segTo))
      précédente.text = segments
        .slice(précédente.segFrom, précédente.segTo + 1)
        .map((s) => s.text)
        .join(' ')
    } else {
      // Une fenêtre sans étendue : la fenêtre de repli du transcript vide.
      // Concaténer est la meilleure réponse disponible et ne peut rien
      // dupliquer, parce que ce repli n'est jamais que la fenêtre unique.
      précédente.text = [précédente.text, fenêtre.text].filter((t) => t !== '').join(' ')
    }
  }
  return fusionnées
}

/**
 * Un marqueur absolu `[SECONDS]`, **tronqué vers zéro, jamais arrondi**.
 *
 * C'est tout l'objet de l'arithmétique ci-dessous. Un marqueur arrondi peut
 * tomber APRÈS le vrai début du segment — 30,56 émis en `[30.6]` — et le modèle
 * rend alors une borne qui tombe dans le premier mot de la phrase qu'il voulait
 * exclure ; `snapToWords` la lit comme de la parole et étend le clip jusqu'à la
 * fin de ce mot. **La grandeur ne compte pas, seul le signe compte** : un
 * marqueur en retard de 0,4 ms déclenche exactement le même défaut qu'un
 * marqueur en retard de 40 ms. Tronquer garantit `marqueur <= vrai début`, donc
 * une borne reprise d'un marqueur se lit toujours comme le trou qu'elle est.
 * Ajouter des décimales rétrécit l'erreur sans la supprimer.
 */
export function anchor(seconds: number, precision = 3): string {
  const scale = 10 ** precision
  return `[${(Math.trunc(seconds * scale) / scale).toFixed(precision)}]`
}

/**
 * La prose de la fenêtre, avec un marqueur `[SECONDS]` absolu par segment.
 *
 * La passe de détail doit répondre en secondes absolues. Elle ne recevait que la
 * prose et les bornes de la fenêtre : elle interpolait donc une position dans
 * 90 secondes de texte, et se trompait régulièrement — c'est ce que `snapToWords`
 * passe son temps à réparer. Un marqueur par segment lui donne de vraies ancres
 * entre lesquelles choisir, à raison d'une toutes les 5 à 10 secondes de parole.
 *
 * Les horodatages par MOT étaient l'autre option, et coûtaient environ 40 fois
 * plus cher : une présélection de 24 fenêtres fait 5 à 6 000 mots, soit ~65 000
 * jetons d'entrée de coordonnées enfouissant la prose qu'il s'agit de juger.
 */
export function windowTextWithAnchors(w: Window, tx: Transcript): string {
  const segments = usableSegments(tx)
  if (w.segTo < w.segFrom) {
    // La fenêtre de repli du transcript vide n'a aucun segment à ancrer. Elle
    // reçoit quand même un marqueur — son propre début — parce que le prompt
    // interdit un horodatage qui ne vient pas d'un marqueur, et que livrer au
    // modèle une consigne qu'il ne peut pas satisfaire est pire qu'une ancre
    // grossière.
    return `${anchor(w.start)} ${w.text}`.trim()
  }
  return segments
    .slice(w.segFrom, w.segTo + 1)
    .map((s) => `${anchor(s.start)} ${s.text}`)
    .join(' ')
}

/** `max(1, int(n or 1))` de la source : 0, NaN et les négatifs valent 1. */
function atLeastOneWindow(nWindows: number): number {
  return Math.max(1, Math.floor(nWindows) || 1)
}

/**
 * Le temps où **quelqu'un parle**, en secondes : l'union des segments
 * utilisables, jamais leur somme ni l'écart du premier au dernier.
 *
 * **L'écart du premier mot au dernier n'est pas une durée de parole**, et
 * l'erreur n'est pas théorique : mesurée le 18 août 2026 sur les deux émissions
 * du dépôt, elle surestime de 19 à 21 % — 6642 s d'écart pour 5244 s de parole
 * sur `2026-22-02-entre-nous`, 5755 s pour 4635 s sur `2025-06-15-cqlp` —, et le
 * plus grand trou isolé fait 4 min 46 sur la première et 6 min 43 sur la
 * seconde. Une émission dont deux conversations encadrent une
 * heure d'écran d'attente aurait compté une heure de matière qui n'existe pas,
 * et `clipCountTargets` aurait réclamé au modèle des clips que le transcript ne
 * porte pas. (relevé par Codex)
 *
 * C'est aussi ce qui rétablit la propriété que le compte de fenêtres avait et
 * que l'écart avait perdue : les fenêtres se bâtissent sur les segments
 * utilisables, donc les deux mesures décrivent enfin la même matière.
 *
 * L'union et non la somme : rien n'interdit à deux segments de se chevaucher, et
 * les additionner compterait deux fois le temps commun.
 */
export function secondesDeParole(tx: Transcript): number {
  const intervalles = usableSegments(tx)
    .map((s) => ({ start: s.start, end: s.end }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)

  let total = 0
  let courant: { start: number; end: number } | null = null
  for (const i of intervalles) {
    if (courant === null || i.start > courant.end) {
      if (courant !== null) total += courant.end - courant.start
      courant = { ...i }
    } else if (i.end > courant.end) {
      courant.end = i.end
    }
  }
  if (courant !== null) total += courant.end - courant.start
  return total
}

/**
 * Ce qui dimensionne le repérage, en unités qu'une personne peut régler.
 *
 * Ces valeurs vivent en base (`src/server/db.ts`) et arrivent ici **en
 * argument** : la frontière de pureté de `src/core/` interdit de les lire
 * soi-même, et c'est ce qui rend les deux fonctions ci-dessous testables sans
 * base ni environnement.
 */
export type SelectionDimensions = {
  /** Une proposition attendue par tranche de tant de minutes de parole. */
  minutesPerClip: number
  /** Combien de fenêtres sont examinées pour chaque clip demandé. */
  windowsPerClip: number
  /** Plancher absolu de clips, pour que les sources courtes sortent de la zone morte. */
  minimumClips: number
  /** Plancher absolu de fenêtres examinées. */
  minimumWindows: number
  /** Plafond absolu de clips. `0` veut dire « aucun ». */
  maximumClips: number
}

/**
 * Ce qui s'applique quand la base ne dit rien.
 *
 * **Ici et non à côté de la table** : ce sont les défauts d'un calcul, pas ceux
 * d'un stockage. `src/server/db.ts` ne fait que les surcharger, et les poser
 * là-bas obligerait ce fichier — et ses tests — à dépendre du serveur pour
 * connaître son propre comportement nominal.
 */
export const DEFAULT_SELECTION_DIMENSIONS: SelectionDimensions = {
  // Six et non sept, et le chiffre a une histoire : sept avait été arrêté sur
  // une mesure qui prenait l'écart du premier mot au dernier pour de la parole,
  // donc sur 21 % de matière qui n'existe pas. `secondesDeParole` a corrigé la
  // mesure ; six rend, sur la mesure juste, le rendement qui avait été retenu
  // sur la fausse — 15 clips pour `2026-22-02-entre-nous`, 13 pour
  // `2025-06-15-cqlp`. Corriger l'un sans l'autre aurait livré un rendement que
  // personne n'a choisi.
  minutesPerClip: 6,
  windowsPerClip: 2,
  minimumClips: 6,
  minimumWindows: 10,
  maximumClips: 0,
}

/** La fenêtre de 90 secondes, atome de la conception (spec §7 et `buildWindows`). */
const SECONDES_PAR_CRÉNEAU = 90

/**
 * L'étendue de parole ramenée à un nombre exploitable.
 *
 * **Une seule porte d'entrée, et toutes les formules passent par elle.** Le
 * `NaN` et l'`Infini` se propagent sans bruit à travers `Math.round` et
 * `Math.max` : une seule branche qui oublie l'assainissement rend une cible
 * `NaN`, que le prompt interpolerait telle quelle dans « return NaN to NaN
 * clips ». Un test dégénéré l'a attrapée, ce qui vaut mieux que la production.
 */
function paroleUtile(speechSeconds: number): number {
  return Number.isFinite(speechSeconds) ? Math.max(0, speechSeconds) : 0
}

/**
 * Les tranches de 90 secondes que porte une étendue de parole.
 *
 * C'est le majorant de tout ce qui suit : on ne demande jamais plus de clips
 * qu'il n'y a de créneaux à examiner. Sans cette borne, un plancher absolu de 6
 * réclamerait six clips à une vidéo de 90 secondes.
 */
function créneaux(speechSeconds: number): number {
  return Math.round(paroleUtile(speechSeconds) / SECONDES_PAR_CRÉNEAU)
}

/**
 * Combien de clips demander à la passe de détail, **vu la durée de parole**.
 * Rendu `[plancher, plafond]`.
 *
 * **Le plancher est la sortie, pas une borne basse**, et c'est la seule chose à
 * comprendre ici. Mesuré en production le 3 août 2026 : 408 des 429 travaux
 * (95 %) ont livré 3 clips ou moins, le mode étant UN, alors que le prompt était
 * libre d'en rendre un par fenêtre présélectionnée. Le modèle s'assied sur le
 * minimum qu'on lui donne — le prompt a beau insister (« they are not a licence
 * to return one clip and stop »), c'est ce nombre-là qui décide. Les
 * utilisateurs qui recevaient 1 à 3 clips revenaient le lendemain 0,4 % du
 * temps ; ceux qui en recevaient 4 à 9, 16,1 % : c'est le NOMBRE de clips, et
 * non leur qualité, qui porte la courbe de rétention. D'où `minimumClips`.
 *
 * **Ce que cette version corrige.** Le plancher était `min(6, …)` et le plafond
 * `min(12, …)`, tous deux calculés sur la taille de la présélection — laquelle
 * ne descend jamais sous 10. Les deux saturaient donc immédiatement, et toute
 * source de plus de dix minutes recevait exactement la même consigne, `[6, 12]`.
 * Le 18 août 2026, `2026-22-02-entre-nous` — 1 h 51 de parole, 95 fenêtres — a
 * rendu 6 clips, le plancher pile. Une capsule de dix minutes en aurait demandé
 * autant.
 *
 * **Pourquoi la durée de parole et non le compte de fenêtres.** Mesuré sur les
 * deux émissions du dépôt, une fenêtre tombe tous les 69,3 s et 69,9 s : les
 * deux grandeurs portent le même signal à 1 % près, et changer d'entrée ne
 * change rien par soi-même — ce sont les plafonds plats qui bloquaient. La durée
 * est retenue parce qu'elle rend la règle énonçable : « un clip toutes les
 * `minutesPerClip` minutes de parole » se règle et s'audite, « 30 % des
 * fenêtres » non.
 *
 * **Et « parole » veut dire `secondesDeParole`**, l'union des segments qui
 * portent de la prose — pas la durée vidéo, pas l'écart du premier mot au
 * dernier. Les trois diffèrent : la durée vidéo ajoute 175 à 181 s de silence en
 * tête et en queue, l'écart ajoute encore tous les trous du milieu, soit 19 à
 * 21 % de plus. Voir `secondesDeParole`, qui porte la mesure.
 */
export function clipCountTargets(
  speechSeconds: number,
  dimensions: SelectionDimensions,
): [number, number] {
  const parole = paroleUtile(speechSeconds)
  const parMinutes = Math.round(parole / (60 * Math.max(1, dimensions.minutesPerClip)))
  // Le plancher absolu tient les sources courtes hors de la zone morte ; les
  // créneaux tiennent les très courtes, où six clips n'auraient pas de support.
  let plancher = Math.max(
    1,
    Math.min(créneaux(parole), Math.max(dimensions.minimumClips, parMinutes)),
  )
  // Le plafond laisse une fenêtre riche en rendre plus d'un, sans inviter au
  // remplissage. Il est surtout décoratif : voir le premier paragraphe.
  let plafond = Math.max(plancher + 2, Math.round(plancher * 1.5))
  // **`maximumClips` borne les DEUX bornes.** Ne plafonner que le plancher
  // laissait le plafond repartir au-dessus — un maximum de 10 rendait `[10, 15]`
  // et le prompt autorisait toujours quinze clips, ce qui vidait de son sens un
  // réglage documenté comme absolu. Le plancher suit le plafond quand celui-ci
  // descend sous lui, pour que l'intervalle reste valide. (relevé par Codex et
  // Copilot)
  if (dimensions.maximumClips > 0) {
    plafond = Math.min(plafond, dimensions.maximumClips)
    plancher = Math.min(plancher, plafond)
  }
  return [plancher, plafond]
}

/**
 * Combien de fenêtres notées atteignent la passe de détail, qui est la coûteuse.
 *
 * **Dérivée du plancher de clips plutôt que calculée à part**, et c'est ce qui
 * empêche les deux règles de diverger : la présélection existe pour donner de
 * quoi trouver les clips demandés, donc `windowsPerClip` les lie par
 * construction. Deux formules indépendantes finiraient par demander vingt clips
 * dans dix fenêtres.
 *
 * Le plafond plat de 24 est retiré. Sa justification — « le prompt de détail
 * porte le texte de chaque fenêtre » — chiffrait elle-même sa propre marge : un
 * transcript de deux heures ne fait que ~23 000 jetons **en entier**, donc même
 * envoyer toutes les fenêtres tiendrait. Ce qui reste vrai, et que
 * `windowsPerClip` gouverne, c'est qu'une charge trop grosse dilue l'attention
 * du modèle, exactement comme pour les lots de notation.
 *
 * `nWindows` borne le résultat par le haut : on ne présélectionne pas des
 * fenêtres qui n'existent pas. `minimumWindows` le borne par le bas, sauf
 * quand la source en a moins que ça.
 */
export function shortlistSize(
  speechSeconds: number,
  nWindows: number,
  dimensions: SelectionDimensions,
): number {
  const n = atLeastOneWindow(nWindows)
  const [plancherClips] = clipCountTargets(speechSeconds, dimensions)
  const voulu = plancherClips * Math.max(1, dimensions.windowsPerClip)
  return Math.max(Math.min(dimensions.minimumWindows, n), Math.min(n, voulu))
}

/**
 * Jusqu'où le calage a le droit de marcher pour rejoindre la parole quand une
 * borne tombe dans un silence. Au-delà, l'horodatage du modèle n'est pas « un
 * peu à l'intérieur d'une pause », il est simplement faux, et déplacer la borne
 * aussi loin changerait le contenu du clip — une décision de monteur, pas de
 * caleur.
 */
const MAX_SILENCE_SKIP = 10.0

/** Rembourrage maximal avant le premier mot, et après le dernier. */
const MAX_LEAD = 0.35
const MAX_TAIL = 0.45

/** `bisect.bisect_left` : le premier index où insérer `x` sans casser l'ordre. */
function bisectLeft(sorted: number[], x: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sorted[mid] < x) low = mid + 1
    else high = mid
  }
  return low
}

/** `bisect.bisect_right` : le dernier de ces index. */
function bisectRight(sorted: number[], x: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sorted[mid] <= x) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * Le maximum courant des fins de mots, pour le test d'appartenance ci-dessous.
 *
 * Ne consulter que le dernier mot commençant avant la borne devient faux dès que
 * des mots se chevauchent : sur `[(10, 20), (15, 16)]` à t=17 cette recherche
 * tombe sur `(15, 16)`, déclare « silence », et l'appelant s'éloigne alors d'une
 * parole qui n'est pas finie. Le maximum courant répond à « un mot commençant à
 * cet instant ou avant le couvre-t-il encore », qui est la vraie question.
 */
function runningMaxEnds(intervals: [number, number][]): number[] {
  const running: number[] = []
  let highest = Number.NEGATIVE_INFINITY
  for (const [, end] of intervals) {
    highest = Math.max(highest, end)
    running.push(highest)
  }
  return running
}

/**
 * Vrai quand `time` est strictement à l'intérieur d'un mot — les deux bords
 * ouverts.
 *
 * Le début et la fin d'un mot sont des endroits légaux où couper ; l'entre-deux
 * ne l'est pas. Ceci filtre les frontières CANDIDATES, ce que le test
 * d'appartenance seul ne fait pas : reconnaître qu'une borne est de la parole ne
 * dit rien de la frontière qu'on lui choisira ensuite, et sur
 * `[(10, 20), (15, 16)]` à t=17 la fin la plus proche est 16, qui tombe dans le
 * mot qui court encore jusqu'à 20 — la coupe au milieu d'un mot que toute cette
 * fonction existe pour éviter.
 */
function isMidWord(time: number, starts: number[], maxEnds: number[]): boolean {
  const index = bisectLeft(starts, time) - 1
  return index >= 0 && maxEnds[index] > time
}

/**
 * La frontière la plus proche de `time` qui ne soit pas enterrée dans un mot.
 *
 * Le repli sur `boundaries` est **inatteignable**, et c'est démontrable plutôt
 * qu'espéré : appelée sur `starts`, le premier début n'a aucun mot avant lui
 * donc `isMidWord` y est faux ; appelée sur `ends`, la fin maximale ne peut être
 * dépassée par aucun `maxEnds`, donc `isMidWord` y est faux aussi. La liste
 * filtrée n'est donc jamais vide. On garde quand même la garde, parce que
 * `reduce` sans valeur initiale lèverait sur un tableau vide si l'invariant
 * cédait un jour — mais personne ne doit croire ce chemin vivant.
 */
function nearestCuttable(
  time: number,
  boundaries: number[],
  starts: number[],
  maxEnds: number[],
): number {
  const cuttable = boundaries.filter((b) => !isMidWord(b, starts, maxEnds))
  const candidates = cuttable.length > 0 ? cuttable : boundaries
  // À égalité, la première — comme le `min(…, key=…)` de Python.
  return candidates.reduce((best, b) =>
    Math.abs(b - time) < Math.abs(best - time) ? b : best,
  )
}

/**
 * Le point de coupe juste après un mot, qui n'empiète que sur le silence qui
 * suit.
 *
 * Le rembourrage vient du trou réellement disponible, **jamais d'une constante
 * fixe** : de la parole contiguë ne laisse aucune place, et une constante y
 * poserait la coupe dans le mot suivant. Tout ce qui referme un clip passe par
 * ici — c'est l'intérêt d'en avoir fait une fonction.
 */
function cutAfter(wordEnd: number, starts: number[], maxTail: number): number {
  // `starts` est trié, donc le premier début à `wordEnd` ou après se trouve par
  // dichotomie. La source filtre puis prend le `min` ; ici un
  // `Math.min(...tableau)` étalerait jusqu'à 30 000 arguments sur la pile pour
  // une émission de trois heures, et ce genre de dépassement n'arrive que sur la
  // source la plus longue, c'est-à-dire le plus tard possible.
  const index = bisectLeft(starts, wordEnd)
  const gap = index < starts.length ? starts[index] - wordEnd : null
  const tail = gap === null ? maxTail : Math.min(maxTail, Math.max(0, gap) / 2)
  return wordEnd + tail
}

/** Le miroir de `cutAfter` : le point de coupe juste avant un mot. */
function cutBefore(wordStart: number, ends: number[], maxLead: number): number {
  // Idem : `ends` est trié, la dernière fin à `wordStart` ou avant est juste à
  // gauche du point d'insertion.
  const index = bisectRight(ends, wordStart)
  const gap = index > 0 ? wordStart - ends[index - 1] : null
  const lead = gap === null ? maxLead : Math.min(maxLead, Math.max(0, gap) / 2)
  return Math.max(0, wordStart - lead)
}

/**
 * Vrai quand `time` tombe dans un mot prononcé plutôt que dans un trou.
 *
 * C'est ceci, et non un seuil de distance, qui décide comment une borne est
 * calée. Dans un mot, le modèle a pointé de la parole et la frontière la plus
 * proche est la bonne réponse ; dans un trou, il n'a rien pointé et c'est le
 * sens de marche qui compte (voir les appelants). La distance ne sait pas
 * distinguer les deux : une borne à 0,8 s dans une pause de 2 s est « proche »
 * d'un mot et se trouve pourtant en plein silence.
 *
 * `openEdge` nomme le bord qui compte comme EXTÉRIEUR, et **cette asymétrie est
 * porteuse**. Une fin de clip qui tombe exactement sur le début d'un mot
 * signifie « s'arrêter AVANT ce mot », pas « un instant à l'intérieur » — et
 * c'est le cas courant, pas un cas limite, puisque le prompt de détail demande
 * `end` au marqueur de la phrase suivante. Symétriquement, un début qui tombe
 * sur la fin d'un mot signifie « commencer après ce mot ».
 */
function fallsInsideAWord(
  time: number,
  starts: number[],
  maxEnds: number[],
  openEdge: 'start' | 'end',
): boolean {
  if (starts.length === 0) return false
  if (openEdge === 'start') {
    // Fin de clip : un mot tel que `début < time <= fin` le couvre encore.
    const index = bisectLeft(starts, time) - 1
    return index >= 0 && maxEnds[index] >= time
  }
  // Début de clip : un mot tel que `début <= time < fin` le couvre encore.
  const index = bisectRight(starts, time) - 1
  return index >= 0 && maxEnds[index] > time
}

/** Le début de mot sur lequel ouvrir, ou `null` pour laisser la borne. */
function snapStartToSpeech(
  start: number,
  starts: number[],
  maxEnds: number[],
  maxSilenceSkip: number,
): number | null {
  if (fallsInsideAWord(start, starts, maxEnds, 'end')) {
    return nearestCuttable(start, starts, starts, maxEnds)
  }
  // Dans un trou : on avance. Le mot le plus proche dans l'absolu peut être la
  // queue de la phrase précédente, du mauvais côté de la pause — et comme le
  // prompt de détail prend `start` sur un marqueur de phrase, reculer
  // ramènerait la fin de la phrase d'avant.
  const index = bisectLeft(starts, start)
  if (index >= starts.length) return null
  const wordStart = starts[index]
  return wordStart - start <= maxSilenceSkip ? wordStart : null
}

/** La fin de mot sur laquelle refermer, ou `null` pour laisser la borne. */
function snapEndToSpeech(
  end: number,
  ends: number[],
  starts: number[],
  maxEnds: number[],
  maxSilenceSkip: number,
): number | null {
  if (fallsInsideAWord(end, starts, maxEnds, 'start')) {
    return nearestCuttable(end, ends, starts, maxEnds)
  }
  // Le miroir du début : on recule, pour que le clip ne se termine jamais en
  // silence et n'avale jamais le premier mot de la phrase suivante. Ce dernier
  // point n'a rien d'hypothétique : le prompt de détail demande `end` au
  // marqueur de la phrase APRÈS la dernière voulue, donc la fin de mot la plus
  // proche est souvent le premier mot d'une phrase que le clip ne doit pas
  // contenir.
  const index = bisectRight(ends, end)
  if (index === 0) return null
  const wordEnd = ends[index - 1]
  return end - wordEnd <= maxSilenceSkip ? wordEnd : null
}

/**
 * Cale les bornes proposées par le modèle sur de vraies frontières de mots, plus
 * un peu du silence alentour. Un LLM est mauvais en arithmétique à la
 * milliseconde ; les horodatages par mot sont la vérité terrain, et les coupes
 * tombent alors dans des pauses au lieu du milieu d'un mot.
 *
 * Un paramètre `search_window` gardait autrefois cette fonction : mot le plus
 * proche à moins de 1,5 s, valeur brute sinon. Les deux moitiés étaient fausses.
 * Le seuil ne disait rien de la nature de la borne — 0,8 s dans une pause de 2 s
 * compte comme « proche » — et le repli brut se déclenchait précisément dans le
 * cas de silence qu'il était censé réparer. Ce qui compte est
 * `fallsInsideAWord`, donc le paramètre a disparu plutôt que d'être gardé et
 * ignoré.
 *
 * **Ni plancher ni plafond de durée, et c'est la seule modification volontaire
 * par rapport à openshorts.** Là-bas, `snap_clip_to_words` porte
 * `min_duration=15.0, max_duration=60.0` en valeurs par défaut, jamais
 * surchargées à l'unique site d'appel — et ce plafond est le défaut qui a motivé
 * tout ce projet : une vanne de 90 secondes dont OpenShorts gardait 25 secondes
 * de préambule et coupait la chute. **La durée est un résultat, jamais une
 * contrainte d'entrée** (spec §5), donc toute la logique de « réparation » qui
 * en dépendait a disparu avec les deux paramètres.
 *
 * Rendu `[début, fin]`, en ne retombant sur l'entrée brute que si aucune
 * combinaison de bornes calées et brutes ne tient dans la vidéo.
 *
 * Les trois constantes de calage ne sont **pas** des paramètres, alors qu'elles
 * le sont dans la source. C'est la leçon du plafond de 60 secondes : un défaut
 * de mot-clé jamais surchargé à l'unique site d'appel se lit comme un réglage
 * alors que c'est une constante, et il devient invisible. Les régler se fait
 * donc ici, en une ligne, comme une décision.
 */
export function snapToWords(
  start: number,
  end: number,
  words: Word[],
  videoDuration: number,
): [number, number] {
  // L'entrée du modèle, **non arrondie**. La source l'arrondit ici ; c'est une
  // erreur qu'on ne reprend pas. `round3` existe pour nettoyer le bruit flottant
  // que l'arithmétique de calage introduit (9,649999999999999 → 9,65) ; une
  // borne qu'on se contente de rendre telle quelle n'a pas ce bruit, et
  // l'arrondir ne peut qu'ajouter de l'erreur. Concrètement, une fin valide à
  // 99,9995 s sur une vidéo de 99,9995 s ressortait à 100 — hors média, par le
  // seul fait de l'arrondi.
  const original: [number, number] = [start, end]
  if (words.length === 0) return original

  const intervals: [number, number][] = words
    .map((w): [number, number] => [w.start, w.end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const starts = intervals.map(([s]) => s)
  const ends = intervals.map(([, e]) => e).sort((a, b) => a - b)
  const maxEnds = runningMaxEnds(intervals)

  // DÉBUT : sur un début de mot, puis on recule dans le silence qui le précède.
  let newStart = start
  const wordStart = snapStartToSpeech(newStart, starts, maxEnds, MAX_SILENCE_SKIP)
  if (wordStart !== null) newStart = cutBefore(wordStart, ends, MAX_LEAD)

  // FIN : sur une fin de mot, puis on avance dans le silence qui la suit.
  let newEnd = end
  const wordEnd = snapEndToSpeech(newEnd, ends, starts, maxEnds, MAX_SILENCE_SKIP)
  if (wordEnd !== null) newEnd = Math.min(videoDuration, cutAfter(wordEnd, starts, MAX_TAIL))

  // La paire la plus calée qui soit valide. openshorts rendait l'entrée brute
  // dès que sa réparation de durée échouait, ce qui jetait une borne AYANT
  // correctement calé parce que l'autre n'y arrivait pas — un clip au début
  // propre revenait brut des deux côtés.
  const preferences: [number, number][] = [
    [newStart, newEnd],
    [newStart, original[1]],
    [original[0], newEnd],
    original,
  ]
  // On valide la paire **telle qu'on la rend**, arrondie, et non la paire brute.
  // Contrôler l'une puis rendre l'autre laissait passer une paire distante de
  // moins d'une demi-milliseconde, que l'arrondi ramène sur la même valeur : une
  // durée nulle après un contrôle `fin > début` pourtant réussi.
  //
  // La fin est reclampée **après** l'arrondi. Une fin calée ne peut pas dépasser
  // la vidéo avant d'être arrondie — `newEnd` est déjà passée par un
  // `Math.min(videoDuration, …)` — donc si elle la dépasse ensuite, c'est
  // l'arrondi qui l'y a poussée, et le rattraper ne masque rien. Une fin brute
  // réellement hors vidéo, elle, est rejetée un cran plus haut par
  // `high > videoDuration` et n'atteint jamais ce clamp.
  for (const [low, high] of preferences) {
    if (low < 0 || high > videoDuration) continue
    const lo = round3(low)
    const hi = Math.min(round3(high), videoDuration)
    if (hi <= lo) continue
    return [lo, hi]
  }
  // Dernier recours : l'entrée du modèle, rendue telle quelle. Elle n'est
  // volontairement ni bornée ni clampée — une borne hors vidéo est une erreur du
  // modèle, que la passe de détail rejette (« rejette un clip dont les bornes
  // sortent de la vidéo »). La rattraper ici masquerait ce que l'appelant doit
  // voir.
  return original
}
