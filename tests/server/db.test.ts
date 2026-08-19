import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database, { type Database as BaseSqlite } from 'better-sqlite3'
import {
  applySettings,
  settingField,
  parseSetting,
  validateSetting,
  type SettingField,
  getClip,
  getClips,
  getProject,
  getRéglages,
  listProjects,
  openDb,
  putClip,
  putClipOrdonné,
  SETTING_FIELDS,
  replaceClips,
  InvalidSettingError,
  effectiveSettings,
  setRéglage,
  upsertProject,
  type Project,
} from '@/server/db'
import { mergeCandidates } from '@/core/candidates'
import { DIMENSIONS_PAR_DÉFAUT } from '@/core/transcript'
import type { Clip } from '@/core/edl'

/**
 * La base porte les projets et les clips. Les artefacts du pipeline — proxy,
 * WAV, transcript, rendus — restent des fichiers sur disque (spec §5).
 */

const PROJET: Project = {
  id: '2026-03-08-caro-mdlm',
  sourcePath: '/replay/2026-03-08-caro-mdlm.mp4',
  stagedPath: '/stage/2026-03-08-caro-mdlm.mp4',
  durationSec: 10234.5,
  sizeBytes: 12_700_000_000,
  mtimeMs: 1_772_000_000_000,
  createdAt: 1_772_100_000_000,
}

const clip = (id: string, reste: Partial<Clip> = {}): Clip => ({
  id,
  projectId: PROJET.id,
  segments: [
    { start: 2841.2, end: 2856.9 },
    { start: 2874.1, end: 2931.4 },
  ],
  ratio: 'auto',
  cropX: 0.5,
  captions: true,
  branding: false,
  title: 'La vanne du chapeau',
  description: '',
  status: 'candidate',
  pass: 1,
  ...reste,
})

let db: BaseSqlite

beforeEach(() => {
  db = openDb(':memory:')
  upsertProject(db, PROJET)
})

afterEach(() => {
  db.close()
})

describe('le schéma', () => {
  it('s’applique à l’ouverture, sur une base vierge', () => {
    const vierge = openDb(':memory:')
    try {
      const tables = vierge
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
      expect(tables.map((t) => t.name)).toEqual(
        expect.arrayContaining(['clips', 'projects', 'settings']),
      )
    } finally {
      vierge.close()
    }
  })

  // L'empreinte de la source est taille, date de modification et durée ffprobe.
  // Pas de hash : digérer 12 Go à chaque lancement coûterait plus cher que
  // l'étape qu'on cherche à éviter (spec §5).
  it('empreinte la source par taille, mtime et durée, sans hash', () => {
    const colonnes = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(colonnes).toEqual(expect.arrayContaining(['sizeBytes', 'mtimeMs', 'durationSec']))
    expect(colonnes.some((c) => /hash|sha|md5|digest/i.test(c))).toBe(false)
  })

  it('relit un projet tel qu’il a été écrit', () => {
    expect(getProject(db, PROJET.id)).toEqual(PROJET)
    expect(listProjects(db)).toEqual([PROJET])
  })

  it('réécrit un projet existant sans le dupliquer', () => {
    upsertProject(db, { ...PROJET, durationSec: 9999 })
    expect(listProjects(db)).toHaveLength(1)
    expect(getProject(db, PROJET.id)?.durationSec).toBe(9999)
  })

  // La date de création est celle de la création, pas celle de la dernière
  // écriture. Réécrire avec la même valeur ne distinguait pas « préservé » de
  // « écrasé à l'identique ». (relevé par Aristarque)
  it('garde la date de création d’origine à la réécriture', () => {
    upsertProject(db, { ...PROJET, createdAt: 9_999_999_999_999, durationSec: 1 })
    expect(getProject(db, PROJET.id)?.createdAt).toBe(PROJET.createdAt)
    expect(getProject(db, PROJET.id)?.durationSec).toBe(1)
  })
})

