import type { Platform, PlatformAvailability } from '@/core/publication'
import type { Environment } from '@/server/secrets'

/**
 * L'interface partagée par tout connecteur de publication.
 *
 * **Déclaration canonique** : un futur `meta.ts` et l'écran qui branchera
 * `onLaunch`/`availability` (après #142 et #143) en héritent tel quel. Ne pas
 * le redéfinir ailleurs, et ne pas « simplifier » une des dissymétries
 * ci-dessous — chacune a une raison propre.
 */
export type PublicationJob = {
  clipId: string
  /** Chemin absolu sur le disque du serveur — jamais une URL (spec §3). */
  videoPath: string
  title: string
  description: string
  /** L'empreinte de rendu au moment du lancement, voir `PublicationRecord.publishedFingerprint`. */
  fingerprint: string
}

export type PlatformOutcome =
  | { status: 'in_progress'; requestId: string }
  | { status: 'submitted'; remoteId: string | null; remoteUrl: string | null }
  | { status: 'published'; remoteId: string | null; remoteUrl: string | null }
  | { status: 'failed'; error: string }

export type PublicationAdapter = {
  readonly platforms: readonly Platform[]
  /**
   * **Mesurée, pas déduite de l'environnement.** Une clé API valide ne dit
   * rien des comptes réellement connectés au profil — un compte Upload Post
   * peut porter une clé qui marche et n'avoir relié qu'une seule plateforme.
   * Ce contrôle-ci interroge le compte lui-même ; un environnement sans clé ni
   * profil rend `not_configured` pour les quatre sans réseau, une clé
   * injoignable rend `unavailable` — les deux raisons existent précisément
   * pour ne pas se confondre : la première dit « rien à faire pour l'instant »,
   * la seconde « quelque chose ne répond pas ».
   */
  availability(env: Environment): Promise<Record<Platform, PlatformAvailability>>
  /**
   * **Un `job`, un ensemble de `platforms` — jamais une plateforme seule.**
   * Une requête Upload Post porte `platform[]=…` en répétition et un seul
   * fichier vidéo : un appel par plateforme paierait le téléversement autant
   * de fois qu'il y a de plateformes visées. Le retour, en revanche, est un
   * résultat **par** plateforme : un échec Instagram n'annule ni ne rejoue une
   * réussite TikTok (spec §6.4).
   */
  publish(
    job: PublicationJob,
    platforms: readonly Platform[],
  ): Promise<Record<Platform, PlatformOutcome>>
  /** Relit l'état d'un envoi déjà lancé, par le `requestId` qu'il a rendu. */
  poll(
    requestId: string,
    platforms: readonly Platform[],
  ): Promise<Record<Platform, PlatformOutcome>>
}
