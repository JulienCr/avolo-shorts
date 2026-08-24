import { describe, expect, it } from 'vitest'
import {
  buildInjectTemplate,
  formatEnvLocal,
  parseEnvReferences,
  parseInjectOutput,
  resolveEnvLocal,
} from '../../scripts/generate-env-local'

/**
 * Ce que ces tests figent : **aucun ne lance `op`.** L'injecteur et le lecteur
 * de secours sont toujours fournis par le test, jamais le binaire réel — le CI
 * n'a pas 1Password, et une fuite ici publierait une vraie clé.
 */

describe('parseEnvReferences', () => {
  it('ne retient que les variables dont la valeur est une adresse 1Password', () => {
    const content = [
      'FFMPEG_BIN=/usr/bin/ffmpeg',
      'GEMINI_API_KEY=op://Personal/Avolo-Shorts/GEMINI_API_KEY',
      '',
      '# un commentaire',
      'META_PAGE_TOKEN=op://Personal/Avolo-Shorts/META_PAGE_TOKEN',
    ].join('\n')

    expect(parseEnvReferences(content)).toEqual([
      { name: 'GEMINI_API_KEY', reference: 'op://Personal/Avolo-Shorts/GEMINI_API_KEY' },
      { name: 'META_PAGE_TOKEN', reference: 'op://Personal/Avolo-Shorts/META_PAGE_TOKEN' },
    ])
  })

  it('ignore les valeurs déjà littérales', () => {
    expect(parseEnvReferences('REPLAY_DIR=/mnt/j/Replay\n')).toEqual([])
  })
})

describe('buildInjectTemplate / parseInjectOutput', () => {
  it("extrait une valeur sans ajouter ni retirer d'espace autour", () => {
    const entries = [{ name: 'A_KEY', reference: 'op://c/f/A' }]
    const nonce = 'test-nonce'
    const template = buildInjectTemplate(entries, nonce)

    // Le gabarit ne doit citer que ce que `op inject` doit remplacer.
    expect(template).toContain('{{ op://c/f/A }}')

    // `op inject` remplace `{{ ref }}` par la valeur, en place.
    const output = template.replace('{{ op://c/f/A }}', 'la-valeur')
    expect(parseInjectOutput(output, entries, nonce)).toEqual(new Map([['A_KEY', 'la-valeur']]))
  })

  it('préserve un saut de ligne final qui fait partie du secret', () => {
    const entries = [{ name: 'CLE_PRIVEE', reference: 'op://c/f/CLE' }]
    const nonce = 'n'
    const template = buildInjectTemplate(entries, nonce)
    const output = template.replace('{{ op://c/f/CLE }}', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n')

    expect(parseInjectOutput(output, entries, nonce)).toEqual(
      new Map([['CLE_PRIVEE', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n']]),
    )
  })

  it('extrait correctement deux entrées dans le même gabarit', () => {
    const entries = [
      { name: 'A_KEY', reference: 'op://c/f/A' },
      { name: 'B_KEY', reference: 'op://c/f/B' },
    ]
    const nonce = 'n2'
    const template = buildInjectTemplate(entries, nonce)
    const output = template.replace('{{ op://c/f/A }}', 'val-a').replace('{{ op://c/f/B }}', 'val-b')

    expect(parseInjectOutput(output, entries, nonce)).toEqual(
      new Map([
        ['A_KEY', 'val-a'],
        ['B_KEY', 'val-b'],
      ]),
    )
  })
})

describe('formatEnvLocal', () => {
  it('échappe les guillemets, les antislashs et les sauts de ligne', () => {
    const content = formatEnvLocal([
      ['GEMINI_API_KEY', 'simple'],
      ['CLE_PRIVEE', 'ligne1\nligne2 "cité" \\ fin'],
    ])

    expect(content).toBe(
      'GEMINI_API_KEY="simple"\n' + 'CLE_PRIVEE="ligne1\\nligne2 \\"cité\\" \\\\ fin"\n',
    )
  })
})

describe('resolveEnvLocal', () => {
  it('résout tout en un seul appel à op inject', async () => {
    const entries = [
      { name: 'A_KEY', reference: 'op://c/f/A' },
      { name: 'B_KEY', reference: 'op://c/f/B' },
    ]
    let calls = 0
    const inject = async (template: string): Promise<string> => {
      calls += 1
      return template.replace('{{ op://c/f/A }}', 'val-a').replace('{{ op://c/f/B }}', 'val-b')
    }
    const readOne = async (): Promise<string> => {
      throw new Error('readOne ne doit pas être appelé quand op inject réussit')
    }

    const resolved = await resolveEnvLocal(entries, inject, readOne)
    expect(calls).toBe(1)
    expect(resolved).toEqual([
      ['A_KEY', 'val-a'],
      ['B_KEY', 'val-b'],
    ])
  })

  it("rend une liste vide sans rien appeler quand il n'y a aucune référence", async () => {
    const inject = async (): Promise<string> => {
      throw new Error('ne doit pas être appelé')
    }
    const readOne = async (): Promise<string> => {
      throw new Error('ne doit pas être appelé')
    }

    expect(await resolveEnvLocal([], inject, readOne)).toEqual([])
  })

  it('retombe sur des lectures séquentielles quand op inject échoue, pour un diagnostic par référence', async () => {
    const entries = [
      { name: 'A_KEY', reference: 'op://c/f/A' },
      { name: 'B_KEY', reference: 'op://c/f/B' },
    ]
    const inject = async (): Promise<string> => {
      throw new Error("le lot a échoué : item 'f' n'existe pas")
    }
    const seen: string[] = []
    const readOne = async (reference: string): Promise<string> => {
      seen.push(reference)
      if (reference === 'op://c/f/B') throw new Error("item 'f' does not have a field 'B'")
      return 'val-a'
    }

    await expect(resolveEnvLocal(entries, inject, readOne)).rejects.toThrow(/B_KEY/)
    await expect(resolveEnvLocal(entries, inject, readOne)).rejects.toThrow(/op:\/\/c\/f\/B/)
    // Séquentiel, jamais parallèle : les deux appels sont vus dans l'ordre.
    expect(seen).toEqual(['op://c/f/A', 'op://c/f/B', 'op://c/f/A', 'op://c/f/B'])
  })

  it("n'écrit jamais une valeur résolue dans le message d'échec d'une autre variable", async () => {
    const entries = [
      { name: 'A_KEY', reference: 'op://c/f/A' },
      { name: 'B_KEY', reference: 'op://c/f/B' },
    ]
    const inject = async (): Promise<string> => {
      throw new Error('échec du lot')
    }
    const readOne = async (reference: string): Promise<string> => {
      if (reference === 'op://c/f/A') return 'valeur-très-secrète'
      throw new Error("item 'f' does not have a field 'B'")
    }

    const message = await resolveEnvLocal(entries, inject, readOne).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    )
    expect(message).not.toContain('valeur-très-secrète')
  })
})
