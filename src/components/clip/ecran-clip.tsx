'use client'

import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  RotateCw,
  Scissors,
  Redo2,
  Undo2,
} from 'lucide-react'
import { useIsMutating } from '@tanstack/react-query'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { AppBar } from '@/components/parcours/app-bar'
import { ApercuSortie } from '@/components/clip/apercu-sortie'
import { ChampsTextes } from '@/components/clip/champs-textes'
import { ClipPlayer, basculerLecture, placerLecture } from '@/components/clip/clip-player'
import { CropOverlay, RatioPicker } from '@/components/clip/crop-picker'
import { gesteSurMotBarré } from '@/components/clip/geste-mot'
import { useLecture } from '@/components/clip/lecture'
import { PanneauExport } from '@/components/clip/panneau-export'
import { DialogueRaccourcis, useRaccourcis } from '@/components/clip/raccourcis'
import { TranscriptSurface } from '@/components/clip/transcript-surface'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cadrageAutomatique, ratioEffectif, usePlanCourant } from '@/components/clip/cadrage'
import { clipDuration } from '@/core/edl'
import { estGarde } from '@/core/parcours'
import type { Clip, ClipDetail, ClipPatch } from '@/lib/api'
import { LIBELLES_STATUT } from '@/lib/clip-status'
import { clampCropX, cropWidthFraction } from '@/lib/crop-preview'
import { clipBounds, indexTranscript, ligneInitiale, selectionBounds } from '@/lib/editing'
import { differences, useEnregistrementAuto } from '@/lib/enregistrement'
import { formatDuration, formatSpan, formatTimecode } from '@/lib/format'
import { clipSuivant, lienClip } from '@/lib/parcours'
import { usePatchClip, useCandidats } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useEditeur, usePeutAnnuler, usePeutRetablir, useSegments } from '@/store/editor'

/**
 * L'écran de clip, **hors de la page**.
 *
 * Un fichier de `src/app/` porte une route : ce qu'il rend, il ne le compose
 * pas. La page garde donc le chargement, l'erreur et `use(params)` ; tout le
 * montage vit ici, où il se monte dans un test sans passer par la résolution
 * d'une promesse de paramètres.
 *
 * La surface d'édition est le transcript (spec §13), et **c'est aussi l'organe
 * de navigation temporelle** : cliquer un mot y place la lecture, la lecture y
 * surligne le mot en cours. Ce que cet écran ajoute autour : le lecteur qui
 * saute les passages retirés, l'aperçu de ce que le ratio produira, les deux
 * textes qui se publient, et l'export — qui vit ici, pas ailleurs, parce que
 * c'est par clip qu'on choisit le cadre.
 */
