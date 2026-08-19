/**
 * Lance des cibles du graphe depuis la ligne de commande.
 *
 *     pnpm tsx scripts/dev-run.ts 2026-03-08-caro-mdlm candidates analysis
 *     pnpm tsx scripts/dev-run.ts 2026-03-08-caro-mdlm analysis --force
 *
 * `dev-transcribe.ts` ne vise que le transcript et `dev-ingest.ts` que
 * l'ingestion ; **rien ne lançait `analysis` ni `candidates` hors du serveur**,
 * alors que les deux sont exactement ce qu'une mesure de cadrage a besoin de
 * refaire. Ce script comble ce trou et rien d'autre : il appelle `lancer`, le
 * même point d'entrée que `POST /api/projects/:id/run`, et attend la fin.
 *
 * Il n'y a donc **aucune décision ici** — ni quelles étapes exécuter, ni dans
 * quel ordre : `planPourCibles` le dit, et le redire ailleurs ferait une seconde
 * source de vérité sur la seule question que le graphe existe pour trancher.
 */

import { TARGETS_LAUNCHABLE, wait, launch, lireStatus, type TargetLaunchable } from '@/server/run'
import { closeDb } from '@/server/db'
import { chargerEnv, timer, duration, quit } from './dev-common'

function isTarget(a: string): a is TargetLaunchable {
  return (TARGETS_LAUNCHABLE as readonly string[]).includes(a)
}

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const force = arguments_.includes('--force')
  const positional = arguments_.filter((a) => !a.startsWith('--'))
  const projectId = positional[0]
  const targets = positional.slice(1)

  if (projectId === undefined || targets.length === 0) {
    console.error(
      `Usage : pnpm tsx scripts/dev-run.ts <projectId> <cible…> [--force]\n` +
        `Cibles : ${TARGETS_LAUNCHABLE.join(', ')}`,
    )
    return 1
  }
  const unknown = targets.filter((c) => !isTarget(c))
  if (unknown.length > 0) {
    console.error(
      `Cible inconnue : ${unknown.join(', ')}. Attendu : ${TARGETS_LAUNCHABLE.join(', ')}`,
    )
    return 1
  }

  const t = timer()
  const { plan } = await launch(projectId, targets.filter(isTarget), { force })
  console.log(`Projet  : ${projectId}`)
  console.log(`Cibles  : ${targets.join(', ')}${force ? ' (forcées)' : ''}`)
  console.log(`Plan    : ${plan.length === 0 ? 'rien, tout est là' : plan.join(' → ')}`)

  // **Le suivi passe par `status.json`, pas par les rappels de `lancer`.** Le
  // lanceur les garde pour lui et publie son avancement dans le fichier, qui est
  // aussi ce que l'interface lit : suivre autre chose ici afficherait un état
  // que personne d'autre ne voit.
  let last = ''
  const beat = setInterval(() => {
    const status = lireStatus(projectId)
    const current = status?.running
    if (!current) return
    const line = `${current.step} ${Math.round(current.progress * 100)} %`
    if (line === last) return
    last = line
    console.log(`  ${duration(t())} — ${line}`)
  }, 5000)

  try {
    await wait(projectId)
  } finally {
    clearInterval(beat)
    closeDb()
  }

  const status = lireStatus(projectId)
  console.log(`Fini en ${duration(t())}`)
  if (status?.selectionReport) {
    const r = status.selectionReport
    console.log(
      `Repérage : ${r.scored} fenêtres notées sur ${r.windows}` +
        ` (couverture ${(r.coverage * 100).toFixed(1)} %` +
        `, ${r.rejectedBatches} lot(s) refusé(s), ${r.answeredBatches} repris)`,
    )
  }
  // L'échec est **rendu**, pas seulement affiché : ce script s'enchaîne dans un
  // `&&` avec la mesure qui le suit, et une analyse qui a planté ne doit pas
  // laisser mesurer le fichier de la passe précédente.
  if (status?.error) {
    console.error(`Échec : ${status.error}`)
    return 1
  }
  return 0
}

void main().then(quit, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quit(1)
})
