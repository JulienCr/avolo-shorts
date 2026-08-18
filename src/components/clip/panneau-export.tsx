'use client'

import { Check, Copy, FileText, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { unmeasuredShots, shotRatios } from '@/components/clip/framing'
import type { Clip, Ratio } from '@/core/edl'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { nomsDeSortie, texteDePublication } from '@/components/clip/textes'
import { ApiError, type PublishedFraming, type ClipOutputs } from '@/lib/api'
import type { EtatEnregistrement } from '@/lib/enregistrement'
import { useExporter } from '@/lib/queries'

/**
 * L'export : **un panneau, pas un écran** (spec §3.4).
 *
 * Il consomme le clip qu'on vient de monter, il dure de dix secondes à une
 * minute, et son résultat se juge à côté de ce qui l'a produit. Un écran séparé
 * ferait sortir du sous-parcours pour y revenir aussitôt.
 *
 * Quatre choses, dans cet ordre : ce qui sera produit, le travail pendant qu'il
 * a lieu, ce qui a été produit, et les textes à coller.
 */
export function PanneauExport({
  clip,
  outputs,
  framing,
  duree,
  empreinte,
  enregistrement,
  ecritureEnCours,
  ecritureEnEchec,
  onBranding,
}: {
  /** Le clip **du serveur** : c'est lui qui porte le titre, la description et les marques. */
  clip: Clip
  outputs: ClipOutputs
  /**
   * Le cadrage que le serveur publie.
   *
   * **Le panneau d'export énonce le cadrage** (§3.5) : c'est la dernière surface
   * avant la livraison, et le seul endroit où l'automatique passerait en fraude
   * si personne ne l'y disait. Ça ne coûte rien et ça retire ce cas.
   */
  framing: PublishedFraming
  /** La durée montée. Zéro veut dire qu'il ne reste rien à rendre. */
  duree: number
  /**
   * Tout ce qui décide du rendu, tel que l'écran le connaît : segments, ratio,
   * cadrage, marques, sous-titres, textes.
   *
   * **Elle sert à dater l'annonce de résultat, et la durée n'y suffisait pas** :
   * une coupe de même durée, un cadrage déplacé ou les marques basculées
   * périment les fichiers sans changer un seul des nombres que ce panneau
   * affichait. « Rendu terminé » continuait alors de décrire des fichiers que le
   * `PATCH` venait d'écarter. (relevé par Copilot)
   */
  empreinte: string
  /** L'écriture différée du **montage** : segments, ratio, cadrage. */
  enregistrement: EtatEnregistrement
  /**
   * Une écriture de clip, **quelle qu'elle soit**, est en vol.
   *
   * `enregistrement` ne couvre que le montage. Le titre, la description et les
   * marques partent par la même mutation sans y figurer : sans ce second
   * signal, basculer les marques puis exporter dans la foulée fait lire au
   * rendu la valeur d'avant, et produit un fichier qui contredit l'écran.
   * (relevé par Codex)
   */
  ecritureEnCours: boolean
  /** La dernière écriture de clip a échoué — le rendu lirait un état qu'on n'a pas voulu. */
  ecritureEnEchec: boolean
  onBranding: (branding: boolean) => void
}) {
  const exporter = useExporter()
  const [confirmation, setConfirmation] = useState(false)

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
  const [signatureRendue, setSignatureRendue] = useState<string | null>(null)

  const signature = `${clip.id}|${empreinte}`
  // Le ratio **natif** résolu, celui sous lequel l'export écrit ses fichiers.
  const native = framing.ratio
  const noms = nomsDeSortie(clip.id, native)
  const shotCount = framing.shots.length
  const unmeasured = unmeasuredShots(framing)
  const frames = shotRatios(framing)
  const déjàLivré = outputs.mp4Url !== null

  // **Trois empêchements, et chacun a sa raison écrite à côté du bouton.**
  // Rendre un état non enregistré produirait un fichier qui ne correspond à rien
  // de persistant ; rendre un clip vide ne produirait rien du tout.
  const empêchement =
    duree <= 0
      ? 'Tous les mots ont été retirés : il n’y a rien à rendre.'
      : enregistrement === 'en-attente'
        ? 'Un enregistrement est en attente. Rendre maintenant produirait un fichier qui ne correspond à rien de persistant.'
        : enregistrement === 'echec' || ecritureEnEchec
          ? 'Le dernier enregistrement a échoué. Le rendu attend qu’il passe.'
          : ecritureEnCours
            ? 'Une modification est en cours d’écriture. Le rendu lirait la version d’avant.'
            : null

  function lancer(force: boolean) {
    if (empêchement !== null || exporter.isPending) return
    setSignatureRendue(signature)
    exporter.mutate({ clipId: clip.id, force })
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="titre-export">
      <div className="flex items-baseline gap-2">
        <h2 id="titre-export" className="text-sm font-medium">
          Export
        </h2>
        <span className="font-mono text-[0.75rem] text-muted-foreground">{native}</span>
      </div>

      {/* **Ce que l'automatique a décidé, sur la dernière surface avant la
          livraison** (§3.5). Sans cette ligne, on peut exporter sans avoir
          jamais vu ce qui a été choisi pour soi — le seul cas où l'automatique
          passerait en fraude. */}
      <p className="text-[0.75rem] text-muted-foreground">
        {shotCount === 1 ? '1 plan' : `${shotCount} plans`}, cadrés{' '}
        <span className="font-mono">{frames.join(', ') || '—'}</span>
        {frames.length > 1 && ' selon le plan, dans la variante 9:16'}
        {unmeasured > 0 && (
          <>
            {' · '}
            <span className="text-amber-500 dark:text-amber-400">
              {unmeasured === 1
                ? '1 plan sans mesure, centré par défaut'
                : `${unmeasured} plans sans mesure, centrés par défaut`}
            </span>
          </>
        )}
      </p>

      <ListeDesSorties clip={clip} outputs={outputs} noms={noms} native={native} />

      {clip.title.trim() === '' && (
        // L'avertissement se pose sur le bouton d'export, pas sur le champ : le
        // titre est libre pendant la frappe, et un titre vide n'empêche pas le
        // rendu — il produit un `.txt` dont la première ligne est vide, donc
        // rien à coller au moment de publier.
        <p className="flex items-start gap-1.5 text-[0.75rem] text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Le titre est vide : le fichier de textes sortira avec « (sans titre) », donc rien à
          coller au moment de publier.
        </p>
      )}

      <label className="flex items-start gap-2 text-[0.75rem]">
        <input
          type="checkbox"
          className="mt-0.5 size-3.5 accent-stage"
          checked={clip.branding}
          onChange={(e) => onBranding(e.target.checked)}
        />
        <span>
          Incruster les marques
          <span className="block text-muted-foreground">
            Un clip qui les incruste refuse de se rendre quand aucune marque n’est exploitable.
            Décocher est l’échappatoire.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            // **Le même garde-fou des deux côtés.** Posé sur le seul lancement,
            // la boîte de confirmation s'ouvrait quand même : on confirmait, et
            // rien ne partait, sans qu'une ligne le dise.
            if (empêchement !== null || exporter.isPending) return
            if (déjàLivré) setConfirmation(true)
            else lancer(false)
          }}
          aria-disabled={empêchement !== null || undefined}
          aria-busy={exporter.isPending || undefined}
        >
          {exporter.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden />
          ) : (
            <FileText aria-hidden />
          )}
          {déjàLivré ? 'Ré-exporter' : 'Exporter'}
        </Button>

        {/* **Pas d'annulation.** Le rendu ffmpeg ne s'interrompt pas proprement
            en itération 0, et un bouton qui ne ferait qu'ignorer la réponse
            mentirait sur ce qui se passe. */}
        {exporter.isPending && (
          <span className="text-[0.75rem] text-muted-foreground" aria-live="polite">
            Rendu en cours — de dix secondes à une minute.
          </span>
        )}
      </div>

      {empêchement !== null && (
        // Écrite ici, jamais dans une bulle d'aide : une bulle qui n'apparaît
        // qu'au survol est invisible au clavier, et la raison d'un blocage doit
        // se lire avant d'essayer.
        <p className="text-[0.75rem] text-muted-foreground">{empêchement}</p>
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

      {exporter.isSuccess && !exporter.isPending && signatureRendue === signature && (
        // **`skipped: true` est un cas nominal**, et le plus fréquent quand on
        // rouvre un clip déjà exporté : rien n'a été refait, tout est en place.
        <p className="flex items-center gap-1.5 text-[0.75rem]" aria-live="polite">
          <Check className="size-3.5 text-stage" aria-hidden />
          {exporter.data.skipped
            ? 'Rien n’a été refait : les fichiers étaient déjà à jour.'
            : 'Rendu terminé.'}
        </p>
      )}

      <Separator />

      <ZoneDeTextes clip={clip} />

      <Dialog open={confirmation} onOpenChange={setConfirmation}>
        <DialogContent role="alertdialog">
          <DialogHeader>
            <DialogTitle>Refaire les rendus ?</DialogTitle>
            <DialogDescription>
              Ces fichiers sont livrés et seront écrasés :
            </DialogDescription>
          </DialogHeader>
          <ul className="font-mono text-[0.75rem]">
            {[noms.mp4, noms.variant9x16, noms.texts]
              .filter((nom): nom is string => nom !== null)
              .map((nom) => (
                <li key={nom}>{nom}</li>
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
                lancer(true)
              }}
            >
              Écraser et refaire
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/**
 * Ce que l'export produira, et ce qu'il a produit — **une seule liste**.
 *
 * Deux vidéos quand le ratio natif n'est pas 9:16 : le natif pour le feed
 * d'Instagram et de Facebook, la variante floutée pour TikTok et Shorts. Et
 * elles ne montrent pas le même cadre — le natif garde un seul ratio pour tout
 * le clip, la variante pose chaque plan au sien. C'est la conséquence du choix
 * de ratio qui ne se voyait nulle part, alors qu'elle change ce qu'on aura à
 * publier.
 */
function ListeDesSorties({
  clip,
  outputs,
  noms,
  native,
}: {
  clip: Clip
  outputs: ClipOutputs
  noms: ReturnType<typeof nomsDeSortie>
  native: Ratio
}) {
  return (
    <ul className="flex flex-col gap-2">
      <Sortie
        nom={noms.mp4}
        libellé={`le rendu ${native}, pour le feed`}
        url={outputs.mp4Url}
        étiquette={`Le rendu ${native} de ${clip.title || 'ce clip'}`}
      />

      {noms.variant9x16 === null ? (
        // **`variant9x16Due` sépare deux `null` qui ne veulent pas dire la même
        // chose.** Un clip dont le ratio natif est déjà 9:16 n'aura jamais de
        // variante à fond flouté, et annoncer un rendu manquant ici le ferait sur
        // le clip le mieux livré de la bibliothèque.
        <li className="text-[0.75rem] text-muted-foreground">
          Le ratio natif est déjà 9:16 : pas de variante à produire.
        </li>
      ) : (
        <Sortie
          nom={noms.variant9x16}
          libellé="la variante sur fond flouté, pour TikTok et Shorts"
          url={outputs.variant9x16Url}
          étiquette="La variante 9:16 sur fond flouté"
          absence="due, pas encore produite"
        />
      )}

      <Sortie nom={noms.texts} libellé="titre, description, mots-dièse" url={null} />
    </ul>
  )
}

function Sortie({
  nom,
  libellé,
  url,
  étiquette,
  absence,
}: {
  nom: string
  libellé: string
  url: string | null
  /** Le nom que lit un lecteur d'écran sur la vidéo. Absent : pas de lecture sur place. */
  étiquette?: string
  /** Ce qu'on dit quand le fichier est **dû** et pas encore là. */
  absence?: string
}) {
  return (
    <li className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[0.75rem]">{nom}</span>
        <span className="text-[0.75rem] text-muted-foreground">{libellé}</span>
      </span>
      {url !== null && étiquette !== undefined && (
        <video
          src={url}
          aria-label={étiquette}
          controls
          preload="metadata"
          className="w-full max-w-64 rounded bg-zinc-950"
        />
      )}
      {url === null && absence !== undefined && (
        <span className="text-[0.75rem] text-muted-foreground">{absence}</span>
      )}
    </li>
  )
}

/**
 * Les textes à coller, et le bouton qui les copie.
 *
 * Le `.txt` existe sur le disque du serveur : ce qu'il faut ici est le
 * presse-papiers, pas un chemin. La zone reste un `textarea` en lecture seule
 * plutôt qu'un bloc de texte, parce qu'un presse-papiers refusé — contexte non
 * sécurisé, permission coupée — laisse alors la sélection à la main comme
 * recours, au lieu d'un bouton mort.
 */
function ZoneDeTextes({ clip }: { clip: Clip }) {
  // **Le texte copié, pas un booléen.** « Copié » doit redevenir « Copier » dès
  // que les textes changent, sinon le bouton affirme que le presse-papiers porte
  // quelque chose qu'il ne porte plus.
  const [copié, setCopié] = useState<string | null>(null)
  const texte = texteDePublication(clip)
  const àJour = copié === texte

  async function copier() {
    try {
      await navigator.clipboard.writeText(texte)
      setCopié(texte)
    } catch {
      setCopié(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Textes de publication</h3>
        <Button size="sm" variant="outline" onClick={() => void copier()}>
          {àJour ? <Check aria-hidden /> : <Copy aria-hidden />}
          {àJour ? 'Copié' : 'Copier'}
        </Button>
      </div>
      <textarea
        readOnly
        value={texte}
        aria-label="Textes de publication"
        rows={7}
        className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-[0.75rem] leading-relaxed"
      />
    </div>
  )
}
