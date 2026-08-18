import { describe, expect, it } from 'vitest'
import { estRéférence, exigerSecret, résoudreSecrets, type Environnement } from '@/server/secrets'

/**
 * Ce que ces tests figent tient en trois points, et le premier est le seul qui
 * fasse tomber le CI :
 *
 * 1. **Sans référence `op://`, `op` n'est jamais appelé.** GitHub Actions n'a
 *    pas 1Password, et un dépôt fraîchement cloné non plus. Le lecteur injecté
 *    compte ses appels ; s'il en reçoit un, c'est que la résolution s'est mise à
 *    dépendre d'un binaire qui n'existe pas partout.
 * 2. **Un échec nomme la variable, la référence et le remède.** Le mode d'échec
 *    par défaut de ce chemin est un 401 du fournisseur d'API, qui accuse la
 *    clé plutôt que 1Password.
 * 3. **Rien ne fuit.** Le lecteur est toujours injecté : aucun de ces tests ne
 *    lance `op`, donc aucun ne peut publier une vraie clé.
 */

/** Un lecteur de secrets qui compte ses appels, et ne lance rien. */
function lecteurFactice(table: Record<string, string>): {
  lire: (référence: string) => Promise<string>
  appels: string[]
} {
  const appels: string[] = []
  return {
    appels,
    lire: (référence) => {
      appels.push(référence)
      const valeur = table[référence]
      if (valeur === undefined) {
        return Promise.reject(new Error(`could not read secret '${référence}': pas dans la table`))
      }
      return Promise.resolve(valeur)
    },
  }
}

/** Le message d'un rejet. Échoue franchement si la promesse aboutit. */
async function messageDÉchec(promesse: Promise<unknown>): Promise<string> {
  return promesse.then(
    () => expect.unreachable('la résolution devait échouer'),
    (erreur: unknown) => (erreur instanceof Error ? erreur.message : String(erreur)),
  )
}

describe('estRéférence', () => {
  it('reconnaît une adresse de secret', () => {
    expect(estRéférence('op://Personal/Avolo-Shorts/GEMINI_API_KEY')).toBe(true)
  })

  it("laisse passer ce qui n'en est pas une", () => {
    // Une valeur littérale reste une valeur littérale : `op://` est une
    // possibilité, pas une obligation.
    for (const valeur of ['une-clé-littérale', '', 'https://exemple/op://', 'OP://MAJUSCULES']) {
      expect(estRéférence(valeur)).toBe(false)
    }
    expect(estRéférence(undefined)).toBe(false)
  })
})

