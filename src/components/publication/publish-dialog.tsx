'use client'

import { AlertTriangle, CircleDashed, ExternalLink, Info, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'

import {
  canTargetPlatform,
  PLATFORM_LABELS,
  PLATFORM_UNAVAILABLE_REASON_LABELS,
  PLATFORMS,
  PUBLICATION_STATUS_LABELS,
  defaultPlatformAvailability,
  selectablePlatforms,
  type ClipEligibility,
  type Platform,
  type PlatformAvailability,
  type PublicationRecord,
  type PublicationStatus,
} from '@/core/publication'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * La primitive de publication, **partagée** entre l'écran de clip et la
 * sélection multiple de la vue Émission (retour d'usage §8 et §11 : « la
 * publication en masse doit réutiliser exactement la même logique que la
 * publication d'un clip »). Un tableau d'une seule cible sert le premier cas,
 * un tableau de plusieurs le second — c'est la seule différence, et elle vit
 * chez l'appelant, jamais ici.
 *
 * Le parcours : choisir les plateformes → récapitulatif et confirmation →
 * lancer (retour d'usage §2.4). Les deux derniers tiennent sur le même écran,
 * comme le fait déjà la boîte « Refaire les rendus ? » du panneau d'export :
 * une confirmation est une seule question, pas deux surfaces qui se
 * succèdent pour la poser.
 *
 * **C'est la troisième confirmation du parcours, et la mieux justifiée des
 * trois** (spec publication §6.5) : le parcours réserve `dialog` au repérage
 * forcé et au ré-export (parcours-utilisateur §3.0, §6.1) ; publier est
 * public et potentiellement irréversible, donc l'ouvrir en modale ne rompt
 * pas la règle « rien ne s'ouvre en modale sauf une confirmation », elle
 * l'applique.
 *
 * `availability` par défaut à `defaultPlatformAvailability()` — les quatre
 * plateformes en `not_configured` —, et `onLaunch` n'est appelé que si au
 * moins une cible a été retenue. Les deux sont injectables : pour tester le
 * composant sans connecteur, et parce qu'un connecteur réel (Upload Post) les
 * fournit désormais depuis les deux appelants (`export-panel.tsx`, `feed.tsx`).
 */
export type PublishClipTarget = {
  clipId: string
  title: string
  eligibility: ClipEligibility
  /**
   * Ce qu'une publication précédente a laissé, par plateforme. Vide tant que
   * rien n'écrit ici. `stale` y est déjà décidé par le serveur (issue #145) :
   * la nuance du retour d'usage §9, « Instagram — publié » contre « Instagram
   * — publié, mais le clip local a été modifié depuis », n'a plus besoin
   * d'empreinte côté client.
   */
  records?: Partial<Record<Platform, PublicationRecord>>
}

type Step = 'platforms' | 'confirm'

/** Coché à l'ouverture (issue #97) : disponible, et jamais une plateforme qui exigerait `force`. */
function defaultSelection(
  selectable: readonly Platform[],
  eligible: readonly PublishClipTarget[],
): Set<Platform> {
  return new Set(
    selectable.filter(
      (platform) =>
        !eligible.some((clip) => {
          const status = clip.records?.[platform]?.status
          return status === 'published' || status === 'planned'
        }),
    ),
  )
}

/**
 * Le repli d'une disponibilité qu'on sait, avec certitude, en échec —
 * distinct de `defaultPlatformAvailability()` (`not_configured`, l'état
 * honnête d'un environnement où rien n'a encore été branché). `unavailable`
 * existe déjà dans `PlatformUnavailableReason` pour ce cas précis ; ce
 * fichier le réutilise plutôt que d'ajouter un quatrième vocabulaire.
 */
function unavailablePlatformAvailability(): Record<Platform, PlatformAvailability> {
  return Object.fromEntries(
    PLATFORMS.map((platform) => [platform, { available: false, reason: 'unavailable' as const }]),
  ) as Record<Platform, PlatformAvailability>
}

export function PublishDialog({
  open,
  onOpenChange,
  clips,
  availability,
  availabilityError = false,
  onRetryAvailability,
  recordsLoading = false,
  recordsError = false,
  onLaunch,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clips: readonly PublishClipTarget[]
  /** Injectable pour les tests, et pour le connecteur du jour où il existera. */
  availability?: Readonly<Record<Platform, PlatformAvailability>>
  /**
   * `usePublicationAvailability` a échoué définitivement, plutôt que de
   * charger encore. **Distinct d'une absence de données** : sans lui, un
   * échec réseau se lit comme « rien n'est configuré », l'inverse de la
   * vérité (issue #150). Ignoré si `availability` est fourni malgré tout.
   */
  availabilityError?: boolean
  /** Réessaie la requête de disponibilité — absent, le bandeau d'échec n'a rien à proposer. */
  onRetryAvailability?: () => void
  /**
   * La requête qui remplit `clips[].records` est encore en vol.
   *
   * **`records === undefined` porte deux sens qu'il faut distinguer** :
   * « aucune publication connue » (sélection par défaut légitime) et « la
   * requête charge encore » (sélection inconnue). Sans ce signal, une
   * plateforme déjà `published` reste précochée le temps du chargement, et
   * confirmer avant l'arrivée des données envoie un clip vers un 409 pendant
   * que les autres partent — la sélection par défaut se recalcule à
   * l'arrivée (voir `dataSignature` plus bas), mais rien n'empêchait de
   * confirmer avant. (relevé par Copilot)
   */
  recordsLoading?: boolean
  /**
   * La requête d'historique a échoué définitivement, plutôt que de charger
   * encore. Bloque la confirmation comme `recordsLoading` : un échec n'est
   * pas moins incertain qu'un chargement (issue #150).
   */
  recordsError?: boolean
  /**
   * Appelé une fois, seulement si au moins une cible a été retenue. Porte
   * `force` (issue #97) : sans lui, une republication délibérée se distingue
   * mal d'un premier envoi côté appelant.
   */
  onLaunch?: (targets: readonly { clipId: string; platform: Platform }[], force: boolean) => void
}) {
  // **Qui décide (issue #96) : l'appelant propose, cette modale décide.**
  // `eligibility` vient de `clip.status` (vue Émission) ou d'`outputs.mp4Url`
  // (écran de clip) — non réconciliés ; la modale filtre sur ce qu'on lui donne.
  const availabilityUnavailable = availabilityError && availability === undefined
  const resolvedAvailability =
    availability ?? (availabilityUnavailable ? unavailablePlatformAvailability() : defaultPlatformAvailability())
  const eligible = clips.filter((c) => c.eligibility.eligible)
  const ineligible = clips.filter((c) => !c.eligibility.eligible)
  const selectable = selectablePlatforms(resolvedAvailability)

  const [step, setStep] = useState<Step>('platforms')
  const [selected, setSelected] = useState<ReadonlySet<Platform>>(() => defaultSelection(selectable, eligible))
  const [force, setForced] = useState(false)

  // **Remise à zéro pendant le rendu, pas dans un effet.** La même boîte sert
  // un clip après l'autre : rouvrir sur la sélection du clip précédent
  // publierait sur une plateforme qu'on n'a jamais choisie pour celui-ci. Un
  // ajustement d'état pendant le rendu — le motif que `useViewFrozen` (fil.tsx)
  // emploie déjà pour la même raison — évite l'image intermédiaire qu'un
  // `useEffect` produirait entre l'ouverture et la remise à zéro.
  const [wasOpen, setWasOpen] = useState(open)

  // **`availability` et `records` sont deux requêtes asynchrones, injectées
  // par la page.** Ouvrir la boîte pendant qu'elles chargent encore fige la
  // sélection sur leur repli — quatre plateformes `not_configured`, aucun
  // enregistrement connu — et leur arrivée ensuite ne rejoue pas
  // `defaultSelection` : une plateforme qui vient de se brancher reste
  // décochée, une déjà `published` reste cochée. Réconcilié tant que
  // l'utilisateur n'a touché aucune case (`dirty`) ; un geste manuel gèle la
  // sélection, quoi que les données fassent ensuite. (relevé par Copilot,
  // Codex et Aristarque)
  const [dirty, setDirty] = useState(false)
  const dataSignature = JSON.stringify([resolvedAvailability, eligible.map((c) => c.records ?? null)])
  const [lastDataSignature, setLastDataSignature] = useState(dataSignature)

  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setStep('platforms')
      setSelected(defaultSelection(selectable, eligible))
      setForced(false)
      setDirty(false)
      setLastDataSignature(dataSignature)
    }
  } else if (open && !dirty && dataSignature !== lastDataSignature) {
    setLastDataSignature(dataSignature)
    setSelected(defaultSelection(selectable, eligible))
  }

  // **Chaque plateforme réussit ou échoue seule** (spec publication §6.4) :
  // la cible se calcule couple par couple, jamais en bloc, pour que la suite
  // — un connecteur qui échoue sur l'un — n'ait rien à changer ici.
  //
  // **Toujours recoupé avec `selectable`, jamais avec `selected` seul.**
  // Rien ne peut cocher une plateforme indisponible aujourd'hui — les cases
  // désactivées ne déclenchent pas `onCheckedChange` — mais `availability`
  // est une prop injectable, explicitement destinée à devenir dynamique le
  // jour d'un connecteur : une plateforme qui bascule `available` →
  // `unavailable` pendant que la boîte reste ouverte ne doit jamais partir
  // dans `onLaunch` sous prétexte qu'elle était cochée avant. (relevé par
  // Copilot)
  const selectedAndAvailable = PLATFORMS.filter((p) => selected.has(p) && selectable.includes(p))

  const alreadyPublished = eligible.some((clip) =>
    selectedAndAvailable.some((p) => clip.records?.[p]?.status === 'published'),
  )

  // **`force` s'annule avec la case qui l'a rendu pertinent.** Cocher
  // « Republier explicitement » puis décocher la seule plateforme déjà
  // `published` gardait `force` à `true` : un envoi ordinaire suivant
  // partait avec lui, et Upload Post lui associe une clé d'idempotence
  // aléatoire (`upload-post.ts`), perdant sa protection contre les
  // doublons. `effectiveForce` ne vaut jamais plus que ce que la sélection
  // courante justifie. (relevé par Copilot)
  const effectiveForce = force && alreadyPublished

  const targets = eligible.flatMap((clip) =>
    selectedAndAvailable.flatMap((platform) =>
      canTargetPlatform(clip.records?.[platform], effectiveForce) ? [{ clipId: clip.clipId, platform }] : [],
    ),
  )

  // **Recoupé avec `selectedAndAvailable`, pas `selected` seul.**
  // Cocher une plateforme puis la voir devenir indisponible pendant que la
  // boîte reste ouverte laissait « Suivant » actif alors que `targets` était
  // déjà vide — la passe 2 avait renommé l'identifiant sans corriger le
  // calcul. (relevé par Copilot, passe 3)
  // **`recordsLoading` et `recordsError` bloquent pareil.** Le critère est
  // « connu avec certitude », pas « n'est pas encore en train de charger » —
  // un échec n'est pas moins incertain qu'un chargement (issue #150).
  const canContinue =
    !recordsLoading && !recordsError && (selectable.length === 0 || selectedAndAvailable.length > 0)

  function togglePlatform(platform: Platform) {
    setDirty(true)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(platform)) next.delete(platform)
      else next.add(platform)
      return next
    })
  }

  function confirmLaunch() {
    if (targets.length > 0) onLaunch?.(targets, effectiveForce)
    onOpenChange(false)
  }

  const dialogTitle =
    clips.length === 1 ? `Publier « ${clips[0]?.title || 'ce clip'} »` : `Publier ${clips.length} clips`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* **Bornée et défilable.** La sélection en masse peut passer des
          dizaines de clips ; sans hauteur maximale, l'en-tête, le pied et les
          actions sortaient du viewport sur une petite fenêtre. (relevé par
          Copilot) */}
      <DialogContent
        role="alertdialog"
        className="flex max-h-[85vh] flex-col overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            Instagram, Facebook, TikTok et YouTube Shorts. Une publication est publique et
            potentiellement irréversible : elle se confirme avant de partir.
          </DialogDescription>
        </DialogHeader>

        {/* **Conditionné à l'état réel, pas affiché en dur.** `availability` est
            injectable — pour les tests, et pour le connecteur du jour où il
            existera. La passe précédente conditionnait sur « au moins une
            plateforme non configurée », ce qui garderait le bandeau affiché
            le jour où un seul connecteur existerait parmi quatre — il faut
            les quatre pour que « aucun connecteur n'est branché » reste
            vrai. (relevé par Copilot) */}
        {PLATFORMS.every((p) => {
          const a = resolvedAvailability[p]
          return !a.available && a.reason === 'not_configured'
        }) && (
          <Alert>
            <Info aria-hidden />
            <AlertTitle>Aucun connecteur n’est encore branché.</AlertTitle>
            <AlertDescription>
              Les quatre plateformes ci-dessous sont donc « non configuré » : c’est l’état honnête
              aujourd’hui, pas une panne. Le parcours reste utilisable jusqu’à la confirmation, qui
              est le geste qu’on veut fixer avant d’écrire le premier connecteur.
            </AlertDescription>
          </Alert>
        )}

        {/* `unavailable`, jamais `not_configured` : le second dit « rien n'est
            branché », la vérité ici est que la requête est en panne. */}
        {availabilityUnavailable && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>Impossible de vérifier les connecteurs.</AlertTitle>
            <AlertDescription>
              La disponibilité des plateformes n’a pas pu être chargée. Elle peut être branchée sans
              que ce constat le sache — réessayer avant de conclure au contraire.
              {onRetryAvailability && (
                <Button size="sm" variant="outline" className="mt-2" onClick={onRetryAvailability}>
                  Réessayer
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {ineligible.length > 0 && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>
              {ineligible.length === 1
                ? '1 clip ne peut pas être publié.'
                : `${ineligible.length} clips ne peuvent pas être publiés.`}
            </AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-0.5">
                {ineligible.map((clip) => (
                  <li key={clip.clipId}>
                    <span className="font-medium text-foreground">{clip.title || clip.clipId}</span>
                    {' — '}
                    <span>{!clip.eligibility.eligible && clip.eligibility.reason}</span>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {recordsLoading && (
          <p className="text-xs text-muted-foreground">
            Chargement de l’état des publications précédentes…
          </p>
        )}

        {/* Bloque « Suivant » comme `recordsLoading` (voir `canContinue`), mais
            dit la vraie raison : l'historique n'a pas pu être lu, pas qu'il
            charge encore. */}
        {recordsError && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>Historique de publication indisponible.</AlertTitle>
            <AlertDescription>
              L’état des publications précédentes n’a pas pu être vérifié. Un clip déjà publié
              pourrait donc être proposé à nouveau sans le savoir — la confirmation reste bloquée
              jusqu’à ce que ce soit su.
            </AlertDescription>
          </Alert>
        )}

        {step === 'platforms' ? (
          <PlatformsStep
            eligible={eligible}
            availability={resolvedAvailability}
            selected={selected}
            onToggle={togglePlatform}
            force={force}
            onForced={setForced}
            alreadyPublished={alreadyPublished}
          />
        ) : (
          <ConfirmStep targets={targets} />
        )}

        <DialogFooter>
          {step === 'platforms' ? (
            <Button onClick={() => setStep('confirm')} disabled={!canContinue}>
              Suivant
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep('platforms')}>
                Retour
              </Button>
              {targets.length > 0 ? (
                <Button variant="destructive" onClick={confirmLaunch}>
                  Confirmer et publier
                </Button>
              ) : (
                <Button onClick={() => onOpenChange(false)}>Fermer</Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Le choix des plateformes : une case par plateforme, désactivée avec sa
 * raison quand elle ne l'est pas — **jamais retirée de la liste, jamais
 * désactivée en silence** (retour d'usage §2.4 et §8).
 */
function PlatformsStep({
  eligible,
  availability,
  selected,
  onToggle,
  force,
  onForced,
  alreadyPublished,
}: {
  eligible: readonly PublishClipTarget[]
  availability: Readonly<Record<Platform, PlatformAvailability>>
  selected: ReadonlySet<Platform>
  onToggle: (platform: Platform) => void
  force: boolean
  onForced: (force: boolean) => void
  alreadyPublished: boolean
}) {
  const forcedId = useId()
  return (
    <div className="flex flex-col gap-3">
      {PLATFORMS.map((platform) => (
        <PlatformRow
          key={platform}
          platform={platform}
          availability={availability[platform]}
          checked={selected.has(platform)}
          onToggle={() => onToggle(platform)}
          clips={eligible}
        />
      ))}

      {/* **Republier se refuse sans un geste explicite** (spec publication
          §6.5) : sans cette case, un double-clic mettrait deux reels
          identiques en ligne. Elle n'apparaît que quand elle a quelque chose
          à débloquer — aujourd'hui, jamais, faute de publication existante. */}
      {alreadyPublished && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
          <Checkbox
            id={forcedId}
            checked={force}
            onCheckedChange={(checked) => onForced(checked === true)}
          />
          <Label htmlFor={forcedId} className="flex flex-col gap-0.5 text-sm font-normal">
            Republier explicitement
            <span className="text-xs text-muted-foreground">
              Au moins un clip sélectionné est déjà publié sur une plateforme cochée. Sans cette
              case, cette plateforme-là est ignorée pour lui.
            </span>
          </Label>
        </div>
      )}
    </div>
  )
}

function PlatformRow({
  platform,
  availability,
  checked,
  onToggle,
  clips,
}: {
  platform: Platform
  availability: PlatformAvailability
  checked: boolean
  onToggle: () => void
  clips: readonly PublishClipTarget[]
}) {
  const id = useId()
  const reasonId = useId()
  const disabled = !availability.available

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border px-3 py-2.5',
        disabled && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          aria-describedby={disabled ? reasonId : undefined}
          onCheckedChange={onToggle}
        />
        <Label htmlFor={id} className="flex-1 text-sm font-normal">
          {PLATFORM_LABELS[platform]}
        </Label>
      </div>

      {/* La raison se lit sur place, jamais dans une bulle d'aide : elle doit
          se lire avant d'essayer, pas seulement au survol. */}
      {disabled && (
        <p id={reasonId} className="pl-6 text-xs text-muted-foreground">
          {PLATFORM_UNAVAILABLE_REASON_LABELS[availability.reason]}
        </p>
      )}

      {checked && <PlatformRecords platform={platform} clips={clips} />}
    </div>
  )
}

/** Une ligne par clip qui porte déjà un état sur cette plateforme. Vide tant que rien n'écrit. */
function PlatformRecords({
  platform,
  clips,
}: {
  platform: Platform
  clips: readonly PublishClipTarget[]
}) {
  const withRecord = clips.filter((c) => c.records?.[platform] !== undefined)
  if (withRecord.length === 0) return null

  return (
    <ul className="flex flex-col gap-1 pl-6">
      {withRecord.map((clip) => {
        const record = clip.records?.[platform]
        if (record === undefined) return null
        const stale = record.stale === true
        return (
          <li key={clip.clipId} className="flex items-center gap-1.5 text-xs">
            <StatusBadge status={record.status} />
            <span className="truncate">{clip.title || clip.clipId}</span>
            {/* **`http`/`https` seulement.** `remoteUrl` vient d'une future
                réponse de plateforme, jamais vérifiée à la frontière de
                l'API : aucun appelant ne le fournit encore, mais poser un
                `href` sur une chaîne quelconque laisserait passer un
                `javascript:` ou un `data:` le jour où l'un le fera. (relevé
                par Copilot) */}
            {record.remoteUrl !== null && /^https?:\/\//.test(record.remoteUrl) && (
              <a
                href={record.remoteUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
              >
                <ExternalLink className="size-3" aria-hidden />
                <span className="sr-only">voir en ligne</span>
              </a>
            )}
            {stale && (
              <span className="flex items-center gap-1 text-amber-500 dark:text-amber-400">
                <AlertTriangle className="size-3" aria-hidden />
                modifié depuis
              </span>
            )}
            {/* **Le message du connecteur, pas seulement le badge.** Jeton
                expiré, quota atteint, fichier refusé : trois échecs que
                « échec » seul ne distingue pas, alors que le serveur garde
                déjà la raison. (relevé par Codex) */}
            {record.status === 'failed' && record.error !== null && (
              <span className="truncate text-destructive" title={record.error}>
                {record.error}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Les cinq états d'une publication déjà lancée ou programmée — jamais un état de configuration. */
function StatusBadge({ status }: { status: PublicationStatus }) {
  const variant =
    status === 'published' ? 'default' : status === 'failed' ? 'destructive' : status === 'planned' ? 'secondary' : 'outline'
  return (
    <Badge variant={variant} className="shrink-0">
      {status === 'in_progress' && <CircleDashed className="animate-spin" aria-hidden />}
      {PUBLICATION_STATUS_LABELS[status]}
    </Badge>
  )
}

/**
 * Le récapitulatif et la confirmation, sur le même écran — comme la boîte
 * « Refaire les rendus ? » du panneau d'export : une confirmation est une
 * seule question.
 */
function ConfirmStep({
  targets,
}: {
  targets: readonly { clipId: string; platform: Platform }[]
}) {
  if (targets.length === 0) {
    return (
      <Alert>
        <Info aria-hidden />
        <AlertTitle>Rien à lancer aujourd’hui.</AlertTitle>
        <AlertDescription>
          Aucune plateforme sélectionnée n’est disponible, ou toutes les cibles cochées sont déjà
          publiées sans que la republication n’ait été confirmée. Rien ne sera envoyé.
        </AlertDescription>
      </Alert>
    )
  }

  // **Les plateformes réellement ciblées, pas celles cochées.** `selected`
  // inclut une case cochée que `targets` a déjà retirée — clip déjà `published`
  // sans confirmation explicite, plateforme redevenue indisponible pendant que
  // la boîte était ouverte. Compter sur `selected` ici annoncerait un envoi qui
  // n'a pas lieu. (relevé par Copilot)
  const chosenPlatforms = PLATFORMS.filter((p) => targets.some((t) => t.platform === p))
  const targetedClipsCount = new Set(targets.map((t) => t.clipId)).size

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {targetedClipsCount === 1 ? 'Ce clip part vers' : `Ces ${targetedClipsCount} clips partent vers`}{' '}
        <span className="font-medium">
          {chosenPlatforms.map((p) => PLATFORM_LABELS[p]).join(', ')}
        </span>
        {' — '}
        {targets.length === 1 ? '1 publication au total.' : `${targets.length} publications au total.`}
      </p>
      <p className="text-muted-foreground">
        C’est un geste public et potentiellement irréversible. Confirmer déclenche l’envoi.
      </p>
    </div>
  )
}
