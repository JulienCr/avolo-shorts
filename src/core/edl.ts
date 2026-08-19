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

/**
 * Les quatre ratios de sortie. Le ratio se choisit **par clip** : sur trois
 * émissions mesurées, seuls 24 à 33 % du temps tiennent dans un 9:16, contre
 * 48 % jusqu'au 1:1 (spec §2). Tout sortir en 9:16 jette la moitié du matériel.
 */
export type Ratio = '9:16' | '4:5' | '1:1' | '16:9'

/**
 * Le cycle de vie d'un clip. `candidate` est ce que la machine propose ;
 * les trois autres sont des décisions humaines, et à ce titre elles survivent à
 * une nouvelle passe de repérage.
 */
export type ClipStatus = 'candidate' | 'kept' | 'discarded' | 'exported'

/**
 * Un clip : une liste de segments et la manière de les rendre.
 *
 * Il n'y a **ni `start`, ni `end`, ni durée** à ce niveau — la durée se calcule
 * par `clipDuration(clip.segments)`. Ajouter ici un couple début/fin ferait
 * réapparaître la fenêtre fixe que ce projet remplace.
 */
export type Clip = {
  id: string
  projectId: string
  segments: Segment[]
  /**
   * `'auto'` laisse le cadrage décider. En itération 0, le cadrage automatique
   * n'existe pas encore et `resolveRatio` (tâche 5) le rabat sur 9:16.
   */
  ratio: Ratio | 'auto'
  /**
   * Le centre horizontal du crop, entre 0 et 1. `0.5` = centré.
   *
   * Un seul nombre suffit parce que le crop est **pleine hauteur** (spec §2) :
   * dans une image 16:9, la hauteur est toujours prise en entier et seule la
   * position horizontale reste à décider. Un rectangle à quatre composantes
   * offrirait trois degrés de liberté qui n'existent pas.
   */
  cropX: number
  captions: boolean
  branding: boolean
  title: string
  description: string
  status: ClipStatus
  /** Le numéro de passe de repérage qui a produit ce clip. */
  pass: number
}

/**
 * La forme canonique d'une liste de segments : triée, sans chevauchement, sans
 * segment vide ou inversé.
 *
 * Deux segments qui se touchent (`end === start` du suivant) fusionnent aussi :
 * ils désignent le même morceau continu de source, et les garder séparés
 * ouvrirait un décodeur ffmpeg de plus pour rien (tâche 5).
 *
 * Toutes les opérations ci-dessous s'y ramènent en sortie, ce qui les rend
 * composables : le résultat de l'une est une entrée valide pour la suivante.
 */
export function normalizeSegments(segments: Segment[]): Segment[] {
  // `filter` rend un nouveau tableau : le `sort` qui suit ne réordonne jamais
  // celui de l'appelant.
  const sorted = segments.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)

  const out: Segment[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    // `last` est une copie fraîche, jamais un segment de l'appelant : l'étendre
    // ne modifie rien à l'extérieur.
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/**
 * Retire l'intervalle `[from, to]` de la liste.
 *
 * C'est **l'opération centrale du produit**, et elle couvre à elle seule les
 * quatre demandes de l'utilisateur (spec §5) :
 *
 * - retirer une digression → coupe un segment en deux ;
 * - retirer les hésitations → le même appel, répété ;
 * - rétrécir le clip → un retrait qui mord sur une borne ;
 * - connaître la durée → `clipDuration` du résultat.
 *
 * Rien ne plafonne la durée obtenue, dans un sens comme dans l'autre : c'est
 * un résultat, jamais une contrainte.
 */
export function removeRange(segments: Segment[], from: number, to: number): Segment[] {
  const out: Segment[] = []
  for (const s of segments) {
    // Le retrait ne touche pas ce segment : il tombe avant, après, ou dans un
    // trou entre deux segments.
    if (to <= s.start || from >= s.end) {
      out.push({ ...s })
      continue
    }
    // Ce qui précède le retrait, puis ce qui le suit. Les deux existent quand le
    // retrait tombe au milieu — c'est là que le segment se coupe en deux ; aucun
    // des deux quand le retrait couvre le segment entier, qui disparaît alors.
    if (from > s.start) out.push({ start: s.start, end: from })
    if (to < s.end) out.push({ start: to, end: s.end })
  }
  return normalizeSegments(out)
}

/**
 * Déplace la borne extérieure du clip : le début du premier segment, ou la fin
 * du dernier.
 *
 * Seules les bornes extérieures se déplacent — c'est ce que l'utilisateur voit
 * comme « étendre » ou « rétrécir » le clip. Les bornes intérieures, elles, sont
 * la trace des retraits déjà faits : les bouger reviendrait à annuler une coupe,
 * ce qui est une autre opération.
 *
 * `to` n'est pas contraint : étendre n'a pas de plafond, et rétrécir traverse
 * autant de segments qu'il faut, jusqu'à vider le clip.
 *
 * **Une réserve, et elle vise l'interface.** La borne obtenue vaut `to`, *sauf*
 * quand `to` tombe dans un trou entre deux segments : il n'y a alors rien à
 * monter entre `to` et le segment suivant, et la borne se pose sur celui-ci.
 * `moveBoundary([{10,20},{30,40}], 'start', 25)` rend `[{30,40}]`, dont la borne
 * est 30 et non 25. Donc ne pas afficher `to` comme la borne du clip : relire la
 * liste rendue.
 */
export function moveBoundary(segments: Segment[], edge: 'start' | 'end', to: number): Segment[] {
  // Normaliser **avant** de choisir la borne, et pas seulement après. « Premier »
  // et « dernier » veulent dire dans l'ordre du temps, pas dans celui du
  // tableau : sur une liste arrivée désordonnée — d'un JSON, de la base — un
  // `segments[0]` brut déplacerait la borne d'un segment du milieu, sans erreur
  // et sans trace.
  const segs = normalizeSegments(segments)
  if (segs.length === 0) return []

  // Deux gestes distincts, et c'est le sens de `to` qui les sépare.
  //
  // **Étendre** ajoute de la source que le clip n'avait pas : seul le segment
  // extérieur bouge, il n'y a rien d'autre à toucher.
  //
  // **Rétrécir** est un *retrait* — tout ce qui précède `to` (ou le suit) sort
  // du clip — et le passer par `removeRange` est ce qui le rend correct quand la
  // borne traverse plusieurs segments. Déplacer seulement la borne du segment
  // extérieur l'inversait, `normalizeSegments` le jetait, et le voisin n'était
  // pas rogné : demander 35 sur `[{10,20},{30,40}]` rendait 30. La valeur
  // demandée disparaissait sans erreur — le pire des deux mondes.
  if (edge === 'start') {
    const first = segs[0]
    if (to <= first.start) {
      first.start = to
      return normalizeSegments(segs)
    }
    return removeRange(segs, first.start, to)
  }

  const last = segs[segs.length - 1]
  if (to >= last.end) {
    last.end = to
    return normalizeSegments(segs)
  }
  return removeRange(segs, to, last.end)
}
