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

import { CIBLES_LANÇABLES, attendre, lancer, lireStatut, type CibleLançable } from '@/server/run'
import { closeDb } from '@/server/db'
import { chargerEnv, chrono, durée, quitter } from './dev-commun'

function estCible(a: string): a is CibleLançable {
  return (CIBLES_LANÇABLES as readonly string[]).includes(a)
}

async function main(): Promise<number> {
  await chargerEnv()

  const arguments_ = process.argv.slice(2)
  const force = arguments_.includes('--force')
  const positionnels = arguments_.filter((a) => !a.startsWith('--'))
  const projectId = positionnels[0]
  const cibles = positionnels.slice(1)

  if (projectId === undefined || cibles.length === 0) {
    console.error(
      `Usage : pnpm tsx scripts/dev-run.ts <projectId> <cible…> [--force]\n` +
        `Cibles : ${CIBLES_LANÇABLES.join(', ')}`,
    )
    return 1
  }
  const inconnues = cibles.filter((c) => !estCible(c))
  if (inconnues.length > 0) {
    console.error(
      `Cible inconnue : ${inconnues.join(', ')}. Attendu : ${CIBLES_LANÇABLES.join(', ')}`,
    )
    return 1
  }

  const t = chrono()
  const { plan } = await lancer(projectId, cibles.filter(estCible), { force })
  console.log(`Projet  : ${projectId}`)
  console.log(`Cibles  : ${cibles.join(', ')}${force ? ' (forcées)' : ''}`)
  console.log(`Plan    : ${plan.length === 0 ? 'rien, tout est là' : plan.join(' → ')}`)

  // **Le suivi passe par `status.json`, pas par les rappels de `lancer`.** Le
  // lanceur les garde pour lui et publie son avancement dans le fichier, qui est
  // aussi ce que l'interface lit : suivre autre chose ici afficherait un état
  // que personne d'autre ne voit.
  let dernier = ''
  const battement = setInterval(() => {
    const statut = lireStatut(projectId)
    const courante = statut?.running
    if (!courante) return
    const ligne = `${courante.step} ${Math.round(courante.progress * 100)} %`
    if (ligne === dernier) return
    dernier = ligne
    console.log(`  ${durée(t())} — ${ligne}`)
  }, 5000)

  try {
    await attendre(projectId)
  } finally {
    clearInterval(battement)
    closeDb()
  }

  const statut = lireStatut(projectId)
  console.log(`Fini en ${durée(t())}`)
  if (statut?.repérage) {
    const r = statut.repérage
    console.log(
      `Repérage : ${r.notées} fenêtres notées sur ${r.fenêtres}` +
        ` (couverture ${(r.couverture * 100).toFixed(1)} %` +
        `, ${r.lotsRefusés} lot(s) refusé(s), ${r.lotsRépondus} repris)`,
    )
  }
  // L'échec est **rendu**, pas seulement affiché : ce script s'enchaîne dans un
  // `&&` avec la mesure qui le suit, et une analyse qui a planté ne doit pas
  // laisser mesurer le fichier de la passe précédente.
  if (statut?.error) {
    console.error(`Échec : ${statut.error}`)
    return 1
  }
  return 0
}

void main().then(quitter, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  quitter(1)
})