describe('résoudreSecrets', () => {
  it("n'appelle jamais op quand aucune valeur n'est une référence", async () => {
    const { lire, appels } = lecteurFactice({})
    const env = { GEMINI_API_KEY: 'une-clé-littérale', REPLAY_DIR: '/mnt/j/Replay' }

    expect(await résoudreSecrets(env, lire)).toEqual([])
    expect(appels).toEqual([])
    expect(env.GEMINI_API_KEY).toBe('une-clé-littérale')
    expect(env.REPLAY_DIR).toBe('/mnt/j/Replay')
  })

  it('remplace une référence par sa valeur, et rend le nom de la variable', async () => {
    const { lire } = lecteurFactice({ 'op://Personal/Avolo-Shorts/GEMINI_API_KEY': 'la-vraie-clé' })
    const env: Environnement = { GEMINI_API_KEY: 'op://Personal/Avolo-Shorts/GEMINI_API_KEY' }

    // Ce que la fonction rend est une liste de **noms**. Les valeurs ne
    // ressortent que par `env`, jamais par un retour qu'on serait tenté de
    // journaliser.
    expect(await résoudreSecrets(env, lire)).toEqual(['GEMINI_API_KEY'])
    expect(env.GEMINI_API_KEY).toBe('la-vraie-clé')
  })

  it('laisse intactes les variables voisines', async () => {
    const { lire } = lecteurFactice({ 'op://c/f/GEMINI_API_KEY': 'la-vraie-clé' })
    const env: Environnement = {
      GEMINI_API_KEY: 'op://c/f/GEMINI_API_KEY',
      GEMINI_MODEL: 'gemini-3.1-flash-lite',
      FFMPEG_ENCODER: 'auto',
    }

    await résoudreSecrets(env, lire)
    expect(env.GEMINI_MODEL).toBe('gemini-3.1-flash-lite')
    expect(env.FFMPEG_ENCODER).toBe('auto')
  })

  it('résout plusieurs variables, dans un ordre stable', async () => {
    const { lire } = lecteurFactice({
      'op://c/f/GEMINI_API_KEY': 'clé-gemini',
      'op://c/f/OPENAI_API_KEY': 'clé-openai',
    })
    const env: Environnement = {
      OPENAI_API_KEY: 'op://c/f/OPENAI_API_KEY',
      GEMINI_API_KEY: 'op://c/f/GEMINI_API_KEY',
    }

    // Trié : c'est ce qui est journalisé au démarrage, et un journal dont
    // l'ordre dépend de l'ordre d'énumération de `process.env` se compare mal
    // d'un lancement à l'autre.
    expect(await résoudreSecrets(env, lire)).toEqual(['GEMINI_API_KEY', 'OPENAI_API_KEY'])
    expect(env.GEMINI_API_KEY).toBe('clé-gemini')
    expect(env.OPENAI_API_KEY).toBe('clé-openai')
  })

  it("ne lit qu'une fois une référence citée deux fois", async () => {
    // Chaque `op read` est un aller-retour de 2,5 s, et potentiellement une
    // approbation biométrique. Deux variables qui pointent le même champ n'en
    // valent qu'une.
    const { lire, appels } = lecteurFactice({ 'op://c/f/CLÉ': 'la-vraie-clé' })
    const env: Environnement = { A_KEY: 'op://c/f/CLÉ', B_KEY: 'op://c/f/CLÉ' }

    await résoudreSecrets(env, lire)
    expect(appels).toEqual(['op://c/f/CLÉ'])
    expect(env.A_KEY).toBe('la-vraie-clé')
    expect(env.B_KEY).toBe('la-vraie-clé')
  })

  it("échoue en nommant la variable et la référence", async () => {
    const { lire } = lecteurFactice({})
    const env: Environnement = { GEMINI_API_KEY: 'op://Personal/Avolo-Shorts/GEMINI_API_KEY' }

    const message = await messageDÉchec(résoudreSecrets(env, lire))
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
    const env: Environnement = { GEMINI_API_KEY: 'op://c/f/CLÉ' }

    // Le message de `op` dit exactement ce qui manque : on le garde. Son
    // préfixe `[ERROR] <date> <heure>`, lui, ne dit rien à personne, et son
    // `Command failed:` répète une commande qu'on cite déjà.
    const message = await messageDÉchec(résoudreSecrets(env, lire))
    expect(message).toContain('does not have a field')
    expect(message).not.toContain('[ERROR]')
    expect(message).not.toContain('Command failed')
  })

  it("nomme l'installation quand la commande op est introuvable", async () => {
    const absent = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' })
    const env: Environnement = { GEMINI_API_KEY: 'op://c/f/CLÉ' }

    const message = await messageDÉchec(résoudreSecrets(env, () => Promise.reject(absent)))
    expect(message).toContain('1Password CLI')
    // Et le second remède, celui qui n'a besoin de rien : une valeur littérale.
    expect(message).toMatch(/littérale/)
  })

  it('nomme le déverrouillage quand 1Password refuse la session', async () => {
    const refus = new Error(
      'Command failed: op read op://c/f/CLÉ\n[ERROR] 2026/08/18 15:03:15 account is not signed in\n',
    )
    const env: Environnement = { GEMINI_API_KEY: 'op://c/f/CLÉ' }

    // Le remède n'est pas le même que pour une fiche renommée, et c'est tout
    // l'intérêt de distinguer les deux : ici il faut déverrouiller, là il faut
    // corriger le `.env`.
    const message = await messageDÉchec(résoudreSecrets(env, () => Promise.reject(refus)))
    expect(message).toMatch(/déverrouill/i)
  })

  it('refuse une valeur vide plutôt que de la laisser passer', async () => {
    // Un champ vidé dans 1Password rendrait une chaîne vide, que
    // `clientParDéfaut` prendrait pour une variable absente — donc un message
    // qui accuse le `.env` alors que le `.env` est juste.
    const env: Environnement = { GEMINI_API_KEY: 'op://c/f/CLÉ' }

    const message = await messageDÉchec(résoudreSecrets(env, () => Promise.resolve('')))
    expect(message).toContain('GEMINI_API_KEY')
    expect(message).toMatch(/vide/)
  })

  it('nomme le délai quand op est tué sans avoir rien écrit', async () => {
    // Le cas le plus muet de tous : `execFile` tue `op` par un signal au bout
    // de 60 s, `stderr` est vide et le `message` se réduit au `Command failed:`
    // qu'on retire. Sans branche dédiée, le remède commençait par un point
    // isolé et n'accusait rien. (relevé par Copilot et par Aristarque)
    const tué = Object.assign(new Error('Command failed: op read op://c/f/CLÉ'), {
      killed: true,
      signal: 'SIGTERM',
      stderr: '',
    })
    const env: Environnement = { GEMINI_API_KEY: 'op://c/f/CLÉ' }

    const message = await messageDÉchec(résoudreSecrets(env, () => Promise.reject(tué)))
    expect(message).toMatch(/60 s/)
    expect(message).toMatch(/approbation/)
    expect(message).not.toMatch(/\.\s+\./)
  })

  it("ne prend pas un champ nommé « signin » pour une session verrouillée", async () => {
    // Le diagnostic testé contient le nom du champ. Sur des mots isolés, un
    // champ absent nommé `signin`, `unlock` ou `authorization` faisait répondre
    // « déverrouiller 1Password » à un `.env` qui nomme mal son champ.
    // (relevé par Copilot et par Aristarque)
    const piège = new Error(
      "[ERROR] 2026/08/18 15:07:28 could not read secret 'op://c/f/signin': item 'c/f' does not have a field 'signin'",
    )
    const env: Environnement = { GEMINI_API_KEY: 'op://c/f/signin' }

    const message = await messageDÉchec(résoudreSecrets(env, () => Promise.reject(piège)))
    expect(message).not.toMatch(/déverrouill/i)
    expect(message).toContain('does not have a field')
  })

  it("ne résout rien du tout quand une seule lecture échoue", async () => {
    // La propriété « tout ou rien » : un environnement à moitié résolu ferait
    // partir la variable suivante chez le fournisseur d'API alors que le
    // démarrage a déjà échoué. (relevé par Aristarque)
    const { lire } = lecteurFactice({ 'op://c/f/BONNE': 'la-vraie-clé' })
    const env: Environnement = { A_KEY: 'op://c/f/BONNE', B_KEY: 'op://c/f/ABSENTE' }

    await messageDÉchec(résoudreSecrets(env, lire))
    expect(env.A_KEY).toBe('op://c/f/BONNE')
    expect(env.B_KEY).toBe('op://c/f/ABSENTE')
  })

  it("ne balaye pas OP_BIN, qui nomme l'outil de la lecture", async () => {
    // Une `OP_BIN=op://…` demanderait à `op` de se lire lui-même : `execFile`
    // échouerait en ENOENT sur un binaire nommé `op://…`, donc sur « installer
    // 1Password CLI », qui accuse la mauvaise chose. (relevé par Aristarque)
    const { lire, appels } = lecteurFactice({})
    const env: Environnement = { OP_BIN: 'op://c/f/CHEMIN' }

    expect(await résoudreSecrets(env, lire)).toEqual([])
    expect(appels).toEqual([])
    expect(env.OP_BIN).toBe('op://c/f/CHEMIN')
  })

  it("n'écrit jamais la valeur d'un secret dans le message d'échec", async () => {
    // Deux variables, une qui résout et une qui échoue : le message ne doit
    // rien porter de la première. Les journaux de ce dépôt se recopient dans
    // des rapports.
    const { lire } = lecteurFactice({ 'op://c/f/BONNE': 'valeur-très-secrète' })
    const env: Environnement = { A_KEY: 'op://c/f/BONNE', B_KEY: 'op://c/f/ABSENTE' }

    const message = await messageDÉchec(résoudreSecrets(env, lire))
    expect(message).not.toContain('valeur-très-secrète')
  })
})

