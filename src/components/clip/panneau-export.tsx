'use client'

import { Check, Copy, FileText, LoaderCircle, Send, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { unmeasuredShots, shotRatios } from '@/components/clip/framing'
import type { Clip, Ratio } from '@/core/edl'
import { clipExportEligibility } from '@/core/publication'
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
import { motsDièse, nomsDeSortie, texteDePublication } from '@/components/clip/textes'
import { PublishDialog, type PublishClipTarget } from '@/components/publication/publish-dialog'
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
  const attendus = [noms.mp4, noms.variant9x16, noms.texts].filter((n) => n !== null).length
  const livres = [outputs.mp4Url, outputs.variant9x16Url, outputs.textsUrl].filter(
    (u) => u !== null,
  ).length
  const pluriel = attendus > 1 ? 's' : ''
  const resume =
    livres === 0
      ? `${attendus} fichier${pluriel} à produire · natif ${native}`
      : livres === attendus
        ? `${attendus} fichier${pluriel} livré${pluriel} · natif ${native}`
        : `${livres} fichier${livres > 1 ? 's' : ''} sur ${attendus} livré${livres > 1 ? 's' : ''} · natif ${native}`

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

  const [publierOuvert, setPublierOuvert] = useState(false)
  /**
   * L'éligibilité à la publication, **lue sur `outputs.mp4Url`, jamais
   * déduite du statut.** `mp4Url` vaut `null` dans les trois situations que
   * son propre docbloc énumère (`src/lib/api.ts`) — jamais rendu, rendu
   * périmé, fichier disparu — et c'est exactement ce que `déjàLivré`
   * utilise déjà deux lignes plus haut pour le même écran. Répéter le même
   * calcul ici serait la première divergence.
   */
  const éligibilitéPublication = clipExportEligibility(déjàLivré)
  const cibleÀPublier: PublishClipTarget = {
    clipId: clip.id,
    title: clip.title,
    eligibility: éligibilitéPublication,
    // **L'empreinte de ce panneau, pas une recomputation.** `empreinte` porte
    // déjà tout ce qui décide du rendu (segments, ratio, cadrage, marques,
    // sous-titres, textes) — voir le commentaire de la prop plus haut. La
    // passer ici est ce qui préparera la nuance du retour d'usage §9 le jour
    // où une publication existera pour de vrai.
    currentFingerprint: empreinte,
  }

  return (
    // **Deux colonnes, parce que le panneau est devenu un bandeau.** Il vivait au
    // bas d'une colonne de réglages, où l'empilement était la seule mise en page
    // possible ; sous les quatre zones, en pleine largeur, l'empiler ferait
    // descendre les textes à coller sous un pli. Ce qui sort à gauche, ce qui se
    // colle à droite — et c'est à gauche, sous le bouton, que « Publier » viendra.
    <section
      className="grid items-start gap-4 lg:grid-cols-2 lg:gap-10"
      aria-labelledby="titre-export"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-baseline gap-2">
          {/* `h3` et non `h2` : l'écran de clip nomme désormais quatre zones, et
              « Livraison » est le titre de celle-ci. Deux `h2` empilés diraient
              deux sections là où il n'y en a qu'une — et c'est ici que le bouton
              « Publier » viendra se poser à côté de l'export. */}
          <h3 id="titre-export" className="text-sm font-medium">
            Export
          </h3>
          <span className="font-mono text-[0.75rem] text-muted-foreground">{native}</span>
        </div>

        {/* **Ce que l'automatique a décidé, sur la dernière surface avant la
            livraison** (§3.5). Sans cette ligne, on peut exporter sans avoir
            jamais vu ce qui a été choisi pour soi — le seul cas où l'automatique
            passerait en fraude. */}
        {/* **Ce qui est livré se regarde ; ce qui s'appelle comment se replie.**
            Le nom des fichiers, le compte des plans et « due, pas encore
            produite » sont vrais et utiles le jour où quelque chose cloche —
            pas les trente autres fois. Ils prenaient le tiers du panneau au
            détriment des textes qu'on vient y chercher. Ils restent à un clic,
            ce qui est la même règle que le transcript dans son tiroir. */}
        <details className="group/sorties">
          <summary className="cursor-pointer list-none text-[0.75rem] text-muted-foreground marker:content-none hover:text-foreground">
            <span className="mr-1 inline-block transition-transform group-open/sorties:rotate-90">
              ›
            </span>
            {resume}
          </summary>

          <p className="mt-2 text-[0.75rem] text-muted-foreground">
            {shotCount === 1 ? '1 plan' : `${shotCount} plans`}, cadrés{' '}
            <span className="font-mono">{frames.join(', ') || '—'}</span>
            {frames.length > 1 && ' selon le plan, dans la variante 9:16'}
          </p>

          <ListeDesSorties noms={noms} native={native} outputs={outputs} />
        </details>

        {/* **L'avertissement, lui, ne se replie pas.** Un plan que le détecteur
            n'a pas mesuré est posé au centre par défaut : c'est la dernière
            surface avant la livraison où cela peut encore se dire (§3.5), et le
            cacher derrière un pli reviendrait à le taire. */}
        {unmeasured > 0 && (
          <p className="text-[0.75rem] text-amber-500 dark:text-amber-400">
            {unmeasured === 1
              ? '1 plan sans mesure, centré par défaut'
              : `${unmeasured} plans sans mesure, centrés par défaut`}
          </p>
        )}

        {/* Ce qui est sur le disque se lit sur place. C'est le seul succès du
            parcours qui mérite d'être vu, donc il reste hors du pli. */}
        <DeliveredPlayers clip={clip} outputs={outputs} native={native} />

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

          {/* **Le bouton principal de la publication** (retour d'usage §3.6),
              à côté de l'export dans la zone Livraison. Il ouvre la même
              modale que la sélection en masse de la vue Émission — voir
              `PublishDialog`, qui porte la logique, jamais recopiée ici. */}
          <Button
            variant="outline"
            onClick={() => éligibilitéPublication.eligible && setPublierOuvert(true)}
            aria-disabled={!éligibilitéPublication.eligible || undefined}
          >
            <Send aria-hidden />
            Publier
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

        {/* **Même règle pour « Publier » : la raison se lit, elle ne se
            devine pas** (retour d'usage §2.4, mot pour mot). Un clip non
            exporté explique pourquoi plutôt que de désactiver en silence. */}
        {!éligibilitéPublication.eligible && (
          <p className="text-[0.75rem] text-muted-foreground">{éligibilitéPublication.reason}</p>
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
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        {/* Le filet ne sépare qu'en colonnes : empilées, c'est le trait
            horizontal qui fait le même travail. */}
        <Separator className="lg:hidden" />
        <ZoneDeTextes clip={clip} />
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

      <PublishDialog open={publierOuvert} onOpenChange={setPublierOuvert} clips={[cibleÀPublier]} />
    </section>
  )
}

/**
 * Ce que l'export produira : **les noms, et rien d'autre**.
 *
 * Deux vidéos quand le ratio natif n'est pas 9:16 : le natif pour le feed
 * d'Instagram et de Facebook, la variante floutée pour TikTok et Shorts. Et
 * elles ne montrent pas le même cadre — le natif garde un seul ratio pour tout
 * le clip, la variante pose chaque plan au sien.
 *
 * **La lecture sur place a déménagé dans `DeliveredPlayers`**, et la séparation
 * porte une décision : ces noms-ci sont du détail qu'on replie, un fichier livré
 * est un résultat qu'on regarde. Les tenir dans une seule liste obligeait à
 * choisir entre replier le résultat et déplier le détail.
 */
function ListeDesSorties({
  noms,
  native,
  outputs,
}: {
  noms: ReturnType<typeof nomsDeSortie>
  native: Ratio
  outputs: ClipOutputs
}) {
  return (
    <ul className="mt-2 flex flex-col gap-1">
      <li className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[0.75rem]">{noms.mp4}</span>
        <span className="text-[0.75rem] text-muted-foreground">le rendu {native}, pour le feed</span>
      </li>

      {noms.variant9x16 === null ? (
        // **`variant9x16Due` sépare deux `null` qui ne veulent pas dire la même
        // chose.** Un clip dont le ratio natif est déjà 9:16 n'aura jamais de
        // variante à fond flouté, et annoncer un rendu manquant ici le ferait sur
        // le clip le mieux livré de la bibliothèque.
        <li className="text-[0.75rem] text-muted-foreground">
          Le ratio natif est déjà 9:16 : pas de variante à produire.
        </li>
      ) : (
        <li className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[0.75rem]">{noms.variant9x16}</span>
          <span className="text-[0.75rem] text-muted-foreground">
            la variante sur fond flouté, pour TikTok et Shorts
            {outputs.variant9x16Url === null && outputs.variant9x16Due && ' — due, pas encore produite'}
          </span>
        </li>
      )}

      <li className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[0.75rem]">{noms.texts}</span>
        <span className="text-[0.75rem] text-muted-foreground">titre, description, mots-dièse</span>
      </li>
    </ul>
  )
}

/**
 * Ce qui est **sur le disque**, lisible sur place.
 *
 * « L'export produit un ou deux fichiers et le panneau les montre : lecture sur
 * place […] C'est le seul succès du parcours qui mérite d'être vu » (parcours
 * §3.3). Il reste donc hors du pli qui range les noms : c'est le résultat, pas
 * la nomenclature.
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
  ].filter((sortie): sortie is { url: string; label: string } => sortie.url !== null)

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
 * Les textes à coller — **trois champs, trois boutons, et un pour tout**.
 *
 * Le `.txt` existe sur le disque du serveur : ce qu'il faut ici est le
 * presse-papiers, pas un chemin. Il a d'abord vécu en un seul bloc, celui du
 * fichier ; mais on ne colle jamais le fichier — on colle un titre dans un
 * champ, une description dans un autre, des mots-dièse dans un troisième, et
 * chaque formulaire les demande séparément. Un bloc unique obligeait à
 * sélectionner à la main les trois morceaux, ce qui est exactement le geste que
 * le bouton existait pour supprimer.
 *
 * **Le bouton « tout » reste**, parce qu'il sert le cas où l'on garde le texte
 * de côté plutôt qu'on ne le publie tout de suite, et parce qu'il produit le
 * même contenu que le `.txt` — la seule chose qui garantisse que les deux ne
 * divergent pas.
 *
 * Les champs restent en lecture seule plutôt qu'en blocs de texte : un
 * presse-papiers refusé — contexte non sécurisé, permission coupée — laisse
 * alors la sélection à la main comme recours, au lieu d'un bouton mort.
 */
function ZoneDeTextes({ clip }: { clip: Clip }) {
  const titre = clip.title.trim()
  const description = clip.description.trim()
  const dièses = motsDièse(`${titre}\n${description}`).join(' ')

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Textes de publication</h3>
        <BoutonCopier texte={texteDePublication(clip)} libellé="Copier tout" />
      </div>

      <ChampCopiable étiquette="Titre" valeur={titre} />
      <ChampCopiable étiquette="Description" valeur={description} lignes={6} />
      <ChampCopiable étiquette="Mots-dièse" valeur={dièses} />
    </div>
  )
}

/**
 * Un des trois textes, avec son bouton.
 *
 * Vide, le champ le dit plutôt que de rester blanc — et son bouton se désactive
 * : copier le vide efface le presse-papiers, ce qui est le contraire du service
 * rendu, et se remarque au moment de coller.
 */
function ChampCopiable({
  étiquette,
  valeur,
  lignes = 1,
}: {
  étiquette: string
  valeur: string
  /** Une ligne pour un titre ou des mots-dièse, plusieurs pour une description. */
  lignes?: number
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        {/* **Le nom accessible dit « de publication », l'étiquette visible non.**
            L'écran porte déjà un champ « Titre » et un champ « Description »,
            ceux qu'on écrit ; ces trois-ci sont ce qu'on en copie. Deux contrôles
            du même nom sur le même écran, c'est un lecteur d'écran qui ne sait
            plus lequel il annonce — et à l'œil, la colonne dit déjà lequel est
            lequel. */}
        <span aria-hidden className="text-[0.75rem] text-muted-foreground">
          {étiquette}
        </span>
        <BoutonCopier texte={valeur} libellé={`Copier ${étiquette.toLowerCase()}`} taille="xs" />
      </div>
      <textarea
        aria-label={`${étiquette} de publication`}
        readOnly
        rows={lignes}
        value={valeur}
        placeholder={`(sans ${étiquette.toLowerCase()})`}
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
function BoutonCopier({
  texte,
  libellé,
  taille = 'sm',
}: {
  texte: string
  libellé: string
  taille?: 'xs' | 'sm'
}) {
  const [copié, setCopié] = useState<string | null>(null)
  const àJour = copié === texte && texte !== ''
  // Ce que le bouton montre : « Copier », ou « Copier tout » quand il les prend
  // tous. Son nom accessible, lui, reste complet.
  const court = libellé.startsWith('Copier tout') ? 'Copier tout' : 'Copier'

  async function copier() {
    try {
      await navigator.clipboard.writeText(texte)
      setCopié(texte)
    } catch {
      setCopié(null)
    }
  }

  return (
    <Button
      size={taille}
      variant="outline"
      onClick={() => void copier()}
      // Copier le vide efface le presse-papiers : le contraire du service rendu,
      // et cela ne se remarque qu'au moment de coller.
      disabled={texte === ''}
      // **Le nom complet à la voix, court à l'œil.** Quatre boutons « Copier »
      // sur le même écran ne se distinguent qu'à leur place ; un lecteur d'écran
      // n'a pas cette place. Et le nom porte l'état : sans lui, « Copié » ne
      // serait qu'un mot à l'écran, invisible à la voix — un `aria-label` fixe
      // masque le contenu du bouton.
      aria-label={àJour ? `${libellé} — copié` : libellé}
    >
      {àJour ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-hidden>{àJour ? 'Copié' : court}</span>
    </Button>
  )
}
