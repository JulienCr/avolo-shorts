/**
 * La couverture d'une émission : **où sont, dans l'heure quarante, les clips
 * qu'on en a tirés**.
 *
 * C'est une bande en **lecture seule**, sous le lecteur de la vue Émission. Elle
 * dit trois choses d'un coup d'œil : ce qui a été extrait, où se trouve chaque
 * clip, et ce qui reste inexploité. Rien ne s'y édite — un clip s'ouvre, il ne
 * se déplace pas.
 *
 * **La conception §13 écarte nommément « toute la famille timeline multi-pistes,
 * waveforms et playhead », et cette bande n'en fait pas partie.** Le motif de
 * l'exclusion est que *la surface d'édition est le transcript* : construire un
 * banc de montage reviendrait à bâtir le morceau le plus difficile du métier
 * pour un produit qui ne s'en sert pas. Une bande qui ne modifie rien ne coûte
 * pas ce prix-là et ne prend la place de rien — elle rend visible une propriété
 * de l'émission (sa couverture) que trois écrans ne savaient pas dire. La §13 le
 * note désormais explicitement, faute de quoi le lecteur suivant y verrait une
 * contradiction.
 *
 * Ce module est **pur** : il place des intervalles dans des voies et calcule des
 * pourcentages. Aucune couleur, aucun pixel, aucun DOM.
 */

import type { Segment } from '@/core/edl'

/** Un intervalle de la source, en secondes. */
export type Intervalle = { début: number; fin: number }

/**
 * L'étendue d'un clip dans la source : du premier début à la dernière fin.
 *
 * **Ce n'est pas sa durée.** Un clip est une liste de segments, et retirer un
 * passage par le milieu — la décision fondatrice du projet — laisse un trou
 * qu'aucune bande ne montrera : le clip *occupe* toujours la même place dans
 * l'émission, il en garde seulement moins. La bande décrit la couverture de la
 * source, la durée se lit à côté, sur l'étiquette du clip.
 *
 * Rend `null` sur une liste vide : un clip dont tous les mots ont été retirés
 * n'occupe aucune place, et lui en dessiner une de largeur nulle mettrait un
 * bloc invisible mais cliquable sur la bande.
 */
export function étendue(segments: readonly Segment[]): Intervalle | null {
  if (segments.length === 0) return null
  let début = Infinity
  let fin = -Infinity
  for (const s of segments) {
    if (s.start < début) début = s.start
    if (s.end > fin) fin = s.end
  }
  // Une liste de segments dégénérés — bornes non finies, fin avant début — ne
  // décrit aucune étendue. `normalizeSegments` les écarte en amont ; ici on ne
  // fabrique pas un rectangle à partir d'un `NaN`.
  if (!Number.isFinite(début) || !Number.isFinite(fin) || fin <= début) return null
  return { début, fin }
}

/** Un intervalle et la voie où il se dessine. */
export type Placé<T> = { item: T; intervalle: Intervalle; voie: number }

export type Placement<T> = {
  placés: Placé<T>[]
  /** Le nombre de voies occupées. Zéro quand il n'y a rien à placer. */
  voies: number
}

/**
 * Les intervalles répartis en voies, **de sorte que deux qui se chevauchent ne
 * se cachent jamais**.
 *
 * C'est l'exigence explicite du retour d'usage : « il faut rester capable de
 * comprendre lorsqu'il existe plusieurs clips qui se chevauchent ». Deux
 * candidats issus de la même scène se recouvrent régulièrement — le repérage
 * propose des fenêtres qui se chevauchent d'une trentaine de secondes —, et
 * empilés sur une seule ligne le second efface le premier, ou pire, le survol
 * n'en désigne qu'un des deux sans dire lequel.
 *
 * **L'algorithme est glouton sur les débuts, et c'est optimal ici.** Trié par
 * début croissant, poser chaque intervalle dans la première voie dont la
 * dernière fin ne dépasse pas son début donne le nombre minimal de voies : c'est
 * le résultat classique sur les graphes d'intervalles, où le nombre chromatique
 * égale le recouvrement maximal. Autrement dit, le nombre de voies rendu **est**
 * le nombre maximal de clips simultanés, et la bande n'est jamais plus haute
 * qu'elle n'a besoin.
 *
 * **Les bornes se touchent sans se chevaucher** : un clip qui finit à 12:30 et
 * un qui commence à 12:30 partagent une voie. Les traiter comme un chevauchement
 * ajouterait une voie à toute une émission pour un point de contact.
 *
 * **L'ordre d'entrée départage les ex æquo.** Deux clips au même début tombent
 * dans deux voies, dans l'ordre où la liste les donne — celui du repérage, qui
 * suit l'émission. Un tri stable est ce qui rend la bande identique d'un rendu à
 * l'autre : sans lui, deux relevés successifs échangeraient les voies de deux
 * clips voisins et la bande clignoterait.
 */