describe('les réglages', () => {
  it('rendent les défauts sur une base vierge', () => {
    expect(getRéglages(db)).toEqual(DIMENSIONS_PAR_DÉFAUT)
  })

  it('font l’aller-retour', () => {
    setRéglage(db, 'minutesParClip', 4)
    expect(getRéglages(db).minutesParClip).toBe(4)
    // Les autres ne bougent pas : un réglage écrit n'en efface aucun.
    expect(getRéglages(db).fenetresParClip).toBe(DIMENSIONS_PAR_DÉFAUT.fenetresParClip)
  })

  it('réécrivent sans dupliquer', () => {
    setRéglage(db, 'minutesParClip', 4)
    setRéglage(db, 'minutesParClip', 9)
    expect(getRéglages(db).minutesParClip).toBe(9)
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 1 })
  })

  // La lecture ne lève jamais : le repérage tourne derrière une transcription
  // qui a coûté quarante minutes, et une valeur mal saisie ne doit pas la jeter.
  it('ignorent une valeur illisible comme si elle était absente', () => {
    const poser = (valeur: string) =>
      db
        .prepare('INSERT OR REPLACE INTO settings (key, value, updatedAt) VALUES (?, ?, ?)')
        .run('selection.minutesParClip', valeur, 0)
    for (const valeur of ['', 'sept', '-3', '0']) {
      poser(valeur)
      expect(getRéglages(db).minutesParClip).toBe(DIMENSIONS_PAR_DÉFAUT.minutesParClip)
    }
  })

  // Zéro est la valeur signifiante de ce champ-là — « aucun plafond » — et lui
  // appliquer le refus des autres le rendrait impossible à remettre à zéro.
  it('acceptent zéro pour clipsMaximum, et lui seul', () => {
    setRéglage(db, 'clipsMaximum', 30)
    expect(getRéglages(db).clipsMaximum).toBe(30)
    setRéglage(db, 'clipsMaximum', 0)
    expect(getRéglages(db).clipsMaximum).toBe(0)
    expect(() => setRéglage(db, 'fenetresParClip', 0)).toThrow()
  })

  // Une clé mal orthographiée s'écrirait sans bruit, ne serait jamais relue, et
  // l'écran de réglages afficherait le défaut en jurant avoir enregistré.
  it('refusent une clé inconnue', () => {
    expect(() =>
      setRéglage(db, 'minutesParClipe' as keyof typeof DIMENSIONS_PAR_DÉFAUT, 4),
    ).toThrow(/inconnu/i)
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 })
  })

  it('refusent une valeur qui n’est pas un entier positif', () => {
    expect(() => setRéglage(db, 'minutesParClip', 0)).toThrow()
    expect(() => setRéglage(db, 'minutesParClip', -1)).toThrow()
    expect(() => setRéglage(db, 'minutesParClip', 4.5)).toThrow()
  })

  /**
   * L'écrivain et le lecteur doivent appliquer la **même** règle. `isInteger`
   * accepte `1e100`, que `String` écrit `"1e+100"` et que `getRéglages` refuse :
   * l'écriture réussissait donc, et la relecture rendait le défaut sans qu'un
   * mot le signale. (relevé par Copilot)
   */
  it('refusent un entier non sûr, comme le lecteur', () => {
    expect(() => setRéglage(db, 'minutesParClip', 1e100)).toThrow()
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 })
  })

  // Le contrat qui relie la table au type : une clé ajoutée à `DimensionsRepérage`
  // sans être relue ici passerait inaperçue jusqu'à ce qu'on la règle en vain.
  it('savent lire et écrire chacun des champs de DimensionsRepérage', () => {
    for (const champ of Object.keys(DIMENSIONS_PAR_DÉFAUT) as (keyof typeof DIMENSIONS_PAR_DÉFAUT)[]) {
      setRéglage(db, champ, 3)
      expect(getRéglages(db)[champ]).toBe(3)
    }
  })
})

