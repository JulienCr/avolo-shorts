'use client'

import { AlertTriangle, CircleDashed, ExternalLink, Info, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'

import {
  canTargetPlatform,
  isPublicationStale,
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
 * **Rien n'est branché.** `availability` par défaut à `defaultPlatformAvailability()` —
 * les quatre plateformes en `not_configured` — et `onLaunch` n'est appelé que
 * si au moins une cible a été retenue, ce qui n'arrive jamais aujourd'hui
 * puisqu'aucune plateforme n'est sélectionnable. Les deux sont injectables
 * pour que le composant se teste sans attendre un connecteur, et pour que le
 * jour où l'un existera, seul l'appelant change.
 */
export type PublishClipTarget = {
  clipId: string
  title: string
  eligibility: ClipEligibility
  /** Ce qu'une publication précédente a laissé, par plateforme. Vide tant que rien n'écrit ici. */
  records?: Partial<Record<Platform, PublicationRecord>>
  /**
   * L'empreinte de rendu courante (`empreinteDuRendu`), pour la nuance du
   * retour d'usage §9 : « Instagram — publié » contre « Instagram — publié,
   * mais le clip local a été modifié depuis ». Absente tant qu'aucun appelant
   * ne la calcule pour ce contexte — la vue Émission, par exemple, n'a que le
   * statut du clip, pas son empreinte de rendu.
   */
  currentFingerprint?: string
}

type Step = 'platforms' | 'confirm'

export function PublishDialog({
  open,
  onOpenChange,
  clips,
  availability,
  onLaunch,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clips: readonly PublishClipTarget[]
  /** Injectable pour les tests, et pour le connecteur du jour où il existera. */
  availability?: Readonly<Record<Platform, PlatformAvailability>>
  /**
   * Appelé une fois, seulement si au moins une cible a été retenue. Aucun
   * appelant réel n'existe encore : la publication n'a pas de backend.
   */
  onLaunch?: (targets: readonly { clipId: string; platform: Platform }[]) => void
}) {
  const resolvedAvailability = availability ?? defaultPlatformAvailability()
  const [step, setStep] = useState<Step>('platforms')
  const [selected, setSelected] = useState<ReadonlySet<Platform>>(new Set())
  const [force, setForce] = useState(false)

  // **Remise à zéro pendant le rendu, pas dans un effet.** La même boîte sert
  // un clip après l'autre : rouvrir sur la sélection du clip précédent
  // publierait sur une plateforme qu'on n'a jamais choisie pour celui-ci. Un
  // ajustement d'état pendant le rendu — le motif que `useVueFigée` (fil.tsx)
  // emploie déjà pour la même raison — évite l'image intermédiaire qu'un
  // `useEffect` produirait entre l'ouverture et la remise à zéro.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setStep('platforms')
      setSelected(new Set())
      setForce(false)
    }
  }

  const eligible = clips.filter((c) => c.eligibility.eligible)
  const ineligible = clips.filter((c) => !c.eligibility.eligible)
  const selectable = selectablePlatforms(resolvedAvailability)

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
  const targets = eligible.flatMap((clip) =>
    selectedAndAvailable.flatMap((platform) =>
      canTargetPlatform(clip.records?.[platform], force) ? [{ clipId: clip.clipId, platform }] : [],
    ),
  )

  const alreadyPublished = eligible.some((clip) =>
    selectedAndAvailable.some((p) => clip.records?.[p]?.status === 'published'),
  )

  const canContinue = selectable.length === 0 || selected.size > 0

  function togglePlatform(platform: Platform) {
    setSelected((courant) => {
      const suivant = new Set(courant)
      if (suivant.has(platform)) suivant.delete(platform)
      else suivant.add(platform)
      return suivant
    })
  }

  function confirmLaunch() {
    if (targets.length > 0) onLaunch?.(targets)
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

        {step === 'platforms' ? (
          <PlatformsStep
            eligible={eligible}
            availability={resolvedAvailability}
            selected={selected}
            onToggle={togglePlatform}
            force={force}
            onForce={setForce}
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
  onForce,
  alreadyPublished,
}: {
  eligible: readonly PublishClipTarget[]
  availability: Readonly<Record<Platform, PlatformAvailability>>
  selected: ReadonlySet<Platform>
  onToggle: (platform: Platform) => void
  force: boolean
  onForce: (force: boolean) => void
  alreadyPublished: boolean
}) {
  const forceId = useId()
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
            id={forceId}
            checked={force}
            onCheckedChange={(checked) => onForce(checked === true)}
          />
          <Label htmlFor={forceId} className="flex flex-col gap-0.5 text-sm font-normal">
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
        const stale =
          clip.currentFingerprint !== undefined && isPublicationStale(record, clip.currentFingerprint)
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
          </li>
        )
      })}
    </ul>
  )
}

/** Les quatre états d'une publication déjà lancée — jamais un état de configuration. */
function StatusBadge({ status }: { status: PublicationStatus }) {
  const variant = status === 'published' ? 'default' : status === 'failed' ? 'destructive' : 'outline'
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
        C’est un geste public et potentiellement irréversible. Confirmer le lance.
      </p>
    </div>
  )
}
