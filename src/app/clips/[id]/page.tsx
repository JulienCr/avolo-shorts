'use client'

import { ArrowLeftToLine, ArrowRightToLine, Scissors, Undo2 } from 'lucide-react'
import { use, useEffect, useMemo } from 'react'

import { AppBar } from '@/components/app-bar'
import { ClipPlayer } from '@/components/clip-player'
import { CropOverlay, RatioPicker } from '@/components/crop-picker'
import { TranscriptSurface } from '@/components/transcript-surface'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { clipDuration, type ClipStatus, type Segment } from '@/core/edl'
import { resolveRatio } from '@/core/framing'
import type { ClipDetail, ClipPatch } from '@/lib/api'
import { clampCropX, cropWidthFraction } from '@/lib/crop-preview'
import { clipBounds, indexTranscript, selectionBounds } from '@/lib/editing'
import { formatDuration, formatSpan, formatTimecode } from '@/lib/format'
import { usePatchClip, useClip } from '@/lib/queries'
import { useEditeur, usePeutAnnuler, useSegments } from '@/store/editor'

const LIBELLES_STATUT: Record<ClipStatus, string> = {
  candidate: 'proposition',
  kept: 'gardé',
  discarded: 'écarté',
  exported: 'exporté',
}

/**
 * L'écran de clip.
 *
 * La surface d'édition est le transcript (spec §13). Ce que cette page ajoute
 * autour : le lecteur qui saute les passages retirés, le cadrage à la main, et
 * la durée qui bouge en direct — comme information, jamais comme contrainte.
 */
export default function PageDeClip({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const detail = useClip(id)

  return (
    <div className="flex h-dvh flex-col">
      {detail.data ? (
        <Editeur detail={detail.data} />
      ) : (
        <>
          <AppBar chemin={[{ libelle: detail.isError ? 'Clip introuvable' : '…' }]} />
          <main className="mx-auto w-full max-w-5xl flex-1 p-6">
            {detail.isError ? (
              <p className="text-sm text-muted-foreground">
                Ce clip n’existe pas, ou le projet qui le portait a été supprimé.
              </p>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <Skeleton className="aspect-video w-full rounded-lg" />
                <div className="space-y-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              </div>
            )}
          </main>
        </>
      )}
    </div>
  )
}

function Editeur({ detail }: { detail: ClipDetail }) {
  const { clip, project, lines, proxyUrl } = detail
  const editeur = useEditeur()
  const segments = useSegments()
  const peutAnnuler = usePeutAnnuler()
  const patch = usePatchClip()

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

  const bornes = clipBounds(segments)
  const duree = clipDuration(segments)
  const selection = editeur.selection
  const etendueSelection = selection
    ? selectionBounds(words, selection.ancre, selection.tete)
    : null

  // La première phrase du clip, pour ne pas ouvrir sur le contexte qui le
  // précède. Calculée sur le clip **enregistré** et non sur le montage en
  // cours : sinon chaque coupe déplacerait le début du clip, donc la valeur,
  // donc le défilement — le texte fuirait sous les yeux à chaque geste.
  // La surface, elle, ne s'en sert qu'une fois par clip (voir `cle`).
  const ligneInitiale = useMemo(() => {
    const debut = clip.segments[0]?.start
    if (debut === undefined) return 0
    const i = lines.findIndex((l) => l.end > debut)
    return i < 0 ? 0 : i
  }, [lines, clip.segments])

  useEnregistrementAuto({
    reference: clip,
    segments,
    ratio: editeur.ratio,
    cropX: editeur.cropX,
    ecrire: patch.mutate,
  })

  useRaccourcis({
    annuler: editeur.annuler,
    retirer: () => editeur.retirerSelection(words),
    echapper: editeur.viderSelection,
    aSelection: selection !== null,
  })

  return (
    <>
      <AppBar
        chemin={[
          { libelle: project.title, href: `/projects/${clip.projectId}` },
          { libelle: clip.title },
        ]}
      >
        <span className="text-[0.7rem] text-muted-foreground">
          {patch.isPending ? 'enregistrement…' : 'enregistré'}
        </span>
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
      </AppBar>

      <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(22rem,38%)_1fr]">
        <section className="flex flex-col gap-4 overflow-y-auto border-b p-4 lg:border-r lg:border-b-0">
          <ClipPlayer
            proxyUrl={proxyUrl}
            segments={segments}
            overlay={
              <CropOverlay
                ratio={editeur.ratio}
                cropX={editeur.cropX}
                onCropX={editeur.deplacerCrop}
              />
            }
          />

          <RatioPicker ratio={editeur.ratio} onRatio={editeur.choisirRatio} />

          <Separator />

          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-medium">{clip.title}</h1>
              <Badge variant="outline" className="shrink-0 text-[0.65rem]">
                {LIBELLES_STATUT[clip.status]}
              </Badge>
            </div>
            {clip.description && (
              <p className="text-[0.8rem] leading-relaxed text-muted-foreground">
                {clip.description}
              </p>
            )}
          </div>

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
            {/* La valeur ramenée dans l'image, celle que dessine le rectangle —
                pas la valeur brute du store, qui garde l'intention quand on
                passe par un ratio où elle ne tient pas. */}
            <dd className="font-mono tabular-nums">
              {Math.round(
                clampCropX(editeur.cropX, cropWidthFraction(resolveRatio(editeur.ratio))) * 100,
              )}{' '}
              %
            </dd>
          </dl>
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
                >
                  <ArrowLeftToLine aria-hidden />
                  Commencer ici
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => editeur.poserBorne(words, selection.tete, 'end')}
                >
                  <ArrowRightToLine aria-hidden />
                  Terminer ici
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Glisser sur des mots pour les sélectionner · cliquer un mot barré pour le remonter
              </p>
            )}

            <span className="ml-auto flex items-baseline gap-1.5">
              <span className="text-[0.7rem] text-muted-foreground">durée</span>
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
              ligneInitiale={ligneInitiale}
              onSelectionner={editeur.commencerSelection}
              onEtendre={editeur.etendreSelection}
              onTerminer={editeur.terminerSelection}
              onRemonter={(index) => editeur.remonterMot(words, index)}
            />
          </div>
        </section>
      </main>
    </>
  )
}

