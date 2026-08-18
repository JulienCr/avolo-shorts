import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import {
  getClip,
  getClips,
  getProject,
  listProjects,
  openDb,
  putClip,
  replaceClips,
  upsertProject,
  type Project,
} from '@/server/db'
import { mergeCandidates } from '@/core/candidates'
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

let db: BetterSqlite3.Database

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
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['clips', 'projects']))
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
