'use client'

import { Check, ChevronDown, Copy, LoaderCircle, Send, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { unmeasuredShots, shotRatios } from '@/components/clip/framing'
import type { Clip, Ratio } from '@/core/edl'
import { clipExportEligibility } from '@/core/publication'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { wordsHash, outputNames, publicationText } from '@/components/clip/texts'
import { PublishDialog, type PublishClipTarget } from '@/components/publication/publish-dialog'
import { ApiError, type PublishedFraming, type ClipOutputs } from '@/lib/api'
import type { AutosaveState } from '@/lib/autosave'
import { useExporter } from '@/lib/queries'

/**
 * L'état de livraison d'un clip, réduit à ce que le rail doit en montrer.
 *
 * **Une seule dérivation, là où il y en avait deux** (spec du 23 août, §3.4) :
 * `alreadyDelivered` (compté sur les trois fichiers, `.txt` compris) et
 * `publicationEligibility.eligible` (compté sur la vidéo seule) répondaient
 * chacun à une question différente, mais avec le même vocabulaire — « livré »
 * — ce qui les faisait lire comme la même chose. Elles convergent ici, et le
 * signal qui survit est celui d'`publicationEligibility` : une vidéo au moins
 * (`mp4Url` ou `variant9x16Url`), jamais le seul `.txt`. C'est le distinguo qui
 * comptait — un clip dont la vidéo a disparu du disque en ne laissant que son
 * texte n'a rien de publiable, quel que soit le libellé du bouton d'export —
 * et c'est donc lui qui décide aussi si le bouton dit « Publier » plutôt que
 * « Ré-exporter ». La lecture littérale du §3.4 (`mp4Url === null`) figerait
 * en « périmé » tout clip dont le natif est désactivé par `RENDER_NATIVE` —
 * `mp4Url` n'existe alors jamais, même livré — donc « vidéo rendue » se lit
 * sur les deux champs, pas sur un seul.
 */
export type DeliveryState = 'never' | 'stale' | 'delivered'

export function deriveDeliveryState(
  status: Clip['status'],
  outputs: Pick<ClipOutputs, 'mp4Url' | 'variant9x16Url'>,
): DeliveryState {
  const hasRenderedVideo = outputs.mp4Url !== null || outputs.variant9x16Url !== null
  if (hasRenderedVideo) return 'delivered'
  return status === 'exported' ? 'stale' : 'never'
}

/** La phrase du rail, à gauche, dans les mots qu'on lirait à voix haute. */
function deliverySentence(state: DeliveryState, native: Ratio): string {
  const base =
    state === 'delivered'
      ? 'exporté et à jour'
      : state === 'stale'
        ? 'le rendu ne correspond plus au montage'
        : 'jamais exporté'
  return `${base} · natif ${native}`
}

/**
 * L'export : **un rail, pas un panneau** (spec du 23 août, §3.3-§3.4).
 *
 * Il vivait au bas d'une colonne de réglages, en pleine largeur ; il devient
 * la troisième pointe de la diagonale du regard — le geste terminal, à
 * l'extrémité droite de la dernière ligne de l'écran. Tout ce qui n'est pas
 * le geste ou l'avertissement qui l'empêche part derrière « Détail », un
 * dépliant qui s'ouvre au-dessus du rail plutôt que de l'alourdir.
 */
export function PanelExport({
  clip,
  outputs,
  framing,
  duration,
  fingerprint,
  autosave,
  writeInCurrent,
  writeInFailure,
}: {
  /** Le clip **du serveur** : c'est lui qui porte le titre, la description et les marques. */
  clip: Clip
  outputs: ClipOutputs
  /**
   * Le cadrage que le serveur publie.
   *
   * **Le rail énonce le cadrage** (§3.5) : c'est la dernière surface avant la
   * livraison, et le seul endroit où l'automatique passerait en fraude si
   * personne ne l'y disait. Ça ne coûte rien et ça retire ce cas.
   */
  framing: PublishedFraming
  /** La durée montée. Zéro veut dire qu'il ne reste rien à rendre. */
  duration: number
  /**
   * Tout ce qui décide du rendu, tel que l'écran le connaît : segments, ratio,
   * cadrage, marques, sous-titres, textes.
   *
   * **Elle sert à dater l'annonce de résultat, et la durée n'y suffisait pas** :
   * une coupe de même durée, un cadrage déplacé ou les marques basculées
   * périment les fichiers sans changer un seul des nombres que ce rail
   * affichait. « Rendu terminé » continuait alors de décrire des fichiers que
   * le `PATCH` venait d'écarter. (relevé par Copilot)
   */
  fingerprint: string
  /** L'écriture différée du **montage** : segments, ratio, cadrage. */
  autosave: AutosaveState
  /**
   * Une écriture de clip, **quelle qu'elle soit**, est en vol.
   *
   * `autosave` ne couvre que le montage. Le titre, la description et les
   * marques partent par la même mutation sans y figurer : sans ce second
   * signal, basculer les marques puis exporter dans la foulée fait lire au
   * rendu la valeur d'avant, et produit un fichier qui contredit l'écran.
   * (relevé par Codex)
   */
  writeInCurrent: boolean
  /** La dernière écriture de clip a échoué — le rendu lirait un état qu'on n'a pas voulu. */
  writeInFailure: boolean
}) {
  const exporter = useExporter()
  const [confirmation, setConfirmation] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)

  /**
   * Ce que décrivait le clip au moment où on l'a lancé.
   *
   * L'annonce du résultat dit ce qui **vient** d'avoir lieu. Une coupe plus tard,
   * les fichiers sur le disque ne décrivent plus ce clip-ci — le `PATCH` a
   * d'ailleurs écarté le rendu — et laisser « rendu terminé » affirmerait le
   * contraire. La signature se pose depuis le geste, jamais depuis un effet :
   * annoncer un changement d'état depuis un `useEffect` est un motif que le
   * dépôt refuse, et il n'y a rien à observer ici qu'on ne sache déjà.
   */
  const [signatureRendered, setSignatureRendered] = useState<string | null>(null)

  const signature = `${clip.id}|${fingerprint}`
  // Le ratio **natif** résolu, celui sous lequel l'export écrit ses fichiers.
  const native = framing.ratio
  const names = outputNames(clip.id, native)
  const shotCount = framing.shots.length
  const unmeasured = unmeasuredShots(framing)
  const frames = shotRatios(framing)
  const state = deriveDeliveryState(clip.status, outputs)
  /**
   * Ce que le pli dit sans être ouvert : combien de fichiers, à quel ratio, et
   * combien sont là. Le reste — leurs noms, le compte des plans — est du détail
   * qu'on va chercher le jour où quelque chose cloche.
   *
   * **Il compte les fichiers réellement présents, pas la seule vidéo native.**
   * Déduire « livré » de `mp4Url` faisait annoncer « 2 fichiers livrés » sur une
   * livraison où la variante manque encore — le pli disait le contraire de son
   * détail, ce qui est pire que de ne rien dire. (relevé par Copilot)
   */
  const expected = [names.mp4, names.variant9x16, names.texts].filter((n) => n !== null).length
  const delivered = [outputs.mp4Url, outputs.variant9x16Url, outputs.textsUrl].filter(
    (u) => u !== null,
  ).length
  const plural = expected > 1 ? 's' : ''
  const summary =
    delivered === 0
      ? `${expected} fichier${plural} à produire`
      : delivered === expected
        ? `${expected} fichier${plural} livré${plural}`
        : `${delivered} fichier${delivered > 1 ? 's' : ''} sur ${expected} livré${delivered > 1 ? 's' : ''}`

  // **Trois empêchements, et chacun a sa raison écrite à côté du bouton.**
  // Rendre un état non enregistré produirait un fichier qui ne correspond à rien
  // de persistant ; rendre un clip vide ne produirait rien du tout.
  const prevention =
    duration <= 0
      ? 'Tous les mots ont été retirés : il n’y a rien à rendre.'
      : autosave === 'en-attente'
        ? 'Un enregistrement est en attente. Rendre maintenant produirait un fichier qui ne correspond à rien de persistant.'
        : autosave === 'echec' || writeInFailure
          ? 'Le dernier enregistrement a échoué. Le rendu attend qu’il passe.'
          : writeInCurrent
            ? 'Une modification est en cours d’écriture. Le rendu lirait la version d’avant.'
            : null

  function launch(force: boolean) {
    if (prevention !== null || exporter.isPending) return
    setSignatureRendered(signature)
    exporter.mutate({ clipId: clip.id, force })
  }

  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const publicationEligibility = clipExportEligibility(state === 'delivered')
  const publishTarget: PublishClipTarget = {
    clipId: clip.id,
    title: clip.title,
    eligibility: publicationEligibility,
    // **L'empreinte de ce rail, pas une recomputation.** `empreinte` porte
    // déjà tout ce qui décide du rendu (segments, ratio, cadrage, marques,
    // sous-titres, textes) — voir le commentaire de la prop plus haut. La
    // passer ici est ce qui préparera la nuance du retour d'usage §9 le jour
    // où une publication existera pour de vrai.
    currentFingerprint: fingerprint,
  }

  return (
    // **Un seul enveloppe pour le pli et le rail** (spec du 23 août, §3.3) :
    // le pli s'ouvre au-dessus, avant le rail dans l'ordre du DOM, et les deux
    // sont le quatrième frère flexible de l'écran — après `<main>`, jamais en
    // `sticky` ni `fixed`.
    <Collapsible
      open={detailOpen}
      onOpenChange={setDetailOpen}
      className="flex shrink-0 flex-col border-t"
    >
      <CollapsiblePanel className="flex flex-col gap-4 border-b p-4 lg:flex-row lg:gap-10">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-medium">Ce que l’export produit</h3>
            <span className="font-mono text-[0.75rem] text-muted-foreground">{native}</span>
          </div>

          <p className="text-[0.75rem] text-muted-foreground">
            {summary} · {shotCount === 1 ? '1 plan' : `${shotCount} plans`}, cadrés{' '}
            <span className="font-mono">{frames.join(', ') || '—'}</span>
            {frames.length > 1 && ' selon le plan, dans la variante 9:16'}
          </p>

          <OutputsList names={names} native={native} outputs={outputs} />

          {/* Ce qui est sur le disque se lit sur place. C'est le seul succès du
              parcours qui mérite d'être vu, donc il reste au premier niveau du
              pli plutôt que d'exiger un second clic. */}
          <DeliveredPlayers clip={clip} outputs={outputs} native={native} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <h3 className="text-sm font-medium">Textes de publication</h3>
          <FieldCopyable tag="Titre" value={clip.title.trim()} />
          <FieldCopyable tag="Description" value={clip.description.trim()} lines={6} />
          <FieldCopyable
            tag="Mots-dièse"
            value={wordsHash(`${clip.title.trim()}\n${clip.description.trim()}`).join(' ')}
          />
        </div>
      </CollapsiblePanel>

      <div className="flex flex-col gap-2 p-3">
        {/* **Ce qui suit ne se replie jamais** (doctrine de `export-panel.tsx`,
            reprise spec §3.4 point 5) : la raison d'un blocage, le titre vide,
            l'alerte d'échec et « rendu en cours » se lisent avant d'essayer,
            sur chaque clip où ils s'appliquent — jamais derrière « Détail ». */}
        {clip.title.trim() === '' && (
          <p className="flex items-start gap-1.5 text-[0.75rem] text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Le titre est vide : le fichier de textes sortira avec « (sans titre) », donc rien à
            coller au moment de publier.
          </p>
        )}

        {unmeasured > 0 && (
          <p className="text-[0.75rem] text-amber-500 dark:text-amber-400">
            {unmeasured === 1
              ? '1 plan sans mesure, centré par défaut'
              : `${unmeasured} plans sans mesure, centrés par défaut`}
          </p>
        )}

        {prevention !== null && (
          // Écrite ici, jamais dans une bulle d'aide : une bulle qui n'apparaît
          // qu'au survol est invisible au clavier, et la raison d'un blocage doit
          // se lire avant d'essayer.
          <p className="text-[0.75rem] text-muted-foreground">{prevention}</p>
        )}

        {/* **Même règle pour « Publier » : la raison se lit, elle ne se
            devine pas** (retour d'usage §2.4, mot pour mot). « Publier »
            disparaît plutôt que de rester grisé (spec du 23 août, §3.4) — la
            phrase qui dit pourquoi reste, elle, toujours là où le bouton
            aurait été. */}
        {!publicationEligibility.eligible && (
          <p className="text-[0.75rem] text-muted-foreground">{publicationEligibility.reason}</p>
        )}

        {exporter.isError && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>
              L’export a échoué
              {exporter.error instanceof ApiError ? ` (${exporter.error.status})` : ''}
            </AlertTitle>
            <AlertDescription>{exporter.error.message}</AlertDescription>
          </Alert>
        )}

        {exporter.isSuccess && !exporter.isPending && signatureRendered === signature && (
          // **`skipped: true` est un cas nominal**, et le plus fréquent quand on
          // rouvre un clip déjà exporté : rien n'a été refait, tout est en place.
          <p className="flex items-center gap-1.5 text-[0.75rem]" aria-live="polite">
            <Check className="size-3.5 text-stage" aria-hidden />
            {exporter.data.skipped
              ? 'Rien n’a été refait : les fichiers étaient déjà à jour.'
              : 'Rendu terminé.'}
          </p>
        )}

        {/* **Le rail : l'état en clair à gauche, le geste terminal à
            droite** (spec du 23 août, §3.3-§3.4). Rien entre les deux
            n'engage à lui seul — « Détail » ouvre le pli, « Copier » remplit
            le presse-papiers, « Ré-exporter » n'est jamais le primaire
            puisqu'il confirme toujours l'écrasement. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[0.75rem] text-muted-foreground">
            {deliverySentence(state, native)}
          </span>

          <CollapsibleTrigger
            render={
              <Button size="sm" variant="ghost">
                <ChevronDown
                  aria-hidden
                  className={`size-3.5 transition-transform ${detailOpen ? 'rotate-180' : ''}`}
                />
                Détail
              </Button>
            }
          />

          <ButtonCopy text={publicationText(clip)} label="Copier pour publication" />

          {exporter.isPending && (
            <span className="text-[0.75rem] text-muted-foreground" aria-live="polite">
              Rendu en cours — de dix secondes à une minute.
            </span>
          )}

          {/* **Pas d'annulation.** Le rendu ffmpeg ne s'interrompt pas proprement
              en itération 0, et un bouton qui ne ferait qu'ignorer la réponse
              mentirait sur ce qui se passe. */}

          {state === 'delivered' && (
            <Button
              variant="outline"
              onClick={() => prevention === null && !exporter.isPending && setConfirmation(true)}
              aria-disabled={prevention !== null || exporter.isPending || undefined}
            >
              Ré-exporter
            </Button>
          )}

          {state === 'delivered' ? (
            <Button
              onClick={() =>
                prevention === null &&
                !exporter.isPending &&
                publicationEligibility.eligible &&
                setPublishDialogOpen(true)
              }
              aria-disabled={
                prevention !== null ||
                exporter.isPending ||
                !publicationEligibility.eligible ||
                undefined
              }
            >
              <Send aria-hidden />
              Publier
            </Button>
          ) : (
            <Button
              onClick={() => {
                if (prevention !== null || exporter.isPending) return
                // « jamais livré » lance directement ; « périmé » confirme
                // toujours l'écrasement — un geste confirmé n'est jamais le
                // primaire (spec du 23 août, §3.4).
                if (state === 'stale') setConfirmation(true)
                else launch(false)
              }}
              aria-disabled={prevention !== null || undefined}
              aria-busy={exporter.isPending || undefined}
            >
              {exporter.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : null}
              {state === 'stale' ? 'Ré-exporter' : 'Exporter'}
            </Button>
          )}
        </div>
      </div>

      <Dialog open={confirmation} onOpenChange={setConfirmation}>
        <DialogContent role="alertdialog">
          <DialogHeader>
            <DialogTitle>Refaire les rendus ?</DialogTitle>
            <DialogDescription>
              Ces fichiers sont livrés et seront écrasés :
            </DialogDescription>
          </DialogHeader>
          <ul className="font-mono text-[0.75rem]">
            {[names.mp4, names.variant9x16, names.texts]
              .filter((name): name is string => name !== null)
              .map((name) => (
                <li key={name}>{name}</li>
              ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(false)}>
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmation(false)
                launch(true)
              }}
            >
              Écraser et refaire
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PublishDialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen} clips={[publishTarget]} />
    </Collapsible>
  )
}

