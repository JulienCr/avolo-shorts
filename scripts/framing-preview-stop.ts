/**
 * `pnpm framing-preview:stop` — stops the server started by
 * `framing-preview.ts`. `lsof` cannot see it on this box (see
 * `scripts/ui/listening-pid.ts`), so this resolves the PID through
 * `/proc/net/tcp{,6}` instead and sends it `SIGINT`, same as `lsof -t | kill`.
 */

import { listeningPid } from './ui/listening-pid'

const port = process.env.PORT ?? '4321'

try {
  process.kill(listeningPid(port), 'SIGINT')
} catch {
  // No listener on this port: nothing to stop, same as the old `xargs -r`.
}
