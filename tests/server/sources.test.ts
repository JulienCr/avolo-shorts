import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SourcesListing } from '@/lib/api'
import { openDb, upsertProject } from '@/server/db'
import { editingFstype, listSources } from '@/server/sources'

/**
 * Le catalogue des replays, c'est-à-dire **l'entrée du parcours**.
 *
 * Ce qui se vérifie ici n'est pas qu'un `readdir` liste des fichiers, mais les
 * deux choses qui ont coûté quelque chose ailleurs : que le montage se juge par
 * un **accès réel avec délai de garde** — le Drive décroche de deux façons que
 * `/proc/mounts` ne distingue pas, dont une où le dossier se liste encore
 * pendant que le moindre accès au contenu suspend l'appelant sans limite — et
 * que « ce dossier est vide » ne se confonde jamais avec « ce montage n'a pas eu
 * lieu ». Les deux rendaient la même page dans OpenShorts (spec §12).
 */

describe('editingFstype', () => {
  const EDITS = [
    '/dev/sdd / ext4 rw,relatime 0 0',
    'none /mnt/wsl tmpfs rw,relatime 0 0',
    'drvfs /mnt/j 9p rw,noatime,trans=fd 0 0',
    'drvfs /mnt/jazz drvfs rw 0 0',
  ].join('\n')

  it('rend le type du montage qui porte le chemin', () => {
    expect(editingFstype(EDITS, '/mnt/j/Replay')).toBe('9p')
  })

  it('rend le type du montage lui-même', () => {
    expect(editingFstype(EDITS, '/mnt/j')).toBe('9p')
  })

  /**
   * Le plus long préfixe gagne : sans cela, `/` répondrait pour tout le monde et
   * le relevé dirait `ext4` sur un Drive monté en 9p.
   */
  it('retient le montage le plus profond, pas le premier venu', () => {
    expect(editingFstype(EDITS, '/home/julien')).toBe('ext4')
  })

  /**
   * `/mnt/jazz` n'est pas sous `/mnt/j`. Comparer les chaînes sans exiger une
   * frontière de segment ferait répondre `9p` pour un dossier qui n'y est pas.
   */
  it('ne confond pas deux montages dont l’un préfixe le nom de l’autre', () => {
    expect(editingFstype(EDITS, '/mnt/jazz/Replay')).toBe('drvfs')
  })

  /** `/proc/mounts` échappe les espaces en octal. Un dossier de replays en porte. */
  it('déséchappe les espaces du point de montage', () => {
    const withSpace = 'drvfs /mnt/mon\\040drive 9p rw 0 0'
    expect(editingFstype(withSpace, '/mnt/mon drive/Replay')).toBe('9p')
  })

  /**
   * Le noyau empile les montages : un point remonté par-dessus un autre apparaît
   * **après** lui, et c'est le dernier qui décrit ce qu'on atteint. Retenir le
   * premier ferait annoncer le type du montage recouvert.
   */
  it('retient le dernier montage d’un même point, celui qui recouvre', () => {
    const stacked = ['none /mnt/wsl tmpfs rw 0 0', 'drvfs /mnt/wsl 9p rw 0 0'].join('\n')
    expect(editingFstype(stacked, '/mnt/wsl/x')).toBe('9p')
  })

  it('rend null quand aucun montage ne porte le chemin', () => {
    expect(editingFstype('drvfs /mnt/j 9p rw 0 0', '/ailleurs')).toBeNull()
  })

  it('ignore une ligne qui n’a pas la forme attendue', () => {
    expect(editingFstype('bidon\n/dev/sdd / ext4 rw 0 0', '/x')).toBe('ext4')
  })
})