/**
 * Ce que l'export produira : **les noms, et rien d'autre**.
 *
 * Deux vidéos quand le ratio natif n'est pas 9:16 : le natif pour le feed
 * d'Instagram et de Facebook, la variante floutée pour TikTok et Shorts. Et
 * elles ne montrent pas le même cadre — le natif garde un seul ratio pour tout
 * le clip, la variante pose chaque plan au sien.
 */
function OutputsList({
  names,
  native,
  outputs,
}: {
  names: ReturnType<typeof outputNames>
  native: Ratio
  outputs: ClipOutputs
}) {
  return (
    <ul className="flex flex-col gap-1">
      {names.mp4 === null ? (
        // **`mp4Due` sépare deux `null` qui ne veulent pas dire la même
        // chose**, comme `variant9x16Due` juste en dessous. Le natif est
        // désactivé (`RENDER_NATIVE`) sur ce clip parce que sa variante 9:16
        // le remplace : son absence n'est pas un rendu manquant.
        <li className="text-[0.75rem] text-muted-foreground">
          Le rendu natif est désactivé : la variante 9:16 sert de livrable.
        </li>
      ) : (
        <li className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[0.75rem]">{names.mp4}</span>
          <span className="text-[0.75rem] text-muted-foreground">
            le rendu {native}, pour le feed
            {outputs.mp4Url === null && outputs.mp4Due && ' — dû, pas encore produit'}
          </span>
        </li>
      )}

      {names.variant9x16 === null ? (
        // **`variant9x16Due` sépare deux `null` qui ne veulent pas dire la même
        // chose.** Un clip dont le ratio natif est déjà 9:16 n'aura jamais de
        // variante à fond flouté, et annoncer un rendu manquant ici le ferait sur
        // le clip le mieux livré de la bibliothèque.
        <li className="text-[0.75rem] text-muted-foreground">
          Le ratio natif est déjà 9:16 : pas de variante à produire.
        </li>
      ) : (
        <li className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[0.75rem]">{names.variant9x16}</span>
          <span className="text-[0.75rem] text-muted-foreground">
            la variante sur fond flouté, pour TikTok et Shorts
            {outputs.variant9x16Url === null && outputs.variant9x16Due && ' — due, pas encore produite'}
          </span>
        </li>
      )}

      <li className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[0.75rem]">{names.texts}</span>
        <span className="text-[0.75rem] text-muted-foreground">titre, description, mots-dièse</span>
      </li>
    </ul>
  )
}

