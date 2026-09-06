import { createServer } from 'node:net'

import { describe, expect, it } from 'vitest'

import { listeningPid } from '../../scripts/ui/listening-pid'

describe('listeningPid', () => {
  it('résout le PID réel derrière un socket en écoute, sans lsof', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(58642, '127.0.0.1', resolve))
    try {
      expect(listeningPid('58642')).toBe(process.pid)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
