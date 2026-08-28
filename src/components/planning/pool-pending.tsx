'use client'

import { useState } from 'react'

import type { PlanningPendingClip } from '@/lib/api'
import { useExporter } from '@/lib/queries'
import { agreement } from '@/components/review/template'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

/** Le tour en cours : combien sont faits, sur combien le clic en a promis. */
type Run = { done: number; total: number }

/**
 * Le rattrapage du vivier : exporter les clips gardés sans vidéo à jour.
 *
 * **Séquentiel**, parce qu'un export tient ffmpeg et le GPU quelques dizaines
 * de secondes — 4 à 24 s par clip, mesuré le 28 août 2026 — et que deux rendus
 * concurrents se les disputeraient sans rien signaler.
 *
 * **Un échec n'arrête pas les suivants** : sinon un seul clip dont la source a
 * bougé ferait renoncer le lot, et réparer deviendrait « relancer en espérant ».
 */
export function PendingExport({ pending }: { pending: readonly PlanningPendingClip[] }) {
  const exporter = useExporter()
  const [run, setRun] = useState<Run | null>(null)
  const [failures, setFailures] = useState<readonly string[]>([])

  async function exportAll() {
    // **Un instantané, jamais la propriété** : chaque export invalide le
    // vivier, donc `pending` rétrécit pendant la boucle — la parcourir en
    // direct sauterait un clip sur deux, sous un dénominateur qui recule.
    const targets = [...pending]
    setRun({ done: 0, total: targets.length })
    setFailures([])
    const failed: string[] = []
    for (const clip of targets) {
      try {
        await exporter.mutateAsync({ clipId: clip.clipId })
      } catch {
        failed.push(clip.title)
      }
      setRun((current) => (current === null ? null : { ...current, done: current.done + 1 }))
    }
    setFailures(failed)
    setRun(null)
  }

  if (pending.length === 0 && run === null && failures.length === 0) return null

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={run !== null || pending.length === 0}
        onClick={() => void exportAll()}
      >
        {run !== null
          ? `Export ${Math.min(run.done + 1, run.total)}/${run.total}…`
          : pending.length === 1
            ? 'Exporter le clip manquant'
            : `Exporter les ${pending.length} clips manquants`}
      </Button>

      {run === null ? (
        pending.length > 0 && <p className="text-xs text-muted-foreground">{breakdown(pending)}</p>
      ) : (
        <Progress
          value={Math.round((run.done / run.total) * 100)}
          aria-label="Avancement de l’export"
          className="w-56"
        />
      )}

      {failures.length > 0 && run === null && (
        <p className="text-xs text-destructive">
          {agreement(failures.length, 'clip n’a pas pu être exporté', 'clips n’ont pas pu être exportés')}
          &nbsp;: {failures.join(', ')}.
        </p>
      )}
    </div>
  )
}

/**
 * Les deux raisons, comptées séparément.
 *
 * Elles ne portent pas le même risque : `stale` rattrape un clip déjà réglé,
 * `unedited` en rend un que personne n'a ouvert — donc avec ses valeurs par
 * défaut. Le mélange doit se lire avant le clic, pas se découvrir après.
 */
function breakdown(pending: readonly PlanningPendingClip[]): string {
  const unedited = pending.filter((c) => c.reason === 'unedited').length
  const stale = pending.length - unedited
  const parts: string[] = []
  if (unedited > 0) parts.push(agreement(unedited, 'jamais monté', 'jamais montés'))
  if (stale > 0) parts.push(agreement(stale, 'rendu périmé', 'rendus périmés'))
  return parts.join(', ')
}