/**
 * Ce qui est **sur le disque**, lisible sur place.
 *
 * Rien ne s'affiche tant que rien n'existe — et `mp4Url: null` ne veut pas dire
 * « jamais exporté » (voir le contrat de `ClipOutputs`) ; ce qui se dit ici est
 * seulement ce qui est disponible maintenant.
 */
function DeliveredPlayers({
  clip,
  outputs,
  native,
}: {
  clip: Clip
  outputs: ClipOutputs
  native: Ratio
}) {
  const delivered = [
    { url: outputs.mp4Url, label: `Le rendu ${native} de ${clip.title || 'ce clip'}` },
    { url: outputs.variant9x16Url, label: 'La variante 9:16 sur fond flouté' },
  ].filter((output): output is { url: string; label: string } => output.url !== null)

  if (delivered.length === 0) return null

  return (
    <ul className="flex flex-wrap gap-3">
      {delivered.map(({ url, label }) => (
        <li key={url}>
          <video
            src={url}
            aria-label={label}
            controls
            preload="metadata"
            className="w-full max-w-64 rounded bg-zinc-950"
          />
        </li>
      ))}
    </ul>
  )
}

/**
 * Un des trois textes, avec son bouton — **dans le pli « Détail »**
 * désormais : la copie d'ensemble vit dans le rail (« Copier pour
 * publication », spec du 23 août, §3.2), et rien n'oblige plus à ouvrir un
 * champ readonly pour chaque texte pris séparément.
 *
 * Vide, le champ le dit plutôt que de rester blanc — et son bouton se désactive
 * : copier le vide efface le presse-papiers, ce qui est le contraire du service
 * rendu, et se remarque au moment de coller.
 */
