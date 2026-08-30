/**
 * Fige `process.env`, rend une fonction qui l'y ramène.
 *
 * La restauration mute `process.env` en place, jamais ne le réassigne :
 * `process.env = { ...start }` casse silencieusement `process.loadEnvFile`
 * pour le reste du process (mesuré sur Node 22.22.1, voir
 * tests/scripts/dev-common.test.ts:39-47).
 */
export function snapshotEnv(): () => void {
  const start = { ...process.env }
  return function restoreEnv() {
    for (const name of Object.keys(process.env)) {
      if (!Object.hasOwn(start, name)) delete process.env[name]
    }
    Object.assign(process.env, start)
  }
}
