import { describe, expect, it } from 'vitest'
import { buildInjectTemplate, createBatchInjector, parseInjectOutput } from '@/server/op-inject'

/**
 * Le socle partagé par `resolveSecrets` (`src/server/secrets.ts`) et
 * `pnpm generate-env:local` (`scripts/generate-env-local.ts`) : un gabarit à
 * sentinelles pour `op inject`, et l'injecteur qui l'envoie sur stdin.
 *
 * **Aucun test ne lance `op`.** `createBatchInjector` est vérifié ici avec
 * `cat`, qui rend simplement ce qu'il reçoit sur stdin — assez pour couvrir le
 * branchement stdin/stdout sans dépendre de 1Password.
 */

describe('buildInjectTemplate / parseInjectOutput', () => {
  it("extrait une valeur sans ajouter ni retirer d'espace autour", () => {
    const entries = [{ key: 'A_KEY', reference: 'op://c/f/A' }]
    const nonce = 'nonce-1'
    const template = buildInjectTemplate(entries, nonce)

    expect(template).toContain('{{ op://c/f/A }}')
    const output = template.replace('{{ op://c/f/A }}', 'la-valeur')
    expect(parseInjectOutput(output, entries, nonce)).toEqual(new Map([['A_KEY', 'la-valeur']]))
  })

  it('préserve un saut de ligne final qui fait partie du secret', () => {
    const entries = [{ key: 'CLE_PRIVEE', reference: 'op://c/f/CLE' }]
    const nonce = 'nonce-2'
    const template = buildInjectTemplate(entries, nonce)
    const output = template.replace('{{ op://c/f/CLE }}', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n')

    expect(parseInjectOutput(output, entries, nonce)).toEqual(
      new Map([['CLE_PRIVEE', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n']]),
    )
  })

  it('extrait plusieurs entrées du même gabarit', () => {
    const entries = [
      { key: 'A_KEY', reference: 'op://c/f/A' },
      { key: 'B_KEY', reference: 'op://c/f/B' },
    ]
    const nonce = 'nonce-3'
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

describe('createBatchInjector', () => {
  it('écrit le gabarit sur stdin et rend la sortie standard', async () => {
    // `cat` renvoie exactement ce qu'il reçoit : ça vérifie le branchement
    // stdin → stdout sans dépendre de `op`.
    const inject = createBatchInjector({ bin: 'cat', timeoutMs: 5_000, args: [] })
    expect(await inject('un gabarit\nquelconque\n')).toBe('un gabarit\nquelconque\n')
  })

  it('rejette quand le binaire est introuvable', async () => {
    const inject = createBatchInjector({ bin: 'ce-binaire-n-existe-pas-avolo', timeoutMs: 5_000 })
    await expect(inject('gabarit')).rejects.toThrow()
  })
})
