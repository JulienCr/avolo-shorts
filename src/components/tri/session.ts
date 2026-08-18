'use client'

/**
 * Ce qu'un aller-retour vers un clip doit retrouver.
 *
 * L'écran de clip est réentré trois à cinq fois par émission, et il en sort par
 * un simple lien. Sans mémoire, le clavier repart du haut de la page à chaque
 * retour et la grille remonte à zéro : quatre fois par émission, sur l'écran
 * dont le coût se paie trente fois.
 *
 * **Deux choses ici, une troisième dans l'URL.** La vue active (`?vue=gardes`)
 * est dans l'URL parce qu'un rechargement doit rendre le même écran. La position
 * de défilement et la carte d'où l'on est parti sont ici, parce qu'une position
 * de défilement dans une URL est une URL qu'on ne peut plus partager.
 *
 * **En session, pas en local** : ces deux valeurs décrivent un aller-retour en
 * cours, pas une préférence. Les retrouver le lendemain ferait sauter dans une
 * liste sans que le geste l'explique.
 */

export type ÉtatDeTri = {
  /** L'identifiant de la carte à retrouver, ou `null`. */
  carte: string | null
  /** La position de défilement, en pixels. */
  defilement: number
}

const NEUTRE: ÉtatDeTri = { carte: null, defilement: 0 }

/** Une clé par projet : le retour depuis un clip vise **sa** grille. */
function clé(projectId: string): string {
  return `avolo-shorts:tri:${projectId}`
}

/**
 * Le stockage de session, ou `null`.
 *
 * `null` couvre trois cas d'un coup : le rendu serveur, où il n'existe pas ; la
 * navigation privée de Safari, où la seule lecture peut lever ; et le quota
 * dépassé. **Perdre une position de défilement est ennuyeux, faire tomber
 * l'écran de tri ne l'est pas.**
 */
function stockage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function lireSessionTri(projectId: string): ÉtatDeTri {
  const mémoire = stockage()
  if (mémoire === null) return NEUTRE
  try {
    const brut = mémoire.getItem(clé(projectId))
    if (brut === null) return NEUTRE
    const lu: unknown = JSON.parse(brut)
    if (typeof lu !== 'object' || lu === null) return NEUTRE
    // **Chaque champ contrôlé séparément.** Ce qui est ici a été écrit par une
    // version précédente de l'écran, ou bricolé à la main : un `carte` numérique
    // passerait tel quel jusque dans un `querySelector`, et un `defilement`
    // textuel jusque dans un `scrollTo`.
    const { carte, defilement } = lu as Partial<ÉtatDeTri>
    return {
      carte: typeof carte === 'string' ? carte : null,
      defilement: typeof defilement === 'number' && Number.isFinite(defilement) ? defilement : 0,
    }
  } catch {
    return NEUTRE
  }
}

/**
 * Écrit un ou deux champs, **sans effacer l'autre**.
 *
 * Les deux ne bougent pas ensemble : la carte change à chaque déplacement au
 * clavier, le défilement à chaque roulette. Une écriture complète obligerait
 * chaque appelant à relire d'abord, donc à oublier de le faire une fois.
 */
export function écrireSessionTri(projectId: string, état: Partial<ÉtatDeTri>): void {
  const mémoire = stockage()
  if (mémoire === null) return
  try {
    mémoire.setItem(clé(projectId), JSON.stringify({ ...lireSessionTri(projectId), ...état }))
  } catch {
    // Quota, navigation privée : rien à réparer et rien à dire.
  }
}
