import { describe, expect, it, vi } from 'vitest'

import { ALERT_RECIPIENT, createResendMailer } from '@/server/publication/mailer'

/**
 * `createResendMailer` contre un `fetch` injecté — jamais le réseau. La seule
 * garantie qui compte (spec §5.5) : une clé absente ne fait jamais lever
 * l'appelant.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('createResendMailer', () => {
  it('poste sur api.resend.com avec un jeton porteur et le destinataire fixe', async () => {
    let seenUrl: string | URL | Request | undefined
    let seenInit: RequestInit | undefined
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = input
      seenInit = init
      return jsonResponse(200, { id: 'email_1' })
    })
    const mailer = createResendMailer({ RESEND_API_KEY: 'clef_test', RESEND_FROM: 'avolo-shorts@avolo.fr' }, fetchImpl)

    await mailer('Publication en échec', 'corps du message')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    if (seenInit === undefined) throw new Error('init manquant')
    expect(seenUrl).toBe('https://api.resend.com/emails')
    expect((seenInit.headers as Record<string, string>).authorization).toBe('Bearer clef_test')
    const body = JSON.parse(seenInit.body as string) as { to: string; from: string; subject: string; text: string }
    expect(body.to).toBe(ALERT_RECIPIENT)
    expect(body.from).toBe('avolo-shorts@avolo.fr')
    expect(body.subject).toBe('Publication en échec')
    expect(body.text).toBe('corps du message')
  })

  it('journalise et résout sans lever quand `RESEND_API_KEY` est absente', async () => {
    const fetchImpl = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mailer = createResendMailer({}, fetchImpl)

    await expect(mailer('sujet', 'corps')).resolves.toBeUndefined()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('journalise et résout quand la clé est encore une adresse 1Password non résolue', async () => {
    const fetchImpl = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mailer = createResendMailer({ RESEND_API_KEY: 'op://Personal/Avolo-Shorts/RESEND_API_KEY' }, fetchImpl)

    await expect(mailer('sujet', 'corps')).resolves.toBeUndefined()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('retombe sur l’adresse par défaut quand RESEND_FROM est encore une adresse 1Password non résolue', async () => {
    let seenInit: RequestInit | undefined
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenInit = init
      return jsonResponse(200, { id: 'email_1' })
    })
    const mailer = createResendMailer(
      { RESEND_API_KEY: 'clef_test', RESEND_FROM: 'op://Personal/Avolo-Shorts/RESEND_FROM' },
      fetchImpl,
    )

    await mailer('sujet', 'corps')

    if (seenInit === undefined) throw new Error('init manquant')
    const body = JSON.parse(seenInit.body as string) as { from: string }
    expect(body.from).toBe('avolo-shorts@avolo.fr')
  })

  it('journalise et résout quand Resend refuse la requête', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { message: 'clef invalide' }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mailer = createResendMailer({ RESEND_API_KEY: 'clef_test' }, fetchImpl)

    await expect(mailer('sujet', 'corps')).resolves.toBeUndefined()

    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
