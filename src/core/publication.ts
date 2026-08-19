/**
 * La publication vers les réseaux, **le calcul pur**.
 *
 * Ce module ne parle à rien : ni réseau, ni base, ni fichier. Il porte les
 * quatre plateformes, les sept états qu'une paire clip/plateforme peut
 * prendre, et les deux garde-fous que la conception impose (un clip non
 * exporté ne se publie pas, une publication déjà en ligne ne se refait pas
 * sans un geste explicite). Voir
 * `docs/superpowers/specs/2026-08-18-publication-reseaux-design.md` pour la
 * conception d'ensemble — ce fichier n'en code que ce qui est prêt aujourd'hui.
 *
 * **Rien n'est branché.** Aucun connecteur n'existe pour aucune des quatre
 * plateformes : `defaultPlatformAvailability` rend donc `not_configured` pour
 * les quatre, et c'est l'état honnête. `PlatformUnavailableReason` porte
 * aussi `audit_required`, prêt pour le jour où TikTok et YouTube existeront
 * en connecteur mais attendront encore leur audit (deux à six semaines,
 * refus possible) — mais rien ici ne le sélectionne encore.
 *
 * **Le nom `Platform`, pas `Plateforme`.** Le code neuf de ce dépôt s'écrit en
 * anglais (`CLAUDE.md`) ; la conception de la publication, rédigée avant que
 * cette règle ne soit énoncée pour du code, nommait le type `Plateforme`. Ce
 * module suit la règle en vigueur plutôt que le nom de la conception, et le
 * jour où un connecteur s'écrira, il suivra cette même règle.
 */

import type { ClipStatus } from '@/core/edl'

/** Les quatre réseaux dans le périmètre (spec publication §4). */
export type Platform = 'instagram' | 'facebook' | 'tiktok' | 'youtube'

export const PLATFORMS: readonly Platform[] = ['instagram', 'facebook', 'tiktok', 'youtube']

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube Shorts',
}

/**
 * L'état d'une publication déjà lancée pour un couple clip/plateforme.
 *
 * **`submitted` n'est pas `published`, et c'est le point qui compte** (retour
 * d'usage §2.4 et §8) : TikTok dépose un brouillon que quelqu'un publie
 * ensuite depuis l'application. Les confondre ferait annoncer comme publié ce
 * qui attend encore une main.
 */
export type PublicationStatus = 'in_progress' | 'submitted' | 'published' | 'failed'

export const PUBLICATION_STATUS_LABELS: Record<PublicationStatus, string> = {
  in_progress: 'en cours',
  submitted: 'déposé',
  published: 'publié',
  failed: 'échec',
}

/**
 * Pourquoi une plateforme n'est pas actionnable — une raison de
 * **configuration**, pas de publication : elle ne décrit jamais un couple
 * clip/plateforme, seulement la plateforme elle-même.
 */
export type PlatformUnavailableReason = 'not_configured' | 'unavailable' | 'audit_required'

export const PLATFORM_UNAVAILABLE_REASON_LABELS: Record<PlatformUnavailableReason, string> = {
  not_configured: 'Aucun connecteur n’est encore branché pour cette plateforme.',
  unavailable: 'Cette plateforme est momentanément indisponible.',
  // Le contre-sens le plus coûteux du sujet (spec publication §2.4 et §7) :
  // avant l'audit, une vidéo envoyée par l'API YouTube est verrouillée en
  // privé et ne peut plus être libérée, même à la main dans Studio. Le
  // connecteur ne s'écrit donc pas avant que l'audit soit passé, deux à six
  // semaines et refus possible. TikTok, lui, se dépose en brouillon en
  // attendant — le message reste donc générique aux deux plutôt que
  // d'affirmer un verrouillage qui n'est vrai que d'une des deux. (relevé
  // par Copilot)
  audit_required:
    'Cette plateforme exige un audit de deux à six semaines avant de publier, avec refus possible. Le connecteur n’existe donc pas encore.',
}

export type PlatformAvailability =
  | { available: true }
  | { available: false; reason: PlatformUnavailableReason }

