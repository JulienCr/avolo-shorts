import type { Platform } from '@/core/publication'

/**
 * Les échecs nommés de la publication : les quatre natures d'Upload Post de
 * la spec §8 qui remontent par un code HTTP, celles propres aux connecteurs
 * Meta et TikTok directs plus bas, et le refus, propre à ce dépôt, de
 * republier une plateforme déjà en ligne sans un geste explicite. La
 * cinquième nature de la spec — l'audit non passé — ne se voit qu'à la
 * visibilité du résultat, jamais dans un statut : elle n'a pas d'erreur à elle.
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

/**
 * Les échecs nommés du connecteur Meta direct (`meta.ts`, issue #146), même
 * discipline que les quatre ci-dessus : un code Graph API se lit en une
 * fois, ici, plutôt que d'être redécouvert au point d'appel.
 */

/** Le jeton Facebook Login a expiré ou a été révoqué. Rejouer `scripts/dev-connect-meta.ts`. */
export class MetaTokenExpiredError extends Error {
  constructor(detail: string) {
    super(`Meta refuse le jeton : ${detail} Rejouer pnpm tsx scripts/dev-connect-meta.ts.`)
    this.name = 'MetaTokenExpiredError'
  }
}

/** Le débit est atteint : 100 publications/24 h sur Instagram, 30 sur Facebook. */
export class MetaRateLimitError extends Error {
  constructor(detail: string) {
    super(`Le débit Meta est atteint : ${detail} Attendre la fenêtre de 24 h glissante.`)
    this.name = 'MetaRateLimitError'
  }
}

/** Le fichier est refusé, ou le conteneur Instagram a échoué (`status_code` autre que `FINISHED`). */
export class MetaFileRefusedError extends Error {
  constructor(detail: string) {
    super(`Meta refuse le fichier : ${detail}`)
    this.name = 'MetaFileRefusedError'
  }
}

/** App id/secret absents, Page non rattachée, ou type de compte Instagram inadapté. */
export class MetaAccountMisconfiguredError extends Error {
  constructor(detail: string) {
    super(`Le compte Meta est mal configuré : ${detail}`)
    this.name = 'MetaAccountMisconfiguredError'
  }
}

/**
 * `error_subcode: 2207085` sur `media_publish` — mesuré le 23 août 2026
 * (issue #146, `docs/lessons.md`) : Meta répond « erreur serveur interne »,
 * qui invite à réessayer, alors que la cause réelle est un droit manquant sur
 * l'actif dans le portefeuille business. Nommée à part pour ne pas laisser
 * ce message trompeur passer tel quel.
 */
export class MetaAssetPermissionError extends Error {
  constructor(detail: string) {
    super(
      `Meta refuse de publier faute de droit sur l'actif (sous-code 2207085), et non ` +
        `d'une panne malgré son message : ${detail} Affecter une personne à ce compte ` +
        `dans le portefeuille business.`,
    )
    this.name = 'MetaAssetPermissionError'
  }
}

/** Le conteneur Instagram n'a jamais atteint `FINISHED` dans le budget de sondage. */
export class MetaContainerTimeoutError extends Error {
  constructor(readonly containerId: string) {
    super(`Le conteneur Instagram ${containerId} n'a pas atteint FINISHED avant l'abandon du sondage.`)
    this.name = 'MetaContainerTimeoutError'
  }
}

/**
 * Les échecs nommés du connecteur TikTok direct (`tiktok.ts`), même discipline
 * que les deux groupes ci-dessus.
 */

/** Le jeton d'accès a expiré ou a été révoqué. Rejouer `scripts/dev-connect-tiktok.ts`. */
export class TikTokTokenExpiredError extends Error {
  constructor(detail: string) {
    super(`TikTok refuse le jeton : ${detail} Rejouer pnpm tsx scripts/dev-connect-tiktok.ts.`)
    this.name = 'TikTokTokenExpiredError'
  }
}

/** Le débit non audité est atteint : 5 utilisateurs publiants par 24 h (spec §2.3). */
export class TikTokRateLimitError extends Error {
  constructor(detail: string) {
    super(`Le débit TikTok est atteint : ${detail} Attendre la fenêtre de 24 h glissante.`)
    this.name = 'TikTokRateLimitError'
  }
}

/** Le fichier est refusé — format, durée ou fenêtre de dépôt (5-64 Mo par morceau). */
export class TikTokFileRefusedError extends Error {
  constructor(detail: string) {
    super(`TikTok refuse le fichier : ${detail}`)
    this.name = 'TikTokFileRefusedError'
  }
}

/** Clé/secret d'app absents, ou aucun jeton appairé (`dev-connect-tiktok.ts` jamais lancé). */
export class TikTokAccountMisconfiguredError extends Error {
  constructor(detail: string) {
    super(`Le compte TikTok est mal configuré : ${detail}`)
    this.name = 'TikTokAccountMisconfiguredError'
  }
}
