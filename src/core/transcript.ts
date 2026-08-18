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
 * **Une seule modification volontaire : `snapToWords` n'a plus de plancher ni de
 * plafond de durée.** Voir sa documentation — c'est le défaut qui a motivé tout
 * le projet.
 *
 * Les deux surcharges d'environnement d'openshorts (`CLIP_SHORTLIST_MAX`,
 * `CLIP_TARGET_MIN`/`MAX`, pour ses campagnes A/B) ne sont pas portées : elles
 * lisent `process.env`, ce que la frontière de pureté de `src/core` interdit —
 * un calcul qui dépend de l'environnement qui l'exécute n'est pas reproductible
 * en test. Le harnais qui les pilotait n'existe pas ici.
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
 */
function usableSegments(tx: Transcript): TxSegment[] {
  return (tx?.segments ?? []).filter((s) => (s.text ?? '').trim() !== '')
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
 * Combien de fenêtres notées atteignent la passe de détail, qui est la coûteuse.
 *
 * Le plafond était un 10 plat quelle que soit la longueur, ce qui dégradait
 * silencieusement l'analyse à mesure que la source s'allongeait : une vidéo de
 * 15 minutes construit ~13 fenêtres et en faisait examiner 10, un live de 2
 * heures en construit ~79 et en faisait examiner 10 aussi — 13 % de la matière,
 * le reste noté puis jeté.
 *
 * Prendre une part des FENÊTRES plutôt qu'une part du temps est ce qui fait
 * suivre la matière réelle : les fenêtres sont bâties sur la parole, donc un
 * live avec 20 minutes d'écran d'attente n'en est pas crédité.
 *
 * Le plafond reste borné parce que le prompt de détail porte le texte de chaque
 * fenêtre, mais la marge est réelle : un transcript de 2 heures ne fait que
 * ~23 000 jetons en entier, donc 24 fenêtres coûtent quelques milliers.
 *
 * Le plancher absolu de 3 de la source est **absorbé** : `min(n, max(3,
 * min(plafond, n)))` vaut `min(n, plafond)` dès que `plafond >= 3`, ce que le
 * `max(10, …)` garantit toujours. On écrit donc la forme réduite plutôt qu'un
 * `max(3, …)` mort ; un test vérifie l'équivalence sur tout le domaine.
 */
export function shortlistSize(nWindows: number): number {
  const n = atLeastOneWindow(nWindows)
  const ceiling = Math.max(10, Math.min(24, Math.round(n * 0.3)))
  return Math.min(n, ceiling)
}

/**
 * Combien de clips demander à la passe de détail, vu la taille de la
 * présélection. Rendu `[plancher, plafond]`.
 *
 * Mesuré en production le 3 août 2026 : 408 des 429 travaux (95 %) ont livré
 * 3 clips ou moins, le mode étant UN, alors que le prompt était libre d'en
 * rendre un par fenêtre présélectionnée. Les utilisateurs qui recevaient 1 à 3
 * clips revenaient le lendemain 0,4 % du temps ; ceux qui en recevaient 4 à 9,
 * 16,1 % — c'est donc le NOMBRE de clips, et non leur qualité, qui porte la
 * courbe de rétention.
 *
 * Le prompt d'origine penchait franchement dans l'autre sens (« préférer un
 * excellent clip par fenêtre candidate ») et accordait au modèle deux licences
 * illimitées d'abandonner un clip, sans plancher pour l'empêcher de s'effondrer
 * sur un seul. Ceci pose un plancher et un plafond réaliste à la place.
 */
export function clipCountTargets(nWindows: number): [number, number] {
  const n = atLeastOneWindow(nWindows)
  // Le plancher croît avec la matière : 3 fenêtres → 3, 5 → 4, 10 et plus → 6.
  const floor = Math.max(2, Math.min(6, Math.floor(n / 2) + 2))
  // Le plafond laisse une fenêtre riche en rendre plus d'un, sans inviter au
  // remplissage.
  const ceiling = Math.min(12, Math.max(4, n * 2))
  return [Math.min(floor, ceiling), ceiling]
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

/** La frontière la plus proche de `time` qui ne soit pas enterrée dans un mot. */
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
  const following = starts.filter((s) => s >= wordEnd)
  const gap = following.length > 0 ? Math.min(...following) - wordEnd : null
  const tail = gap === null ? maxTail : Math.min(maxTail, Math.max(0, gap) / 2)
  return wordEnd + tail
}

/** Le miroir de `cutAfter` : le point de coupe juste avant un mot. */
function cutBefore(wordStart: number, ends: number[], maxLead: number): number {
  const preceding = ends.filter((e) => e <= wordStart)
  const gap = preceding.length > 0 ? wordStart - Math.max(...preceding) : null
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
 */
export function snapToWords(
  start: number,
  end: number,
  words: Word[],
  videoDuration: number,
  maxLead = MAX_LEAD,
  maxTail = MAX_TAIL,
  maxSilenceSkip = MAX_SILENCE_SKIP,
): [number, number] {
  const original: [number, number] = [round3(start), round3(end)]
  if (!words || words.length === 0) return original

  const intervals: [number, number][] = words
    .map((w): [number, number] => [w.start, w.end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const starts = intervals.map(([s]) => s)
  const ends = intervals.map(([, e]) => e).sort((a, b) => a - b)
  const maxEnds = runningMaxEnds(intervals)

  // DÉBUT : sur un début de mot, puis on recule dans le silence qui le précède.
  let newStart = start
  const wordStart = snapStartToSpeech(newStart, starts, maxEnds, maxSilenceSkip)
  if (wordStart !== null) newStart = cutBefore(wordStart, ends, maxLead)

  // FIN : sur une fin de mot, puis on avance dans le silence qui la suit.
  let newEnd = end
  const wordEnd = snapEndToSpeech(newEnd, ends, starts, maxEnds, maxSilenceSkip)
  if (wordEnd !== null) newEnd = Math.min(videoDuration, cutAfter(wordEnd, starts, maxTail))

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
  for (const [low, high] of preferences) {
    if (low < 0 || high > videoDuration || high <= low) continue
    return [round3(low), round3(high)]
  }
  return original
}
