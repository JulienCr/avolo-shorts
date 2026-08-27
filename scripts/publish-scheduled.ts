/**
 * Une passe de l'ordonnanceur, depuis la ligne de commande (spec §5.4).
 *
 *     pnpm tsx scripts/publish-scheduled.ts
 *     pnpm tsx scripts/publish-scheduled.ts --dry-run
 *
 * Moulé sur `dev-publish.ts` : pas de serveur Next, `chargerEnv()` résout le
 * `.env`. La tâche planifiée de Windows invoque ce script toutes les cinq
 * minutes (`docs/publication-scheduler.md`) ; toute la décision vit dans
 * `src/server/publication/scheduler.ts`, ce fichier ne fait que la brancher.
 */

import { wait } from '@/server/llm/retry'
import { closeDb, getDb } from '@/server/db'
import { projectsDir } from '@/server/paths'
import { createResendMailer } from '@/server/publication/mailer'
import { runOnePass, type SchedulerOutcome } from '@/server/publication/scheduler'
import { chargerEnv, quit } from './dev-common'

/**
 * Construit une fois, comme `FORMAT_DATE` dans `src/components/sources/
 * texts.ts` : Julien programme et lit ce journal depuis Paris, jamais en UTC
 * — un `Z` ne se lit pas comme une heure de la grille.
 */
const FORMAT_PARIS = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'Europe/Paris',
})

function formatParis(ms: number): string {
  return FORMAT_PARIS.format(new Date(ms))
}

/**
 * Les quatre vrais résultats — `dry-run` a sa propre présentation, ci-dessous.
 *
 * **Préfixé par l'heure de la passe**, pas seulement celle du verrou : le
 * protocole d'essai (`docs/publication-scheduler.md`) déverrouille la
 * session et lit ensuite si une ligne `Publié`/`Abandonné` est datée pendant
 * le verrouillage — sans horodatage sur ces deux lignes-là, cette lecture
 * était impossible (relevé en revue).
 */
function describe(outcome: Exclude<SchedulerOutcome, { kind: 'dry-run' }>, now: number): string {
  const passTime = formatParis(now)
  switch (outcome.kind) {
    case 'idle':
      return 'Rien à publier.'
    case 'locked':
      return `Verrou déjà posé depuis ${formatParis(outcome.since)}.`
    case 'disabled':
      return `${passTime} — Publication automatique désactivée (réglage publication.autoPublish).`
    case 'done':
      return `${passTime} — Publié : ${outcome.clipId} (${outcome.attempts} essai(s)).`
    case 'abandoned':
      return `${passTime} — Abandonné après ${outcome.attempts} essai(s) : ${outcome.clipId}.`
  }
}

/**
 * `runOnePass` en `dryRun` n'imprime rien et rend seulement un fait — ce
 * script en est le seul lecteur, donc la seule présentation (spec §6, comme
 * `dev-publish.ts`). Deux branches, et chacune écrit quelque chose : un
 * terminal vide ne dit jamais « rien n'était dû ».
 */
function printDryRun(due: Extract<SchedulerOutcome, { kind: 'dry-run' }>['due']): void {
  if (due === null) {
    console.log('Rien à publier.')
    return
  }
  const label = due.title === '' ? due.clipId : due.title
  console.log(`Échéance due : ${label} (${due.clipId}), prévue le ${formatParis(due.scheduledAt)}`)
  for (const platform of due.platforms) console.log(`  ${platform}`)
}

async function main(): Promise<number> {
  await chargerEnv()

  const dryRun = process.argv.slice(2).includes('--dry-run')
  const db = getDb()

  const outcome = await runOnePass(
    {
      db,
      now: Date.now,
      sleep: wait,
      sendMail: createResendMailer(),
      lockDir: projectsDir(),
    },
    { dryRun },
  )

  if (outcome.kind === 'dry-run') {
    printDryRun(outcome.due)
    return 0
  }

  console.log(describe(outcome, Date.now()))
  if (outcome.kind === 'done' || outcome.kind === 'abandoned') {
    for (const [platform, status] of Object.entries(outcome.statuses)) {
      console.log(`  ${platform.padEnd(10)}: ${status}`)
    }
  }

  // `idle`/`locked`/`done` rendent 0 ; seul `abandoned` est un échec (spec
  // §6.4 du contrat) — le planificateur Windows consigne le code, et c'est
  // la seconde voie d'alerte après le courriel.
  return outcome.kind === 'abandoned' ? 1 : 0
}

// Gardé par `import.meta.url`, comme `framing-cases.ts` : un test qui importe
// ce module ne doit pas relancer la CLI en même temps.
if (import.meta.url === `file://${process.argv[1]}`) {
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
}
