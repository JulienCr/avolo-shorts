import { describe, expect, it } from 'vitest'
import { isReference, requireSecret, resolveSecrets, type Environment } from '@/server/secrets'
import type { BatchInjector } from '@/server/op-inject'

/**
 * Ce que ces tests figent tient en quatre points, et le premier est le seul
 * qui fasse tomber le CI :
 *
 * 1. **Sans référence `op://`, `op` n'est jamais appelé.** GitHub Actions n'a
 *    pas 1Password, et un dépôt fraîchement cloné non plus.
 * 2. **Un échec nomme la variable, la référence et le remède** — sauf quand la
 *    cause touche le process entier (`op` introuvable, session verrouillée) :
 *    toutes les références produisent alors le même remède, et une seule
 *    ligne suffit.
 * 3. **`op inject` porte le lot**, `op read` ne sert plus qu'au repli
 *    séquentiel — jamais parallèle — quand le lot échoue.
 * 4. **Rien ne fuit.** L'injecteur et le lecteur sont toujours fournis par le
 *    test, jamais le vrai `op`.
 */

/** Un lecteur de secrets qui compte ses appels, et ne lance rien. */
function playerFake(table: Record<string, string>): {
  lire: (reference: string) => Promise<string>
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    lire: (reference) => {
      calls.push(reference)
      const value = table[reference]
      if (value === undefined) {
        return Promise.reject(new Error(`could not read secret '${reference}': pas dans la table`))
      }
      return Promise.resolve(value)
    },
  }
}

/**
 * Un injecteur de lot qui imite `op inject` : il substitue chaque
 * `{{ op://… }}` du gabarit par sa valeur dans `table`, et échoue en bloc dès
 * qu'une référence en manque — comme le vrai.
 */
function injectFake(table: Record<string, string>): { inject: BatchInjector; calls: string[] } {
  const calls: string[] = []
  const inject: BatchInjector = async (template) => {
    calls.push(template)
    let missing: string | undefined
    const output = template.replace(/\{\{ (op:\/\/[^}]*) \}\}/g, (_all, reference: string) => {
      const value = table[reference]
      if (value === undefined) missing = reference
      return value ?? ''
    })
    if (missing !== undefined) throw new Error(`could not read secret '${missing}': pas dans la table`)
    return output
  }
  return { inject, calls }
}

/** Un lot qui échoue toujours, pour forcer le repli séquentiel. */
const injectAlwaysFails: BatchInjector = () => Promise.reject(new Error('op inject : échec du lot'))

/** Le message d'un rejet. Échoue franchement si la promesse aboutit. */
async function messageDFailure(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => expect.unreachable('la résolution devait échouer'),
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
}

describe('isReference', () => {
  it('reconnaît une adresse de secret', () => {
    expect(isReference('op://Personal/Avolo-Shorts/GEMINI_API_KEY')).toBe(true)
  })

  it("laisse passer ce qui n'en est pas une", () => {
    for (const value of ['une-clé-littérale', '', 'https://exemple/op://', 'OP://MAJUSCULES']) {
      expect(isReference(value)).toBe(false)
    }
    expect(isReference(undefined)).toBe(false)
  })
})

