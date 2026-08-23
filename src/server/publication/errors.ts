import type { Platform } from '@/core/publication'

/**
 * Les échecs nommés de la publication : les quatre natures d'Upload Post de
 * la spec §8 qui remontent par un code HTTP, et le refus, propre à ce dépôt,
 * de republier une plateforme déjà en ligne sans un geste explicite. La
 * cinquième nature de la spec — l'audit non passé — ne se voit qu'à la
 * visibilité du résultat, jamais dans un statut : elle n'a pas d'erreur à
 * elle.
 *
 * Wiring dans `statusFor` (`src/server/http.ts`), qui est le seul endroit qui
 * décide du code de réponse HTTP. Regroupées ici plutôt que dans
 * `service.ts`, qui les lèverait : `http.ts` doit pouvoir les importer sans
 * fermer un cycle avec `service.ts`, qui importe déjà `http.ts`.
 */

/** Le jeton d'un compte connecté a expiré. Se reconnecte sur upload-post.com. */
export class UploadPostTokenExpiredError extends Error {
  constructor(detail: string) {
    super(`Upload Post refuse le jeton : ${detail} Reconnecter les comptes sur upload-post.com.`)
    this.name = 'UploadPostTokenExpiredError'
  }
}

/**
 * Le quota est atteint. Sur l'offre gratuite, c'est dix envois par mois pour
 * l'ensemble du compte — rare le premier mois, systématique ensuite dès
 * qu'on publie plusieurs clips. Le message cite les chiffres reçus plutôt que
 * d'en supposer, et dit clairement qu'attendre est le seul remède : ce n'est
 * jamais transitoire à l'échelle d'une relance.
 */
export class UploadPostRateLimitError extends Error {
  constructor(readonly usage: { count: number; limit: number } | null) {
    super(
      usage === null
        ? 'Le quota mensuel Upload Post est épuisé. Attendre le mois suivant : réessayer ne débloque rien.'
        : `Le quota mensuel Upload Post est épuisé (${usage.count}/${usage.limit} ce mois-ci). Attendre le mois suivant : réessayer ne débloque rien.`,
    )
    this.name = 'UploadPostRateLimitError'
  }
}

/** Le fichier est refusé — durée, ratio ou taille que la plateforme n'accepte pas. */
export class UploadPostFileRefusedError extends Error {
  constructor(detail: string) {
    super(`Upload Post refuse le fichier : ${detail}`)
    this.name = 'UploadPostFileRefusedError'
  }
}

/** Le compte n'a pas le bon type ou le bon rôle pour publier. */
export class UploadPostAccountMisconfiguredError extends Error {
  constructor(detail: string) {
    super(`Le compte Upload Post est mal configuré : ${detail}`)
    this.name = 'UploadPostAccountMisconfiguredError'
  }
}

/** Republier une plateforme déjà `published` sans `force` explicite (spec §6.5). */
export class PublicationAlreadyPublishedError extends Error {
  constructor(readonly platform: Platform) {
    super(`${platform} est déjà publié pour ce clip. Passer force: true pour republier.`)
    this.name = 'PublicationAlreadyPublishedError'
  }
}
