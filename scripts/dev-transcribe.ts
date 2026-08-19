/**
 * Transcription WhisperX, depuis la ligne de commande.
 *
 *     pnpm tsx scripts/dev-transcribe.ts 2025-06-15-cqlp
 *     pnpm tsx scripts/dev-transcribe.ts 2025-06-15-cqlp --force
 *
 * Le projet doit avoir été ingéré (`dev-ingest.ts`) : c'est la base qui dit quel
 * original porte le sidecar, et le sidecar se pose **à côté de l'original sur le
 * Drive**, pas à côté de la copie de travail.
 *
 * Le chemin à parcourir est calculé par `planSteps` — le graphe par présence de
 * `core/graph.ts` — et non écrit en dur : viser le transcript ne doit pas
 * construire le proxy, et un WAV absent sous un transcript présent ne doit pas
 * relancer vingt-cinq minutes de GPU.
 */

import fs from 'node:fs'
import { shotSteps, type StepName } from '@/core/graph'
import { closeDb, getDb, getProject } from '@/server/db'
import { audioPath, placeSidecar, proxyPath } from '@/server/paths'
import { extractAudio } from '@/server/steps/audio'
import { editingResponds } from '@/server/steps/ingest'
import { transcribe } from '@/server/steps/transcript'
import { chargerEnv, timer, createBar, duration, finBar, quit } from './dev-common'

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const force = arguments_.includes('--force')
  const projectId = arguments_.find((a) => !a.startsWith('--'))
  if (projectId === undefined) {
    console.error('Usage : pnpm tsx scripts/dev-transcribe.ts <identifiant de projet> [--force]')
    return 1
  }

  const db = getDb()
  const project = getProject(db, projectId)
  if (project === undefined) {
    console.error(
      `Projet inconnu : ${projectId}. Lancer d'abord : pnpm tsx scripts/dev-ingest.ts "<fichier>.mp4"`,
    )
    return 1
  }

  const audio = audioPath(projectId)

  // La même garde que dans `transcribe`, et **avant** `placeSidecar` : c'est
  // ici que le premier accès synchrone au Drive a lieu, donc ici que le script
  // se figerait si le transport 9p était mort — la garde de `transcribe`, plus
  // bas, ne serait jamais atteinte. (relevé par Copilot)
  if (!(await editingResponds(project.sourcePath))) {
    console.error(
      'Le dossier des replays ne répond pas. REPLAY_DIR est monté en 9p et peut être monté ' +
        'avec son transport mort dessous. Rouvrir le lecteur côté Windows, ou remonter le partage.',
    )
    return 1
  }

  // **Par `placeSidecar`, jamais par `transcriptPath`.** Le second rend le
  // chemin voulu et ignore le repli dans le projet : un transcript rangé là par
  // une passe précédente passerait pour absent, et l'émission entière serait
  // retranscrite.
  const placement = placeSidecar(project.sourcePath, projectId)

  const presence: Record<StepName, boolean> = {
    proxy: fs.existsSync(proxyPath(projectId)),
    audio: fs.existsSync(audio),
    transcript: fs.existsSync(placement.transcript),
    // Ce script ne vise que le transcript : ni l'analyse ni les candidats
    // n'entrent dans son plan, et un `false` ne les y fait pas entrer non plus
    // — `planSteps` ne remonte que les dépendances de la cible.
    analysis: false,
    candidates: false,
    renders: false,
  }

  const shot = shotSteps('transcript', presence, force ? ['transcript'] : [])
  console.log(`Projet     : ${projectId}`)
  console.log(`Source     : ${project.sourcePath}`)
  console.log(`Sidecar    : ${placement.transcript}${placement.fallback ? ' (repli dans le projet)' : ''}`)
  console.log(`À faire    : ${shot.length === 0 ? 'rien, tout est là' : shot.join(' → ')}`)

  if (shot.includes('audio')) {
    if (project.stagedPath === null) {
      console.error("Le projet n'a pas de copie de travail. Relancer dev-ingest.ts.")
      return 1
    }
    const bar = createBar('  audio ')
    const t = timer()
    await extractAudio({
      projectId,
      input: project.stagedPath,
      durationSec: project.durationSec,
      force: true,
      onProgress: (a) => bar(a.fraction),
    })
    finBar()
    console.log(`Audio      : ${audio} — extrait en ${duration(t())}`)
  }

  // Le chemin effectivement écrit, qui n'est pas forcément celui calculé plus
  // haut : si l'état d'écriture du Drive change entre les deux, `transcribe`
  // pose le sidecar dans le repli et le dit. Relire l'ancien chemin échouerait
  // sur un transcript pourtant bien produit. (relevé par Copilot)
  let transcript = placement.transcript

  if (shot.includes('transcript')) {
    const t = timer()
    const result = await transcribe({
      source: project.sourcePath,
      projectId,
      audio,
      force: true,
      onLog: (line) => console.log(`  worker | ${line}`),
    })
    transcript = result.path
    console.log(
      `Transcript : ${result.path}${result.fallback ? ' (repli dans le projet)' : ''}` +
        ` — écrit en ${duration(t())}`,
    )
  }

  // Le contrôle attendu par la tâche 8 : plusieurs milliers de segments,
  // plusieurs dizaines de milliers de mots, et des horodatages mot à mot non
  // nuls.
  const content: unknown = JSON.parse(fs.readFileSync(transcript, 'utf8'))
  const segments = (content as { segments?: { words?: { start?: number }[] }[] }).segments ?? []
  const words = segments.reduce((n, s) => n + (s.words?.length ?? 0), 0)
  const withoutTimestamp = segments
    .flatMap((s) => s.words ?? [])
    .filter((w) => typeof w.start !== 'number').length
  console.log(
    `Contrôle   : ${segments.length} segments, ${words} mots, ${withoutTimestamp} sans horodatage`,
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