export function EcranDeClip({ detail }: { detail: ClipDetail }) {
  const { clip, project, lines, proxyUrl, outputs, framing } = detail
  const editeur = useEditeur()
  const segments = useSegments()
  const peutAnnuler = usePeutAnnuler()
  const peutRetablir = usePeutRetablir()
  const patch = usePatchClip()

  // **La liste des candidats, interrogée ici et pas supposée en cache.** Arriver
  // par une URL partagée, un signet ou un rechargement est un parcours que la
  // conception promet de rendre repreneur, et le cache est alors vide. Venant du
  // tri, c'est un succès de cache et cela ne coûte rien.
  const candidats = useCandidats(clip.projectId)

  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [recherche, setRecherche] = useState(false)
  /**
   * Les champs de texte dont l'écriture est restée en échec.
   *
   * Ils ne se déduisent pas de `patch.isError`, qui ne décrit que le dernier
   * appel de l'observateur partagé : une écriture qui aboutit derrière une qui
   * a échoué le remet à faux, et l'export repartirait contre un texte que le
   * serveur n'a pas. (relevé par Codex et par Copilot)
   */
  const [textesEnEchec, setTextesEnEchec] = useState<string[]>([])
  const signalerEchecTexte = useCallback((champ: string, enEchec: boolean) => {
    setTextesEnEchec((liste) =>
      enEchec
        ? liste.includes(champ)
          ? liste
          : [...liste, champ]
        : liste.filter((autre) => autre !== champ),
    )
  }, [])
  const [aide, setAide] = useState(false)

  // Le store se charge du clip une fois, et pas à chaque passage de la requête :
  // la garde est dans `charger`.
  const charger = editeur.charger
  useEffect(() => {
    charger(clip)
  }, [charger, clip])

  const { words, lines: lignesIndexees } = useMemo(
    () => indexTranscript(lines, segments),
    [lines, segments],
  )

  // **La remise à zéro d'abord, la publication des mots ensuite — l'ordre de
  // déclaration est l'ordre d'exécution.** Le clip suivant repart d'une position
  // nulle, faute de quoi celle du précédent surlignerait un mot avant même
  // d'avoir lu quoi que ce soit ; mais déclarée après, cette remise à zéro
  // efface les mots qu'on vient de publier, et plus rien ne se surligne jusqu'à
  // la première coupe.
  useEffect(() => {
    useLecture.getState().reinitialiser()
    return () => useLecture.getState().reinitialiser()
  }, [clip.id])

  // Le surlignage se calcule dans `useLecture`, à partir de ces mots-ci : ils
  // sont réindexés à chaque coupe, et un index gardé tel quel surlignerait un
  // mot au hasard.
  useEffect(() => {
    useLecture.getState().definirMots(words)
  }, [words])

  const bornes = clipBounds(segments)
  const duree = clipDuration(segments)

  // Tout ce qui décide du rendu. Le panneau d'export s'en sert pour dater son
  // annonce de résultat : une coupe de même durée, un cadrage déplacé ou les
  // marques basculées périment les fichiers sans changer la durée.
  // **Le cadrage résolu y entre, et pas seulement le ratio demandé.** Le cadre
  // se recalcule sur les segments : une coupe peut le changer sans que
  // `editeur.ratio` ni `editeur.cropX` ne bougent, et « rendu terminé »
  // continuerait de décrire des fichiers que le `PATCH` vient d'écarter.
  const empreinteDuRendu = JSON.stringify([
    clip.id,
    segments,
    editeur.ratio,
    editeur.cropX,
    framing,
    clip.branding,
    clip.captions,
    clip.title,
    clip.description,
  ])
  const selection = editeur.selection
  const etendueSelection = selection
    ? selectionBounds(words, selection.ancre, selection.tete)
    : null

  // Calculée sur le clip **enregistré**, et la règle est dans `@/lib/editing`.
  // La surface, elle, ne s'en sert qu'une fois par clip (voir `cle`).
  const premiereLigne = useMemo(() => ligneInitiale(lines, clip.segments), [lines, clip.segments])

  const enregistrement = useEnregistrementAuto({
    // **Tant que le store n'a pas chargé ce clip, on n'enregistre rien.** Au
    // premier rendu, `segments` vaut `[]` et le cadrage ses valeurs par défaut :
    // comparés au clip du serveur, ils forment une modification — celle qui
    // viderait le clip. `charger` ne s'exécute qu'après ce rendu, donc sans
    // cette garde l'écriture différée part d'un état qui n'est pas le montage,
    // et le Strict Mode de développement la déclenche immédiatement.
    pret: editeur.clipId === clip.id,
    reference: clip,
    segments,
    ratio: editeur.ratio,
    cropX: editeur.cropX,
    // **`mutateAsync` ici aussi**, et pour la raison écrite sur `ecrire` plus
    // bas : cet observateur-ci est celui que les champs de texte et les marques
    // se partagent avec le montage, donc `mutate` aurait laissé la première
    // frappe de titre emporter le sort de l'enregistrement en vol. (issue #55)
    ecrire: patch.mutateAsync,
    reconcilier: editeur.reconcilier,
  })

  // **L'échec d'une écriture directe ne remonte pas par `useEnregistrementAuto`.**
  // Celui-ci ne compare que les segments, le ratio et le cadrage ; le titre, la
  // description et les marques partent par la même mutation sans y figurer. Sans
  // ce raccord, la barre affiche « enregistré » sur une écriture que le serveur
  // vient de refuser, et son rollback a déjà remis la valeur d'avant à l'écran.
  // (relevé par Copilot)
  const enEchec = enregistrement === 'echec' || patch.isError || textesEnEchec.length > 0
  const dernierRefus = patch.isError ? patch.variables : undefined

  // **Toutes les écritures en vol sur ce clip, et pas seulement la dernière.**
  // `isPending` décrit le dernier appel de l'observateur, que les champs de
  // texte, les marques et l'enregistrement du montage partagent : une écriture
  // récente qui aboutit le remet à faux alors qu'une plus ancienne est encore
  // en vol, et l'export part contre un état que le serveur n'a pas encore.
  // (relevé par Copilot)
  // Ce que la barre sait renvoyer : l'écart de montage que l'écriture différée
  // refuse de rejouer telle quelle, ou la dernière écriture directe refusée.
  const peutRenvoyer =
    differences(clip, segments, editeur.ratio, editeur.cropX) !== null ||
    (dernierRefus !== undefined && dernierRefus.clipId === clip.id)

  const ecrituresEnVol = useIsMutating({
    predicate: (mutation) =>
      (mutation.state.variables as { clipId?: string } | undefined)?.clipId === clip.id,
  })

  /**
   * Une écriture directe — titre, description, marques.
   *
   * **`mutateAsync`, et pas `mutate`.** Les rappels de `mutate` sont attachés à
   * la dernière mutation de l'observateur, que `usePatchClip` partage entre
   * tous les champs et l'enregistrement du montage : une écriture partie
   * entre-temps efface ceux de la précédente, dont l'appelant n'apprend jamais
   * le sort. La promesse de `mutateAsync`, elle, appartient à la mutation.
   * (relevé par Copilot)
   */
  const ecrire = useCallback(
    (champs: ClipPatch) =>
      patch.mutateAsync({ clipId: clip.id, projectId: clip.projectId, patch: champs }),
    [patch, clip.id, clip.projectId],
  )

  /** Le clip barré cliqué : un trou à combler, ou une borne à déplacer (§7.1). */
  const remonter = useCallback(
    (index: number) => {
      const mot = words[index]
      if (!mot) return
      const geste = gesteSurMotBarré(clipBounds(segments), mot)
      if (geste.kind === 'remonter') editeur.remonterMot(words, index)
      else editeur.poserBorne(words, index, geste.bord)
    },
    [words, segments, editeur],
  )

  useRaccourcis({
    lectureOuPause: () => basculerLecture(video, segments),
    annuler: editeur.annuler,
    retablir: editeur.retablir,
    retirer: () => editeur.retirerSelection(words),
    echapper: () => (recherche ? setRecherche(false) : editeur.viderSelection()),
    // **« Le mot sous le curseur » est le mot sélectionné.** Cliquer un mot le
    // sélectionne, `Entrée` aussi : les deux chemins font coïncider le curseur
    // du clavier et la sélection, et `I`/`O` n'ont donc pas besoin d'un troisième
    // repère.
    poserBorne: (bord) => {
      if (selection) editeur.poserBorne(words, selection.tete, bord)
    },
    chercher: () => setRecherche(true),
    aide: () => setAide(true),
    aSelection: selection !== null,
  })

  const gardes = (candidats.data ?? []).filter((c) => estGarde(c.status))
  const rang = gardes.findIndex((c) => c.id === clip.id)
  const precedent = rang > 0 ? gardes[rang - 1] : null
  const suivant = clipSuivant(candidats.data ?? [], clip.id)

  return (
    <>
      <AppBar
        lieu={{
          kind: 'clip',
          projet: { id: clip.projectId, titre: project.title },
          clip: { titre: clip.title },
        }}
      >
        {/* Trois états, dont l'échec : un montage qui n'est pas parti doit se
            voir, sinon on ferme l'onglet en croyant l'avoir enregistré. Et
            « enregistré » n'apparaît qu'une fois le dernier état local
            réellement écrit — pas pendant les 600 ms de temporisation. */}
        <span
          className={cn(
            'text-[0.75rem]',
            enEchec ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {enEchec
            ? 'échec de l’enregistrement'
            : enregistrement === 'en-attente' || patch.isPending
              ? 'enregistrement…'
              : 'enregistré'}
        </span>

        {/* **Réessayer, plutôt qu'attendre un nouveau geste.** L'écriture
            différée retient la signature de la tentative ratée et ne la rejoue
            pas telle quelle — sans quoi elle boucle. Ce bouton refait la même
            comparaison et l'envoie, ce qui débloque sans rien inventer. */}
        {/* **Le bouton ne paraît que s'il a quelque chose à renvoyer.** Un
            échec qui ne porte que sur un champ de texte se rattrape à côté du
            champ, où le geste est déjà : un second bouton, inerte, y ferait
            croire à une reprise qui n'a pas lieu. */}
        {enEchec && peutRenvoyer && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              // Le montage d'abord — c'est l'écart que l'écriture différée
              // refuse de rejouer telle quelle, sans quoi elle bouclerait. À
              // défaut, la dernière écriture directe : elle n'a pas d'écart à
              // recalculer, seulement une requête à refaire.
              const modif = differences(clip, segments, editeur.ratio, editeur.cropX)
              if (modif) {
                void ecrire(modif).catch(() => {})
                return
              }
              const refusé = patch.variables
              if (refusé && refusé.clipId === clip.id) void ecrire(refusé.patch).catch(() => {})
            }}
          >
            <RotateCw aria-hidden />
            Réessayer
          </Button>
        )}

        <Button
          size="sm"
          variant="ghost"
          onClick={editeur.annuler}
          disabled={!peutAnnuler}
          title="Ctrl+Z"
        >
          <Undo2 aria-hidden />
          Annuler
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={editeur.retablir}
          disabled={!peutRetablir}
          title="Ctrl+Shift+Z"
        >
          <Redo2 aria-hidden />
          Rétablir
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => setAide(true)}
          aria-label="Raccourcis clavier"
        >
          <Keyboard aria-hidden />
        </Button>
      </AppBar>

      <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(24rem,40%)_1fr]">
        <section className="flex flex-col gap-4 overflow-y-auto border-b p-4 lg:border-r lg:border-b-0">
          {/* **Deux images, deux outils.** À gauche la source avec le rectangle :
              on cadre en regardant ce qu'on laisse dehors. À droite le canevas de
              sortie, à l'échelle du téléphone : c'est là qu'un 16:9 se voit
              occuper le tiers de la hauteur et un 4:5 les sept dixièmes. */}
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <ClipPlayer
              proxyUrl={proxyUrl}
              segments={segments}
              onVideo={setVideo}
              overlay={
                <CropOverlay
                  cadrage={framing}
                  ratio={editeur.ratio}
                  cropX={editeur.cropX}
                  onCropX={editeur.deplacerCrop}
                />
              }
            />
            <ApercuSortie
              video={video}
              cadrage={framing}
              ratio={editeur.ratio}
              cropX={editeur.cropX}
            />
          </div>

          <RatioPicker cadrage={framing} ratio={editeur.ratio} onRatio={editeur.choisirRatio} />

          <Separator />

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="shrink-0 text-[0.75rem]">
              {LIBELLES_STATUT[clip.status]}
            </Badge>
            {rang >= 0 && (
              // Le rang dit qu'on est dans une boucle, pas au bout du monde.
              <span className="text-[0.75rem] text-muted-foreground">
                clip {rang + 1} sur {gardes.length} gardés
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {precedent ? (
                <Button size="sm" variant="ghost" render={<Link href={lienClip(precedent.id)} />}>
                  <ChevronLeft aria-hidden />
                  Clip précédent
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled>
                  <ChevronLeft aria-hidden />
                  Clip précédent
                </Button>
              )}
              {suivant ? (
                <Button size="sm" variant="outline" render={<Link href={lienClip(suivant.id)} />}>
                  Clip suivant
                  <ChevronRight aria-hidden />
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled>
                  Clip suivant
                  <ChevronRight aria-hidden />
                </Button>
              )}
            </span>
          </div>

          <ChampsTextes clip={clip} onEcrire={ecrire} onEchec={signalerEchecTexte} />

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.75rem]">
            <dt className="text-muted-foreground">Bornes</dt>
            {/* Relues dans la liste rendue, jamais la valeur demandée :
                `moveBoundary` pose la borne sur le segment voisin quand la
                demande tombe dans un trou. */}
            <dd className="font-mono tabular-nums">
              {bornes ? `${formatTimecode(bornes.start)} → ${formatTimecode(bornes.end)}` : '—'}
            </dd>

            <dt className="text-muted-foreground">Segments</dt>
            <dd className="font-mono tabular-nums">{segments.length}</dd>

            <dt className="text-muted-foreground">Cadre</dt>
            {/* Ce que le rendu découpera sur le plan qu'on regarde : le cadre
                saute aux frontières, donc une seule valeur pour tout le clip ne
                voudrait rien dire. La valeur est ramenée dans l'image, comme le
                rectangle la dessine — pas la valeur brute du store, qui garde
                l'intention quand on passe par un ratio où elle ne tient pas. */}
            <CadreDuPlan cadrage={framing} ratio={editeur.ratio} cropX={editeur.cropX} />
          </dl>

          <Separator />

          <PanneauExport
            clip={clip}
            outputs={outputs}
            cadrage={framing}
            duree={duree}
            enregistrement={enregistrement}
            empreinte={empreinteDuRendu}
            // `enregistrement` ne suit que le montage : le titre, la description
            // et les marques passent par la même mutation sans y figurer.
            ecritureEnCours={ecrituresEnVol > 0}
            ecritureEnEchec={patch.isError || textesEnEchec.length > 0}
            // `mutateAsync` rejette : la promesse se ramasse ici, l'échec se lit
            // dans la barre d'application et dans le garde-fou du panneau.
            onBranding={(branding) => void ecrire({ branding }).catch(() => {})}
          />
        </section>

        <section className="flex min-h-0 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
            {selection && etendueSelection ? (
              <>
                <span className="text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums">
                    {Math.abs(selection.tete - selection.ancre) + 1}
                  </span>{' '}
                  mots ·{' '}
                  <span className="font-mono tabular-nums">
                    {formatSpan(etendueSelection.to - etendueSelection.from)}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => editeur.retirerSelection(words)}
                  title="Suppr"
                >
                  <Scissors aria-hidden />
                  Retirer
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => editeur.poserBorne(words, selection.tete, 'start')}
                  title="I"
                >
                  <ArrowLeftToLine aria-hidden />
                  Commencer ici
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => editeur.poserBorne(words, selection.tete, 'end')}
                  title="O"
                >
                  <ArrowRightToLine aria-hidden />
                  Terminer ici
                </Button>
              </>
            ) : duree === 0 ? (
              // Le cas prévu côté serveur et qui n'avait pas de rendu propre :
              // tout a été retiré, et le transcript reste la façon d'en sortir.
              <p className="text-[0.75rem] text-muted-foreground">
                Il ne reste rien du clip. Cliquer un mot barré le fait recommencer là.
              </p>
            ) : (
              <p className="text-[0.75rem] text-muted-foreground">
                Glisser sur des mots pour les sélectionner · cliquer un mot pour y placer la
                lecture · cliquer un mot barré pour le remonter
              </p>
            )}

            <span className="ml-auto flex items-baseline gap-1.5">
              <span className="text-[0.75rem] text-muted-foreground">durée</span>
              <span className="font-mono text-sm font-medium tabular-nums">
                {formatDuration(duree)}
              </span>
            </span>
          </div>

          <div className="min-h-0 flex-1">
            <TranscriptSurface
              cle={clip.id}
              lines={lignesIndexees}
              words={words}
              selection={selection}
              ligneInitiale={premiereLigne}
              onSelectionner={editeur.commencerSelection}
              onEtendre={editeur.etendreSelection}
              onTerminer={editeur.terminerSelection}
              onRemonter={remonter}
              onPlacer={(index) => placerLecture(video, segments, words[index].start)}
              recherche={recherche}
              onRecherche={setRecherche}
            />
          </div>
        </section>
      </main>

      <DialogueRaccourcis ouvert={aide} onOuvert={setAide} />
    </>
  )
}

/**
 * Le cadre du plan sous la lecture, en toutes lettres.
 *
 * **Un composant à part, et c'est la raison qui compte** : il s'abonne à la
 * position de lecture, qui change quatre fois par seconde. Lu dans `EcranDeClip`,
 * il ferait rendre le transcript virtualisé et le lecteur à cette cadence. Ici,
 * le sélecteur ne rend qu'un index de plan, donc rien ne bouge entre deux
 * frontières.
 */
function CadreDuPlan({
  cadrage,
  ratio,
  cropX,
}: {
  cadrage: ClipDetail['framing']
  ratio: Clip['ratio']
  cropX: number
}) {
  const plan = usePlanCourant(cadrage)
  const effectif = ratioEffectif(plan, ratio)
  const position = cadrageAutomatique(cadrage) ? (plan?.cropX ?? 0.5) : cropX
  const pourcent = Math.round(clampCropX(position, cropWidthFraction(effectif)) * 100)
  return (
    <dd className="font-mono tabular-nums">
      {effectif} · {pourcent} %
      {plan?.source === 'default' && (
        <span className="ml-1 font-sans text-amber-500 dark:text-amber-400">
          rien mesuré sur ce plan
        </span>
      )}
    </dd>
  )
}