describe('le registre des réglages', () => {
  it('décrit chaque champ de DimensionsRepérage, libellé compris', () => {
    // Le contrat du §6.2 du retour d'usage : « éviter de présenter uniquement
    // les noms techniques des clés ». Un champ ajouté sans libellé casse le
    // type-check ; celui-ci vérifie qu'aucun ne reste vide.
    for (const nom of Object.keys(DIMENSIONS_PAR_DÉFAUT)) {
      const champ = settingField('selection', nom)
      expect(champ, nom).toBeDefined()
      expect(champ!.label.length).toBeGreaterThan(0)
      expect(champ!.description.length).toBeGreaterThan(0)
      expect(champ!.defaultValue).toBe(DIMENSIONS_PAR_DÉFAUT[nom as keyof typeof DIMENSIONS_PAR_DÉFAUT])
    }
  })

  /**
   * **Jamais une clé d'API en clair dans `settings`.** La table se relit en
   * clair avec `sqlite3`, et le dépôt est public : les secrets passent par
   * `@/server/secrets`, qui les résout depuis 1Password. Une famille
   * « intelligence artificielle » stockera un modèle et une *référence*, jamais
   * une valeur — ce test tombe le jour où quelqu'un ajoute `apiKey` au registre.
   */
  it('ne porte aucun champ dont le nom annonce un secret', () => {
    for (const champ of SETTING_FIELDS) {
      expect(`${champ.family}.${champ.name}`).not.toMatch(
        /(cle|clé|key|token|secret|password|passwd|motdepasse)/i,
      )
    }
  })

  it('ne connaît pas une famille qui n’existe pas', () => {
    expect(settingField('hook', 'duree')).toBeUndefined()
    expect(settingField('selection', 'minutesParClipe')).toBeUndefined()
  })

  it('préfixe chaque clé stockée par sa famille', () => {
    setRéglage(db, 'minutesParClip', 4)
    expect(db.prepare('SELECT key FROM settings').all()).toEqual([
      { key: 'selection.minutesParClip' },
    ])
  })
})

/**
 * La famille `ai`, posée par la PR C (retour d'usage §6.1) : le fournisseur et
 * le modèle de chaque usage de langage, plus l'adresse d'un serveur Ollama.
 */
describe('la famille `ai`', () => {
  it('décrit ses sept champs, libellé compris', () => {
    for (const nom of [
      'selectionProvider',
      'selectionModel',
      'correctionProvider',
      'correctionModel',
      'hookProvider',
      'hookModel',
      'ollamaBaseUrl',
    ]) {
      const champ = settingField('ai', nom)
      expect(champ, nom).toBeDefined()
      expect(champ!.label.length).toBeGreaterThan(0)
      expect(champ!.description.length).toBeGreaterThan(0)
    }
  })

  it('contraint un fournisseur à l’ensemble des trois connus', () => {
    expect(() => applySettings(db, { ai: { selectionProvider: 'anthropic' } })).toThrow(
      InvalidSettingError,
    )
    expect(applySettings(db, { ai: { selectionProvider: 'openai' } }).ai.selectionProvider).toBe(
      'openai',
    )
  })

  /**
   * **Vide est une valeur, pas un champ oublié.** `CLAUDE.md`, « L'environnement » :
   * l'adresse de la passerelle WSL change au redémarrage et se résout à
   * l'exécution quand le réglage est vide.
   */
  it('accepte une adresse Ollama vide, et la refuse pour tout autre champ texte', () => {
    expect(applySettings(db, { ai: { ollamaBaseUrl: '' } }).ai.ollamaBaseUrl).toBe('')
    expect(() => applySettings(db, { ai: { selectionModel: '' } })).toThrow(InvalidSettingError)
  })

  it('relit une adresse Ollama réglée, aller-retour compris', () => {
    applySettings(db, { ai: { ollamaBaseUrl: 'http://172.20.16.1:11434' } })
    expect(effectiveSettings(db).ai.ollamaBaseUrl).toBe('http://172.20.16.1:11434')
  })

  it('ne recalcule rien : les usages non branchés se règlent sans effet', () => {
    upsertProject(db, PROJET)
    putClip(db, {
      id: 'clip_01',
      projectId: PROJET.id,
      segments: [{ start: 0, end: 1 }],
      ratio: '9:16',
      cropX: 0,
      captions: true,
      branding: true,
      title: 't',
      description: 'd',
      status: 'kept',
      pass: 1,
    })
    applySettings(db, { ai: { correctionProvider: 'openai', hookProvider: 'ollama' } })
    expect(getClips(db, PROJET.id).map((c) => c.status)).toEqual(['kept'])
  })
})

