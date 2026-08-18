/**
 * L'EDL — la liste des morceaux de source qui composent un clip.
 *
 * Un clip est une **liste de segments**, pas un couple début/fin. C'est la
 * décision qui porte tout le produit : une vanne de 90 secondes se raccourcit en
 * retirant son milieu, pas en tronquant sa chute. La durée en est un *résultat*,
 * jamais une entrée, et rien nulle part ne la plafonne.
 */

export type Segment = { start: number; end: number }

/**
 * La durée du clip : la somme des segments. Les trous entre eux ne comptent pas,
 * puisqu'ils ne sont pas montés.
 *
 * Un segment inversé (`end < start`) compte pour zéro plutôt que de retrancher
 * du temps à ses voisins.
 */
export function clipDuration(segments: Segment[]): number {
  return segments.reduce((total, s) => total + Math.max(0, s.end - s.start), 0)
}
