'use client'

import { VUES, type Vue } from '@/components/tri/modele'

/**
 * Ce qu'un aller-retour vers un clip doit retrouver.
 *
 * L'écran de clip est réentré trois à cinq fois par émission, et il en sort par
 * un simple lien. Sans mémoire, le clavier repart du haut de la page à chaque
 * retour et la grille remonte à zéro : quatre fois par émission, sur l'écran
 * dont le coût se paie trente fois.
 *
 * **La vue reste dans l'URL, et n'est copiée ici qu'en repli.** L'URL est la
 * vérité — un rechargement doit rendre le même écran, et une URL se partage —,
 * mais on revient d'un clip par le fil d'Ariane, qui pointe sur `lienProjet`,
 * c'est-à-dire une URL sans vue. La copie ne sert qu'à ce cas-là. La position de
 * défilement, elle, n'a rien à faire dans une URL : ce serait une URL qu'on ne
 * peut plus partager.
 *
 * **En session, pas en local** : ces valeurs décrivent un aller-retour en cours,
 * pas une préférence. Les retrouver le lendemain ferait sauter dans une liste
 * sans que le geste l'explique.
 */

export type ÉtatDeTri = {
  /** L'identifiant de la carte à retrouver, ou `null`. */
  carte: string | null
  /** La position de défilement, en pixels. */
  defilement: number
  /**
   * La vue active, ou `null`.
   *
   * **Elle double l'URL, elle ne la remplace pas.** L'URL reste la vérité — un
   * rechargement doit rendre le même écran, et une URL se partage. Mais on
   * revient d'un clip par le fil d'Ariane, que `chemin` construit sur
   * `lienProjet` : une URL nue, sans vue. Sans cette copie, le retour retombait
   * sur « à trier », la carte gardée n'y était pas, et le focus mémorisé n'avait
   * nulle part où se poser. (relevé par Codex)
   */
  vue: Vue | null
  /**
   * Y a-t-il un retour de clip à honorer ?
   *
   * **Sans elle, la mémoire s'appliquait à toute visite.** Venir de la
   * bibliothèque emprunte la même URL nue que le fil d'Ariane d'un clip : la
   * session ramenait donc sur « gardés » et volait le focus à quelqu'un qui
   * ouvrait simplement le projet. Cette marque est posée au départ vers un clip
   * et consommée au retour — elle décrit un aller-retour en cours, ce que le
   * reste de ce module prétendait déjà être. (relevé par Codex)
   */
  retour: boolean
  /**
   * L'instant, en millisecondes epoch, où `retour` a été posé à `true`.
   *
   * **Sans horodatage, la marque survit à un départ sans retour.** Elle est
   * posée au clic vers un clip, mais rien ne la retire si l'on quitte ensuite
   * le clip vers la bibliothèque au lieu de revenir au projet : la visite
   * suivante, ordinaire celle-là, restaure une vue et un focus que personne
   * n'a demandés. Un `Ctrl`/`Cmd`/`Shift` + clic pose la même marque sur un
   * onglet qui n'a pas navigué, pour la même raison — c'est un vrai `click`.
   * L'horodatage ferme les deux d'un coup : lu, la marque expire d'elle-même.
   * (Le clic du milieu, lui, émet `auxclick` et ne pose jamais la marque —
   * rien à corriger de ce côté.)
   */
  postedAt: number | null
}

const NEUTRE: ÉtatDeTri = { carte: null, defilement: 0, vue: null, retour: false, postedAt: null }

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
    const { carte, defilement, vue, retour, postedAt } = lu as Partial<ÉtatDeTri>
    const posteA = typeof postedAt === 'number' && Number.isFinite(postedAt) ? postedAt : null
    // Un aller-retour normal vers un clip — l'ouvrir, éventuellement le monter,
    // revenir par le fil d'Ariane — se joue en quelques minutes. Passé ce
    // délai, la marque est plus probablement un départ sans retour (vers la
    // bibliothèque, ou un onglet ouvert en arrière-plan qui n'a jamais navigué)
    // qu'un aller-retour en cours : on ne la restaure plus.
    const MAX_RETURN_AGE_MS = 30 * 60 * 1000
    const retourFrais = retour === true && posteA !== null && Date.now() - posteA <= MAX_RETURN_AGE_MS
    return {
      carte: typeof carte === 'string' ? carte : null,
      defilement: typeof defilement === 'number' && Number.isFinite(defilement) ? defilement : 0,
      // Comparée à la liste des vues plutôt que crue sur parole : la clé se
      // bricole à la main, et une vue inconnue ferait rendre une grille vide.
      vue: VUES.some((v) => v.valeur === vue) ? (vue as Vue) : null,
      retour: retourFrais,
      postedAt: posteA,
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
    // L'horodatage se pose ici, pas chez l'appelant : c'est le seul endroit
    // qui sait *quand* la marque est posée, et un appelant qui l'oublierait
    // écrirait une marque qui n'expire jamais.
    const horodatage = état.retour === true ? { postedAt: Date.now() } : {}
    mémoire.setItem(
      clé(projectId),
      JSON.stringify({ ...lireSessionTri(projectId), ...état, ...horodatage }),
    )
  } catch {
    // Quota, navigation privée : rien à réparer et rien à dire.
  }
}
