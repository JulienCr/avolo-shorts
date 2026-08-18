'use client'

import { use, useMemo, useState } from 'react'

import { CandidateCard } from '@/components/candidate-card'
import { AppBar } from '@/components/app-bar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { clipDuration } from '@/core/edl'
import type { CandidateClip, StepName } from '@/lib/api'
import { basculerStatut, estEcarte, estGarde, type Decision } from '@/lib/clip-status'
import { formatDuration } from '@/lib/format'
import { useCandidats, usePatchClip, useProjet } from '@/lib/queries'

const LIBELLES_ETAPES: Record<StepName, string> = {
  proxy: 'Proxy',
  audio: 'Audio',
  transcript: 'Transcription',
  candidates: 'Repérage',
  renders: 'Rendus',
}

/**
 * L'écran de tri.
 *
 * Le premier écran de l'itération 0, et celui qui se soigne en premier
 * (spec §13). Vingt-cinq propositions, deux décisions par proposition, et rien
 * entre le regard et la décision : pas de boîte de dialogue, pas de confirmation,
 * pas d'attente serveur — l'écriture est optimiste.
 */
export default function PageDeTri({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const projet = useProjet(id)
  const candidats = useCandidats(id)
  const patch = usePatchClip()

  const [voirEcartes, setVoirEcartes] = useState(false)

  const liste = useMemo(() => candidats.data ?? [], [candidats.data])
  const compte = useMemo(() => compter(liste), [liste])
  const visibles = voirEcartes ? liste : liste.filter((c) => !estEcarte(c.status))

  function basculer(clip: CandidateClip, decision: Decision) {
    // `basculerStatut` est la même définition que celle qu'affiche la carte —
    // elles divergeaient, et le bouton « Gardé » d'un clip exporté produisait un
    // changement d'état invisible.
    const status = basculerStatut(clip.status, decision)
    patch.mutate({ clipId: clip.id, projectId: id, patch: { status } })
  }

  return (
    <div className="flex min-h-full flex-col">
      <AppBar chemin={[{ libelle: projet.data?.project.title ?? id }]}>
        {projet.data?.running && <Progression running={projet.data.running} />}
      </AppBar>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">
        <div className="mb-4 flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <h1 className="text-lg font-semibold tracking-tight">Candidats</h1>

          <p className="text-sm text-muted-foreground">
            <span className="font-mono tabular-nums">{compte.aTrier}</span> à trier ·{' '}
            <span className="font-mono text-stage-foreground tabular-nums">{compte.gardes}</span>{' '}
            gardé{compte.gardes > 1 ? 's' : ''} ·{' '}
            <span className="font-mono tabular-nums">
              {formatDuration(compte.dureeGardee)}
            </span>{' '}
            au total
          </p>

          {/* Une écriture optimiste qui échoue remet la carte comme elle était.
              Sans ce mot, le clic aurait simplement l'air de ne pas avoir été
              pris — et on recommencerait. */}
          {patch.isError && (
            <p className="text-sm text-destructive">
              L’enregistrement a échoué. La carte est revenue à son état précédent.
            </p>
          )}

          {compte.ecartes > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              onClick={() => setVoirEcartes((v) => !v)}
              aria-pressed={voirEcartes}
            >
              {voirEcartes ? 'Masquer' : 'Revoir'}{' '}
              {compte.ecartes === 1 ? 'l’écarté' : `les ${compte.ecartes} écartés`}
            </Button>
          )}
        </div>

        {/* **Une analyse qui a échoué doit se voir.** Elle dure quarante minutes
            et rend la main bien après la réponse 202 : sans ce mot, un échec
            ressemble trait pour trait à un repérage qui n'a rien trouvé, et on
            relance la même chose en attendant un autre résultat. */}
        {projet.data?.error && !projet.data.running && (
          <div
            // La bannière apparaît après coup, une fois l'interrogation revenue :
            // sans région live, un lecteur d'écran ne dit rien d'une analyse de
            // quarante minutes qui vient d'échouer. (relevé par Copilot)
            role="alert"
            className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3"
          >
            <p className="text-sm font-medium text-destructive">La dernière analyse a échoué.</p>
            <p className="mt-1 text-sm text-muted-foreground">{projet.data.error}</p>
          </div>
        )}

        {candidats.isPending && <GrilleEnAttente />}

        {candidats.isError && (
          <Message
            titre="Les candidats ne se chargent pas."
            detail="Relancer le repérage depuis le projet, ou vérifier que l'analyse est allée jusqu'au bout."
          />
        )}

        {candidats.isSuccess && visibles.length === 0 && (
          <Message
            titre={liste.length === 0 ? 'Aucun candidat pour le moment.' : 'Tout est trié.'}
            detail={
              liste.length === 0
                ? "Le repérage n'a rien rendu, ou il n'a pas encore tourné."
                : 'Les clips gardés se montent depuis leur carte.'
            }
          />
        )}

        {visibles.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {visibles.map((clip) => (
              <CandidateCard
                key={clip.id}
                clip={clip}
                onGarder={() => basculer(clip, 'kept')}
                onEcarter={() => basculer(clip, 'discarded')}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function compter(liste: CandidateClip[]) {
  const gardes = liste.filter((c) => estGarde(c.status))
  return {
    aTrier: liste.filter((c) => c.status === 'candidate').length,
    gardes: gardes.length,
    ecartes: liste.filter((c) => estEcarte(c.status)).length,
    dureeGardee: gardes.reduce((total, c) => total + clipDuration(c.segments), 0),
  }
}

/** L'étape en cours et son avancement, pendant que le pipeline tourne. */
function Progression({ running }: { running: { step: StepName; progress: number } }) {
  const pourcent = Math.round(Math.min(1, Math.max(0, running.progress)) * 100)
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{LIBELLES_ETAPES[running.step]}</span>
      <span
        role="progressbar"
        aria-valuenow={pourcent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${LIBELLES_ETAPES[running.step]} en cours`}
        className="h-1 w-28 overflow-hidden rounded-full bg-muted"
      >
        <span className="block h-full bg-stage transition-[width]" style={{ width: `${pourcent}%` }} />
      </span>
      <span className="font-mono tabular-nums">{pourcent}%</span>
    </div>
  )
}

function GrilleEnAttente() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border">
          <Skeleton className="aspect-video rounded-none" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        </div>
      ))}
    </div>
  )
}

function Message({ titre, detail }: { titre: string; detail: string }) {
  return (
    <div className="rounded-xl border border-dashed px-6 py-14 text-center">
      <p className="text-sm font-medium">{titre}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  )
}
