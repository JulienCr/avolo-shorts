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
        // `role="alert"` : l'échec arrive au bout d'une attente longue, et un
        // lecteur d'écran resté sur le bouton ne verrait rien passer sans lui.
        // (relevé par Copilot)
        <p role="alert" className="text-xs text-destructive">
          {agreement(failures.length, 'clip n’a pas pu être exporté', 'clips n’ont pas pu être exportés')}
          &nbsp;: {failures.join(', ')}.
        </p>
      )}
    </div>
  )
}

/**
 * Les deux raisons, comptées séparément — elles ne coûtent pas le même temps :
 * `stale` réencode par-dessus un rendu existant, `missing` part de zéro.
 *
 * **Elles disent l'état du rendu, pas l'histoire du clip.** Un clip sans rendu
 * n'est pas un clip que personne n'a ouvert : `discardRenderStale` fait
 * redescendre à `kept` un exporté qu'on rouvre. (relevé par Copilot et Codex)
 */
function breakdown(pending: readonly PlanningPendingClip[]): string {
  const missing = pending.filter((c) => c.reason === 'missing').length
  const stale = pending.length - missing
  const parts: string[] = []
  if (missing > 0) parts.push(`${missing} sans rendu`)
  if (stale > 0) parts.push(agreement(stale, 'rendu périmé', 'rendus périmés'))
  return parts.join(', ')
}