function FieldCopyable({
  tag,
  value,
  lines = 1,
}: {
  tag: string
  value: string
  /** Une ligne pour un titre ou des mots-dièse, plusieurs pour une description. */
  lines?: number
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span aria-hidden className="text-[0.75rem] text-muted-foreground">
          {tag}
        </span>
        <ButtonCopy text={value} label={`Copier ${tag.toLowerCase()}`} size="xs" />
      </div>
      <textarea
        aria-label={`${tag} de publication`}
        readOnly
        rows={lines}
        value={value}
        placeholder={`(sans ${tag.toLowerCase()})`}
        className="w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-[0.8rem] leading-relaxed"
      />
    </div>
  )
}

/**
 * Le bouton qui copie, et qui dit qu'il a copié.
 *
 * **Le texte copié, pas un booléen.** « Copié » doit redevenir « Copier » dès
 * que le texte change, sinon le bouton affirme que le presse-papiers porte
 * quelque chose qu'il ne porte plus.
 */
function ButtonCopy({
  text,
  label,
  size = 'sm',
}: {
  text: string
  label: string
  size?: 'xs' | 'sm'
}) {
  const [copy, setCopy] = useState<string | null>(null)
  const toDay = copy === text && text !== ''
  // Ce que le bouton montre : « Copier », ou « Copier pour publication » pour
  // le seul bouton du rail. Son nom accessible, lui, reste complet.
  const court = label.startsWith('Copier pour publication') ? 'Copier pour publication' : 'Copier'

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(text)
      setCopy(text)
    } catch {
      setCopy(null)
    }
  }

  return (
    <Button
      size={size}
      variant="outline"
      onClick={() => void copyToClipboard()}
      // Copier le vide efface le presse-papiers : le contraire du service rendu,
      // et cela ne se remarque qu'au moment de coller.
      disabled={text === ''}
      // **Le nom complet à la voix, court à l'œil.** Plusieurs boutons
      // « Copier » sur le même écran ne se distinguent qu'à leur place ; un
      // lecteur d'écran n'a pas cette place. Et le nom porte l'état : sans
      // lui, « Copié » ne serait qu'un mot à l'écran, invisible à la voix —
      // un `aria-label` fixe masque le contenu du bouton.
      aria-label={toDay ? `${label} — copié` : label}
    >
      {toDay ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-hidden>{toDay ? 'Copié' : court}</span>
    </Button>
  )
}
