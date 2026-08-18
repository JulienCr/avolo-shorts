/**
 * Le modèle de l'écran de tri : ce que les composants lisent, et qui ne dépend
 * ni du DOM ni du réseau.
 *
 * Il vit à côté des composants qui s'en servent, pas dans `src/core/` : il
 * connaît `@/lib/api` — donc une forme de réponse HTTP — et il compose des
 * phrases d'interface. Ce qui est en revanche vrai partout — la définition de
 * « gardé », les comptes du fil de tri, la phase — est dans `@/core/parcours`
 * et n'est pas recopié ici.
 */

import type { ClipStatus } from '@/core/edl'
import { estEcarte, estGarde } from '@/core/parcours'
import type { BilanRepérage } from '@/lib/api'

/**
 * Les trois vues du tri.
 *
 * **Trois vues, pas un booléen.** L'écran basculait « voir les écartés » d'un
 * bouton fantôme, ce qui ne sait pas dire « montre-moi ce que j'ai gardé » —
 * la question qu'on se pose à la fin de la boucle, et celle qui ouvre le
 * montage.
 */
export type Vue = 'atrier' | 'gardes' | 'ecartes'

export const VUES: readonly { valeur: Vue; libelle: string }[] = [
  { valeur: 'atrier', libelle: 'À trier' },
  { valeur: 'gardes', libelle: 'Gardés' },
  { valeur: 'ecartes', libelle: 'Écartés' },
]

/**
 * La vue nommée par l'URL, ou celle par défaut.
 *
 * **La vue active vit dans l'URL** (`?vue=gardes`) parce qu'un rechargement doit
 * rendre le même écran. La position de défilement et le focus, eux, restent en
 * session : une position de défilement dans une URL est une URL qu'on ne peut
 * plus partager.
 *
 * Tout ce qui n'est pas l'une des trois retombe sur « à trier » : une URL se
 * recopie et se bricole, et une valeur inconnue doit rendre un écran plutôt
 * qu'une page vide.
 */
export function vueDepuisUrl(valeur: string | null): Vue {
  return VUES.some((v) => v.valeur === valeur) ? (valeur as Vue) : 'atrier'
}

/** Le clip appartient-il à cette vue ? */
export function appartient(status: ClipStatus, vue: Vue): boolean {
  if (vue === 'gardes') return estGarde(status)
  if (vue === 'ecartes') return estEcarte(status)
  return status === 'candidate'
}

/**
 * Les identifiants d'une vue, **dans l'ordre reçu**.
 *
 * L'ordre des candidats est celui du repérage, qui suit l'émission. Le
 * réordonner ferait perdre le fil de ce qu'on vient de voir.
 *
 * Des identifiants et non des clips : c'est cette liste que l'écran fige au
 * changement de vue pour qu'une carte décidée ne bouge pas sous la main, et une
 * liste de clips figée porterait aussi des statuts périmés.
 */
export function idsPourVue(
  clips: readonly { id: string; status: ClipStatus }[],
  vue: Vue,
): string[] {
  return clips.filter((c) => appartient(c.status, vue)).map((c) => c.id)
}

/**
 * Ce que l'écran dit de ce que le repérage n'a pas jugé.
 *
 * **Ce n'est pas décoratif** (spec §7.2). Sur `2025-06-15-cqlp`, quatre lots sur
 * onze reviennent refusés par le filtre de sécurité de Gemini : un tiers du
 * matériau est écarté **sans être jugé, en silence**. Sans ce mot à l'écran, on
 * trie vingt-cinq cartes en croyant regarder ce que l'émission a de mieux, alors
 * qu'on regarde ce qu'elle a de mieux dans les deux tiers qui ont été notés.
 *
 * Trois règles portent cette fonction :
 *
 * - **on dit ce qu'on a mesuré.** Le serveur compte des **lots**, et « sept lots
 *   sur onze » ne font 64 % de rien : les fenêtres se chevauchent d'environ 30 s
 *   et le dernier lot est plus court. `couverture` est la vraie mesure — l'union
 *   des fenêtres notées rapportée à l'étendue du transcript —, donc c'est elle
 *   qui porte la phrase ; les lots ne viennent qu'en explication ;
 * - **ça ne porte pas de fausse action.** `buildWindows` et le découpage en lots
 *   sont déterministes, et le serveur traite le refus comme reproductible : une
 *   seconde passe soumettrait exactement les mêmes charges pour se faire refuser
 *   pareil. On énonce la perte, on ne feint pas de la réparer ;
 * - **`provisoire` vient du serveur**, qui le calcule sur le sort de l'étape
 *   `candidates` et non sur celui de l'exécution qui la porte. Le refabriquer
 *   depuis `error` marquerait provisoire un repérage complet dès qu'une étape
 *   ultérieure tombe.
 */