/**
 * Ce que l'écran dit aujourd'hui, honnêtement : les quatre plateformes en
 * `not_configured`. Aucune n'est jointe en fraude, aucune n'est retirée de la
 * liste.
 */
export function defaultPlatformAvailability(): Record<Platform, PlatformAvailability> {
  return {
    instagram: { available: false, reason: 'not_configured' },
    facebook: { available: false, reason: 'not_configured' },
    tiktok: { available: false, reason: 'not_configured' },
    youtube: { available: false, reason: 'not_configured' },
  }
}

/** Les plateformes qu'on peut effectivement cocher, dans cet état d'availability. */
export function selectablePlatforms(
  availability: Readonly<Record<Platform, PlatformAvailability>>,
): Platform[] {
  return PLATFORMS.filter((p) => availability[p].available)
}

/**
 * Ce qu'une publication déjà lancée a laissé derrière elle, pour un couple
 * clip/plateforme.
 */
export type PublicationRecord = {
  status: PublicationStatus
  /** Le lien public, une fois `published`. `null` avant, et pour un échec. */
  remoteUrl: string | null
  /**
   * L'empreinte de rendu (`empreinteDuRendu`, `src/server/steps/render.ts`)
   * telle qu'elle était **au moment de la publication**.
   *
   * **Personne ne l'écrit encore : il n'y a pas d'empreinte publiée puisqu'il
   * n'y a pas de publication.** Le champ existe pour que le jour où un
   * connecteur écrit une ligne, `isPublicationStale` distingue tout de suite
   * « Instagram — publié » de « Instagram — publié, mais le clip local a été
   * modifié depuis » (retour d'usage §9), sans qu'il faille inventer un
   * second mécanisme : l'empreinte compare déjà le condensat du document de
   * sous-titres réellement incrusté, en plus des segments, du ratio, du crop,
   * du branding et des marques (PR #89).
   */
  publishedFingerprint: string | null
}

/**
 * La publication `record` correspond-elle encore au montage courant ?
 *
 * `null` de part et d'autre — pas d'empreinte publiée, ou pas d'empreinte
 * courante connue — ne peut pas mentir par excès : sans les deux valeurs, on
 * ne sait rien, donc on ne prétend rien avoir changé.
 */
export function isPublicationStale(
  record: Pick<PublicationRecord, 'publishedFingerprint'>,
  currentFingerprint: string,
): boolean {
  return record.publishedFingerprint !== null && record.publishedFingerprint !== currentFingerprint
}

/** Ce qu'un clip a besoin pour être publiable : ni plus, ni moins que d'être exporté. */
export type ClipEligibility = { eligible: true } | { eligible: false; reason: string }

/**
 * `ClipOutputs.mp4Url` vaut `null` dans trois situations que son propre
 * docbloc énumère (`src/lib/api.ts`) : jamais rendu, rendu périmé par une
 * édition, ou fichier disparu du disque. Cette fonction ne prétend pas
 * distinguer laquelle — l'écran de clip, qui a `outputs`, n'a pas plus
 * d'information que ça lui non plus — elle dit seulement que, dans les trois
 * cas, publier n'a rien à envoyer.
 */
export function clipExportEligibility(exported: boolean): ClipEligibility {
  if (exported) return { eligible: true }
  return {
    eligible: false,
    reason:
      'Ce clip n’a pas de rendu disponible : il n’a jamais été exporté, une modification a périmé son rendu, ou le fichier a disparu. Exporter avant de publier.',
  }
}

/** La même règle, lue depuis le seul statut du clip (la vue Émission n'a pas `outputs`). */
export function clipEligibilityFromStatus(status: ClipStatus): ClipEligibility {
  return clipExportEligibility(status === 'exported')
}

/**
 * Peut-on viser cette plateforme pour ce clip ?
 *
 * **`published` sans `force` se refuse** (spec publication §6.5) : un
 * double-clic ne doit pas mettre deux reels identiques en ligne. Les trois
 * autres états n'empêchent rien — relancer un échec, ou une publication en
 * cours, reste une action volontaire de l'appelant.
 */
export function canTargetPlatform(record: PublicationRecord | undefined, forced: boolean): boolean {
  if (record === undefined) return true
  if (record.status !== 'published') return true
  return forced
}