describe('listSources', () => {
  let root: string
  let replays: string
  let db: Database.Database
  const envStart = { ...process.env }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-sources-'))
    replays = path.join(root, 'Replay')
    fs.mkdirSync(replays, { recursive: true })
    process.env.REPLAY_DIR = replays
    process.env.STAGE_DIR = path.join(root, 'stage')
    process.env.PROJECTS_DIR = path.join(root, 'projects')
    db = openDb(':memory:')
  })

  afterEach(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
    process.env = { ...envStart }
  })

  function poserVideo(name: string, octets = 1_024): void {
    fs.writeFileSync(path.join(replays, name), Buffer.alloc(octets))
  }

  it('rend le nom, la taille et la date de chaque replay', async () => {
    poserVideo('2025-06-15-cqlp.mp4', 4_096)

    const listing = await listSources({ db })
    expect(listing.sources).toHaveLength(1)
    expect(listing.sources[0].name).toBe('2025-06-15-cqlp.mp4')
    expect(listing.sources[0].sizeBytes).toBe(4_096)
    expect(Date.parse(listing.sources[0].modifiedAt)).toBeGreaterThan(0)
  })

  /**
   * **Un nom de fichier, jamais un chemin.** C'est ce que `createProject`
   * attend, et c'est la même règle que pour `ProjectSummary` : un type d'API est
   * une promesse, et ce qu'il porte finit par sortir — ici, le point de montage
   * du Drive partagé.
   */
  it('ne publie aucun chemin du serveur', async () => {
    poserVideo('2025-06-15-cqlp.mp4')

    const listing = await listSources({ db })
    expect(JSON.stringify(listing.sources)).not.toContain(root)
  })

  it('écarte ce qui n’est pas une vidéo, et les compte quand même', async () => {
    poserVideo('2025-06-15-cqlp.mp4')
    fs.writeFileSync(path.join(replays, 'notes.txt'), 'rien à voir')
    fs.mkdirSync(path.join(replays, '2025-06-15-cqlp.avolo'))

    const listing = await listSources({ db })
    expect(listing.sources.map((s) => s.name)).toEqual(['2025-06-15-cqlp.mp4'])
    // Trois entrées dans le dossier : le relevé de montage les compte toutes,
    // parce qu'un dossier plein de fichiers illisibles n'est pas un dossier vide.
    expect(listing.editing.entries).toBe(3)
  })

  /**
   * **Un dossier adossé à un Drive porte des téléchargements partiels**, et ils
   * ont l'extension de leur destination : proposés, ils apparaîtraient comme des
   * vidéos cassées. La spec les écarte nommément (§ « Lister les sources »).
   * Ils restent comptés dans `entries` — un dossier plein de moignons n'est pas
   * un dossier vide, et c'est justement cette distinction qui porte le
   * diagnostic.
   */
  it('écarte les entrées cachées et celles en `$`, sans cesser de les compter', async () => {
    poserVideo('vraie.mp4')
    poserVideo('.com.google.Chrome.partiel.mp4')
    poserVideo('$RECYCLE.mp4')

    const listing = await listSources({ db })
    expect(listing.sources.map((s) => s.name)).toEqual(['vraie.mp4'])
    expect(listing.editing.entries).toBe(3)
  })

  it('reconnaît une vidéo quelle que soit la casse de son extension', async () => {
    poserVideo('EMISSION.MP4')

    expect((await listSources({ db })).sources.map((s) => s.name)).toEqual(['EMISSION.MP4'])
  })

  /**
   * `statWithDelay` fait un `lstat` pour la même raison : un lien qui pointe hors
   * de `REPLAY_DIR` ferait ingérer autre chose qu'un replay, et l'ingestion le
   * refuse. Le proposer ici mènerait droit à ce refus.
   */
  it('ignore un lien symbolique, que l’ingestion refuse de toute façon', async () => {
    poserVideo('vraie.mp4')
    fs.symlinkSync(path.join(replays, 'vraie.mp4'), path.join(replays, 'copie.mp4'))

    expect((await listSources({ db })).sources.map((s) => s.name)).toEqual(['vraie.mp4'])
  })

  it('trie les replays du plus récent au plus ancien', async () => {
    poserVideo('vieille.mp4')
    poserVideo('récente.mp4')
    fs.utimesSync(path.join(replays, 'vieille.mp4'), new Date(1_700_000_000_000), new Date(1_700_000_000_000))

    expect((await listSources({ db })).sources.map((s) => s.name)).toEqual([
      'récente.mp4',
      'vieille.mp4',
    ])
  })

  /**
   * Une source déjà analysée mène à son projet au lieu de relancer une création.
   * `createProject` est idempotent sur ce cas, mais proposer deux chemins vers le
   * même endroit sans le dire fait douter de ce qu'on vient de déclencher.
   */
  it('rattache une source au projet qu’elle a produit', async () => {
    poserVideo('2025-06-15-cqlp.mp4')
    poserVideo('2026-03-08-caro-mdlm.mp4')
    upsertProject(db, {
      id: '2025-06-15-cqlp',
      sourcePath: path.join(replays, '2025-06-15-cqlp.mp4'),
      stagedPath: null,
      durationSec: 5936,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    })

    const listing = await listSources({ db })
    const byName = new Map(listing.sources.map((s) => [s.name, s.projectId]))
    expect(byName.get('2025-06-15-cqlp.mp4')).toBe('2025-06-15-cqlp')
    expect(byName.get('2026-03-08-caro-mdlm.mp4')).toBeNull()
  })

  /**
   * **Un identifiant n'est pas une source.** `projectIdFromSource` retire
   * l'extension : `show.mp4` et `show.mov` donnent tous deux `show`. Rattacher
   * sur l'identifiant seul ferait mener la carte du MOV au projet du MP4 — une
   * autre vidéo —, alors que `createProject` refuse précisément cette paire par un
   * `ProjectErrorCollision`. La carte doit rester « à créer » : la création
   * répondra 409 avec le message qui nomme les deux fichiers, ce qui est un
   * cul-de-sac qui s'explique, là où un lien vers la mauvaise vidéo n'en est pas
   * un. (relevé par Codex et Copilot)
   */
  it('ne rattache pas une source à un projet né d’un autre fichier', async () => {
    poserVideo('show.mp4')
    poserVideo('show.mov')
    upsertProject(db, {
      id: 'show',
      sourcePath: path.join(replays, 'show.mp4'),
      stagedPath: null,
      durationSec: 100,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    })

    const byName = new Map((await listSources({ db })).sources.map((s) => [s.name, s.projectId]))
    expect(byName.get('show.mp4')).toBe('show')
    expect(byName.get('show.mov')).toBeNull()
  })

  /**
   * **Le vide et l'absence sont deux pages différentes**, et les confondre est un
   * défaut de diagnostic : l'un se répare en déposant un fichier, l'autre en
   * rouvrant le lecteur côté Windows.
   */
  it('distingue un dossier vide d’un montage absent — le dossier vide', async () => {
    const listing = await listSources({ db })
    expect(listing.sources).toEqual([])
    expect(listing.editing.available).toBe(true)
    expect(listing.editing.cause).toBeNull()
    expect(listing.editing.entries).toBe(0)
  })

  it('distingue un dossier vide d’un montage absent — le montage absent', async () => {
    fs.rmSync(replays, { recursive: true, force: true })

    const listing = await listSources({ db })
    expect(listing.sources).toEqual([])
    expect(listing.editing.available).toBe(false)
    expect(listing.editing.cause).toBe('absent')
    expect(listing.editing.entries).toBe(0)
  })

  /**
   * **Le mode d'échec à fermer.** Monté avec son transport mort dessous, le
   * Drive ne répond rien du tout et suspend l'appelant sans limite de temps :
   * `/proc/mounts` ne le distingue pas d'un montage sain, et les bits de
   * permission répondent oui aux deux. Seul un accès réel, avec délai de garde,
   * tranche.
   */
  it('renonce sur un montage muet au lieu d’attendre indéfiniment', async () => {
    const listing = await listSources({
      db,
      timeoutMs: 20,
      capture: () => new Promise(() => {}),
    })
    expect(listing.editing.available).toBe(false)
    expect(listing.editing.cause).toBe('silent')
    expect(listing.sources).toEqual([])
  })

  /**
   * **Quatre causes, quatre noms** (issue #56, point 5). Tant que
   * `captureWithGuard` les collapsait, l'écran devait énumérer les trois gestes
   * possibles — vérifier le chemin, vérifier les droits, remonter le partage —
   * là où le serveur en connaissait un seul.
   *
   * L'erreur porte un `code` d'`errno` ; le code d'échec publié, lui, est un mot
   * énuméré. Ce dépôt est public, et la valeur part sur le réseau.
   */
  it.each([
    ['ENOENT', 'absent'],
    ['ENOTDIR', 'absent'],
    ['ENAMETOOLONG', 'absent'],
    ['EACCES', 'denied'],
    ['EPERM', 'denied'],
    ['EIO', 'unreadable'],
    ['ESTALE', 'unreadable'],
  ])('nomme la cause : %s donne « %s »', async (code, expected) => {
    const listing = await listSources({
      db,
      capture: () => {
        const error: NodeJS.ErrnoException = new Error('le message du système')
        error.code = code
        return Promise.reject(error)
      },
    })

    expect(listing.editing.available).toBe(false)
    expect(listing.editing.cause).toBe(expected)
  })

  it('range sous « unreadable » une erreur sans code plutôt que de deviner', async () => {
    const listing = await listSources({ db, capture: () => Promise.reject(new Error('boum')) })
    expect(listing.editing.cause).toBe('unreadable')
  })

  /**
   * **Le cas que l'issue #56 appelle « le diagnostic le plus trompeur
   * possible ».** `editingFstype` remonte au montage le plus profond qui
   * *contienne* le chemin : un `REPLAY_DIR` mal orthographié sous un partage 9p
   * parfaitement sain rend donc `disponible: false` **avec** `fstype: '9p'`. Sans
   * la cause, l'écran conclut au transport mort et envoie remonter un partage
   * qui répond ; avec elle, il dit « ce chemin n'existe pas ».
   */
  it('dit « absent », pas « muet », sur un REPLAY_DIR mal orthographié', async () => {
    process.env.REPLAY_DIR = path.join(replays, 'Repaly')

    const listing = await listSources({ db })
    expect(listing.editing.available).toBe(false)
    expect(listing.editing.cause).toBe('absent')
  })

  /**
   * Dans `captureFolder`, un `lstat` refusé sur **un seul fichier** fait
   * basculer tout le dossier. La bascule est voulue — un catalogue amputé
   * présenté comme complet est pire —, mais elle était muette : elle porte
   * maintenant `rejected`, ce qui envoie regarder les droits plutôt que le
   * partage. (second cas mesuré de l'issue #56)
   */
  it('nomme un droit refusé sur un seul fichier comme un refus, pas un silence', async () => {
    poserVideo('lisible.mp4')
    const lstat = vi.spyOn(fsp, 'lstat').mockImplementation(() => {
      const error: NodeJS.ErrnoException = new Error('permission denied')
      error.code = 'EACCES'
      return Promise.reject(error)
    })

    const listing = await listSources({ db })
    lstat.mockRestore()

    expect(listing.editing.available).toBe(false)
    expect(listing.editing.cause).toBe('denied')
  })

  /**
   * L'URL est **toujours** là, contrairement à celle d'un candidat : la source
   * existe, on vient de la mesurer. Ce qui peut manquer est l'image au bout.
   */
  it('donne à chaque source l’URL de sa vignette, encodée', async () => {
    poserVideo('2026-01-11-méchante.mp4')

    const [source] = (await listSources({ db })).sources
    expect(source.thumbnailUrl).toContain('file=2026-01-11-m%C3%A9chante.mp4')
    // La version fait changer l'URL quand le fichier change : sans elle, la
    // carte ne redemanderait jamais l'image d'un replay réenregistré.
    expect(source.thumbnailUrl).toContain(`v=${source.sizeBytes}-`)
  })

  /**
   * Le relevé de type reste lisible quand l'accès échoue : c'est justement là
   * qu'il sert. Un `ext4` là où on attend `9p` dit « ce montage n'a pas eu
   * lieu », et c'est la phrase que l'écran doit pouvoir écrire.
   */
  it('relève le type du système de fichiers même sans accès', async () => {
    fs.rmSync(replays, { recursive: true, force: true })

    const listing: SourcesListing = await listSources({ db })
    expect(listing.editing.fstype === null || typeof listing.editing.fstype === 'string').toBe(true)
  })
})