describe('resolveSecrets', () => {
  it("n'appelle jamais op quand aucune valeur n'est une référence", async () => {
    const { lire, calls: lireCalls } = playerFake({})
    const { inject, calls: injectCalls } = injectFake({})
    const env = { GEMINI_API_KEY: 'une-clé-littérale', REPLAY_DIR: '/mnt/j/Replay' }

    expect(await resolveSecrets(env, lire, inject)).toEqual([])
    expect(lireCalls).toEqual([])
    expect(injectCalls).toEqual([])
    expect(env.GEMINI_API_KEY).toBe('une-clé-littérale')
    expect(env.REPLAY_DIR).toBe('/mnt/j/Replay')
  })

  it('remplace une référence par sa valeur, en un seul appel au lot', async () => {
    const { inject, calls } = injectFake({ 'op://Personal/Avolo-Shorts/GEMINI_API_KEY': 'la-vraie-clé' })
    const { lire, calls: lireCalls } = playerFake({})
    const env: Environment = { GEMINI_API_KEY: 'op://Personal/Avolo-Shorts/GEMINI_API_KEY' }

    expect(await resolveSecrets(env, lire, inject)).toEqual(['GEMINI_API_KEY'])
    expect(env.GEMINI_API_KEY).toBe('la-vraie-clé')
    expect(calls).toHaveLength(1)
    // Le lot a suffi : le repli séquentiel n'a pas eu à s'exécuter.
    expect(lireCalls).toEqual([])
  })

  it('laisse intactes les variables voisines', async () => {
    const { inject } = injectFake({ 'op://c/f/GEMINI_API_KEY': 'la-vraie-clé' })
    const env: Environment = {
      GEMINI_API_KEY: 'op://c/f/GEMINI_API_KEY',
      GEMINI_MODEL: 'gemini-3.1-flash-lite',
      FFMPEG_ENCODER: 'auto',
    }

    await resolveSecrets(env, playerFake({}).lire, inject)
    expect(env.GEMINI_MODEL).toBe('gemini-3.1-flash-lite')
    expect(env.FFMPEG_ENCODER).toBe('auto')
  })

  it('résout plusieurs variables, dans un ordre stable', async () => {
    const { inject } = injectFake({
      'op://c/f/GEMINI_API_KEY': 'clé-gemini',
      'op://c/f/OPENAI_API_KEY': 'clé-openai',
    })
    const env: Environment = {
      OPENAI_API_KEY: 'op://c/f/OPENAI_API_KEY',
      GEMINI_API_KEY: 'op://c/f/GEMINI_API_KEY',
    }

    // Trié : c'est ce qui est journalisé au démarrage.
    expect(await resolveSecrets(env, playerFake({}).lire, inject)).toEqual(['GEMINI_API_KEY', 'OPENAI_API_KEY'])
    expect(env.GEMINI_API_KEY).toBe('clé-gemini')
    expect(env.OPENAI_API_KEY).toBe('clé-openai')
  })

  it("ne construit qu'une entrée dans le gabarit pour une référence citée deux fois", async () => {
    const { inject, calls } = injectFake({ 'op://c/f/CLÉ': 'la-vraie-clé' })
    const env: Environment = { A_KEY: 'op://c/f/CLÉ', B_KEY: 'op://c/f/CLÉ' }

    await resolveSecrets(env, playerFake({}).lire, inject)
    expect(calls).toHaveLength(1)
    expect(calls[0].match(/\{\{ op:\/\/c\/f\/CLÉ \}\}/g)).toHaveLength(1)
    expect(env.A_KEY).toBe('la-vraie-clé')
    expect(env.B_KEY).toBe('la-vraie-clé')
  })

  it("échoue en nommant la variable et la référence", async () => {
    const { lire } = playerFake({})
    const env: Environment = { GEMINI_API_KEY: 'op://Personal/Avolo-Shorts/GEMINI_API_KEY' }

    const message = await messageDFailure(resolveSecrets(env, lire, injectAlwaysFails))
    expect(message).toContain('GEMINI_API_KEY')
    expect(message).toContain('op://Personal/Avolo-Shorts/GEMINI_API_KEY')
  })

  it('reporte le diagnostic de 1Password, sans son horodatage', async () => {
    const lire = (): Promise<string> =>
      Promise.reject(
        new Error(
          "Command failed: op read --no-newline op://c/f/CLÉ\n[ERROR] 2026/08/18 15:07:28 could not read secret 'op://c/f/CLÉ': item 'c/f' does not have a field 'CLÉ'\n",
        ),
      )
    const env: Environment = { GEMINI_API_KEY: 'op://c/f/CLÉ' }

    const message = await messageDFailure(resolveSecrets(env, lire, injectAlwaysFails))
    expect(message).toContain('does not have a field')
    expect(message).not.toContain('[ERROR]')
    expect(message).not.toContain('Command failed')
  })

  it("nomme l'installation quand la commande op est introuvable", async () => {
    const missing = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' })
    const env: Environment = { GEMINI_API_KEY: 'op://c/f/CLÉ' }

    const message = await messageDFailure(resolveSecrets(env, () => Promise.reject(missing), injectAlwaysFails))
    expect(message).toContain('1Password CLI')
    expect(message).toMatch(/littérale/)
  })

  it('nomme le déverrouillage quand 1Password refuse la session', async () => {
    const rejection = new Error(
      'Command failed: op read op://c/f/CLÉ\n[ERROR] 2026/08/18 15:03:15 account is not signed in\n',
    )
    const env: Environment = { GEMINI_API_KEY: 'op://c/f/CLÉ' }

    const message = await messageDFailure(
      resolveSecrets(env, () => Promise.reject(rejection), injectAlwaysFails),
    )
    expect(message).toMatch(/déverrouill/i)
  })

  it('refuse une valeur vide plutôt que de la laisser passer', async () => {
    const { inject } = injectFake({ 'op://c/f/CLÉ': '' })
    const env: Environment = { GEMINI_API_KEY: 'op://c/f/CLÉ' }

    const message = await messageDFailure(resolveSecrets(env, playerFake({}).lire, inject))
    expect(message).toContain('GEMINI_API_KEY')
    expect(message).toMatch(/vide/)
  })

  it('nomme le délai quand op est tué sans avoir rien écrit', async () => {
    const killed = Object.assign(new Error('Command failed: op read op://c/f/CLÉ'), {
      killed: true,
      signal: 'SIGTERM',
      stderr: '',
    })
    const env: Environment = { GEMINI_API_KEY: 'op://c/f/CLÉ' }

    const message = await messageDFailure(resolveSecrets(env, () => Promise.reject(killed), injectAlwaysFails))
    expect(message).toMatch(/60 s/)
    expect(message).toMatch(/approbation/)
    expect(message).not.toMatch(/\.\s+\./)
  })

  it("ne prend pas un champ nommé « signin » pour une session verrouillée", async () => {
    const trap = new Error(
      "[ERROR] 2026/08/18 15:07:28 could not read secret 'op://c/f/signin': item 'c/f' does not have a field 'signin'",
    )
    const env: Environment = { GEMINI_API_KEY: 'op://c/f/signin' }

    const message = await messageDFailure(resolveSecrets(env, () => Promise.reject(trap), injectAlwaysFails))
    expect(message).not.toMatch(/déverrouill/i)
    expect(message).toContain('does not have a field')
  })

  it("ne résout rien du tout quand une seule lecture échoue", async () => {
    const { lire } = playerFake({ 'op://c/f/BONNE': 'la-vraie-clé' })
    const env: Environment = { A_KEY: 'op://c/f/BONNE', B_KEY: 'op://c/f/ABSENTE' }

    await messageDFailure(resolveSecrets(env, lire, injectAlwaysFails))
    expect(env.A_KEY).toBe('op://c/f/BONNE')
    expect(env.B_KEY).toBe('op://c/f/ABSENTE')
  })

  it("ne balaye pas OP_BIN, qui nomme l'outil de la lecture", async () => {
    const { lire, calls: lireCalls } = playerFake({})
    const { inject, calls: injectCalls } = injectFake({})
    const env: Environment = { OP_BIN: 'op://c/f/CHEMIN' }

    expect(await resolveSecrets(env, lire, inject)).toEqual([])
    expect(lireCalls).toEqual([])
    expect(injectCalls).toEqual([])
    expect(env.OP_BIN).toBe('op://c/f/CHEMIN')
  })

  it("n'écrit jamais la valeur d'un secret dans le message d'échec", async () => {
    const { lire } = playerFake({ 'op://c/f/BONNE': 'valeur-très-secrète' })
    const env: Environment = { A_KEY: 'op://c/f/BONNE', B_KEY: 'op://c/f/ABSENTE' }

    const message = await messageDFailure(resolveSecrets(env, lire, injectAlwaysFails))
    expect(message).not.toContain('valeur-très-secrète')
  })

  it("regroupe en une seule ligne les échecs qui partagent le même remède", async () => {
    // Un `op` introuvable, ou une session verrouillée, touche le process
    // entier : rien ne distingue une référence de l'autre, donc une ligne
    // suffit — pas une par variable en défaut.
    const missing = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' })
    const env: Environment = { A_KEY: 'op://c/f/A', B_KEY: 'op://c/f/B', C_KEY: 'op://c/f/C' }

    const message = await messageDFailure(
      resolveSecrets(env, () => Promise.reject(missing), injectAlwaysFails),
    )
    expect(message.split('\n')).toHaveLength(1)
    expect(message).toContain('1Password CLI')
  })

  it('garde une ligne par variable quand les remèdes diffèrent réellement', async () => {
    // Un champ absent est une cause par référence : le nom du champ manquant
    // varie, donc les lignes ne se regroupent pas.
    const lireDistinct = (reference: string): Promise<string> =>
      Promise.reject(
        new Error(
          `[ERROR] 2026/08/18 15:00:00 could not read secret '${reference}': item 'f' does not have a field '${reference}'`,
        ),
      )
    const env: Environment = { A_KEY: 'op://c/f/A', B_KEY: 'op://c/f/B' }

    const message = await messageDFailure(resolveSecrets(env, lireDistinct, injectAlwaysFails))
    expect(message.split('\n')).toHaveLength(2)
    expect(message).toContain('A_KEY')
    expect(message).toContain('B_KEY')
  })
})

