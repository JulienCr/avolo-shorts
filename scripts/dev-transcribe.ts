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
import { planSteps, type StepName } from '@/core/graph'
import { closeDb, getDb, getProject } from '@/server/db'
import { audioPath, placeSidecar, proxyPath } from '@/server/paths'
import { extractAudio } from '@/server/steps/audio'
import { montageRépond } from '@/server/steps/ingest'
import { transcribe } from '@/server/steps/transcript'
import { chargerEnv, chrono, créerBarre, durée, finBarre, quitter } from './dev-commun'

async function main(): Promise<number> {
  chargerEnv()

  const arguments_ = process.argv.slice(2)
  const force = arguments_.includes('--force')
  const projectId = arguments_.find((a) => !a.startsWith('--'))
  if (projectId === undefined) {
    console.error('Usage : pnpm tsx scripts/dev-transcribe.ts <identifiant de projet> [--force]')
    return 1
  }

  const db = getDb()
  const projet = getProject(db, projectId)
  if (projet === undefined) {
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
  if (!(await montageRépond(projet.sourcePath))) {
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
  const placement = placeSidecar(projet.sourcePath, projectId)

  const présence: Record<StepName, boolean> = {
    proxy: fs.existsSync(proxyPath(projectId)),
    audio: fs.existsSync(audio),
    transcript: fs.existsSync(placement.transcript),
    candidates: false,
    renders: false,
  }

  const plan = planSteps('transcript', présence, force ? ['transcript'] : [])
  console.log(`Projet     : ${projectId}`)
  console.log(`Source     : ${projet.sourcePath}`)
  console.log(`Sidecar    : ${placement.transcript}${placement.fallback ? ' (repli dans le projet)' : ''}`)
  console.log(`À faire    : ${plan.length === 0 ? 'rien, tout est là' : plan.join(' → ')}`)

  if (plan.includes('audio')) {
    if (projet.stagedPath === null) {
      console.error("Le projet n'a pas de copie de travail. Relancer dev-ingest.ts.")
      return 1
    }
    const barre = créerBarre('  audio ')
    const t = chrono()
    await extractAudio({
      projectId,
      input: projet.stagedPath,
      durationSec: projet.durationSec,
      force: true,
      onProgress: (a) => barre(a.fraction),
    })
    finBarre()
    console.log(`Audio      : ${audio} — extrait en ${durée(t())}`)
  }

  // Le chemin effectivement écrit, qui n'est pas forcément celui calculé plus
  // haut : si l'état d'écriture du Drive change entre les deux, `transcribe`
  // pose le sidecar dans le repli et le dit. Relire l'ancien chemin échouerait
  // sur un transcript pourtant bien produit. (relevé par Copilot)
  let transcript = placement.transcript

  if (plan.includes('transcript')) {
    const t = chrono()
    const résultat = await transcribe({
      source: projet.sourcePath,
      projectId,
      audio,
      force: true,
      onLog: (ligne) => console.log(`  worker | ${ligne}`),
    })
    transcript = résultat.path
    console.log(
      `Transcript : ${résultat.path}${résultat.fallback ? ' (repli dans le projet)' : ''}` +
        ` — écrit en ${durée(t())}`,
    )
  }

  // Le contrôle attendu par la tâche 8 : plusieurs milliers de segments,
  // plusieurs dizaines de milliers de mots, et des horodatages mot à mot non
  // nuls.
  const contenu: unknown = JSON.parse(fs.readFileSync(transcript, 'utf8'))
  const segments = (contenu as { segments?: { words?: { start?: number }[] }[] }).segments ?? []
  const mots = segments.reduce((n, s) => n + (s.words?.length ?? 0), 0)
  const sansHorodatage = segments
    .flatMap((s) => s.words ?? [])
    .filter((w) => typeof w.start !== 'number').length
  console.log(
    `Contrôle   : ${segments.length} segments, ${mots} mots, ${sansHorodatage} sans horodatage`,
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
