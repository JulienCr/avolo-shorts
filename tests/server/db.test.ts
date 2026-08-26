import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database, { type Database as BaseSqlite } from 'better-sqlite3'
import {
  applySettings,
  copiesSourceLocally,
  settingField,
  parseSetting,
  validateSetting,
  type SettingField,
  getClip,
  getClips,
  getProject,
  getPublications,
  getSettings,
  listProjects,
  openDb,
  putClip,
  putClipOrdered,
  SETTING_FIELDS,
  replaceClips,
  InvalidSettingError,
  effectiveSettings,
  setSetting,
  upsertProject,
  upsertPublication,
  type Project,
  type PublicationRow,
} from '@/server/db'
import { mergeCandidates } from '@/core/candidates'
import { DEFAULT_SELECTION_DIMENSIONS } from '@/core/transcript'
import type { Clip } from '@/core/edl'
import { FRAMING_BOUNDS, FRAMING_SETTINGS_DEFAULTS, HOOK_DEFAULTS } from '@/lib/api'

/**
 * La base porte les projets et les clips. Les artefacts du pipeline — proxy,
 * WAV, transcript, rendus — restent des fichiers sur disque (spec §5).
 */

const PROJECT: Project = {
  id: '2026-03-08-caro-mdlm',
  sourcePath: '/replay/2026-03-08-caro-mdlm.mp4',
  stagedPath: '/stage/2026-03-08-caro-mdlm.mp4',
  durationSec: 10234.5,
  sizeBytes: 12_700_000_000,
  mtimeMs: 1_772_000_000_000,
  createdAt: 1_772_100_000_000,
}

const clip = (id: string, remaining: Partial<Clip> = {}): Clip => ({
  id,
  projectId: PROJECT.id,
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
  hookText: '',
  hookBadge: '',
  hookStyle: {},
  framingStyle: {},
  ...remaining,
})

let db: BaseSqlite

beforeEach(() => {
  db = openDb(':memory:')
  upsertProject(db, PROJECT)
})

afterEach(() => {
  db.close()
})

describe('le schéma', () => {
  it('s’applique à l’ouverture, sur une base vierge', () => {
    const blank = openDb(':memory:')
    try {
      const tables = blank
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
      expect(tables.map((t) => t.name)).toEqual(
        expect.arrayContaining(['clips', 'projects', 'settings']),
      )
    } finally {
      blank.close()
    }
  })

  // L'empreinte de la source est taille, date de modification et durée ffprobe.
  // Pas de hash : digérer 12 Go à chaque lancement coûterait plus cher que
  // l'étape qu'on cherche à éviter (spec §5).
  it('empreinte la source par taille, mtime et durée, sans hash', () => {
    const columns = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns).toEqual(expect.arrayContaining(['sizeBytes', 'mtimeMs', 'durationSec']))
    expect(columns.some((c) => /hash|sha|md5|digest/i.test(c))).toBe(false)
  })

  it('relit un projet tel qu’il a été écrit', () => {
    expect(getProject(db, PROJECT.id)).toEqual(PROJECT)
    expect(listProjects(db)).toEqual([PROJECT])
  })

  it('réécrit un projet existant sans le dupliquer', () => {
    upsertProject(db, { ...PROJECT, durationSec: 9999 })
    expect(listProjects(db)).toHaveLength(1)
    expect(getProject(db, PROJECT.id)?.durationSec).toBe(9999)
  })

  // La date de création est celle de la création, pas celle de la dernière
  // écriture. Réécrire avec la même valeur ne distinguait pas « préservé » de
  // « écrasé à l'identique ». (relevé par Aristarque)
  it('garde la date de création d’origine à la réécriture', () => {
    upsertProject(db, { ...PROJECT, createdAt: 9_999_999_999_999, durationSec: 1 })
    expect(getProject(db, PROJECT.id)?.createdAt).toBe(PROJECT.createdAt)
    expect(getProject(db, PROJECT.id)?.durationSec).toBe(1)
  })
})

describe('les réglages', () => {
  it('rendent les défauts sur une base vierge', () => {
    expect(getSettings(db)).toEqual(DEFAULT_SELECTION_DIMENSIONS)
  })

  it('font l’aller-retour', () => {
    setSetting(db, 'minutesPerClip', 4)
    expect(getSettings(db).minutesPerClip).toBe(4)
    // Les autres ne bougent pas : un réglage écrit n'en efface aucun.
    expect(getSettings(db).windowsPerClip).toBe(DEFAULT_SELECTION_DIMENSIONS.windowsPerClip)
  })

  it('réécrivent sans dupliquer', () => {
    setSetting(db, 'minutesPerClip', 4)
    setSetting(db, 'minutesPerClip', 9)
    expect(getSettings(db).minutesPerClip).toBe(9)
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 1 })
  })

  // La lecture ne lève jamais : le repérage tourne derrière une transcription
  // qui a coûté quarante minutes, et une valeur mal saisie ne doit pas la jeter.
  it('ignorent une valeur illisible comme si elle était absente', () => {
    const poser = (value: string) =>
      db
        .prepare('INSERT OR REPLACE INTO settings (key, value, updatedAt) VALUES (?, ?, ?)')
        .run('selection.minutesPerClip', value, 0)
    for (const value of ['', 'sept', '-3', '0']) {
      poser(value)
      expect(getSettings(db).minutesPerClip).toBe(DEFAULT_SELECTION_DIMENSIONS.minutesPerClip)
    }
  })

  // Zéro est la valeur signifiante de ce champ-là — « aucun plafond » — et lui
  // appliquer le refus des autres le rendrait impossible à remettre à zéro.
  it('acceptent zéro pour maximumClips, et lui seul', () => {
    setSetting(db, 'maximumClips', 30)
    expect(getSettings(db).maximumClips).toBe(30)
    setSetting(db, 'maximumClips', 0)
    expect(getSettings(db).maximumClips).toBe(0)
    expect(() => setSetting(db, 'windowsPerClip', 0)).toThrow()
  })

  // Une clé mal orthographiée s'écrirait sans bruit, ne serait jamais relue, et
  // l'écran de réglages afficherait le défaut en jurant avoir enregistré.
  it('refusent une clé inconnue', () => {
    expect(() =>
      setSetting(db, 'minutesParClipe' as keyof typeof DEFAULT_SELECTION_DIMENSIONS, 4),
    ).toThrow(/inconnu/i)
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 })
  })

  it('refusent une valeur qui n’est pas un entier positif', () => {
    expect(() => setSetting(db, 'minutesPerClip', 0)).toThrow()
    expect(() => setSetting(db, 'minutesPerClip', -1)).toThrow()
    expect(() => setSetting(db, 'minutesPerClip', 4.5)).toThrow()
  })

  /**
   * L'écrivain et le lecteur doivent appliquer la **même** règle. `isInteger`
   * accepte `1e100`, que `String` écrit `"1e+100"` et que `getSettings` refuse :
   * l'écriture réussissait donc, et la relecture rendait le défaut sans qu'un
   * mot le signale. (relevé par Copilot)
   */
  it('refusent un entier non sûr, comme le lecteur', () => {
    expect(() => setSetting(db, 'minutesPerClip', 1e100)).toThrow()
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 })
  })

  // Le contrat qui relie la table au type : une clé ajoutée à `SelectionDimensions`
  // sans être relue ici passerait inaperçue jusqu'à ce qu'on la règle en vain.
  it('savent lire et écrire chacun des champs de SelectionDimensions', () => {
    for (const field of Object.keys(DEFAULT_SELECTION_DIMENSIONS) as (keyof typeof DEFAULT_SELECTION_DIMENSIONS)[]) {
      setSetting(db, field, 3)
      expect(getSettings(db)[field]).toBe(3)
    }
  })
})

