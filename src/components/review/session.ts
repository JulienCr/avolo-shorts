'use client'

import { useEffect, useRef } from 'react'

import { VIEWS, type View } from '@/components/review/template'

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
 * mais on revient d'un clip par le fil d'Ariane, qui pointe sur `linkProject`,
 * c'est-à-dire une URL sans vue. La copie ne sert qu'à ce cas-là. La position de
 * défilement, elle, n'a rien à faire dans une URL : ce serait une URL qu'on ne
 * peut plus partager.
 *
 * **En session, pas en local** : ces valeurs décrivent un aller-retour en cours,
 * pas une préférence. Les retrouver le lendemain ferait sauter dans une liste
 * sans que le geste l'explique.
 */

export type ReviewState = {
  /** L'identifiant de la carte à retrouver, ou `null`. */
  card: string | null
  /** La position de défilement, en pixels. */
  scroll: number
  /**
   * La vue active, ou `null`.
   *
   * **Elle double l'URL, elle ne la remplace pas.** L'URL reste la vérité — un
   * rechargement doit rendre le même écran, et une URL se partage. Mais on
   * revient d'un clip par le fil d'Ariane, que `chemin` construit sur
   * `linkProject` : une URL nue, sans vue. Sans cette copie, le retour retombait
   * sur « à trier », la carte gardée n'y était pas, et le focus mémorisé n'avait
   * nulle part où se poser. (relevé par Codex)
   */
  view: View | null
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
  returning: boolean
  /**
   * L'instant, en millisecondes depuis l'époque Unix, où `returning` a été posé à `true`.
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

const NEUTRAL: ReviewState = { card: null, scroll: 0, view: null, returning: false, postedAt: null }

/**
 * Une clé par projet : le retour depuis un clip vise **sa** grille.
 *
 * Traduite depuis `avolo-shorts:tri:` (issue #110) — un rechargement en cours
 * de bascule perd sa position de défilement une fois, sans conséquence au-delà.
 */
function key(projectId: string): string {
  return `avolo-shorts:sort:${projectId}`
}

/**
 * Le stockage de session, ou `null`.
 *
 * `null` couvre trois cas d'un coup : le rendu serveur, où il n'existe pas ; la
 * navigation privée de Safari, où la seule lecture peut lever ; et le quota
 * dépassé. **Perdre une position de défilement est ennuyeux, faire tomber
 * l'écran de tri ne l'est pas.**
 */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function lireSessionReview(projectId: string): ReviewState {
  const memory = storage()
  if (memory === null) return NEUTRAL
  try {
    const raw = memory.getItem(key(projectId))
    if (raw === null) return NEUTRAL
    const lu: unknown = JSON.parse(raw)
    if (typeof lu !== 'object' || lu === null) return NEUTRAL
    // **Chaque champ contrôlé séparément.** Ce qui est ici a été écrit par une
    // version précédente de l'écran, ou bricolé à la main : un `carte` numérique
    // passerait tel quel jusque dans un `querySelector`, et un `defilement`
    // textuel jusque dans un `scrollTo`.
    const { card, scroll, view, returning, postedAt } = lu as Partial<ReviewState>
    const storedPostedAt = typeof postedAt === 'number' && Number.isFinite(postedAt) ? postedAt : null
    // Un aller-retour normal vers un clip — l'ouvrir, éventuellement le monter,
    // revenir par le fil d'Ariane — se joue en quelques minutes. Passé ce
    // délai, la marque est plus probablement un départ sans retour (vers la
    // bibliothèque, ou un onglet ouvert en arrière-plan qui n'a jamais navigué)
    // qu'un aller-retour en cours : on ne la restaure plus.
    const MAX_RETURN_AGE_MS = 30 * 60 * 1000
    // L'âge doit être positif : un `postedAt` dans le futur (horloge reculée,
    // clé bricolée à la main) rendrait sinon un âge négatif, toujours
    // inférieur à la limite, et la marque ne périmerait jamais. (relevé par
    // Copilot)
    const age = storedPostedAt !== null ? Date.now() - storedPostedAt : null
    const isFresh = returning === true && age !== null && age >= 0 && age <= MAX_RETURN_AGE_MS
    return {
      card: typeof card === 'string' ? card : null,
      scroll: typeof scroll === 'number' && Number.isFinite(scroll) ? scroll : 0,
      // Comparée à la liste des vues plutôt que crue sur parole : la clé se
      // bricole à la main, et une vue inconnue ferait rendre une grille vide.
      view: VIEWS.some((v) => v.value === view) ? (view as View) : null,
      returning: isFresh,
      postedAt: storedPostedAt,
    }
  } catch {
    return NEUTRAL
  }
}

/**
 * Écrit un ou deux champs, **sans effacer l'autre**.
 *
 * Les deux ne bougent pas ensemble : la carte change à chaque déplacement au
 * clavier, le défilement à chaque roulette. Une écriture complète obligerait
 * chaque appelant à relire d'abord, donc à oublier de le faire une fois.
 */
export function writeSessionReview(projectId: string, state: Partial<ReviewState>): void {
  const memory = storage()
  if (memory === null) return
  try {
    // L'horodatage se pose ici, pas chez l'appelant : c'est le seul endroit
    // qui sait *quand* la marque est posée, et un appelant qui l'oublierait
    // écrirait une marque qui n'expire jamais.
    const timestamp = state.returning === true ? { postedAt: Date.now() } : {}
    memory.setItem(
      key(projectId),
      JSON.stringify({ ...lireSessionReview(projectId), ...state, ...timestamp }),
    )
  } catch {
    // Quota, navigation privée : rien à réparer et rien à dire.
  }
}

/**
 * Restores the focus and scroll a round trip to a clip screen left behind.
 *
 * The clip screen doesn't know this exists: it only leaves by a plain link,
 * and this is the sort screen's own memory of where it was.
 */
export function useReviewSession(
  projectId: string,
  current: string | null,
  view: View,
  focus: (clipId: string | null) => boolean,
): void {
  const poser = useRef(focus)
  useEffect(() => {
    poser.current = focus
  })

  useEffect(() => {
    const { card, scroll, view: memoized, returning } = lireSessionReview(projectId)
    if (!returning) return

    // Scroll first, focus second: a recovered card places the view more
    // precisely than a pixel position, and its `scrollIntoView` then wins.
    if (scroll > 0) window.scrollTo(0, scroll)
    const posed = card !== null && poser.current(card)

    // Replayed per view, only on a marked return: a bare-URL return mounts
    // 'atrier' first and the memoized view lands later, so a mount-only replay
    // would miss it; the mark also keeps an ordinary visit from being hijacked.
    if (posed || memoized === null || memoized === view) {
      writeSessionReview(projectId, { returning: false })
    }
  }, [projectId, view])

  useEffect(() => {
    // Throttled to four writes a second: a scroll event fires every frame,
    // and serializing on each one would pay for a rare read.
    let scheduled = 0
    function onScroll() {
      if (scheduled !== 0) return
      scheduled = window.setTimeout(() => {
        scheduled = 0
        writeSessionReview(projectId, { scroll: window.scrollY })
      }, 250)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      // Flushed before cancelling: opening a clip within the 250ms window
      // unmounted this before the timer wrote, and the return restored the
      // stale position — exactly the gesture this memory exists to serve.
      if (scheduled === 0) return
      window.clearTimeout(scheduled)
      writeSessionReview(projectId, { scroll: window.scrollY })
    }
  }, [projectId])
}
