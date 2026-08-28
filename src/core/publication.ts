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
 * **Depuis le 23 août 2026, un connecteur existe** — `src/server/publication/
 * upload-post.ts`, pour les quatre plateformes à la fois, via Upload Post
 * plutôt qu'un accès direct par plateforme. `defaultPlatformAvailability`
 * reste la réponse honnête pour un environnement où rien n'est configuré ;
 * l'état réel se lit dans `PublicationAdapter.availability`. `PlatformUnavailableReason`
 * porte toujours `audit_required`, gardé pour un futur connecteur direct qui
 * attendrait son propre audit — Upload Post, lui, publie à travers le sien,
 * déjà passé (voir le docbloc d'`upload-post.ts`).
 *
 * **Le nom `Platform`, pas `Plateforme`.** Le code neuf de ce dépôt s'écrit en
 * anglais (`CLAUDE.md`) ; la conception de la publication, rédigée avant que
 * cette règle ne soit énoncée pour du code, nommait le type `Plateforme`. Ce
 * module suit la règle en vigueur plutôt que le nom de la conception, et le
 * jour où un connecteur s'écrira, il suivra cette même règle.
 */

import type { Clip, ClipStatus } from '@/core/edl'

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
export type PublicationStatus = 'planned' | 'in_progress' | 'submitted' | 'published' | 'failed'

export const PUBLICATION_STATUS_LABELS: Record<PublicationStatus, string> = {
  planned: 'programmé',
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
export type PlatformUnavailableReason = 'not_configured' | 'not_paired' | 'unavailable' | 'audit_required'

export const PLATFORM_UNAVAILABLE_REASON_LABELS: Record<PlatformUnavailableReason, string> = {
  not_configured: 'Aucun connecteur n’est encore branché pour cette plateforme.',
  // Le remède n'a rien à voir avec `not_configured` : l'identifiant est déjà
  // renseigné, il manque le geste d'appairage (`pnpm tsx scripts/dev-connect-*`).
  not_paired: 'Identifiants renseignés, mais jamais appairés : lancer le script d’appairage.',
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
 * Reste-t-il une plateforme programmable pour ce clip (planning §5.1) ?
 * `schedulePublications` ne réécrit jamais une ligne au résultat déjà
 * arrêté : une plateforme sans ligne, ou déjà `planned`, l'est encore.
 */
export function hasSchedulablePlatform(statuses: Partial<Record<Platform, PublicationStatus>>): boolean {
  return PLATFORMS.some((platform) => statuses[platform] === undefined || statuses[platform] === 'planned')
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
   * Le condensat du rendu **et** des textes envoyés à cette plateforme
   * (issue #226), au moment de la publication.
   *
   * **Écrit par les connecteurs depuis le 23 août 2026**
   * (`src/server/publication/service.ts`). `isPublicationStale` le compare
   * au condensat courant pour distinguer « Instagram — publié » de
   * « Instagram — publié, mais modifié depuis » (retour d'usage §9).
   * Diffère de `PublicationJob.fingerprint` (`adapter.ts`), rendu-seul.
   */
  publishedFingerprint: string | null
  /**
   * Le message que le connecteur a laissé pour un échec — expiration de jeton,
   * quota, fichier refusé. `null` hors échec. Sans lui, l'interface ne peut
   * rendre qu'un badge « échec » indifférencié alors que le serveur a gardé la
   * raison (`upload-post.ts`). (relevé par Codex)
   */
  error: string | null
  /**
   * Le verdict du serveur (`isPublicationStale`) sur cette publication, tel
   * que `GET /api/clips/:id/publications` le rend. Absent quand l'appelant
   * n'interroge pas cette route — `toRecord` (`src/server/publication/service.ts`)
   * en usage interne, par exemple, qui ne rend jamais cette valeur.
   */
  stale?: boolean
}

/**
 * Une ligne de `publications` telle que le serveur la rend, en base
 * (`src/server/db.ts`) comme sur le fil (`GET /api/clips/:id/publications`,
 * `POST /api/clips/:id/publish`).
 *
 * **Déclarée ici, jamais redite.** `src/server/db.ts` et `src/lib/api.ts` la
 * réexportent tous les deux plutôt que de la redéfinir — la même règle que
 * `ClipFraming`/`HookSettings` dans `src/lib/api.ts` : deux exemplaires d'une
 * même union ne se contraignent pas, et celui qui prend du retard ne fait rien
 * échouer, il affiche seulement quelque chose de faux. (relevé par Aristarque)
 */
export type PublicationRow = {
  clipId: string
  platform: Platform
  status: PublicationStatus
  remoteId: string | null
  remoteUrl: string | null
  requestId: string | null
  error: string | null
  publishedFingerprint: string | null
  createdAt: number
  updatedAt: number
  /** L'échéance de diffusion, en ms depuis l'époque. `NULL` hors ordonnancement. */
  scheduledAt: number | null
}

/**
 * `PublicationRow`, telle que `GET /api/clips/:id/publications` la sert : la
 * ligne, plus le verdict du serveur (`isPublicationStale`) sur l'empreinte du
 * rendu actuel.
 */
export type PublicationView = PublicationRow & { stale: boolean }

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
 * **`published` et `planned` sans `force` se refusent** (spec publication
 * §6.5, planning §5.1) : un double-clic ne doit pas mettre deux reels
 * identiques en ligne, et le dialogue manuel ne doit pas court-circuiter une
 * échéance posée par le planning avant qu'elle soit due. Les deux autres
 * états n'empêchent rien — relancer un échec, ou une publication en cours,
 * reste une action volontaire de l'appelant.
 */
export function canTargetPlatform(record: PublicationRecord | undefined, force: boolean): boolean {
  if (record === undefined) return true
  if (record.status !== 'published' && record.status !== 'planned') return true
  return force
}

/**
 * Les deux fichiers qu'un export peut avoir produits — mêmes noms de champs
 * que `PathsRender` (`src/server/steps/render.ts`), redéclarés ici plutôt
 * qu'importés : ce sont des chemins absolus sur le disque du serveur, et
 * `src/core/` ne connaît ni `node:fs` ni `node:path`.
 */
export type RenderedOutputs = {
  mp4: string | null
  variant9x16: string | null
}

/**
 * Le fichier à envoyer aux plateformes — **un seul**, pour tout le job : une
 * requête Upload Post porte plusieurs plateformes mais un seul `video`
 * (`src/server/publication/adapter.ts`), donc le choix se fait une fois, pas
 * par plateforme.
 *
 * La variante 9:16 est préférée à chaque fois qu'elle existe. Elle n'existe
 * pas seulement quand le ratio natif résolu est déjà 9:16 (`pathsRender`) —
 * auquel cas le natif **est** la livraison —, si bien que cette seule règle
 * reste juste sous les deux états de `RENDER_NATIVE`
 * (`src/core/render-flags.ts`) sans avoir besoin de le lire : à
 * `RENDER_NATIVE = false`, un clip non-9:16 n'a que la variante ; à
 * `RENDER_NATIVE = true`, il a les deux et la variante reste le meilleur
 * choix pour des plateformes qui veulent toutes du vertical.
 */
export function platformFile(outputs: RenderedOutputs): string | null {
  return outputs.variant9x16 ?? outputs.mp4
}

/** Les textes qu'une plateforme reçoit — un couple titre/description dans les deux cas. */
export type PlatformTexts = { title: string; description: string }

/**
 * Le pied de page commun, tel que le registre le porte
 * (`publication.descriptionFooter`). Passé en paramètre plutôt que lu en base
 * — `src/core/**` ne parle à rien (voir le docbloc en tête de ce fichier).
 * L'interrupteur, lui, vient du clip (`Clip.footer`) : pas besoin de le
 * répéter ici.
 */
export type DescriptionFooterOptions = { footer: string }

/**
 * Compose la description finale d'un clip : la sienne, puis le pied de page
 * commun si `clip.footer` l'active et que le pied de page n'est pas vide —
 * **l'unique fonction dont dérivent `platformTexts` et `publicationText`**,
 * pour que l'aperçu, le planning et les connecteurs envoient tous le même
 * texte (BACKLOG « pied de page commun »).
 */
export function composeDescription(
  clip: Pick<Clip, 'description' | 'footer'>,
  options: DescriptionFooterOptions,
): string {
  const description = clip.description.trim()
  const footer = clip.footer ? options.footer.trim() : ''
  if (footer === '') return description
  if (description === '') return footer
  return `${description}\n\n${footer}`
}

/** YouTube refuse un titre de plus de 100 caractères (spec §6.1). */
const YOUTUBE_TITLE_MAX = 100

/** Tronque sur une frontière de mot, jamais en plein mot. */
function truncateOnWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace <= 0 ? cut : cut.slice(0, lastSpace)).trimEnd()
}

/**
 * Les textes envoyés pour une plateforme donnée.
 *
 * **YouTube veut un titre et une description séparés** (spec §6.1) ; le titre
 * est tronqué à 100 caractères sur une frontière de mot. **Les trois autres
 * veulent une légende unique** — Reels et TikTok n'ont pas de champ titre — :
 * `title` sort vide et `description` porte le titre et la description du clip
 * réunis, comme le fait déjà `publicationText` pour le `.txt` de secours.
 * La description est celle que rend `composeDescription`, pied de page compris.
 */
export function platformTexts(
  clip: Pick<Clip, 'title' | 'description' | 'footer'>,
  platform: Platform,
  footerOptions: DescriptionFooterOptions,
): PlatformTexts {
  const title = clip.title.trim()
  const description = composeDescription(clip, footerOptions)
  if (platform === 'youtube') {
    return { title: truncateOnWordBoundary(title, YOUTUBE_TITLE_MAX), description }
  }
  const caption = [title, description].filter((part) => part !== '').join('\n\n')
  return { title: '', description: caption }
}

/**
 * Sérialisation canonique de `PlatformTexts` (issue #226) : un ordre de
 * champs fixe, pour que l'empreinte de publication qui la hache ne soit
 * jamais périmée par un simple réordonnancement du type.
 */
export function canonicalPlatformTexts(texts: PlatformTexts): string {
  return JSON.stringify({ title: texts.title, description: texts.description })
}

/**
 * Un Short ne dépasse pas trois minutes (spec §8 point 3) — refusé ici, avec sa
 * raison, plutôt que découvert dans un 400 renvoyé après le téléversement.
 */
const MAX_DURATION_SEC = 180

/**
 * Une borne large plutôt que la limite propre à chacune des quatre
 * plateformes — TikTok, la plus stricte des quatre, tolère de l'ordre de 4 Go.
 * Elle n'existe que pour intercepter un export manifestement anormal (un
 * proxy envoyé par erreur, un rendu non recadré) avant de payer un
 * téléversement qui échouera de toute façon, pas pour serrer la marge exacte
 * d'aucune API.
 */
const MAX_SIZE_BYTES = 500 * 1024 * 1024

/** Un clip est-il publiable, du seul point de vue de sa durée et de son poids ? */
export function platformEligibility(durationSec: number, sizeBytes: number): ClipEligibility {
  if (durationSec > MAX_DURATION_SEC) {
    // La limite s'affiche, pas la durée mesurée arrondie : à 180,4 s,
    // `toFixed(0)` aurait affiché « 180 s », contredisant le refus juste au-dessus
    // de la borne qui l'a causé (une valeur comparée à un seuil se tronque, ne
    // s'arrondit pas — voir CLAUDE.md).
    return {
      eligible: false,
      reason: `Ce clip dure plus de ${MAX_DURATION_SEC} s (3 minutes) : ce n’est pas un format court.`,
    }
  }
  if (sizeBytes > MAX_SIZE_BYTES) {
    return {
      eligible: false,
      reason: `Le fichier dépasse ${(MAX_SIZE_BYTES / (1024 * 1024)).toFixed(0)} Mio, au-delà de ce que ce dépôt envoie sans vérification manuelle.`,
    }
  }
  return { eligible: true }
}

/** Les mots-dièse d'un texte, dédoublonnés sans tenir compte de la casse. */
export function wordsHash(text: string): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const found of text.matchAll(/#[\p{L}\p{N}_]+/gu)) {
    const key = found[0].toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    output.push(found[0])
  }
  return output
}

/**
 * Le `.txt` qui accompagne le MP4 : titre, description, mots-dièse.
 *
 * Fait pour être **copié**, pas analysé — trois sections nommées, dans l'ordre
 * où on les colle. Il servait à publier à la main avant que la publication
 * n'entre dans l'outil (18 août 2026) ; il reste pour les réseaux qu'on ne
 * branche pas et pour le rattrapage quand une plateforme refuse. **Il n'est
 * pas une source à part** : sa description passe par `composeDescription`,
 * la même fonction que `platformTexts`, pied de page compris.
 *
 * Les mots-dièse ne sont pas retirés de la description, ils en sont extraits :
 * elle se colle telle quelle dans le formulaire d'Instagram, et la section du
 * bas n'existe que pour les reprendre ailleurs sans les retaper.
 */
export function publicationText(
  clip: Pick<Clip, 'title' | 'description' | 'footer'>,
  footerOptions: DescriptionFooterOptions,
): string {
  const title = clip.title.trim()
  const description = composeDescription(clip, footerOptions)
  const hashes = wordsHash(`${title}\n${description}`)
  return [
    `Titre : ${title === '' ? '(sans titre)' : title}`,
    '',
    'Description :',
    description === '' ? '(sans description)' : description,
    '',
    `Mots-dièse : ${hashes.length === 0 ? '(aucun)' : hashes.join(' ')}`,
    '',
  ].join('\n')
}
