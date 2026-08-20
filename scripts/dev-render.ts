/**
 * Export d'un clip, depuis la ligne de commande.
 *
 *     pnpm tsx scripts/dev-render.ts clip_0001
 *     pnpm tsx scripts/dev-render.ts clip_0001 --force
 *
 * Comme `dev-ingest.ts` et `dev-transcribe.ts`, ce n'est pas une couche du
 * produit : c'est le point d'entrée qui rend l'étape vérifiable sans passer par
 * l'interface. La tâche 10 branche la même fonction derrière
 * `POST /api/clips/:id/export`.
 *
 * Le contrôle qui compte est imprimé à la fin : **la durée du MP4 doit égaler la
 * somme des segments**. Un écart signale que les coupes internes n'ont pas été
 * faites là où l'EDL les demandait. Ce que ce contrôle ne voit pas, en revanche,
 * c'est la dérive des sous-titres après une coupe — celle-là ne se voit qu'en
 * regardant la vidéo.
 */

import { clipDuration } from '@/core/edl'
import { closeDb, getClip, getDb } from '@/server/db'
import { probe } from '@/server/ffprobe'
import { renderClip, type OutputRender } from '@/server/steps/render'
import { chargerEnv, timer, createBar, duration, finBar, quit } from './dev-common'

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const force = arguments_.includes('--force')
  const clipId = arguments_.find((a) => !a.startsWith('--'))
  if (clipId === undefined) {
    console.error('Usage : pnpm tsx scripts/dev-render.ts <identifiant de clip> [--force]')
    return 1
  }

  const db = getDb()
  const clip = getClip(db, clipId)
  if (clip === undefined) {
    console.error(`Clip inconnu : ${clipId}`)
    return 1
  }

  const expected = clipDuration(clip.segments)
  console.log(`Clip       : ${clipId} (projet ${clip.projectId})`)
  console.log(`Segments   : ${clip.segments.length} → ${expected.toFixed(2)} s attendues`)
  console.log(`Ratio      : ${clip.ratio}${clip.ratio === 'auto' ? ' → 9:16 en itération 0' : ''}`)

  const bars = new Map<OutputRender, (fraction: number | null) => void>()
  const t = timer()
  const result = await renderClip(clipId, {
    db,
    force,
    onProgress: (a) => {
      let bar = bars.get(a.output)
      if (bar === undefined) {
        // La barre précédente est refermée avant d'en ouvrir une autre : les deux
        // sorties s'encodent l'une après l'autre, et deux barres sur la même
        // ligne se réécriraient l'une sur l'autre.
        if (bars.size > 0) finBar()
        bar = createBar(`  ${a.output.padEnd(6)}`)
        bars.set(a.output, bar)
      }
      bar(a.fraction)
    },
  })
  if (bars.size > 0) finBar()

  if (result.skipped) {
    console.log('Rendu      : déjà là, rien à refaire (--force pour repasser dessus)')
  } else {
    console.log(`Rendu      : produit en ${duration(t())}`)
  }
  console.log(`MP4        : ${result.mp4 ?? '(aucun, RENDER_NATIVE est désactivé)'}`)
  console.log(`Variante   : ${result.variant9x16 ?? '(aucune, le clip est déjà en 9:16)'}`)
  console.log(`Textes     : ${result.texts}`)

  // Le contrôle de la tâche 14 : la durée du MP4 égale la somme des segments, à
  // 0,1 s près. Les dimensions sont imprimées avec, parce qu'un ratio mal résolu
  // se voit là et nulle part ailleurs dans une sortie texte.
  for (const [name, file] of [
    ['natif', result.mp4],
    ['9:16', result.variant9x16],
  ] as const) {
    if (file === null) continue
    const { durationSec, width, height } = await probe(file)
    const gap = durationSec === null ? null : Math.abs(durationSec - expected)
    console.log(
      `Contrôle ${name.padEnd(6)}: ${width ?? '?'}x${height ?? '?'}, ` +
        `${durationSec?.toFixed(3) ?? '?'} s ` +
        `(écart ${gap === null ? '?' : `${gap.toFixed(3)} s`}${gap !== null && gap <= 0.1 ? ' ✓' : ''})`,
    )
  }
  return 0
}

main()
  .then((code) => {
    closeDb()
    quit(code)
  })
  .catch((error: unknown) => {
    closeDb()
    console.error(error instanceof Error ? error.message : error)
    quit(1)
  })