export function placerEnVoies<T>(
  items: readonly T[],
  borne: (item: T) => Intervalle | null,
): Placement<T> {
  const bornés = items
    .map((item) => ({ item, intervalle: borne(item) }))
    .filter((x): x is { item: T; intervalle: Intervalle } => x.intervalle !== null)

  // `toSorted` rend une copie : l'ordre de l'appelant — celui du repérage — ne
  // bouge pas sous ses pieds. Et il est stable, ce qui est ici une propriété du
  // rendu et non un détail : voir plus haut.
  const ordonnés = bornés.toSorted((a, b) => a.intervalle.début - b.intervalle.début)

  /** La dernière fin posée dans chaque voie. */
  const fins: number[] = []
  const placés: Placé<T>[] = []

  for (const { item, intervalle } of ordonnés) {
    let voie = fins.findIndex((fin) => fin <= intervalle.début)
    if (voie < 0) {
      voie = fins.length
      fins.push(intervalle.fin)
    } else {
      fins[voie] = intervalle.fin
    }
    placés.push({ item, intervalle, voie })
  }

  return { placés, voies: fins.length }
}

/**
 * La position d'un instant sur la bande, entre 0 et 1.
 *
 * **Bornée des deux côtés.** La durée de l'émission vient de `ProjectSummary` et
 * les bornes des clips du repérage : les deux se sont déjà contredites d'une
 * poignée de secondes en fin d'émission, et un bloc dessiné à 101 % déborde de
 * son conteneur au lieu de s'arrêter au bord. Une durée nulle ou absente rend 0
 * partout, ce qui replie la bande sur elle-même plutôt que de propager un
 * `NaN` dans un attribut de style.
 */
export function part(instant: number, duréeSec: number): number {
  if (!Number.isFinite(instant) || !Number.isFinite(duréeSec) || duréeSec <= 0) return 0
  return Math.min(1, Math.max(0, instant / duréeSec))
}

/** La géométrie d'un bloc sur la bande, en pourcentages prêts à poser. */
export type Géométrie = { gauche: number; largeur: number }

/**
 * Où poser un bloc, en pour cent de la largeur de la bande.
 *
 * La largeur peut être **nulle** — un clip dont l'étendue tombe entièrement
 * au-delà de la durée annoncée —, et c'est au rendu de lui donner une largeur
 * minimale en CSS plutôt qu'à ce calcul de mentir sur les bornes. Un `min-width`
 * garde le bloc cliquable sans déplacer son bord gauche, là où élargir ici
 * ferait glisser tout ce qui suit.
 */
export function géométrie(intervalle: Intervalle, duréeSec: number): Géométrie {
  const gauche = part(intervalle.début, duréeSec)
  const droite = part(intervalle.fin, duréeSec)
  return { gauche: gauche * 100, largeur: Math.max(0, droite - gauche) * 100 }
}

/**
 * L'instant que désigne un clic sur la bande, en secondes.
 *
 * `x` et `largeur` sont ceux du rectangle de la bande, en pixels. Une largeur
 * nulle — la bande n'est pas encore mise en page — rend 0 plutôt que l'infini.
 */
export function instantAuClic(x: number, largeur: number, duréeSec: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(largeur) || largeur <= 0) return 0
  if (!Number.isFinite(duréeSec) || duréeSec <= 0) return 0
  return Math.min(duréeSec, Math.max(0, (x / largeur) * duréeSec))
}