/**
 * **La grammaire du registre.** Le repérage ne porte que des entiers ; la
 * famille `ai` porte des chaînes, dont certaines contraintes à un ensemble
 * fermé ou tolérantes au vide (voir ci-dessus) ; les défauts du hook porteront
 * des booléens (retour d'usage §6.3), qu'aucune famille n'exerce encore. Ces
 * branches *sont* la généralisation — sans elles le registre n'est qu'une
 * table d'entiers déguisée —, et les laisser sans test jusqu'à ce qu'une
 * famille arrive reviendrait à les découvrir fausses le jour où quelqu'un
 * s'en sert.
 */
describe('la grammaire du registre', () => {
  const champ = (
    type: SettingField['type'],
    reste: Partial<SettingField> = {},
  ): SettingField => ({
    family: 'selection',
    name: 'temoin',
    type,
    defaultValue: type === 'integer' ? 1 : type === 'text' ? 'a' : false,
    label: 'Témoin',
    description: 'Un champ qui n’existe que pour ce test.',
    ...reste,
  })

  it('relit un entier, et rien qui lui ressemble', () => {
    const c = champ('integer', { min: 1 })
    expect(parseSetting(c, ' 4 ')).toBe(4)
    // `parseInt` lirait 4 dans « 4.5 » et 7 dans « 7abc » : une saisie à moitié
    // comprise est pire que refusée, personne ne peut deviner ce qui s'applique.
    for (const brut of ['', 'sept', '4.5', '7abc', '0x10', '-3', '0']) {
      expect(parseSetting(c, brut), brut).toBeUndefined()
    }
  })

  it('relit un booléen écrit en toutes lettres, et rien d’autre', () => {
    const c = champ('boolean')
    expect(parseSetting(c, 'true')).toBe(true)
    expect(parseSetting(c, 'false')).toBe(false)
    for (const brut of ['1', '0', 'oui', 'TRUE', '']) {
      expect(parseSetting(c, brut), brut).toBeUndefined()
    }
  })

  it('relit un texte tel quel', () => {
    expect(parseSetting(champ('text'), 'http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
  })

  it('valide chaque type sans convertir d’un type à l’autre', () => {
    expect(validateSetting(champ('integer', { min: 0 }), 0)).toBe(0)
    expect(validateSetting(champ('boolean'), true)).toBe(true)
    expect(validateSetting(champ('text'), 'gemma4:26b')).toBe('gemma4:26b')

    expect(() => validateSetting(champ('integer', { min: 1 }), '4')).toThrow()
    expect(() => validateSetting(champ('boolean'), 'true')).toThrow()
    expect(() => validateSetting(champ('boolean'), 1)).toThrow()
    expect(() => validateSetting(champ('text'), 42)).toThrow()
    // Un texte vide ou fait de blancs n'est pas un réglage, c'est un champ oublié.
    expect(() => validateSetting(champ('text'), '   ')).toThrow()
    expect(() => validateSetting(champ('text'), 'x'.repeat(4_096))).toThrow()
  })

  /** Écriture et lecture appliquent la même règle, sinon l'aller-retour ment. */
  it('fait l’aller-retour sur les trois types', () => {
    for (const [c, valeur] of [
      [champ('integer', { min: 0 }), 12],
      [champ('boolean'), false],
      [champ('text'), 'llama3'],
    ] as const) {
      const stocké = String(validateSetting(c, valeur))
      expect(parseSetting(c, stocké)).toBe(valeur)
    }
  })
})

describe('appliquerRéglages', () => {
  it('écrit plusieurs champs d’un coup et rend les réglages résultants', () => {
    const result = applySettings(db, {
      selection: { minutesParClip: 4, clipsMaximum: 12 },
    })
    expect(result.selection.minutesParClip).toBe(4)
    expect(result.selection.clipsMaximum).toBe(12)
    // Les champs non touchés ressortent à leur valeur effective, pas absents :
    // l'écran affiche ce qui s'applique.
    expect(result.selection.fenetresParClip).toBe(DIMENSIONS_PAR_DÉFAUT.fenetresParClip)
  })

  it('refuse une clé inconnue', () => {
    expect(() => applySettings(db, { selection: { minutesParClipe: 4 } })).toThrow(
      InvalidSettingError,
    )
  })

  it('refuse une famille inconnue', () => {
    expect(() => applySettings(db, { hook: { duree: 2 } })).toThrow(/inconnu/i)
  })

  /**
   * **Y compris vide.** Contrôler le champ suffisait tant que le patch en
   * portait un : `{ hook: {} }` ne déclenchait aucun tour de boucle, donc aucun
   * contrôle, et la route répondait 200 sur une famille qui n'existe pas.
   * (relevé par Codex)
   */
  it('refuse une famille inconnue même sans aucun champ', () => {
    expect(() => applySettings(db, { hook: {} })).toThrow(InvalidSettingError)
    // Et une famille connue vide reste acceptée : elle ne demande rien.
    expect(applySettings(db, { selection: {} }).selection).toEqual(DIMENSIONS_PAR_DÉFAUT)
  })

  it('refuse une valeur hors bornes', () => {
    expect(() => applySettings(db, { selection: { minutesParClip: 0 } })).toThrow(
      InvalidSettingError,
    )
    expect(() => applySettings(db, { selection: { fenetresParClip: -1 } })).toThrow()
    expect(() => applySettings(db, { selection: { clipsMinimum: 2.5 } })).toThrow()
  })

  it('refuse une valeur du mauvais type sans la convertir', () => {
    // `"4"` n'est pas 4 : accepter la chaîne ferait passer `"4abc"` par le même
    // chemin le jour où quelqu'un remplacerait le contrôle par un `Number()`.
    expect(() => applySettings(db, { selection: { minutesParClip: '4' } })).toThrow()
    expect(() => applySettings(db, { selection: { minutesParClip: null } })).toThrow()
    expect(() => applySettings(db, { selection: { minutesParClip: true } })).toThrow()
  })

  it('refuse un corps qui n’est pas un objet de familles', () => {
    for (const corps of [null, 42, 'selection', [], { selection: 4 }, { selection: [] }]) {
      expect(() => applySettings(db, corps)).toThrow(InvalidSettingError)
    }
  })

  /**
   * **Rien n'est écrit tant que tout n'est pas validé.** Un patch dont le second
   * champ est hors bornes ne doit pas laisser le premier en base : l'appelant
   * reçoit un refus et affiche l'état d'avant, alors que la moitié de sa saisie
   * serait passée.
   */
  it('n’écrit rien quand un seul champ du patch est refusé', () => {
    expect(() =>
      applySettings(db, { selection: { minutesParClip: 4, fenetresParClip: 0 } }),
    ).toThrow()
    expect(getRéglages(db)).toEqual(DIMENSIONS_PAR_DÉFAUT)
  })

  it('accepte un patch vide sans rien changer', () => {
    expect(applySettings(db, {}).selection).toEqual(DIMENSIONS_PAR_DÉFAUT)
    expect(applySettings(db, { selection: {} }).selection).toEqual(DIMENSIONS_PAR_DÉFAUT)
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 })
  })

  it('ne touche à aucune émission : changer un réglage ne recalcule rien', () => {
    // Le §11 du retour d'usage, tenu par un test plutôt que par une intention :
    // « toute modification d'un paramètre global ne doit pas silencieusement
    // recalculer des émissions existantes ».
    upsertProject(db, PROJET)
    putClip(db, clip('clip_01', { status: 'kept' }))
    applySettings(db, { selection: { minutesParClip: 4 } })
    expect(getClips(db, PROJET.id).map((c) => c.status)).toEqual(['kept'])
  })

  it('rend la même chose que réglagesEffectifs', () => {
    applySettings(db, { selection: { clipsMinimum: 9 } })
    // **`ai` aussi**, depuis la PR C : `effectiveSettings` rend les deux
    // familles, `getRéglages` ne projette que `selection`. Le résultat est
    // comparé aux défauts de la famille — inchangée par ce patch, qui ne
    // touche que `selection` — plutôt qu'à lui-même, ce qui ne testerait rien.
    expect(effectiveSettings(db)).toEqual({
      selection: getRéglages(db),
      ai: {
        selectionProvider: 'gemini',
        selectionModel: 'gemini-3.1-flash-lite',
        correctionProvider: 'gemini',
        correctionModel: 'gemini-3.1-flash-lite',
        hookProvider: 'gemini',
        hookModel: 'gemini-3.1-flash-lite',
        ollamaBaseUrl: '',
      },
    })
  })
})

