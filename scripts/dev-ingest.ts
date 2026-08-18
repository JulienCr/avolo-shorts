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
import { encoderName } from '@/server/ffmpeg'
import { probe } from '@/server/ffprobe'
import { extractAudio } from '@/server/steps/audio'
import { ingest } from '@/server/steps/ingest'
import { buildProxy } from '@/server/steps/proxy'
import { chargerEnv, chrono, créerBarre, durée, finBarre, taille } from './dev-commun'

async function main(): Promise<number> {
  chargerEnv()

  const arguments_ = process.argv.slice(2)
  const force = arguments_.includes('--force')
  const source = arguments_.find((a) => !a.startsWith('--'))
  if (source === undefined) {
    console.error('Usage : pnpm tsx scripts/dev-ingest.ts "<fichier du dossier de replays>" [--force]')
    return 1
  }

  const db = getDb()

  const barreCopie = créerBarre('  copie ')
  const tCopie = chrono()
  const projet = await ingest(source, {
    force,
    db,
    onProgress: (a) => barreCopie(a.fraction),
  })
  finBarre()

  console.log(`Projet   : ${projet.projectId}`)
  console.log(`Source   : ${projet.sourcePath}`)
  console.log(`           ${taille(projet.sizeBytes)}, ${durée(projet.durationSec)}`)
  console.log(
    `Copie    : ${projet.stagedPath} — ${
      projet.copied ? `copiée en ${durée(tCopie())}` : 'déjà présente, rien à faire'
    }`,
  )
  console.log(`Encodeur : ${encoderName()}`)

  const barreProxy = créerBarre('  proxy ')
  const tProxy = chrono()
  const proxy = await buildProxy({
    projectId: projet.projectId,
    input: projet.stagedPath,
    durationSec: projet.durationSec,
    force,
    onProgress: (a) => barreProxy(a.fraction),
  })
  finBarre()
  console.log(
    `Proxy    : ${proxy.path} — ${proxy.skipped ? 'déjà là, rien à faire' : `encodé en ${durée(tProxy())}`}`,
  )

  const barreAudio = créerBarre('  audio ')
  const tAudio = chrono()
  const audio = await extractAudio({
    projectId: projet.projectId,
    input: projet.stagedPath,
    durationSec: projet.durationSec,
    force,
    onProgress: (a) => barreAudio(a.fraction),
  })
  finBarre()
  console.log(
    `Audio    : ${audio.path} — ${audio.skipped ? 'déjà là, rien à faire' : `extrait en ${durée(tAudio())}`}`,
  )

  // Le contrôle attendu par la tâche 7 : 960x540, 30 fps, et la durée de la
  // source à une seconde près.
  const sondage = await probe(proxy.path)
  console.log(
    `Contrôle : ${sondage.width}x${sondage.height}, ${sondage.fps} fps, ${durée(sondage.durationSec)}`,
  )
  return 0
}

main()
  .then((code) => {
    closeDb()
    process.exitCode = code
  })
  .catch((erreur: unknown) => {
    closeDb()
    console.error(erreur instanceof Error ? erreur.message : erreur)
    process.exitCode = 1
  })
