/**
 * `pnpm framing-preview:stop` — stops the server started by
 * `framing-preview.ts`. `lsof` cannot see it on this box (see
 * `scripts/ui/listening-pid.ts`), so this resolves the PID through
 * `/proc/net/tcp{,6}` instead and sends it `SIGINT`, same as `lsof -t | kill`.
 */

import { listeningPid } from './ui/listening-pid'

const port = process.env.PORT || '4321'

let pid: number
try {
  pid = listeningPid(port)
} catch {
  // No listener on this port: nothing to stop, same as the old `xargs -r`.
  process.exit(0)
}

try {
  process.kill(pid, 'SIGINT')
} catch (err) {
  // Race: the process exited between resolution and the signal — not an error.
  if ((err as NodeJS.ErrnoException).code === 'ESRCH') process.exit(0)
  throw err
}
