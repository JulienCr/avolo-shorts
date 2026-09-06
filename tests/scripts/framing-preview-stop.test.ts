import { execFileSync, spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '../..')

/** Polls `port` until a connection succeeds, so the test never races the listener's startup. */
function waitForPort(port: number, deadline = Date.now() + 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`timeout waiting for port ${port}`))
        else setTimeout(attempt, 50)
      })
    }
    attempt()
  })
}

/** Runs the actual `pnpm` script, not the `.ts` file directly — this must exercise whatever `package.json` wires the command to, `lsof` pipeline or resolver alike. */
function runStop(port: number): void {
  execFileSync('pnpm', ['run', 'framing-preview:stop'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
  })
}

describe('framing-preview-stop', () => {
  it('signale et arrête un vrai serveur en écoute, sans lsof', async () => {
    const port = 58421
    const listener = spawn('node', ['-e', `require('node:net').createServer().listen(${port}, '127.0.0.1')`])
    try {
      await waitForPort(port)
      runStop(port)
      // Race against a deadline shorter than the test timeout: if `'exit'` never
      // fires (the regression this test exists to catch), the `finally` below
      // still runs and kills the listener, instead of leaking it forever.
      const exit = await Promise.race([
        new Promise<{ signal: string | null }>((resolve) => listener.once('exit', (_code, signal) => resolve({ signal }))),
        new Promise<{ signal: string | null }>((resolve) => setTimeout(() => resolve({ signal: null }), 5000)),
      ])
      expect(exit.signal).toBe('SIGINT')
    } finally {
      if (listener.exitCode === null && listener.signalCode === null) listener.kill('SIGKILL')
    }
  }, 10000)

  it('sort en succès sans rien faire quand personne n’écoute', () => {
    expect(() => runStop(58422)).not.toThrow()
  }, 10000)
})