describe('exigerSecret', () => {
  it('rend la valeur quand elle est là', () => {
    expect(exigerSecret('GEMINI_API_KEY', { GEMINI_API_KEY: 'la-vraie-clé' })).toBe('la-vraie-clé')
  })

  it('refuse une variable absente ou vide, en la nommant', () => {
    expect(() => exigerSecret('GEMINI_API_KEY', {})).toThrow(/GEMINI_API_KEY/)
    expect(() => exigerSecret('GEMINI_API_KEY', { GEMINI_API_KEY: '' })).toThrow(/GEMINI_API_KEY/)
  })

  it("refuse une adresse restée non résolue, plutôt que de l'envoyer comme clé", () => {
    // C'est le garde-fou du 401 : `next dev` réapplique l'environnement d'avant
    // `register()` quand le `.env` change, et la variable repasse à `op://…`.
    // Sans ce contrôle, l'adresse partait chez le fournisseur d'API.
    // (relevé par Copilot)
    const env: Environnement = { GEMINI_API_KEY: 'op://Personal/Avolo-Shorts/GEMINI_API_KEY' }
    expect(() => exigerSecret('GEMINI_API_KEY', env)).toThrow(/Relancer le serveur/)
  })

  it("ne cite pas la référence, qui remonterait jusqu'au client HTTP", () => {
    // Cette erreur-là est levée en servant : elle traverse `runCandidates`,
    // `status.json` et le champ `error` de `GET /api/projects/:id`. Et
    // `épurerChemins` ne la nettoie pas — `POSIX_NU` exclut un `/` précédé de
    // `:` ou d'un autre `/`, donc `op://Coffre/Fiche/…` passe intact. Le nom du
    // coffre et de la fiche sortiraient sur un dépôt public, pour n'apprendre
    // rien à un opérateur qui a son `.env` sous les yeux.
    // (relevé par Aristarque)
    const env: Environnement = { GEMINI_API_KEY: 'op://CoffreSecret/FicheSecrète/CHAMP' }
    try {
      exigerSecret('GEMINI_API_KEY', env)
      expect.unreachable('exigerSecret devait lever')
    } catch (erreur: unknown) {
      const message = erreur instanceof Error ? erreur.message : String(erreur)
      expect(message).not.toContain('CoffreSecret')
      expect(message).not.toContain('FicheSecrète')
      expect(message).not.toContain('CHAMP')
    }
  })
})
