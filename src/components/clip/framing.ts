'use client'

/**
 * Ce que l'écran de clip lit du cadrage **que le serveur publie**.
 *
 * `computeFraming` a besoin des plans, des boîtes de personnes et des dimensions
 * de la source. Rien de tout cela n'est ici : `analysis.json` pèse deux à trois
 * méga-octets par projet, et le navigateur n'a aucune raison de le charger pour
 * dessiner un rectangle. Le serveur résout, publie `ClipDetail.framing` — et le
 * renvoie à chaque `PATCH`, puisque le ratio se recalcule sur les segments —, et
 * ce module ne fait que le lire.
 *
 * Les fonctions sont pures ; le seul `hook` est celui qui suit la lecture, et il
 * ne rend qu'un **nombre** pour ne pas réveiller le rectangle quatre fois par
 * seconde.
 */

import { usePlayback } from '@/components/clip/playback'
import type { Ratio } from '@/core/edl'
import type { PublishedFraming, ShotFraming } from '@/lib/api'
import { ORDER_RATIOS } from '@/lib/crop-preview'

/**
 * Le ratio du cadre pris dans la source pour **ce plan**, tel que l'écran peut
 * le savoir tout de suite.
 *
 * **Ce n'est pas le format du fichier natif**, qui vaut le plus large des plans
 * (`PublishedFraming.ratio`) d'un bout à l'autre du clip. C'est le cadre que la
 * **variante 9:16** pose sur son canevas vertical, le fond flouté remplissant ce
 * qui reste. (relevé par Copilot)
 *
 * Un ratio épinglé est celui-là, sans attendre : `computeFraming` le prend
 * verbatim pour tous les plans et n'a que les crops à recalculer. C'est ce qui
 * évite que le sélecteur, qui est le contrôle le plus manipulé de cet écran,
 * réponde avec six cents millisecondes de retard à chaque clic.
 *
 * Sur `auto`, en revanche, seul le serveur sait : on affiche le dernier cadrage
 * publié jusqu'à ce que le `PATCH` en rende un neuf.
 */
export function effectiveRatio(
  shot: ShotFraming | null,
  editedRatio: Ratio | 'auto',
): Ratio {
  if (editedRatio !== 'auto') return editedRatio
  return shot?.ratio ?? '16:9'
}

/**
 * Les ratios distincts que les plans du clip prennent, du plus étroit au plus
 * large.
 *
 * L'écran s'en sert pour dire, en un mot, que le cadre ne sera pas le même d'un
 * bout à l'autre : le ratio se choisit **par plan**, et ne rien en dire ferait
 * passer un saut de taille voulu pour un défaut de rendu.
 */
export function shotRatios(framing: PublishedFraming): Ratio[] {
  const seen = new Set(framing.shots.map((p) => p.ratio))
  return ORDER_RATIOS.filter((r) => seen.has(r))
}

/**
 * Un plan au moins pose-t-il un split-screen ?
 *
 * Vaut seulement pour la **variante 9:16** (spec du 25 août) : le natif ignore
 * `split` et garde toujours un crop unique.
 */
export function anyShotSplit(framing: PublishedFraming): boolean {
  return framing.shots.some((p) => p.split !== undefined)
}

/**
 * Le cadrage est-il celui que la machine a calculé ?
 *
 * Faux quand l'analyse manque, ne se lit pas, ou ne recouvre pas le montage : le
 * serveur se rabat alors sur le réglage manuel du clip, et **c'est ce cas-là qui
 * laisse le curseur utile**. Le confondre avec le cas calculé ferait l'un des
 * deux défauts, selon le sens : un curseur qui ne fait rien, ou un cadrage
 * automatique qu'on écrase sans l'avoir voulu.
 */
export function isComputedFraming(framing: PublishedFraming): boolean {
  return framing.origin === 'computed'
}

/**
 * L'index du plan sous cette position de lecture, ou `-1`.
 *
 * Les bornes sont celles de la **source**, comme la position : le lecteur joue
 * le proxy et saute les passages retirés, donc son horloge est celle de
 * l'émission, pas celle du clip monté.
 *
 * `start <= t < end` : les plans se suivent bout à bout, et une frontière
 * appartient au plan qui commence, jamais aux deux.
 */
