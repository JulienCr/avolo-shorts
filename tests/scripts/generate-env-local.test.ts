import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildInjectTemplate,
  formatEnvLocal,
  parseEnvReferences,
  parseInjectOutput,
  readEnvFile,
  removeStaleEnvLocal,
  resolveEnvLocal,
  writeEnvLocalFile,
} from '../../scripts/generate-env-local'

/**
 * Ce que ces tests figent : **aucun ne lance `op`.** L'injecteur et le lecteur
 * de secours sont toujours fournis par le test, jamais le binaire réel — le CI
 * n'a pas 1Password, et une fuite ici publierait une vraie clé.
 */

describe('readEnvFile', () => {
  it("nomme le fichier attendu et son remède plutôt que le ENOENT brut de Node", () => {
    // Cas réel : un worktree git, où `.env` est ignoré et n'est donc pas
    // partagé avec le dépôt principal.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-envlocal-'))
    const missing = path.join(dir, '.env')

    expect(() => readEnvFile(missing)).toThrow(/\.env/)
    try {
      readEnvFile(missing)
      expect.unreachable('devait lever')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain(missing)
      expect(message).toMatch(/worktree/i)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("laisse passer une autre cause que l'absence (ex. un dossier)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-envlocal-'))
    const isADirectory = path.join(dir, '.env')
    fs.mkdirSync(isADirectory)

    expect(() => readEnvFile(isADirectory)).toThrow()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

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

  // `process.loadEnvFile` tronque au premier « # » d'une valeur non guillemetée,
  // et coupe après le guillemet fermant d'une valeur qui l'est — vérifié à la
  // main sur Node 22.22.1. Un parseur qui l'ignore avale le commentaire dans la
  // référence (échec à l'appel `op`) ou la manque carrément.
  it('tronque un commentaire de fin de ligne, comme Node', () => {
    expect(parseEnvReferences('KEY=op://c/f/A # commentaire\n')).toEqual([
      { name: 'KEY', reference: 'op://c/f/A' },
    ])
  })

  it('tronque un commentaire après une valeur guillemetée', () => {
    expect(parseEnvReferences('KEY="op://c/f/A" # commentaire\n')).toEqual([
      { name: 'KEY', reference: 'op://c/f/A' },
    ])
  })

  it("retire le préfixe « export », que Node accepte aussi", () => {
    expect(parseEnvReferences('export KEY=op://c/f/A\n')).toEqual([
      { name: 'KEY', reference: 'op://c/f/A' },
    ])
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
    const entries = [{ name: 'PRIVATE_KEY', reference: 'op://c/f/CLE' }]
    const nonce = 'n'
    const template = buildInjectTemplate(entries, nonce)
    const output = template.replace('{{ op://c/f/CLE }}', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n')

    expect(parseInjectOutput(output, entries, nonce)).toEqual(
      new Map([['PRIVATE_KEY', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n']]),
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
  it('entoure la valeur de guillemets simples, sans y toucher', () => {
    const content = formatEnvLocal([['GEMINI_API_KEY', 'simple']])
    expect(content).toBe("GEMINI_API_KEY='simple'\n")
  })

  it("refuse une valeur qui contient une apostrophe plutôt que de la corrompre", () => {
    // Ni les guillemets doubles (`\"`, `\\` ignorés par `process.loadEnvFile` et
    // par le `dotenv` de `@next/env` — vérifié, ça tronque ou double le secret)
    // ni les guillemets simples (qui n'admettent aucun échappement) ne savent
    // représenter une apostrophe sans risque. Échouer plutôt que corrompre.
    expect(() => formatEnvLocal([['KEY', "valeur avec une apostrophe '"]])).toThrow(/KEY/)
  })

  // La régression que les trois relecteurs ont trouvée : un secret contenant
  // un antislash ou un guillemet double se faisait tronquer ou dupliquer par
  // l'échappement précédent. Vérifié en rechargeant réellement le fichier
  // avec `process.loadEnvFile`, pas en comparant du texte sérialisé.
  it('restitue à l’identique, via process.loadEnvFile, un secret à guillemets et antislashs', () => {
    const secret = 'a"b\\c\\\\d"e'
    const content = formatEnvLocal([['ROUND_TRIP', secret]])

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-envlocal-'))
    const file = path.join(dir, '.env.local')
    fs.writeFileSync(file, content)
    try {
      const loaded = execFileSync(
        process.execPath,
        ['-e', `process.loadEnvFile(${JSON.stringify(file)}); process.stdout.write(process.env.ROUND_TRIP ?? '')`],
        { encoding: 'utf8' },
      )
      expect(loaded).toBe(secret)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restitue un secret multi-lignes (clé privée)', () => {
    const secret = '-----BEGIN KEY-----\nabc\n-----END KEY-----\n'
    const content = formatEnvLocal([['PRIVATE_KEY', secret]])

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-envlocal-'))
    const file = path.join(dir, '.env.local')
    fs.writeFileSync(file, content)
    try {
      const loaded = execFileSync(
        process.execPath,
        ['-e', `process.loadEnvFile(${JSON.stringify(file)}); process.stdout.write(process.env.PRIVATE_KEY ?? '')`],
        { encoding: 'utf8' },
      )
      expect(loaded).toBe(secret)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
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

  it('refuse une valeur vide plutôt que de l’écrire dans .env.local', async () => {
    // Sans ce garde-fou, `.env.local` porterait `KEY=''` — prioritaire sur
    // `.env` — et le garde-fou équivalent de `resolveSecrets` ne verrait plus
    // jamais passer l'adresse `op://` pour le détecter.
    const entries = [{ name: 'A_KEY', reference: 'op://c/f/A' }]
    const inject = async (template: string): Promise<string> => template.replace('{{ op://c/f/A }}', '')
    const readOne = async (): Promise<string> => {
      throw new Error('ne doit pas être appelé')
    }

    const message = await resolveEnvLocal(entries, inject, readOne).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    )
    expect(message).toContain('A_KEY')
    expect(message).toMatch(/vide/)
  })
})

describe('removeStaleEnvLocal', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-envlocal-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("supprime le fichier s'il existe, et le dit", () => {
    const file = path.join(dir, '.env.local')
    fs.writeFileSync(file, "OLD='valeur-perimee'\n")

    expect(removeStaleEnvLocal(file)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it("ne fait rien si le fichier n'existe pas déjà", () => {
    const file = path.join(dir, '.env.local')
    expect(removeStaleEnvLocal(file)).toBe(false)
  })
})

describe('writeEnvLocalFile', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-envlocal-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('écrit en 0600 même quand un fichier plus permissif existait déjà', () => {
    const file = path.join(dir, '.env.local')
    fs.writeFileSync(file, 'ANCIEN=1\n', { mode: 0o644 })

    writeEnvLocalFile(file, "KEY='nouvelle-valeur'\n")

    expect(fs.readFileSync(file, 'utf8')).toBe("KEY='nouvelle-valeur'\n")
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it("ne laisse pas de fichier temporaire derrière elle", () => {
    const file = path.join(dir, '.env.local')
    writeEnvLocalFile(file, "KEY='v'\n")
    expect(fs.readdirSync(dir)).toEqual(['.env.local'])
  })
})