describe('les clips', () => {
  it('font l’aller-retour sans rien perdre', () => {
    const c = clip('clip_07', { branding: true, description: 'ça part en vrille' })
    putClip(db, c)
    expect(getClip(db, 'clip_07')).toEqual(c)
  })

  // SQLite n'a pas de booléen. Rendre le 0 ou le 1 brut marche partout sauf dans
  // un `JSON.stringify`, qui l'expose tel quel à l'interface.
  it('rendent des booléens, pas des 0 et des 1', () => {
    putClip(db, clip('clip_07', { captions: false, branding: true }))
    const relu = getClip(db, 'clip_07')
    expect(relu?.captions).toBe(false)
    expect(relu?.branding).toBe(true)
  })

  // Le clip est une liste de segments (spec §5). Une colonne `start` et une
  // colonne `end` feraient réapparaître la fenêtre fixe que ce projet remplace.
  it('gardent la liste de segments entière', () => {
    putClip(db, clip('clip_07'))
    expect(getClip(db, 'clip_07')?.segments).toEqual([
      { start: 2841.2, end: 2856.9 },
      { start: 2874.1, end: 2931.4 },
    ])
  })

  it('rendent undefined quand le clip n’existe pas', () => {
    expect(getClip(db, 'jamais-vu')).toBeUndefined()
  })

  it('refusent d’appartenir à un projet inconnu', () => {
    expect(() => putClip(db, clip('clip_07', { projectId: 'fantôme' }))).toThrow()
  })

  it('disparaissent avec leur projet', () => {
    putClip(db, clip('clip_07'))
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJET.id)
    expect(getClips(db, PROJET.id)).toEqual([])
  })
})