describe('requireSecret', () => {
  it('rend la valeur quand elle est là', () => {
    expect(requireSecret('GEMINI_API_KEY', { GEMINI_API_KEY: 'la-vraie-clé' })).toBe('la-vraie-clé')
  })

  it('refuse une variable absente ou vide, en la nommant', () => {
    expect(() => requireSecret('GEMINI_API_KEY', {})).toThrow(/GEMINI_API_KEY/)
    expect(() => requireSecret('GEMINI_API_KEY', { GEMINI_API_KEY: '' })).toThrow(/GEMINI_API_KEY/)
  })

  it("refuse une adresse restée non résolue, plutôt que de l'envoyer comme clé", () => {
    const env: Environment = { GEMINI_API_KEY: 'op://Personal/Avolo-Shorts/GEMINI_API_KEY' }
    expect(() => requireSecret('GEMINI_API_KEY', env)).toThrow(/Relancer le serveur/)
  })

  it("ne cite pas la référence, qui remonterait jusqu'au client HTTP", () => {
    const env: Environment = { GEMINI_API_KEY: 'op://CoffreSecret/FicheSecrète/CHAMP' }
    try {
      requireSecret('GEMINI_API_KEY', env)
      expect.unreachable('exigerSecret devait lever')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain('CoffreSecret')
      expect(message).not.toContain('FicheSecrète')
      expect(message).not.toContain('CHAMP')
    }
  })
})