describe('le registre des réglages', () => {
  it('décrit chaque champ de SelectionDimensions', () => {
    // L'exhaustivité par le type : un champ ajouté à `SelectionDimensions` sans
    // venir dans `SELECTION_FIELDS` casse le type-check.
    for (const name of Object.keys(DEFAULT_SELECTION_DIMENSIONS)) {
      const field = settingField('selection', name)
      expect(field, name).toBeDefined()
      expect(field!.defaultValue).toBe(DEFAULT_SELECTION_DIMENSIONS[name as keyof typeof DEFAULT_SELECTION_DIMENSIONS])
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
    for (const field of SETTING_FIELDS) {
      expect(`${field.family}.${field.name}`).not.toMatch(
        /(cle|clé|key|token|secret|password|passwd|motdepasse)/i,
      )
    }
  })

  it('ne connaît pas une famille qui n’existe pas', () => {
    // `hook` est une vraie famille depuis cette PR : le témoin d'une famille
    // inconnue doit rester un nom que le registre n'a jamais porté. Le témoin
    // lui-même est en anglais, comme tout code neuf (`CLAUDE.md`).
    expect(settingField('unknownFamily', 'unknownField')).toBeUndefined()
    expect(settingField('selection', 'minutesParClipe')).toBeUndefined()
  })

  it('préfixe chaque clé stockée par sa famille', () => {
    setSetting(db, 'minutesPerClip', 4)
    expect(db.prepare('SELECT key FROM settings').all()).toEqual([
      { key: 'selection.minutesPerClip' },
    ])
  })
})

/**
 * La famille `ai`, posée par la PR C (retour d'usage §6.1) : le fournisseur et
 * le modèle de chaque usage de langage, plus l'adresse d'un serveur Ollama.
 */
describe('la famille `ai`', () => {
  it('décrit ses sept champs', () => {
    for (const name of [
      'selectionProvider',
      'selectionModel',
      'correctionProvider',
      'correctionModel',
      'hookProvider',
      'hookModel',
      'ollamaBaseUrl',
    ]) {
      const field = settingField('ai', name)
      expect(field, name).toBeDefined()
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
    upsertProject(db, PROJECT)
    putClip(db, {
      id: 'clip_01',
      projectId: PROJECT.id,
      segments: [{ start: 0, end: 1 }],
      ratio: '9:16',
      cropX: 0,
      captions: true,
      branding: true,
      title: 't',
      description: 'd',
      status: 'kept',
      pass: 1,
      hookText: '',
      hookBadge: '',
      hookStyle: {},
      framingStyle: {},
    })
    applySettings(db, { ai: { correctionProvider: 'openai', hookProvider: 'ollama' } })
    expect(getClips(db, PROJECT.id).map((c) => c.status)).toEqual(['kept'])
  })
})

/**
 * La famille `ingestion` : faut-il copier le replay dans `stage/` avant de
 * l'exploiter ?
 *
 * **La première famille booléenne du registre.** Ce qu'elle vérifie n'est donc
 * pas seulement son propre comportement, mais que la généralisation tient une
 * fois empruntée pour de bon : le défaut, l'aller-retour, le refus d'un
 * non-booléen, et une valeur corrompue en base traitée comme absente.
 */
describe('la famille `ingestion`', () => {
  it('copie par défaut, base vide', () => {
    // **Le défaut le plus prudent est celui qui décrit le Drive**, parce que
    // c'est de là que viennent les replays : décoché par défaut ferait relire
    // douze gigaoctets en 9p à qui n'a rien réglé.
    expect(effectiveSettings(db).ingestion.copySourceLocally).toBe(true)
    expect(copiesSourceLocally(db)).toBe(true)
  })

  it('fait l’aller-retour, et la projection dit la même chose que la famille', () => {
    expect(applySettings(db, { ingestion: { copySourceLocally: false } }).ingestion).toEqual({
      copySourceLocally: false,
    })
    expect(effectiveSettings(db).ingestion.copySourceLocally).toBe(false)
    // Deux lecteurs de la même clé, et c'est tout l'objet de la projection :
    // s'ils divergeaient, l'écran et l'ingestion ne parleraient pas du même
    // réglage.
    expect(copiesSourceLocally(db)).toBe(false)
    expect(applySettings(db, { ingestion: { copySourceLocally: true } }).ingestion).toEqual({
      copySourceLocally: true,
    })
  })

  it('refuse ce qui n’est pas un booléen, y compris ce qui lui ressemble', () => {
    // `'true'` et `1` sont les deux formes qu'un client mal écrit enverrait, et
    // les accepter ferait passer `0` pour un « non » là où le registre n'en
    // sait rien.
    for (const value of ['true', 'false', 1, 0, null]) {
      expect(
        () => applySettings(db, { ingestion: { copySourceLocally: value as never } }),
        String(value),
      ).toThrow(InvalidSettingError)
    }
    // Et rien n'a été écrit : le défaut s'applique toujours.
    expect(effectiveSettings(db).ingestion.copySourceLocally).toBe(true)
  })

  it('ignore une valeur corrompue en base au profit du défaut', () => {
    // Le seul chemin qui y mène est une table éditée à la main avec `sqlite3`,
    // et c'est précisément le chemin qu'on ne contrôle pas. Une ingestion ne
    // doit pas échouer là-dessus : elle tourne derrière une transcription qui a
    // coûté quarante minutes.
    db.prepare(
      'INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)',
    ).run('ingestion.copySourceLocally', 'oui', Date.now())
    expect(effectiveSettings(db).ingestion.copySourceLocally).toBe(true)
  })

  it('rend le défaut du registre quand aucune base n’est ouverte', () => {
    // `db: null` est le contrat des tests et des scripts. Leur laisser écrire
    // `?? true` de leur côté poserait le défaut une seconde fois, à l'endroit
    // exact où il divergerait sans que rien ne le signale.
    expect(copiesSourceLocally(null)).toBe(true)
  })
})

/**
 * La famille `hook` (retour d'usage §6.3), branchée par cette PR : les treize
 * défauts globaux du hook, écrits et relus comme les deux familles
 * précédentes.
 *
 * `sizePermille` et `cornerRadiusPermille` remplacent l'ancien `size` — un
 * fond translucide à angles droits recouvrait l'image plutôt que de s'y
 * poser, le 20 août 2026 — et `uppercase` s'ajoute au même moment.
 */
describe('la famille `hook`', () => {
  it('décrit ses treize champs', () => {
    for (const name of [
      'enabled',
      'durationMs',
      'font',
      'sizePermille',
      'cornerRadiusPermille',
      'uppercase',
      'position',
      'alignment',
      'textColor',
      'backgroundColor',
      'backgroundOpacity',
      'enter',
      'exit',
    ]) {
      const f = settingField('hook', name)
      expect(f, name).toBeDefined()
    }
  })

  it('rend les treize défauts sur une base vierge', () => {
    expect(effectiveSettings(db).hook).toEqual(HOOK_DEFAULTS)
  })

  it('fait l’aller-retour sur un champ de chacun des quatre types', () => {
    const after = applySettings(db, {
      hook: { enabled: false, sizePermille: 150, position: 'bottom', textColor: '#a1b2c3' },
    })
    expect(after.hook.enabled).toBe(false)
    expect(after.hook.sizePermille).toBe(150)
    expect(after.hook.position).toBe('bottom')
    expect(after.hook.textColor).toBe('#A1B2C3')
    // Les autres champs ne bougent pas : un patch partiel ne réinitialise rien
    // de ce qu'il ne touche pas.
    expect(after.hook.backgroundColor).toBe(HOOK_DEFAULTS.backgroundColor)
  })

  it('contraint position, alignment, enter et exit à leurs énumérations', () => {
    expect(() => applySettings(db, { hook: { position: 'diagonal' } })).toThrow(
      InvalidSettingError,
    )
    expect(() => applySettings(db, { hook: { enter: 'wipe' } })).toThrow(InvalidSettingError)
  })

  it('ne recalcule rien : changer un défaut du hook ne touche aucun clip', () => {
    upsertProject(db, PROJECT)
    putClip(db, clip('clip_01', { status: 'kept' }))
    applySettings(db, { hook: { sizePermille: 150 } })
    expect(getClips(db, PROJECT.id).map((c) => c.status)).toEqual(['kept'])
  })
})

/**
 * La famille `framing` (issue #180, première moitié) : les six leviers
 * globaux du split-screen (PR #176) et du plancher de taille (PR #177),
 * jusqu'ici en dur dans `FRAMING_DEFAULTS` (`src/core/framing.ts`).
 *
 * **Entiers et un booléen, jamais de fraction** — même patron que `hook`.
 * `splitMinShotMs` porte des millisecondes, les quatre autres des millièmes ;
 * la conversion vers `FramingOptions` vit dans `src/server/clip-framing.ts`,
 * pas ici.
 */
describe('la famille `framing`', () => {
  it('décrit ses six champs', () => {
    for (const name of [
      'splitScreen',
      'splitMinShotMs',
      'splitMinCellWidthPermille',
      'splitBleedTolerancePermille',
      'splitBleedSharePermille',
      'sizeFloorPermille',
    ]) {
      const f = settingField('framing', name)
      expect(f, name).toBeDefined()
    }
  })

  it('rend les six défauts sur une base vierge', () => {
    expect(effectiveSettings(db).framing).toEqual(FRAMING_SETTINGS_DEFAULTS)
  })

  it('fait l’aller-retour sur un champ de chacun des deux types', () => {
    const after = applySettings(db, {
      framing: { splitScreen: false, sizeFloorPermille: 300 },
    })
    expect(after.framing.splitScreen).toBe(false)
    expect(after.framing.sizeFloorPermille).toBe(300)
    // Un patch partiel ne réinitialise rien de ce qu'il ne touche pas.
    expect(after.framing.splitMinShotMs).toBe(FRAMING_SETTINGS_DEFAULTS.splitMinShotMs)
  })

  /**
   * **`max`, pas `min`**, sur les cinq champs numériques : `validateSetting`
   * défaute `min` à 0 (`const min = field.min ?? 0`), qui est déjà le plancher
   * de chacun — retirer leur `min` explicite ne changerait rien. Vérifié par
   * suppression sur les cinq, un par un (voir le corps de la PR pour le
   * verdict complet) : la seule borne qui meurt sans qu'un test s'en
   * aperçoive quand on la retire est `min`, jamais `max`.
   */
  it('refuse une valeur hors des bornes de `FRAMING_BOUNDS`', () => {
    expect(() =>
      applySettings(db, { framing: { splitMinShotMs: FRAMING_BOUNDS.splitMinShotMs.max + 1 } }),
    ).toThrow(InvalidSettingError)
    expect(() =>
      applySettings(db, {
        framing: { splitMinCellWidthPermille: FRAMING_BOUNDS.splitMinCellWidthPermille.max + 1 },
      }),
    ).toThrow(InvalidSettingError)
    expect(() =>
      applySettings(db, {
        framing: { splitBleedTolerancePermille: FRAMING_BOUNDS.splitBleedTolerancePermille.max + 1 },
      }),
    ).toThrow(InvalidSettingError)
    expect(() =>
      applySettings(db, {
        framing: { splitBleedSharePermille: FRAMING_BOUNDS.splitBleedSharePermille.max + 1 },
      }),
    ).toThrow(InvalidSettingError)
    expect(() =>
      applySettings(db, { framing: { sizeFloorPermille: FRAMING_BOUNDS.sizeFloorPermille.max + 1 } }),
    ).toThrow(InvalidSettingError)
  })

  it('ne recalcule rien : changer un défaut du cadrage ne touche aucun clip', () => {
    upsertProject(db, PROJECT)
    putClip(db, clip('clip_01', { status: 'kept' }))
    applySettings(db, { framing: { splitScreen: false } })
    expect(getClips(db, PROJECT.id).map((c) => c.status)).toEqual(['kept'])
  })
})

/**
 * **La grammaire du registre.** Le repérage ne porte que des entiers ; la
 * famille `ai` porte des chaînes, dont certaines contraintes à un ensemble
 * fermé ou tolérantes au vide (voir ci-dessus) ; `ingestion.copySourceLocally`
 * est le premier booléen à sortir de ce bloc pour aller vivre dans une vraie
 * famille, et la famille `hook` porte le premier type `color` — les deux
 * derniers types que ce fichier exerçait sans qu'une famille ne s'en serve.
 * Ces branches *sont* la généralisation — sans elles le registre n'est qu'une
 * table d'entiers déguisée —, et elles ont été écrites et tenues ici pendant
 * tout le temps où aucune famille ne les empruntait. C'est ce qui a fait
 * qu'ajouter ces réglages-là n'a demandé aucune validation nouvelle.
 */
describe('la grammaire du registre', () => {
  const field = (
    type: SettingField['type'],
    remaining: Partial<SettingField> = {},
  ): SettingField => ({
    family: 'selection',
    name: 'temoin',
    type,
    defaultValue: type === 'integer' ? 1 : type === 'text' ? 'a' : false,
    ...remaining,
  })

  it('relit un entier, et rien qui lui ressemble', () => {
    const c = field('integer', { min: 1 })
    expect(parseSetting(c, ' 4 ')).toBe(4)
    // `parseInt` lirait 4 dans « 4.5 » et 7 dans « 7abc » : une saisie à moitié
    // comprise est pire que refusée, personne ne peut deviner ce qui s'applique.
    for (const raw of ['', 'sept', '4.5', '7abc', '0x10', '-3', '0']) {
      expect(parseSetting(c, raw), raw).toBeUndefined()
    }
  })

  it('relit un booléen écrit en toutes lettres, et rien d’autre', () => {
    const c = field('boolean')
    expect(parseSetting(c, 'true')).toBe(true)
    expect(parseSetting(c, 'false')).toBe(false)
    for (const raw of ['1', '0', 'oui', 'TRUE', '']) {
      expect(parseSetting(c, raw), raw).toBeUndefined()
    }
  })

  it('relit un texte tel quel', () => {
    expect(parseSetting(field('text'), 'http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
  })

  it('valide chaque type sans convertir d’un type à l’autre', () => {
    expect(validateSetting(field('integer', { min: 0 }), 0)).toBe(0)
    expect(validateSetting(field('boolean'), true)).toBe(true)
    expect(validateSetting(field('text'), 'gemma4:26b')).toBe('gemma4:26b')

    expect(() => validateSetting(field('integer', { min: 1 }), '4')).toThrow()
    expect(() => validateSetting(field('boolean'), 'true')).toThrow()
    expect(() => validateSetting(field('boolean'), 1)).toThrow()
    expect(() => validateSetting(field('text'), 42)).toThrow()
    // Un texte vide ou fait de blancs n'est pas un réglage, c'est un champ oublié.
    expect(() => validateSetting(field('text'), '   ')).toThrow()
    expect(() => validateSetting(field('text'), 'x'.repeat(4_096))).toThrow()
  })

  /** Écriture et lecture appliquent la même règle, sinon l'aller-retour ment. */
  it('fait l’aller-retour sur les trois types', () => {
    for (const [c, value] of [
      [field('integer', { min: 0 }), 12],
      [field('boolean'), false],
      [field('text'), 'llama3'],
    ] as const) {
      const stored = String(validateSetting(c, value))
      expect(parseSetting(c, stored)).toBe(value)
    }
  })

  /**
   * **`color`, le quatrième type.** Format `#RRGGBB`, normalisé en majuscules
   * à la lecture comme à l'écriture — jamais un `pattern` générique posé à
   * côté, voir la doc de `SettingFieldType`.
   */
  describe('le type color', () => {
    const c = field('color', { defaultValue: '#000000' })

    it('accepte une couleur minuscule et la normalise en majuscules', () => {
      expect(parseSetting(c, '#a1b2c3')).toBe('#A1B2C3')
      expect(validateSetting(c, '#a1b2c3')).toBe('#A1B2C3')
    })

    it('refuse une couleur sans #', () => {
      expect(parseSetting(c, 'a1b2c3')).toBeUndefined()
      expect(() => validateSetting(c, 'a1b2c3')).toThrow(InvalidSettingError)
    })

    it('refuse des chiffres hexadécimaux invalides', () => {
      expect(parseSetting(c, '#GG0000')).toBeUndefined()
      expect(() => validateSetting(c, '#GG0000')).toThrow(InvalidSettingError)
    })

    it('refuse une forme abrégée à trois chiffres', () => {
      expect(parseSetting(c, '#abc')).toBeUndefined()
      expect(() => validateSetting(c, '#abc')).toThrow(InvalidSettingError)
    })

    it('fait l’aller-retour, majuscules comprises', () => {
      const stored = String(validateSetting(c, '#ffe500'))
      expect(stored).toBe('#FFE500')
      expect(parseSetting(c, stored)).toBe('#FFE500')
    })
  })

  /**
   * **`max`, le plafond entier — sémantiques opposées, comme `min`.**
   * `parseSetting` ignore une valeur au-delà comme il ignore déjà une valeur
   * en-deçà du plancher ; `validateSetting` lève, parce que quelqu'un attend
   * une réponse.
   */
  describe('le plafond max', () => {
    const c = field('integer', { min: 0, max: 10 })

    it('accepte la borne elle-même', () => {
      expect(parseSetting(c, '10')).toBe(10)
      expect(validateSetting(c, 10)).toBe(10)
    })

    it('parseSetting ignore une valeur au-delà, comme une valeur en-deçà du plancher', () => {
      expect(parseSetting(c, '11')).toBeUndefined()
    })

    it('validateSetting lève au-delà, là où parseSetting se tait', () => {
      expect(() => validateSetting(c, 11)).toThrow(InvalidSettingError)
    })

    it('un champ sans max n’a pas de plafond', () => {
      const unbounded = field('integer', { min: 0 })
      expect(parseSetting(unbounded, '999999')).toBe(999999)
      expect(validateSetting(unbounded, 999999)).toBe(999999)
    })
  })
})

describe('appliquerRéglages', () => {
  it('écrit plusieurs champs d’un coup et rend les réglages résultants', () => {
    const result = applySettings(db, {
      selection: { minutesPerClip: 4, maximumClips: 12 },
    })
    expect(result.selection.minutesPerClip).toBe(4)
    expect(result.selection.maximumClips).toBe(12)
    // Les champs non touchés ressortent à leur valeur effective, pas absents :
    // l'écran affiche ce qui s'applique.
    expect(result.selection.windowsPerClip).toBe(DEFAULT_SELECTION_DIMENSIONS.windowsPerClip)
  })

  it('refuse une clé inconnue', () => {
    expect(() => applySettings(db, { selection: { minutesParClipe: 4 } })).toThrow(
      InvalidSettingError,
    )
  })

  it('refuse une famille inconnue', () => {
    // `hook` est une vraie famille depuis cette PR (§6.3) : le témoin d'une
    // famille inconnue doit porter un nom que le registre n'a jamais eu, et
    // rester en anglais comme tout code neuf (`CLAUDE.md`).
    expect(() => applySettings(db, { unknownFamily: { unknownField: 2 } })).toThrow(/inconnu/i)
  })

  /**
   * **Y compris vide.** Contrôler le champ suffisait tant que le patch en
   * portait un : `{ unknownFamily: {} }` ne déclenchait aucun tour de boucle,
   * donc aucun contrôle, et la route répondait 200 sur une famille qui
   * n'existe pas. (relevé par Codex)
   */
  it('refuse une famille inconnue même sans aucun champ', () => {
    expect(() => applySettings(db, { unknownFamily: {} })).toThrow(InvalidSettingError)
    // Et une famille connue vide reste acceptée : elle ne demande rien.
    expect(applySettings(db, { selection: {} }).selection).toEqual(DEFAULT_SELECTION_DIMENSIONS)
  })

  it('refuse une valeur hors bornes', () => {
    expect(() => applySettings(db, { selection: { minutesPerClip: 0 } })).toThrow(
      InvalidSettingError,
    )
    expect(() => applySettings(db, { selection: { windowsPerClip: -1 } })).toThrow()
    expect(() => applySettings(db, { selection: { minimumClips: 2.5 } })).toThrow()
  })

  it('refuse une valeur du mauvais type sans la convertir', () => {
    // `"4"` n'est pas 4 : accepter la chaîne ferait passer `"4abc"` par le même
    // chemin le jour où quelqu'un remplacerait le contrôle par un `Number()`.
    expect(() => applySettings(db, { selection: { minutesPerClip: '4' } })).toThrow()
    expect(() => applySettings(db, { selection: { minutesPerClip: null } })).toThrow()
    expect(() => applySettings(db, { selection: { minutesPerClip: true } })).toThrow()
  })

  it('refuse un corps qui n’est pas un objet de familles', () => {
    for (const body of [null, 42, 'selection', [], { selection: 4 }, { selection: [] }]) {
      expect(() => applySettings(db, body)).toThrow(InvalidSettingError)
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
      applySettings(db, { selection: { minutesPerClip: 4, windowsPerClip: 0 } }),
    ).toThrow()
    expect(getSettings(db)).toEqual(DEFAULT_SELECTION_DIMENSIONS)
  })

  it('accepte un patch vide sans rien changer', () => {
    expect(applySettings(db, {}).selection).toEqual(DEFAULT_SELECTION_DIMENSIONS)
    expect(applySettings(db, { selection: {} }).selection).toEqual(DEFAULT_SELECTION_DIMENSIONS)
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 })
  })

  it('ne touche à aucune émission : changer un réglage ne recalcule rien', () => {
    // Le §11 du retour d'usage, tenu par un test plutôt que par une intention :
    // « toute modification d'un paramètre global ne doit pas silencieusement
    // recalculer des émissions existantes ».
    upsertProject(db, PROJECT)
    putClip(db, clip('clip_01', { status: 'kept' }))
    applySettings(db, { selection: { minutesPerClip: 4 } })
    expect(getClips(db, PROJECT.id).map((c) => c.status)).toEqual(['kept'])
  })

  it('rend la même chose que réglagesEffectifs', () => {
    applySettings(db, { selection: { minimumClips: 9 } })
    // **`ai` aussi**, depuis la PR C : `effectiveSettings` rend les deux
    // familles, `getSettings` ne projette que `selection`. Le résultat est
    // comparé aux défauts de la famille — inchangée par ce patch, qui ne
    // touche que `selection` — plutôt qu'à lui-même, ce qui ne testerait rien.
    expect(effectiveSettings(db)).toEqual({
      selection: getSettings(db),
      ai: {
        selectionProvider: 'gemini',
        selectionModel: 'gemini-3.1-flash-lite',
        correctionProvider: 'gemini',
        correctionModel: 'gemini-3.1-flash-lite',
        hookProvider: 'gemini',
        hookModel: 'gemini-3.1-flash-lite',
        ollamaBaseUrl: '',
      },
      ingestion: { copySourceLocally: true },
      hook: { ...HOOK_DEFAULTS },
      publication: { instagram: 'auto', facebook: 'auto', tiktok: 'auto', youtube: 'auto' },
      framing: { ...FRAMING_SETTINGS_DEFAULTS },
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
    const reread = getClip(db, 'clip_07')
    expect(reread?.captions).toBe(false)
    expect(reread?.branding).toBe(true)
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
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT.id)
    expect(getClips(db, PROJECT.id)).toEqual([])
  })
})

/**
 * Le hook sur un clip (retour d'usage §7) : `hookText` et `hookStyle`, la
 * surcharge par clip des treize défauts globaux.
 */
describe('le hook sur un clip', () => {
  it('font l’aller-retour, texte et style compris', () => {
    const c = clip('clip_07', { hookText: 'Une accroche', hookStyle: { sizePermille: 150 } })
    putClip(db, c)
    expect(getClip(db, 'clip_07')).toEqual(c)
  })

  // **Le badge est du contenu, pas du style** : il vit dans sa propre colonne
  // à côté de `hookText`, pas dans le JSON de `hookStyle`. L'aller-retour doit
  // donc le rendre tel quel, et `putClip` l'écrire aux TROIS endroits de
  // l'`INSERT` — c'est le troisième, l'`ON CONFLICT DO UPDATE`, que ce test
  // attrape en réécrivant un clip déjà en base.
  it('le badge fait l’aller-retour, y compris en réécriture', () => {
    putClip(db, clip('clip_07', { hookBadge: 'DÉFI 10' }))
    expect(getClip(db, 'clip_07')?.hookBadge).toBe('DÉFI 10')

    putClip(db, clip('clip_07', { hookBadge: 'DÉFI 11' }))
    expect(getClip(db, 'clip_07')?.hookBadge).toBe('DÉFI 11')
  })

  it('un badge vide reste vide, il ne devient pas nul', () => {
    putClip(db, clip('clip_07', { hookBadge: '' }))
    expect(getClip(db, 'clip_07')?.hookBadge).toBe('')
  })

  it('`{}` reste distinct d’une surcharge qui vaudrait le même que le défaut', () => {
    // §7 : les deux doivent rester distincts. `{}` dit « aux valeurs
    // globales », `{ sizePermille: 90 }` dit « j'ai surchargé, et c'est la
    // même valeur » — l'un ne doit jamais se réduire à l'autre à l'aller-retour.
    putClip(db, clip('sans-surcharge', { hookStyle: {} }))
    putClip(db, clip('avec-surcharge', { hookStyle: { sizePermille: 90 } }))
    expect(getClip(db, 'sans-surcharge')?.hookStyle).toEqual({})
    expect(getClip(db, 'avec-surcharge')?.hookStyle).toEqual({ sizePermille: 90 })
  })

  it('un hookStyle illisible retombe sur `{}`, sans rendre le clip illisible', () => {
    putClip(db, clip('clip_07'))
    db.prepare('UPDATE clips SET hookStyle = ? WHERE id = ?').run('{pas du json', 'clip_07')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reread = getClip(db, 'clip_07')
    expect(reread?.hookStyle).toEqual({})
    // Le reste du clip reste lisible : une colonne abîmée ne doit pas coûter
    // le clip entier.
    expect(reread?.title).toBe('La vanne du chapeau')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('un hookStyle dont une clé est hors bornes retombe sur `{}`, sans avertissement', () => {
    // Contrairement à l'échec de `JSON.parse` ci-dessus : la forme est un
    // JSON valide, seule une valeur ne respecte pas le schéma. Même partage
    // que `lireTokens` pour `seqs` : silencieux, parce que ce n'est pas une
    // colonne corrompue, c'est une valeur qui ne passe plus la validation.
    putClip(db, clip('clip_07'))
    db.prepare('UPDATE clips SET hookStyle = ? WHERE id = ?').run(
      JSON.stringify({ sizePermille: 9999 }),
      'clip_07',
    )
    expect(getClip(db, 'clip_07')?.hookStyle).toEqual({})
  })

  it('une clé inconnue dans hookStyle retombe sur `{}`', () => {
    putClip(db, clip('clip_07'))
    db.prepare('UPDATE clips SET hookStyle = ? WHERE id = ?').run(
      JSON.stringify({ unknownField: true }),
      'clip_07',
    )
    expect(getClip(db, 'clip_07')?.hookStyle).toEqual({})
  })

  it('une clé inconnue mêlée à une clé valide fait retomber tout l’objet sur `{}`', () => {
    // Un schéma non strict (`z.object` plutôt que `z.strictObject`) tronquerait
    // silencieusement la clé inconnue et garderait `sizePermille`, exactement
    // le comportement partiel que les deux tests ci-dessus refusent pour une
    // valeur hors bornes ou une clé seule : la relecture doit se comporter en
    // tout ou rien, pas en filtrage clé par clé. (relevé par Copilot)
    putClip(db, clip('clip_07'))
    db.prepare('UPDATE clips SET hookStyle = ? WHERE id = ?').run(
      JSON.stringify({ sizePermille: 150, unknownField: true }),
      'clip_07',
    )
    expect(getClip(db, 'clip_07')?.hookStyle).toEqual({})
  })
})

/**
 * La surcharge de cadrage sur un clip (issue #180, seconde moitié) — même
 * patron que `le hook sur un clip` juste au-dessus, `readFramingStyle` étant
 * bâtie sur le même contrat que `readHookStyle`.
 */
describe('la surcharge de cadrage sur un clip', () => {
  it('fait l’aller-retour', () => {
    const c = clip('clip_07', { framingStyle: { splitScreen: false, sizeFloorPermille: 250 } })
    putClip(db, c)
    expect(getClip(db, 'clip_07')).toEqual(c)
  })

  it('`{}` reste distinct d’une surcharge qui vaudrait le même que le défaut', () => {
    putClip(db, clip('sans-surcharge', { framingStyle: {} }))
    putClip(db, clip('avec-surcharge', { framingStyle: { splitScreen: true } }))
    expect(getClip(db, 'sans-surcharge')?.framingStyle).toEqual({})
    expect(getClip(db, 'avec-surcharge')?.framingStyle).toEqual({ splitScreen: true })
  })

  it('un framingStyle illisible retombe sur `{}`, et se dit', () => {
    putClip(db, clip('clip_07'))
    db.prepare('UPDATE clips SET framingStyle = ? WHERE id = ?').run('{pas du json', 'clip_07')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reread = getClip(db, 'clip_07')
    expect(reread?.framingStyle).toEqual({})
    expect(reread?.title).toBe('La vanne du chapeau')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('un framingStyle dont une clé est hors bornes retombe sur `{}`, sans avertissement', () => {
    putClip(db, clip('clip_07'))
    db.prepare('UPDATE clips SET framingStyle = ? WHERE id = ?').run(
      JSON.stringify({ sizeFloorPermille: 9999 }),
      'clip_07',
    )
    expect(getClip(db, 'clip_07')?.framingStyle).toEqual({})
  })

  it('une clé inconnue dans framingStyle retombe sur `{}`', () => {
    putClip(db, clip('clip_07'))
    db.prepare('UPDATE clips SET framingStyle = ? WHERE id = ?').run(
      JSON.stringify({ unknownField: true }),
      'clip_07',
    )
    expect(getClip(db, 'clip_07')?.framingStyle).toEqual({})
  })

  it('une clé inconnue mêlée à une clé valide fait retomber tout l’objet sur `{}`', () => {
    // Même contrôle que pour `hookStyle` : `z.object` tronquerait
    // silencieusement la clé inconnue et garderait `sizeFloorPermille`.
    putClip(db, clip('clip_07'))
    db.prepare('UPDATE clips SET framingStyle = ? WHERE id = ?').run(
      JSON.stringify({ sizeFloorPermille: 200, unknownField: true }),
      'clip_07',
    )
    expect(getClip(db, 'clip_07')?.framingStyle).toEqual({})
  })
})

describe('replaceClips', () => {
  it('remplace le jeu entier, et non seulement ce qu’on lui donne', () => {
    replaceClips(db, PROJECT.id, [clip('a'), clip('b')])
    replaceClips(db, PROJECT.id, [clip('c')])
    expect(getClips(db, PROJECT.id).map((c) => c.id)).toEqual(['c'])
  })

  // Le cas qu'un appelant atteint par accident : `mergeCandidates` sur un lot
  // vide et un projet sans décision humaine rend une liste vide. (relevé par
  // Aristarque)
  it('vide le projet quand on ne lui donne rien', () => {
    replaceClips(db, PROJECT.id, [clip('a'), clip('b')])
    replaceClips(db, PROJECT.id, [])
    expect(getClips(db, PROJECT.id)).toEqual([])
  })

  it('refuse un clip d’un autre projet', () => {
    expect(() => replaceClips(db, PROJECT.id, [clip('a', { projectId: 'autre' })])).toThrow()
  })

  // Sans ce contrôle, l'`ON CONFLICT` écrase le premier par le second et
  // l'appelant croit avoir écrit deux clips. (relevé par Aristarque)
  it('refuse deux fois le même id dans un seul lot', () => {
    expect(() => replaceClips(db, PROJECT.id, [clip('a'), clip('a')])).toThrow(/deux fois/)
  })

  // Un identifiant de clip est unique pour toute la base — la spec §12 expose
  // `GET /api/clips/:id` sans projet dans le chemin. L'upsert rattrapait la
  // collision en déplaçant le clip d'un projet à l'autre, ce qui détruisait le
  // travail du premier. (relevé par Codex, Copilot et Aristarque)
  it('refuse de déménager un identifiant déjà pris par un autre projet', () => {
    upsertProject(db, { ...PROJECT, id: 'autre-emission' })
    putClip(db, clip('clip_07'))

    expect(() =>
      replaceClips(db, 'autre-emission', [clip('clip_07', { projectId: 'autre-emission' })]),
    ).toThrow(/appartient au projet/)

    // Et le clip d'origine est intact : la transaction a tout annulé.
    expect(getClip(db, 'clip_07')?.projectId).toBe(PROJECT.id)
    expect(getClips(db, PROJECT.id)).toHaveLength(1)
  })

  // L'enchaînement réel de la tâche 9 : la fusion décide, la base enregistre.
  // Une passe de repérage ne doit pas ressusciter ce qu'un humain vient
  // d'écarter (spec §5).
  it('enregistre une passe de repérage sans ressusciter un clip écarté', () => {
    replaceClips(db, PROJECT.id, [
      clip('gardé', { status: 'kept' }),
      clip('écarté', { status: 'discarded' }),
      clip('périmé', { status: 'candidate' }),
    ])

    const merge = mergeCandidates(
      getClips(db, PROJECT.id),
      [clip('écarté'), clip('neuf')],
      2,
    )
    replaceClips(db, PROJECT.id, merge)

    const reread = getClips(db, PROJECT.id)
    expect(reread.map((c) => c.id).sort()).toEqual(['gardé', 'neuf', 'écarté'].sort())
    expect(reread.find((c) => c.id === 'écarté')?.status).toBe('discarded')
    expect(reread.find((c) => c.id === 'neuf')?.pass).toBe(2)
  })

  // `publications.clipId` porte `ON DELETE CASCADE` : sans relevé avant le
  // `DELETE FROM clips`, une passe de repérage qui ressort le même clip sous
  // le même identifiant effacerait aussi son état `published`, permettant une
  // republication sans `force`. (relevé par Copilot)
  it('conserve les publications d’un clip qui survit à une nouvelle passe de repérage', () => {
    replaceClips(db, PROJECT.id, [clip('survivant'), clip('écarté')])
    upsertPublication(db, {
      clipId: 'survivant',
      platform: 'youtube',
      status: 'published',
      remoteId: 'v1',
      remoteUrl: 'https://youtube.test/v1',
      requestId: null,
      error: null,
      publishedFingerprint: 'abc',
      createdAt: 1000,
      updatedAt: 1000,
    })

    replaceClips(db, PROJECT.id, [clip('survivant'), clip('neuf')])

    expect(getPublications(db, 'survivant')).toEqual([
      expect.objectContaining({ platform: 'youtube', status: 'published', remoteId: 'v1' }),
    ])
  })

  it('n’imagine pas de publications pour un clip qui n’en a jamais eu', () => {
    replaceClips(db, PROJECT.id, [clip('a')])
    replaceClips(db, PROJECT.id, [clip('a'), clip('b')])
    expect(getPublications(db, 'a')).toEqual([])
    expect(getPublications(db, 'b')).toEqual([])
  })
})

describe('sur un vrai fichier', () => {
  let folder: string

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-db-'))
  })

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true })
  })

  it('crée le dossier manquant et retrouve les données à la réouverture', () => {
    const file = path.join(folder, 'profond', 'avolo.db')
    const first = openDb(file)
    upsertProject(first, PROJECT)
    putClip(first, clip('clip_07'))
    first.close()

    const second = openDb(file)
    expect(getClip(second, 'clip_07')?.title).toBe('La vanne du chapeau')
    second.close()
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
    expect(putClipOrdered(db, clip('survivant', { title: 'Récent' }), ['title'], 100)?.applied).toBe(
      true,
    )

    replaceClips(db, PROJECT.id, [clip('survivant'), clip('nouveau')])

    // Le jeton a survécu : une écriture plus ancienne se fait toujours écarter.
    const stale = putClipOrdered(db, clip('survivant', { title: 'Ancien' }), ['title'], 50)
    expect(stale?.applied).toBe(false)
    // Et un clip que la passe vient de créer n'a rien à opposer à personne.
    expect(putClipOrdered(db, clip('nouveau', { title: 'Neuf' }), ['title'], 1)?.applied).toBe(true)
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
  let file: string
  let root: string

  /** Le schéma d'avant : ni `seqs`, ni son prédécesseur `seq`. */
  const SCHEMA_OLD = `
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-migration-'))
    file = path.join(root, 'avolo.db')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function poserBaseOld(columnSeq: boolean): void {
    const old = new Database(file)
    old.exec(SCHEMA_OLD)
    if (columnSeq) old.exec('ALTER TABLE clips ADD COLUMN seq INTEGER NOT NULL DEFAULT 0')
    old
      .prepare(
        `INSERT INTO projects (id, sourcePath, stagedPath, durationSec, sizeBytes, mtimeMs, createdAt)
         VALUES (@id, @sourcePath, @stagedPath, @durationSec, @sizeBytes, @mtimeMs, @createdAt)`,
      )
      .run(PROJECT)
    old
      .prepare(
        `INSERT INTO clips (id, projectId, segments, ratio, cropX, captions, branding,
                            title, description, status, pass)
         VALUES ('vieux', @p, '[{"start":10,"end":20}]', '1:1', 0.5, 1, 1,
                 'Un titre d''avant', 'Une description', 'kept', 1)`,
      )
      .run({ p: PROJECT.id })
    old.close()
  }

  it('ajoute `seqs` sans toucher aux clips déjà écrits', () => {
    poserBaseOld(false)

    const db = openDb(file)
    const columns = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns).toContain('seqs')
    // Le défaut compte autant que la colonne : sans lui, la première comparaison
    // porterait sur `null` et écarterait des écritures parfaitement fraîches.
    expect(db.prepare('SELECT seqs FROM clips WHERE id = ?').get('vieux')).toEqual({ seqs: '{}' })

    const old = getClip(db, 'vieux')
    expect(old?.title).toBe("Un titre d'avant")
    expect(old?.segments).toEqual([{ start: 10, end: 20 }])
    db.close()
  })

  it('ajoute `hookText` et `hookStyle` à une base qui ne les porte pas', () => {
    poserBaseOld(false)

    const db = openDb(file)
    const columns = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns).toContain('hookText')
    expect(columns).toContain('hookStyle')
    expect(
      db.prepare('SELECT hookText, hookStyle FROM clips WHERE id = ?').get('vieux'),
    ).toEqual({ hookText: '', hookStyle: '{}' })

    const old = getClip(db, 'vieux')
    expect(old?.hookText).toBe('')
    expect(old?.hookStyle).toEqual({})
    db.close()
  })

  it('ajoute `hookBadge` à une base qui ne le porte pas', () => {
    poserBaseOld(false)

    const db = openDb(file)
    const columns = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns).toContain('hookBadge')
    expect(db.prepare('SELECT hookBadge FROM clips WHERE id = ?').get('vieux')).toEqual({
      hookBadge: '',
    })
    expect(getClip(db, 'vieux')?.hookBadge).toBe('')
    db.close()
  })

  it('ajoute `framingStyle` à une base qui ne le porte pas, sans toucher aux clips déjà écrits', () => {
    poserBaseOld(false)

    const db = openDb(file)
    const columns = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns).toContain('framingStyle')
    expect(db.prepare('SELECT framingStyle FROM clips WHERE id = ?').get('vieux')).toEqual({
      framingStyle: '{}',
    })

    const old = getClip(db, 'vieux')
    expect(old?.framingStyle).toEqual({})
    // Même contrôle que pour `seqs`/`hookText` juste au-dessus : une colonne
    // ajoutée ne doit rien réécrire de ce qui existait déjà.
    expect(old?.title).toBe("Un titre d'avant")
    expect(old?.segments).toEqual([{ start: 10, end: 20 }])
    db.close()
  })

  it('est idempotente sur `framingStyle` : une seconde ouverture ne fait rien', () => {
    poserBaseOld(false)
    openDb(file).close()

    const db = openDb(file)
    const columns = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns.filter((c) => c === 'framingStyle')).toHaveLength(1)
    db.close()
  })

  it('est idempotente sur `hookBadge` : une seconde ouverture ne fait rien', () => {
    poserBaseOld(false)
    openDb(file).close()

    const db = openDb(file)
    const columns = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns.filter((c) => c === 'hookBadge')).toHaveLength(1)
    db.close()
  })

  it('est idempotente sur `hookText`/`hookStyle` : une seconde ouverture ne fait rien', () => {
    poserBaseOld(false)
    openDb(file).close()

    const db = openDb(file)
    const columns = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns.filter((c) => c === 'hookText')).toHaveLength(1)
    expect(columns.filter((c) => c === 'hookStyle')).toHaveLength(1)
    db.close()
  })

  it('accepte une écriture ordonnée sur un clip d’avant la colonne', () => {
    poserBaseOld(false)

    const db = openDb(file)
    const old = getClip(db, 'vieux')
    expect(old).toBeDefined()
    // Aucun jeton en base : tout geste dépasse un champ absent, donc rien de ce
    // qui préexiste ne bloque la première écriture.
    const result = putClipOrdered(db, { ...old!, title: 'Après' }, ['title'], 5)
    expect(result?.applied).toBe(true)
    expect(getClip(db, 'vieux')?.title).toBe('Après')
    // Et le suivant, plus ancien, se fait écarter.
    expect(putClipOrdered(db, { ...old!, title: 'Encore avant' }, ['title'], 4)?.applied).toBe(
      false,
    )
    expect(getClip(db, 'vieux')?.title).toBe('Après')
    db.close()
  })

  it('laisse tomber `seq`, le prédécesseur par ligne', () => {
    poserBaseOld(true)

    const db = openDb(file)
    const columns = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns).toContain('seqs')
    // Une colonne morte au nom presque identique à celle qui compte est le pire
    // des deux mondes.
    expect(columns).not.toContain('seq')
    expect(getClip(db, 'vieux')?.title).toBe("Un titre d'avant")
    db.close()
  })

  it('est idempotente : deux ouvertures de suite ne se marchent pas dessus', () => {
    poserBaseOld(true)
    openDb(file).close()
    const db = openDb(file)
    expect(getClip(db, 'vieux')?.status).toBe('kept')
    db.close()
  })
})

/**
 * La traduction des cinq clés de la famille `selection` (issue #73), éprouvée
 * depuis une base **d'avant** — même défense que `migrer` juste au-dessus, et
 * pour la même raison : la rejouer sur une base ouverte par le code courant ne
 * prouve rien, elle n'a jamais porté les anciens noms.
 *
 * **Le cas qui compte est `clipsMaximum` à `0`.** C'est le seul champ dont le
 * défaut et la valeur significative sont différents de « rien de réglé » :
 * une migration qui perdrait la ligne ferait retomber `maximumClips` sur son
 * défaut, `0` aussi — silencieusement identique en apparence, alors qu'un
 * plafond réellement réglé à une autre valeur aurait disparu tout aussi
 * silencieusement. Le test choisit délibérément une valeur non nulle sur les
 * quatre autres champs pour qu'un défaut resurgi ne puisse pas se confondre
 * avec la valeur migrée.
 */
describe('migrateSelectionSettingKeys', () => {
  let file: string
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-migration-selection-'))
    file = path.join(root, 'avolo.db')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** Une base au schéma courant, dont les clés `selection.*` sont les anciennes. */
  function seedLegacySelectionSettings(values: Record<string, string>): void {
    openDb(file).close()
    const raw = new Database(file)
    const insert = raw.prepare('INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, 0)')
    for (const [field, value] of Object.entries(values)) {
      insert.run(`selection.${field}`, value)
    }
    raw.close()
  }

  it('migre les cinq clés en conservant leurs valeurs, `clipsMaximum` à zéro compris', () => {
    seedLegacySelectionSettings({
      minutesParClip: '9',
      fenetresParClip: '3',
      clipsMinimum: '4',
      fenetresMinimum: '12',
      clipsMaximum: '0',
    })

    const db = openDb(file)
    expect(getSettings(db)).toEqual({
      minutesPerClip: 9,
      windowsPerClip: 3,
      minimumClips: 4,
      minimumWindows: 12,
      maximumClips: 0,
    })

    // Les anciennes clés ne traînent pas : une base migrée deux fois, ou
    // relue à la main avec `sqlite3`, ne doit pas retrouver les deux noms.
    const remaining = db
      .prepare("SELECT key FROM settings WHERE key LIKE 'selection.%' ORDER BY key")
      .all() as { key: string }[]
    expect(remaining.map((r) => r.key)).toEqual([
      'selection.maximumClips',
      'selection.minimumClips',
      'selection.minimumWindows',
      'selection.minutesPerClip',
      'selection.windowsPerClip',
    ])
    db.close()
  })

  it('ne touche à rien sur une base qui ne porte déjà que les nouveaux noms', () => {
    const first = openDb(file)
    setSetting(first, 'minutesPerClip', 7)
    first.close()

    const db = openDb(file)
    expect(getSettings(db).minutesPerClip).toBe(7)
    db.close()
  })

  it('laisse la nouvelle clé faire autorité si les deux noms coexistent', () => {
    const first = openDb(file)
    setSetting(first, 'minutesPerClip', 5)
    first.close()
    const raw = new Database(file)
    raw
      .prepare('INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, 0)')
      .run('selection.minutesParClip', '99')
    raw.close()

    const db = openDb(file)
    // La valeur écrite sous le nouveau nom l'emporte : celle sous l'ancien
    // n'écrase rien, elle est simplement effacée.
    expect(getSettings(db).minutesPerClip).toBe(5)
    expect(
      db.prepare("SELECT key FROM settings WHERE key = 'selection.minutesParClip'").all(),
    ).toHaveLength(0)
    db.close()
  })

  it('est idempotente : deux ouvertures de suite ne se marchent pas dessus', () => {
    seedLegacySelectionSettings({ minutesParClip: '9' })
    openDb(file).close()
    const db = openDb(file)
    expect(getSettings(db).minutesPerClip).toBe(9)
    db.close()
  })
})

/**
 * `hook.size` a disparu le 20 août 2026 avec le hook en PNG : `sizePermille`
 * ne mesure plus la même chose (une fraction de la largeur du canevas, pas
 * une taille en unités de script ASS), donc la valeur ne se reporte pas —
 * contrairement à `migrateSelectionSettingKeys`, la clé est simplement
 * effacée et `HOOK_DEFAULTS.sizePermille` prend le relais.
 */
describe('migrateHookSizeSettingKey', () => {
  let file: string
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-migration-hook-size-'))
    file = path.join(root, 'avolo.db')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('efface `hook.size` sans écrire `hook.sizePermille`', () => {
    openDb(file).close()
    const raw = new Database(file)
    raw
      .prepare('INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, 0)')
      .run('hook.size', '72')
    raw.close()

    const db = openDb(file)
    expect(
      db.prepare("SELECT key FROM settings WHERE key LIKE 'hook.size%'").all(),
    ).toHaveLength(0)
    // La valeur d'hier n'a aucune correspondance dans la nouvelle échelle :
    // le défaut prend le relais, pas un report numérique qui aurait l'air
    // valide sans l'être.
    expect(effectiveSettings(db).hook.sizePermille).toBe(HOOK_DEFAULTS.sizePermille)
    db.close()
  })

  it('ne touche à rien sur une base qui ne porte pas `hook.size`', () => {
    const first = openDb(file)
    applySettings(first, { hook: { sizePermille: 150 } })
    first.close()

    const db = openDb(file)
    expect(effectiveSettings(db).hook.sizePermille).toBe(150)
    db.close()
  })

  it('est idempotente', () => {
    openDb(file).close()
    const raw = new Database(file)
    raw
      .prepare('INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, 0)')
      .run('hook.size', '72')
    raw.close()
    openDb(file).close()
    const db = openDb(file)
    expect(effectiveSettings(db).hook.sizePermille).toBe(HOOK_DEFAULTS.sizePermille)
    db.close()
  })
})

/**
 * Complément de la suite au-dessus, côté `clips` cette fois : la garantie
 * anti-perte de données que `migrateHookSizeClipColumn` annonce dans son
 * commentaire — un `hookStyle.size` de clip ne fait disparaître que `size`,
 * jamais les autres surcharges. Relevé par Copilot (PR #117, passe 3) : les
 * tests d'origine ne couvraient que `settings`, pas `clips`.
 */
describe('migrateHookSizeClipColumn', () => {
  let file: string
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-migration-hook-size-clip-'))
    file = path.join(root, 'avolo.db')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function seedClipWithLegacySize(): void {
    const first = openDb(file)
    upsertProject(first, PROJECT)
    putClip(first, clip('vieux-hook'))
    first.close()
    // `HOOK_STYLE_SCHEMA` est strict : passer par `putClip` rejetterait `size`
    // au lieu de le laisser en base comme le ferait une vraie base d'avant
    // cette PR. On écrit donc le JSON brut, comme la migration le lira.
    const raw = new Database(file)
    raw
      .prepare('UPDATE clips SET hookStyle = ? WHERE id = ?')
      .run(JSON.stringify({ size: 72, position: 'bottom' }), 'vieux-hook')
    raw.close()
  }

  it('efface seulement `size`, conserve les autres surcharges', () => {
    seedClipWithLegacySize()

    const db = openDb(file)
    const raw = db.prepare('SELECT hookStyle FROM clips WHERE id = ?').get('vieux-hook') as {
      hookStyle: string
    }
    expect(JSON.parse(raw.hookStyle)).toEqual({ position: 'bottom' })
    // Et le résultat est de nouveau lisible par le schéma strict — c'est
    // précisément ce qu'une clé `size` qui traîne empêchait.
    expect(getClip(db, 'vieux-hook')?.hookStyle).toEqual({ position: 'bottom' })
    db.close()
  })

  it('ne touche pas un clip sans `size`', () => {
    const first = openDb(file)
    upsertProject(first, PROJECT)
    putClip(first, clip('sans-size', { hookStyle: { position: 'bottom' } }))
    first.close()

    const db = openDb(file)
    expect(getClip(db, 'sans-size')?.hookStyle).toEqual({ position: 'bottom' })
    db.close()
  })

  it('est idempotente', () => {
    seedClipWithLegacySize()

    openDb(file).close()
    const db = openDb(file)
    expect(getClip(db, 'vieux-hook')?.hookStyle).toEqual({ position: 'bottom' })
    db.close()
  })
})

/**
 * Le seul objet de schéma en français (issue #73) : `clips_par_projet` devient
 * `clips_by_project`. Aucune donnée n'est portée par un index — `DROP` puis
 * `CREATE` suffit —, mais une base qui gardait encore l'ancien nom se
 * retrouverait avec les deux, l'un mort, sans qu'aucune erreur ne le signale.
 */
describe('l’index clips_by_project', () => {
  let file: string
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-migration-index-'))
    file = path.join(root, 'avolo.db')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function indexNames(base: BaseSqlite): string[] {
    return (
      base
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'clips'")
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      // Celui de la clé primaire, posé par SQLite lui-même : hors sujet ici.
      .filter((name) => !name.startsWith('sqlite_autoindex_'))
  }

  it('renomme `clips_par_projet` sans dupliquer l’index', () => {
    // Une base au schéma courant, sauf pour l'index : posé sous l'ancien nom,
    // comme l'aurait laissé une base ouverte avant cette PR.
    const first = openDb(file)
    first.close()
    const raw = new Database(file)
    raw.exec('DROP INDEX clips_by_project')
    raw.exec('CREATE INDEX clips_par_projet ON clips(projectId, pass, id)')
    raw.close()

    const db = openDb(file)
    expect(indexNames(db)).toEqual(['clips_by_project'])
    db.close()
  })

  it('ne touche à rien sur une base qui porte déjà le nouveau nom', () => {
    const db = openDb(file)
    expect(indexNames(db)).toEqual(['clips_by_project'])
    db.close()
  })
})

/**
 * La table `publications` (`clipId`, `platform`) : posée par un `CREATE TABLE
 * IF NOT EXISTS`, sans entrée dans `migrer` — elle n'existait avant aucune
 * base, il n'y a donc rien à rattraper (`src/server/db.ts`, doctrine des
 * migrations).
 */
describe('la table publications', () => {
  function row(remaining: Partial<PublicationRow> = {}): PublicationRow {
    return {
      clipId: 'clip1',
      platform: 'instagram',
      status: 'in_progress',
      remoteId: null,
      remoteUrl: null,
      requestId: null,
      error: null,
      publishedFingerprint: null,
      createdAt: 1000,
      updatedAt: 1000,
      ...remaining,
    }
  }

  it('existe sur une base fraîche', () => {
    const blank = openDb(':memory:')
    try {
      const tables = blank
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['publications']))
    } finally {
      blank.close()
    }
  })

  it('existe aussi sur une base déjà ouverte avant cette PR', () => {
    // `openDb` applique `SCHEMA` à chaque ouverture : rouvrir une base qui
    // l'a déjà appliquée une fois est exactement ce cas-là, `CREATE TABLE IF
    // NOT EXISTS` ne rejouant rien sur une table déjà là.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-publications-migration-'))
    const file = path.join(root, 'avolo.db')
    try {
      openDb(file).close()
      const reopened = openDb(file)
      try {
        upsertProject(reopened, PROJECT)
        putClip(reopened, clip('clip-old'))
        upsertPublication(reopened, row({ clipId: 'clip-old' }))
        expect(getPublications(reopened, 'clip-old')).toHaveLength(1)
      } finally {
        reopened.close()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('pose une ligne et la relit', () => {
    putClip(db, clip('clip1'))
    upsertPublication(db, row())
    expect(getPublications(db, 'clip1')).toEqual([row()])
  })

  it('met à jour sans dupliquer la ligne, et sans réécrire `createdAt`', () => {
    putClip(db, clip('clip1'))
    upsertPublication(db, row({ createdAt: 1000, updatedAt: 1000 }))
    upsertPublication(
      db,
      row({ status: 'published', remoteId: 'p1', remoteUrl: 'https://x.test/p1', createdAt: 9999, updatedAt: 2000 }),
    )
    const rows = getPublications(db, 'clip1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(
      row({ status: 'published', remoteId: 'p1', remoteUrl: 'https://x.test/p1', createdAt: 1000, updatedAt: 2000 }),
    )
  })

  it('porte une ligne par plateforme, indépendamment', () => {
    putClip(db, clip('clip1'))
    upsertPublication(db, row({ platform: 'instagram', status: 'published' }))
    upsertPublication(db, row({ platform: 'tiktok', status: 'failed', error: 'quota atteint' }))
    const rows = getPublications(db, 'clip1')
    expect(rows.map((r) => r.platform)).toEqual(['instagram', 'tiktok'])
  })

  it('supprime les publications quand le clip est supprimé — la cascade est voulue', () => {
    putClip(db, clip('clip1'))
    upsertPublication(db, row())
    expect(getPublications(db, 'clip1')).toHaveLength(1)

    // `replaceClips` avec une liste vide retire tous les clips du projet ; le
    // clip et sa publication disparaissent ensemble, `foreign_keys = ON`
    // faisant le reste (`openDb`).
    replaceClips(db, PROJECT.id, [])
    expect(getClip(db, 'clip1')).toBeUndefined()
    expect(getPublications(db, 'clip1')).toEqual([])
  })
})