describe('replaceClips', () => {
  it('remplace le jeu entier, et non seulement ce qu’on lui donne', () => {
    replaceClips(db, PROJET.id, [clip('a'), clip('b')])
    replaceClips(db, PROJET.id, [clip('c')])
    expect(getClips(db, PROJET.id).map((c) => c.id)).toEqual(['c'])
  })

  // Le cas qu'un appelant atteint par accident : `mergeCandidates` sur un lot
  // vide et un projet sans décision humaine rend une liste vide. (relevé par
  // Aristarque)
  it('vide le projet quand on ne lui donne rien', () => {
    replaceClips(db, PROJET.id, [clip('a'), clip('b')])
    replaceClips(db, PROJET.id, [])
    expect(getClips(db, PROJET.id)).toEqual([])
  })

  it('refuse un clip d’un autre projet', () => {
    expect(() => replaceClips(db, PROJET.id, [clip('a', { projectId: 'autre' })])).toThrow()
  })

  // Sans ce contrôle, l'`ON CONFLICT` écrase le premier par le second et
  // l'appelant croit avoir écrit deux clips. (relevé par Aristarque)
  it('refuse deux fois le même id dans un seul lot', () => {
    expect(() => replaceClips(db, PROJET.id, [clip('a'), clip('a')])).toThrow(/deux fois/)
  })

  // Un identifiant de clip est unique pour toute la base — la spec §12 expose
  // `GET /api/clips/:id` sans projet dans le chemin. L'upsert rattrapait la
  // collision en déplaçant le clip d'un projet à l'autre, ce qui détruisait le
  // travail du premier. (relevé par Codex, Copilot et Aristarque)
  it('refuse de déménager un identifiant déjà pris par un autre projet', () => {
    upsertProject(db, { ...PROJET, id: 'autre-emission' })
    putClip(db, clip('clip_07'))

    expect(() =>
      replaceClips(db, 'autre-emission', [clip('clip_07', { projectId: 'autre-emission' })]),
    ).toThrow(/appartient au projet/)

    // Et le clip d'origine est intact : la transaction a tout annulé.
    expect(getClip(db, 'clip_07')?.projectId).toBe(PROJET.id)
    expect(getClips(db, PROJET.id)).toHaveLength(1)
  })

  // L'enchaînement réel de la tâche 9 : la fusion décide, la base enregistre.
  // Une passe de repérage ne doit pas ressusciter ce qu'un humain vient
  // d'écarter (spec §5).
  it('enregistre une passe de repérage sans ressusciter un clip écarté', () => {
    replaceClips(db, PROJET.id, [
      clip('gardé', { status: 'kept' }),
      clip('écarté', { status: 'discarded' }),
      clip('périmé', { status: 'candidate' }),
    ])

    const fusion = mergeCandidates(
      getClips(db, PROJET.id),
      [clip('écarté'), clip('neuf')],
      2,
    )
    replaceClips(db, PROJET.id, fusion)

    const relus = getClips(db, PROJET.id)
    expect(relus.map((c) => c.id).sort()).toEqual(['gardé', 'neuf', 'écarté'].sort())
    expect(relus.find((c) => c.id === 'écarté')?.status).toBe('discarded')
    expect(relus.find((c) => c.id === 'neuf')?.pass).toBe(2)
  })
})

