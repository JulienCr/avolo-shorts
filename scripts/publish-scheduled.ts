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

function describe(outcome: SchedulerOutcome): string {
  switch (outcome.kind) {
    case 'idle':
      return 'Rien à publier.'
    case 'locked':
      return `Verrou déjà posé depuis ${new Date(outcome.since).toISOString()}.`
    case 'done':
      return `Publié : ${outcome.clipId} (${outcome.attempts} essai(s)).`
    case 'abandoned':
      return `Abandonné après ${outcome.attempts} essai(s) : ${outcome.clipId}.`
  }
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

  // `runOnePass` imprime déjà le clip et ses plateformes en `dryRun` (elle
  // rend toujours `idle`, faute d'un genre dédié) — `describe` afficherait
  // « Rien à publier. » juste en dessous et se contredirait.
  if (!dryRun) {
    console.log(describe(outcome))
    if (outcome.kind === 'done' || outcome.kind === 'abandoned') {
      for (const [platform, status] of Object.entries(outcome.statuses)) {
        console.log(`  ${platform.padEnd(10)}: ${status}`)
      }
    }
  }

  // `idle`/`locked`/`done`/dry-run rendent 0 ; seul `abandoned` est un échec
  // (spec §6.4 du contrat) — le planificateur Windows consigne le code, et
  // c'est la seconde voie d'alerte après le courriel.
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
