import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `execFile` est mocké **avant** l'import du module testé — `vi.mock` est
 * hissé en tête de fichier par Vitest, donc l'ordre d'écriture ici n'a pas
 * d'importance, mais le geste en a : `resolveGateway`
 * (`@/server/llm/ollama`) passe par `promisify(execFile)`, et Node ne
 * l'enveloppe correctement que si le mock porte le même symbole
 * `util.promisify.custom` que le vrai `child_process.execFile` — sans lui,
 * `promisify` retomberait sur le style « dernier argument = callback », que
 * ce mock n'imite pas.
 */
const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: Object.assign(
    () => {
      throw new Error('execFile appelé en style callback : le mock ne le supporte pas')
    },
    { [promisify.custom]: (...args: unknown[]) => execFileMock(...args) },
  ),
}))

const { createOllamaCall, toFinishReason, toLlmResponse } = await import('@/server/llm/ollama')

afterEach(() => {
  execFileMock.mockReset()
  vi.unstubAllGlobals()
})

describe('Ollama : la traduction des raisons de fin', () => {
  it('traduit length en MAX_TOKENS', () => {
    expect(toFinishReason('length')).toBe('MAX_TOKENS')
  })

  it('met les autres raisons en majuscules, sans inventer de refus de contenu', () => {
    // Un modèle local n'a pas de filtre fournisseur : rien ici ne doit
    // produire une raison que `REFUS_DE_CONTENU` reconnaîtrait.
    expect(toFinishReason('stop')).toBe('STOP')
  })

  it('rend une chaîne vide sans raison', () => {
    expect(toFinishReason(null)).toBe('')
    expect(toFinishReason(undefined)).toBe('')
  })
})

describe('Ollama : la traduction de la response', () => {
  it('porte le texte du message et la raison de fin normalisée', () => {
    const response = toLlmResponse({
      message: { content: '{"shorts": []}' },
      done_reason: 'stop',
    })
    expect(response.text).toBe('{"shorts": []}')
    expect(response.candidates?.[0]?.finishReason).toBe('STOP')
  })

  it('ne porte jamais promptFeedback : Ollama ne bloque pas pour du contenu', () => {
    const response = toLlmResponse({ message: { content: 'x' }, done_reason: 'stop' })
    expect(response.promptFeedback).toBeUndefined()
  })
})

describe('createOllamaCall : la résolution de la passerelle WSL', () => {
  const config = () => ({
    schema: { type: 'object' as const, properties: {}, required: [] },
    temperature: 0.2,
    maxOutputTokens: 512,
  })

  function fetchOk() {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ message: { content: '{}' }, done_reason: 'stop' }),
    }))
  }

  it('analyse la sortie de « ip route show default » et construit l’URL du serveur', async () => {
    execFileMock.mockResolvedValue({
      stdout: 'default via 172.20.16.1 dev eth0 proto kernel\n',
      stderr: '',
    })
    const fetchMock = fetchOk()
    vi.stubGlobal('fetch', fetchMock)

    const call = createOllamaCall({ model: 'llama3.1', timeoutMs: 5_000, config })
    await call('prompt', 'score')

    expect(execFileMock).toHaveBeenCalledWith('ip', ['route', 'show', 'default'])
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('http://172.20.16.1:11434/api/chat')
  })

  it('ne résout la passerelle qu’une fois, mémoïsée pour tout le LlmCall', async () => {
    execFileMock.mockResolvedValue({ stdout: 'default via 172.20.16.1 dev eth0\n', stderr: '' })
    vi.stubGlobal('fetch', fetchOk())

    const call = createOllamaCall({ model: 'llama3.1', timeoutMs: 5_000, config })
    await call('un', 'score')
    await call('deux', 'detail')

    // Un repérage fait des dizaines d'appels : résoudre la passerelle à
    // chacun d'eux referait le sous-processus `ip` autant de fois pour rien.
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('n’appelle jamais « ip route » quand l’adresse est réglée', async () => {
    vi.stubGlobal('fetch', fetchOk())

    const call = createOllamaCall({
      model: 'llama3.1',
      baseUrl: 'http://mon-serveur:11434',
      timeoutMs: 5_000,
      config,
    })
    await call('prompt', 'score')

    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('coupe la requête quand le signal externe s’annule, sans attendre le délai', async () => {
    execFileMock.mockResolvedValue({ stdout: 'default via 172.20.16.1 dev eth0\n', stderr: '' })
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal
        return new Promise<Response>(() => {})
      }),
    )

    const controller = new AbortController()
    const call = createOllamaCall({
      model: 'llama3.1',
      signal: controller.signal,
      timeoutMs: 60_000,
      config,
    })
    void call('prompt', 'score')

    await vi.waitFor(() => expect(capturedSignal).toBeDefined())
    expect(capturedSignal?.aborted).toBe(false)
    controller.abort()
    expect(capturedSignal?.aborted).toBe(true)
  })
})