export function shotIndexAt(shots: readonly ShotFraming[], position: number): number {
  return shots.findIndex((p) => p.shot.start <= position && position < p.shot.end)
}

/**
 * Le plan sous la lecture, **sans réveiller le composant à chaque `timeupdate`**.
 *
 * Le sélecteur rend un index, donc un nombre : `usePlayback` compare par
 * `Object.is` et ne re-rend qu'aux frontières, soit quelques fois par clip. Un
 * sélecteur qui rendrait le plan lui-même fabriquerait un objet neuf quatre fois
 * par seconde et re-rendrait le rectangle de cadrage à cette cadence — ce que le
 * store de lecture existe précisément pour éviter.
 *
 * **Deux absences, et une seule vaut le premier plan.** Avant la première
 * `timeupdate` la position vaut zéro, donc tombe avant le début du clip : montrer
 * le cadre du premier plan est ce que le rendu montrera à sa première image, là
 * où un cadre centré serait une image que personne ne verra.
 *
 * **Un intervalle qu'aucun plan ne couvre, lui, rend `null`** — et les appelants
 * retombent alors sur le 16:9 centré, exactement ce que `splitByShot` donne
 * au rendu dans le même cas. Le cas est atteignable : les plans partitionnent la
 * durée du *proxy*, et la source peut finir quelques images plus loin. Y montrer
 * le cadre du premier plan ferait dire à l'écran autre chose que ce que le
 * fichier contiendra, ce qui est précisément ce que cette PR ferme.
 * (relevé par Codex)
 */
export function useCurrentShot(framing: PublishedFraming): ShotFraming | null {
  const index = usePlayback((e) => shotIndexAt(framing.shots, e.position))
  const beforeFirst = usePlayback(
    (e) => framing.shots.length > 0 && e.position < framing.shots[0].shot.start,
  )
  if (index >= 0) return framing.shots[index]
  return beforeFirst ? framing.shots[0] : null
}

/**
 * Combien de plans **que personne n'a cadrés**, ni la machine ni l'humain — le
 * détecteur n'y a rien mesuré, et ils sont posés au centre par défaut.
 *
 * §3.5 demande que ce cas soit distinct des deux autres, et c'est le seul des
 * trois qui vaille un compte : ce n'est pas une décision, c'est un plan qu'il
 * faut aller regarder. Compter les deux autres ne dirait rien de plus que le
 * total, dont ils sont le complément.
 */
export function unmeasuredShots(framing: PublishedFraming): number {
  return framing.shots.filter((p) => p.source === 'default').length
}

/**
 * Ce que l'écran dit d'un cadrage qui n'a pas pu être calculé, ou `null` quand
 * il l'a été.
 *
 * **Se rabattre en silence serait le défaut à éviter**, pas le repli lui-même :
 * `renders` ne dépend pas d'`analysis` dans le graphe (`src/core/graph.ts`, et
 * c'est délibéré), donc rien ne garantit qu'un clip en `auto` ait des plans sous
 * la main. Un 9:16 centré posé sans un mot ne se verrait qu'à l'image, trois
 * minutes d'export plus tard.
 *
 * Le message vient d'ici et non du serveur : ce n'est pas une exception qu'on
 * relaie, c'est une énumération dont chaque cas a son remède.
 */
export function originMessage(framing: PublishedFraming): string | null {
  switch (framing.origin) {
    case 'computed':
      return null
    case 'no-analysis':
      return "L’analyse d’image n’a pas tourné sur ce projet : le cadrage reste celui réglé à la main, et « auto » vaut 9:16. La lancer depuis l’écran du projet."
    case 'unreadable-analysis':
      return "L’analyse d’image de ce projet ne se lit pas : le cadrage reste celui réglé à la main, et « auto » vaut 9:16. La relancer depuis l’écran du projet."
    case 'no-shots':
      return "Aucun plan de l’analyse ne recouvre ce montage : le cadrage reste celui réglé à la main."
  }
}