export type MotDuRepérage = {
  /** Vrai quand une part du matériau n'a pas été jugée. */
  perte: boolean
  /** Vrai quand la passe ne s'est pas terminée : le décompte est provisoire. */
  provisoire: boolean
  /** La phrase principale, celle qui vit à côté du compte. */
  phrase: string
  /** Ce qui la cause, ou `null` quand rien de plus n'est su. */
  detail: string | null
}

export function motDuRepérage(bilan: BilanRepérage | null): MotDuRepérage | null {
  if (bilan === null) return null

  const provisoire = bilan.partiel

  // Aucune fenêtre à noter : un transcript vide, ou une passe qui n'a rien eu à
  // soumettre. Pas de dénominateur, donc pas de pourcentage.
  if (bilan.fenêtres <= 0) {
    return { perte: false, provisoire, phrase: 'Le repérage n’avait aucune fenêtre à noter.', detail: null }
  }

  const perte = bilan.notées < bilan.fenêtres || bilan.lotsRefusés > 0
  if (!perte) {
    return {
      perte: false,
      provisoire,
      phrase:
        bilan.fenêtres === 1
          ? 'Le repérage a noté la fenêtre de l’émission.'
          : `Le repérage a noté les ${bilan.fenêtres} fenêtres de l’émission.`,
      detail: null,
    }
  }

  // **Arrondi vers le bas.** Au plus proche, 99,6 % s'affiche « 100 % » et
  // dément la perte que la même phrase annonce deux mots plus loin. Vers le bas,
  // 100 % ne sort que d'une couverture exacte — ce qui arrive : deux fenêtres
  // voisines se chevauchant, celle du milieu peut manquer sans laisser de trou.
  const part = Math.max(0, Math.min(100, Math.floor((bilan.couverture || 0) * 100)))

  const lots = bilan.lotsRefusés + bilan.lotsRépondus
  const detail =
    bilan.lotsRefusés > 0
      ? `${bilan.lotsRefusés === 1 ? '1 lot de fenêtres' : `${bilan.lotsRefusés} lots de fenêtres`} sur ${lots} ${
          bilan.lotsRefusés === 1 ? 'a été refusé' : 'ont été refusés'
        } par le filtre de sécurité du modèle. Le découpage est déterministe : une nouvelle passe soumettrait les mêmes lots et obtiendrait le même refus.`
      : null

  return {
    perte: true,
    provisoire,
    phrase: `Le repérage n’a jugé que ${part} % de ce qui se dit dans l’émission : ${bilan.notées} ${
      bilan.notées === 1 ? 'fenêtre' : 'fenêtres'
    } sur ${bilan.fenêtres}.`,
    detail,
  }
}

/**
 * Un compte et son nom, accordés.
 *
 * Le français accorde au singulier jusqu'à un exclu compris : « 0 clip gardé »,
 * « 1 clip gardé », « 2 clips gardés ». La règle est écrite ici parce que
 * l'écran de tri l'applique à quatre comptes qui bougent à chaque décision, et
 * qu'un `n > 1 ? 's' : ''` recopié quatre fois finit par en oublier un.
 */
export function accord(n: number, singulier: string, pluriel: string): string {
  return `${n} ${n <= 1 ? singulier : pluriel}`
}
