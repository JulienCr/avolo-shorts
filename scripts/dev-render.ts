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
import { renderClip, type SortieRendu } from '@/server/steps/render'
import { chargerEnv, chrono, créerBarre, durée, finBarre, quitter } from './dev-commun'

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

  const attendue = clipDuration(clip.segments)
  console.log(`Clip       : ${clipId} (projet ${clip.projectId})`)
  console.log(`Segments   : ${clip.segments.length} → ${attendue.toFixed(2)} s attendues`)
  console.log(`Ratio      : ${clip.ratio}${clip.ratio === 'auto' ? ' → 9:16 en itération 0' : ''}`)

  const barres = new Map<SortieRendu, (fraction: number | null) => void>()
  const t = chrono()
  const résultat = await renderClip(clipId, {
    db,
    force,
    onProgress: (a) => {
      let barre = barres.get(a.sortie)
      if (barre === undefined) {
        // La barre précédente est refermée avant d'en ouvrir une autre : les deux
        // sorties s'encodent l'une après l'autre, et deux barres sur la même
        // ligne se réécriraient l'une sur l'autre.
        if (barres.size > 0) finBarre()
        barre = créerBarre(`  ${a.sortie.padEnd(6)}`)
        barres.set(a.sortie, barre)
      }
      barre(a.fraction)
    },
  })
  if (barres.size > 0) finBarre()

  if (résultat.skipped) {
    console.log('Rendu      : déjà là, rien à refaire (--force pour repasser dessus)')
  } else {
    console.log(`Rendu      : produit en ${durée(t())}`)
  }
  console.log(`MP4        : ${résultat.mp4}`)
  console.log(`Variante   : ${résultat.variant9x16 ?? '(aucune, le clip est déjà en 9:16)'}`)
  console.log(`Textes     : ${résultat.texts}`)

  // Le contrôle de la tâche 14 : la durée du MP4 égale la somme des segments, à
  // 0,1 s près. Les dimensions sont imprimées avec, parce qu'un ratio mal résolu
  // se voit là et nulle part ailleurs dans une sortie texte.
  for (const [nom, fichier] of [
    ['natif', résultat.mp4],
    ['9:16', résultat.variant9x16],
  ] as const) {
    if (fichier === null) continue
    const { durationSec, width, height } = await probe(fichier)
    const écart = durationSec === null ? null : Math.abs(durationSec - attendue)
    console.log(
      `Contrôle ${nom.padEnd(6)}: ${width ?? '?'}x${height ?? '?'}, ` +
        `${durationSec?.toFixed(3) ?? '?'} s ` +
        `(écart ${écart === null ? '?' : `${écart.toFixed(3)} s`}${écart !== null && écart <= 0.1 ? ' ✓' : ''})`,
    )
  }
  return 0
}

main()
  .then((code) => {
    closeDb()
    quitter(code)
  })
  .catch((erreur: unknown) => {
    closeDb()
    console.error(erreur instanceof Error ? erreur.message : erreur)
    quitter(1)
  })
