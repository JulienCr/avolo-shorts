/**
 * Ingestion, proxy et audio, depuis la ligne de commande.
 *
 *     pnpm tsx scripts/dev-ingest.ts "2025-06-15-cqlp.mp4"
 *     pnpm tsx scripts/dev-ingest.ts "2025-06-15-cqlp.mp4" --force
 *
 * Relancé, il ne doit **rien** recalculer : c'est le point qui conditionne toute
 * la vitesse d'itération du projet (spec §4). Sans lui, chaque essai recoûte les
 * douze minutes de proxy.
 */

import { closeDb, getDb } from '@/server/db'
import { probe } from '@/server/ffprobe'
import { extractAudio } from '@/server/steps/audio'
import { ingest } from '@/server/steps/ingest'
import { buildProxy, encoderProxy } from '@/server/steps/proxy'
import { chargerEnv, timer, createBar, duration, finBar, quit, size } from './dev-common'

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const forced = arguments_.includes('--force')
  const source = arguments_.find((a) => !a.startsWith('--'))
  if (source === undefined) {
    console.error('Usage : pnpm tsx scripts/dev-ingest.ts "<fichier du dossier de replays>" [--force]')
    return 1
  }

  const db = getDb()

  const barCopy = createBar('  copie ')
  const tCopy = timer()
  const project = await ingest(source, {
    forced,
    db,
    onProgress: (a) => barCopy(a.fraction),
  })
  finBar()

  console.log(`Projet   : ${project.projectId}`)
  console.log(`Source   : ${project.sourcePath}`)
  console.log(`           ${size(project.sizeBytes)}, ${duration(project.durationSec)}`)
  console.log(
    `Copie    : ${project.stagedPath} — ${
      project.copied ? `copiée en ${duration(tCopy())}` : 'déjà présente, rien à faire'
    }`,
  )
  const barProxy = createBar('  proxy ')
  const tProxy = timer()
  const proxy = await buildProxy({
    projectId: project.projectId,
    input: project.stagedPath,
    durationSec: project.durationSec,
    forced,
    onProgress: (a) => barProxy(a.fraction),
  })
  finBar()
  // L'encodeur ne s'affiche **que si un encodage a eu lieu**, et pas au-dessus :
  // `encodeurProxy()` lève sur un `FFMPEG_ENCODER` inconnu, or `buildProxy` rend
  // justement ce choix paresseux pour qu'un proxy déjà là revienne tout de suite,
  // quoi que porte l'environnement. L'afficher plus haut aurait rétabli d'une
  // main ce que l'autre venait de retirer. Rien n'appelle `encoderName()` non
  // plus : ce serait la sonde NVENC, donc un vrai ffmpeg sur le GPU, dans une
  // commande d'ingestion qui promet de ne rien recalculer. (relevé par Copilot)
  console.log(
    `Proxy    : ${proxy.path} — ${
      proxy.skipped ? 'déjà là, rien à faire' : `encodé en ${duration(tProxy())} (${encoderProxy()})`
    }`,
  )

  const barAudio = createBar('  audio ')
  const tAudio = timer()
  const audio = await extractAudio({
    projectId: project.projectId,
    input: project.stagedPath,
    durationSec: project.durationSec,
    forced,
    onProgress: (a) => barAudio(a.fraction),
  })
  finBar()
  console.log(
    `Audio    : ${audio.path} — ${audio.skipped ? 'déjà là, rien à faire' : `extrait en ${duration(tAudio())}`}`,
  )

  // Le contrôle attendu par la tâche 7 : 960x540, 30 fps, et la durée de la
  // source à une seconde près.
  const probed = await probe(proxy.path)
  console.log(
    `Contrôle : ${probed.width}x${probed.height}, ${probed.fps} fps, ${duration(probed.durationSec)}`,
  )
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