describe('sur un vrai fichier', () => {
  let dossier: string

  beforeEach(() => {
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-db-'))
  })

  afterEach(() => {
    fs.rmSync(dossier, { recursive: true, force: true })
  })

  it('crée le dossier manquant et retrouve les données à la réouverture', () => {
    const fichier = path.join(dossier, 'profond', 'avolo.db')
    const première = openDb(fichier)
    upsertProject(première, PROJET)
    putClip(première, clip('clip_07'))
    première.close()

    const seconde = openDb(fichier)
    expect(getClip(seconde, 'clip_07')?.title).toBe('La vanne du chapeau')
    seconde.close()
  })
})

/**
 * Une passe de repérage réécrit tout le jeu de clips d'un projet. Sans
 * précaution, les survivants y perdraient leur ordre d'écriture : une écriture
 * ancienne encore en vol arriverait devant un champ sans mémoire, passerait pour
 * fraîche, et écraserait un geste plus récent. (relevé par Copilot)
 */
describe('replaceClips et les jetons d’ordre', () => {
  it('garde les jetons des clips qui survivent à la passe', () => {
    putClip(db, clip('survivant'))
    expect(putClipOrdonné(db, clip('survivant', { title: 'Récent' }), ['title'], 100)?.applied).toBe(
      true,
    )

    replaceClips(db, PROJET.id, [clip('survivant'), clip('nouveau')])

    // Le jeton a survécu : une écriture plus ancienne se fait toujours écarter.
    const périmée = putClipOrdonné(db, clip('survivant', { title: 'Ancien' }), ['title'], 50)
    expect(périmée?.applied).toBe(false)
    // Et un clip que la passe vient de créer n'a rien à opposer à personne.
    expect(putClipOrdonné(db, clip('nouveau', { title: 'Neuf' }), ['title'], 1)?.applied).toBe(true)
  })
})

/**
 * La migration, éprouvée depuis une base **d'avant**.
 *
 * Une base ouverte par le code courant a `seqs` par son `CREATE TABLE` : la
 * rejouer ne prouve rien. Ce qui se casserait en silence, c'est la base qui
 * existe déjà — il y en a une sur cette machine, avec les clips d'une émission
 * entière dedans —, et elle n'entre par aucun test qui parte du schéma actuel.
 * (relevé par Copilot)
 */