/**
 * Les raccourcis : `Ctrl+Z` annule, `Suppr` retire la sélection, `Échap` la
 * vide. Trois touches pour trois gestes, comme la surface elle-même.
 */
function useRaccourcis({
  annuler,
  retirer,
  echapper,
  aSelection,
}: {
  annuler: () => void
  retirer: () => void
  echapper: () => void
  aSelection: boolean
}) {
  useEffect(() => {
    function surTouche(e: KeyboardEvent) {
      // Ne jamais voler une frappe à un champ de saisie : il n'y en a pas encore
      // ici, il y en aura (titre, description).
      //
      // Le test `instanceof HTMLElement` n'est pas une précaution de style : la
      // cible d'un événement clavier n'est pas toujours un élément — `window` et
      // `document` en sont aussi, et `closest` n'existe pas dessus. Sans lui, le
      // gestionnaire levait une `TypeError` et **aucun raccourci ne
      // fonctionnait**, sans rien afficher d'autre qu'une ligne de console.
      const cible = e.target
      if (
        cible instanceof HTMLElement &&
        (cible.isContentEditable || cible.closest('input, textarea, select'))
      ) {
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        annuler()
      } else if (aSelection && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        retirer()
      } else if (e.key === 'Escape') {
        echapper()
      }
    }

    window.addEventListener('keydown', surTouche)
    return () => window.removeEventListener('keydown', surTouche)
  }, [annuler, retirer, echapper, aSelection])
}

/**
 * L'enregistrement, en différé.
 *
 * Un `PATCH` par mot cliqué ferait une écriture toutes les deux secondes pendant
 * un montage. On attend donc que le geste se pose, et on n'envoie que ce qui a
 * réellement changé par rapport à la version connue du serveur — sans quoi la
 * réponse de l'écriture, qui met à jour cette version, relancerait une écriture.
 */
function useEnregistrementAuto({
  reference,
  segments,
  ratio,
  cropX,
  ecrire,
}: {
  /** Le clip tel que le serveur le connaît : la référence de comparaison. */
  reference: ClipDetail['clip']
  segments: Segment[]
  ratio: ClipDetail['clip']['ratio']
  cropX: number
  /** `mutate` de TanStack Query, référentiellement stable — donc utilisable en dépendance. */
  ecrire: (variables: { clipId: string; projectId: string; patch: ClipPatch }) => void
}) {
  useEffect(() => {
    const memesSegments =
      segments.length === reference.segments.length &&
      segments.every(
        (s, i) => s.start === reference.segments[i].start && s.end === reference.segments[i].end,
      )
    if (memesSegments && ratio === reference.ratio && cropX === reference.cropX) return

    const minuteur = setTimeout(() => {
      ecrire({
        clipId: reference.id,
        projectId: reference.projectId,
        patch: {
          ...(memesSegments ? {} : { segments }),
          ...(ratio === reference.ratio ? {} : { ratio }),
          ...(cropX === reference.cropX ? {} : { cropX }),
        },
      })
    }, 600)

    return () => clearTimeout(minuteur)
  }, [reference, segments, ratio, cropX, ecrire])
}
