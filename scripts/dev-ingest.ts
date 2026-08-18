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
import { buildProxy, encodeurProxy } from '@/server/steps/proxy'
import { chargerEnv, chrono, créerBarre, durée, finBarre, quitter, taille } from './dev-commun'

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
  // L'encodeur ne s'affiche **que si un encodage a eu lieu**, et pas au-dessus :
  // `encodeurProxy()` lève sur un `FFMPEG_ENCODER` inconnu, or `buildProxy` rend
  // justement ce choix paresseux pour qu'un proxy déjà là revienne tout de suite,
  // quoi que porte l'environnement. L'afficher plus haut aurait rétabli d'une
  // main ce que l'autre venait de retirer. Rien n'appelle `encoderName()` non
  // plus : ce serait la sonde NVENC, donc un vrai ffmpeg sur le GPU, dans une
  // commande d'ingestion qui promet de ne rien recalculer. (relevé par Copilot)
  console.log(
    `Proxy    : ${proxy.path} — ${
      proxy.skipped ? 'déjà là, rien à faire' : `encodé en ${durée(tProxy())} (${encodeurProxy()})`
    }`,
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
    quitter(code)
  })
  .catch((erreur: unknown) => {
    closeDb()
    console.error(erreur instanceof Error ? erreur.message : erreur)
    quitter(1)
  })