describe('migrer', () => {
  let fichier: string
  let racine: string

  /** Le schéma d'avant : ni `seqs`, ni son prédécesseur `seq`. */
  const SCHÉMA_ANCIEN = `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, sourcePath TEXT NOT NULL, stagedPath TEXT,
      durationSec REAL, sizeBytes INTEGER, mtimeMs INTEGER, createdAt INTEGER NOT NULL
    );
    CREATE TABLE clips (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      segments TEXT NOT NULL, ratio TEXT NOT NULL, cropX REAL NOT NULL,
      captions INTEGER NOT NULL, branding INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL,
      status TEXT NOT NULL, pass INTEGER NOT NULL
    );`

  beforeEach(() => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-migration-'))
    fichier = path.join(racine, 'avolo.db')
  })

  afterEach(() => {
    fs.rmSync(racine, { recursive: true, force: true })
  })

  function poserBaseAncienne(colonneSeq: boolean): void {
    const ancienne = new Database(fichier)
    ancienne.exec(SCHÉMA_ANCIEN)
    if (colonneSeq) ancienne.exec('ALTER TABLE clips ADD COLUMN seq INTEGER NOT NULL DEFAULT 0')
    ancienne
      .prepare(
        `INSERT INTO projects (id, sourcePath, stagedPath, durationSec, sizeBytes, mtimeMs, createdAt)
         VALUES (@id, @sourcePath, @stagedPath, @durationSec, @sizeBytes, @mtimeMs, @createdAt)`,
      )
      .run(PROJET)
    ancienne
      .prepare(
        `INSERT INTO clips (id, projectId, segments, ratio, cropX, captions, branding,
                            title, description, status, pass)
         VALUES ('vieux', @p, '[{"start":10,"end":20}]', '1:1', 0.5, 1, 1,
                 'Un titre d''avant', 'Une description', 'kept', 1)`,
      )
      .run({ p: PROJET.id })
    ancienne.close()
  }

  it('ajoute `seqs` sans toucher aux clips déjà écrits', () => {
    poserBaseAncienne(false)

    const db = openDb(fichier)
    const colonnes = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(colonnes).toContain('seqs')
    // Le défaut compte autant que la colonne : sans lui, la première comparaison
    // porterait sur `null` et écarterait des écritures parfaitement fraîches.
    expect(db.prepare('SELECT seqs FROM clips WHERE id = ?').get('vieux')).toEqual({ seqs: '{}' })

    const vieux = getClip(db, 'vieux')
    expect(vieux?.title).toBe("Un titre d'avant")
    expect(vieux?.segments).toEqual([{ start: 10, end: 20 }])
    db.close()
  })

  it('accepte une écriture ordonnée sur un clip d’avant la colonne', () => {
    poserBaseAncienne(false)

    const db = openDb(fichier)
    const vieux = getClip(db, 'vieux')
    expect(vieux).toBeDefined()
    // Aucun jeton en base : tout geste dépasse un champ absent, donc rien de ce
    // qui préexiste ne bloque la première écriture.
    const résultat = putClipOrdonné(db, { ...vieux!, title: 'Après' }, ['title'], 5)
    expect(résultat?.applied).toBe(true)
    expect(getClip(db, 'vieux')?.title).toBe('Après')
    // Et le suivant, plus ancien, se fait écarter.
    expect(putClipOrdonné(db, { ...vieux!, title: 'Encore avant' }, ['title'], 4)?.applied).toBe(
      false,
    )
    expect(getClip(db, 'vieux')?.title).toBe('Après')
    db.close()
  })

  it('laisse tomber `seq`, le prédécesseur par ligne', () => {
    poserBaseAncienne(true)

    const db = openDb(fichier)
    const colonnes = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(colonnes).toContain('seqs')
    // Une colonne morte au nom presque identique à celle qui compte est le pire
    // des deux mondes.
    expect(colonnes).not.toContain('seq')
    expect(getClip(db, 'vieux')?.title).toBe("Un titre d'avant")
    db.close()
  })

  it('est idempotente : deux ouvertures de suite ne se marchent pas dessus', () => {
    poserBaseAncienne(true)
    openDb(fichier).close()
    const db = openDb(fichier)
    expect(getClip(db, 'vieux')?.status).toBe('kept')
    db.close()
  })
})
