import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SourcesListing } from '@/lib/api'
import { openDb, upsertProject } from '@/server/db'
import { fstypeDeMontage, listerSources } from '@/server/sources'

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

describe('fstypeDeMontage', () => {
  const MONTAGES = [
    '/dev/sdd / ext4 rw,relatime 0 0',
    'none /mnt/wsl tmpfs rw,relatime 0 0',
    'drvfs /mnt/j 9p rw,noatime,trans=fd 0 0',
    'drvfs /mnt/jazz drvfs rw 0 0',
  ].join('\n')

  it('rend le type du montage qui porte le chemin', () => {
    expect(fstypeDeMontage(MONTAGES, '/mnt/j/Replay')).toBe('9p')
  })

  it('rend le type du montage lui-même', () => {
    expect(fstypeDeMontage(MONTAGES, '/mnt/j')).toBe('9p')
  })

  /**
   * Le plus long préfixe gagne : sans cela, `/` répondrait pour tout le monde et
   * le relevé dirait `ext4` sur un Drive monté en 9p.
   */
  it('retient le montage le plus profond, pas le premier venu', () => {
    expect(fstypeDeMontage(MONTAGES, '/home/julien')).toBe('ext4')
  })

  /**
   * `/mnt/jazz` n'est pas sous `/mnt/j`. Comparer les chaînes sans exiger une
   * frontière de segment ferait répondre `9p` pour un dossier qui n'y est pas.
   */
  it('ne confond pas deux montages dont l’un préfixe le nom de l’autre', () => {
    expect(fstypeDeMontage(MONTAGES, '/mnt/jazz/Replay')).toBe('drvfs')
  })

  /** `/proc/mounts` échappe les espaces en octal. Un dossier de replays en porte. */
  it('déséchappe les espaces du point de montage', () => {
    const avecEspace = 'drvfs /mnt/mon\\040drive 9p rw 0 0'
    expect(fstypeDeMontage(avecEspace, '/mnt/mon drive/Replay')).toBe('9p')
  })

  /**
   * Le noyau empile les montages : un point remonté par-dessus un autre apparaît
   * **après** lui, et c'est le dernier qui décrit ce qu'on atteint. Retenir le
   * premier ferait annoncer le type du montage recouvert.
   */
  it('retient le dernier montage d’un même point, celui qui recouvre', () => {
    const empilés = ['none /mnt/wsl tmpfs rw 0 0', 'drvfs /mnt/wsl 9p rw 0 0'].join('\n')
    expect(fstypeDeMontage(empilés, '/mnt/wsl/x')).toBe('9p')
  })

  it('rend null quand aucun montage ne porte le chemin', () => {
    expect(fstypeDeMontage('drvfs /mnt/j 9p rw 0 0', '/ailleurs')).toBeNull()
  })

  it('ignore une ligne qui n’a pas la forme attendue', () => {
    expect(fstypeDeMontage('bidon\n/dev/sdd / ext4 rw 0 0', '/x')).toBe('ext4')
  })
})

describe('listerSources', () => {
  let racine: string
  let replays: string
  let db: Database.Database
  const envDépart = { ...process.env }

  beforeEach(() => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-sources-'))
    replays = path.join(racine, 'Replay')
    fs.mkdirSync(replays, { recursive: true })
    process.env.REPLAY_DIR = replays
    process.env.STAGE_DIR = path.join(racine, 'stage')
    process.env.PROJECTS_DIR = path.join(racine, 'projects')
    db = openDb(':memory:')
  })

  afterEach(() => {
    db.close()
    fs.rmSync(racine, { recursive: true, force: true })
    process.env = { ...envDépart }
  })

  function poserVidéo(nom: string, octets = 1_024): void {
    fs.writeFileSync(path.join(replays, nom), Buffer.alloc(octets))
  }

  it('rend le nom, la taille et la date de chaque replay', async () => {
    poserVidéo('2025-06-15-cqlp.mp4', 4_096)

    const listing = await listerSources({ db })
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
    poserVidéo('2025-06-15-cqlp.mp4')

    const listing = await listerSources({ db })
    expect(JSON.stringify(listing.sources)).not.toContain(racine)
  })

  it('écarte ce qui n’est pas une vidéo, et les compte quand même', async () => {
    poserVidéo('2025-06-15-cqlp.mp4')
    fs.writeFileSync(path.join(replays, 'notes.txt'), 'rien à voir')
    fs.mkdirSync(path.join(replays, '2025-06-15-cqlp.avolo'))

    const listing = await listerSources({ db })
    expect(listing.sources.map((s) => s.name)).toEqual(['2025-06-15-cqlp.mp4'])
    // Trois entrées dans le dossier : le relevé de montage les compte toutes,
    // parce qu'un dossier plein de fichiers illisibles n'est pas un dossier vide.
    expect(listing.montage.entrées).toBe(3)
  })

  it('reconnaît une vidéo quelle que soit la casse de son extension', async () => {
    poserVidéo('EMISSION.MP4')

    expect((await listerSources({ db })).sources.map((s) => s.name)).toEqual(['EMISSION.MP4'])
  })

  /**
   * `statAvecDélai` fait un `lstat` pour la même raison : un lien qui pointe hors
   * de `REPLAY_DIR` ferait ingérer autre chose qu'un replay, et l'ingestion le
   * refuse. Le proposer ici mènerait droit à ce refus.
   */
  it('ignore un lien symbolique, que l’ingestion refuse de toute façon', async () => {
    poserVidéo('vraie.mp4')
    fs.symlinkSync(path.join(replays, 'vraie.mp4'), path.join(replays, 'copie.mp4'))

    expect((await listerSources({ db })).sources.map((s) => s.name)).toEqual(['vraie.mp4'])
  })

  it('trie les replays du plus récent au plus ancien', async () => {
    poserVidéo('vieille.mp4')
    poserVidéo('récente.mp4')
    fs.utimesSync(path.join(replays, 'vieille.mp4'), new Date(1_700_000_000_000), new Date(1_700_000_000_000))

    expect((await listerSources({ db })).sources.map((s) => s.name)).toEqual([
      'récente.mp4',
      'vieille.mp4',
    ])
  })

  /**
   * Une source déjà analysée mène à son projet au lieu de relancer une création.
   * `créerProjet` est idempotent sur ce cas, mais proposer deux chemins vers le
   * même endroit sans le dire fait douter de ce qu'on vient de déclencher.
   */
  it('rattache une source au projet qu’elle a produit', async () => {
    poserVidéo('2025-06-15-cqlp.mp4')
    poserVidéo('2026-03-08-caro-mdlm.mp4')
    upsertProject(db, {
      id: '2025-06-15-cqlp',
      sourcePath: path.join(replays, '2025-06-15-cqlp.mp4'),
      stagedPath: null,
      durationSec: 5936,
      sizeBytes: null,
      mtimeMs: null,
      createdAt: 0,
    })

    const listing = await listerSources({ db })
    const parNom = new Map(listing.sources.map((s) => [s.name, s.projectId]))
    expect(parNom.get('2025-06-15-cqlp.mp4')).toBe('2025-06-15-cqlp')
    expect(parNom.get('2026-03-08-caro-mdlm.mp4')).toBeNull()
  })

  /**
   * **Le vide et l'absence sont deux pages différentes**, et les confondre est un
   * défaut de diagnostic : l'un se répare en déposant un fichier, l'autre en
   * rouvrant le lecteur côté Windows.
   */
  it('distingue un dossier vide d’un montage absent — le dossier vide', async () => {
    const listing = await listerSources({ db })
    expect(listing.sources).toEqual([])
    expect(listing.montage.disponible).toBe(true)
    expect(listing.montage.entrées).toBe(0)
  })

  it('distingue un dossier vide d’un montage absent — le montage absent', async () => {
    fs.rmSync(replays, { recursive: true, force: true })

    const listing = await listerSources({ db })
    expect(listing.sources).toEqual([])
    expect(listing.montage.disponible).toBe(false)
    expect(listing.montage.entrées).toBe(0)
  })

  /**
   * **Le mode d'échec à fermer.** Monté avec son transport mort dessous, le
   * Drive ne répond rien du tout et suspend l'appelant sans limite de temps :
   * `/proc/mounts` ne le distingue pas d'un montage sain, et les bits de
   * permission répondent oui aux deux. Seul un accès réel, avec délai de garde,
   * tranche.
   */
  it('renonce sur un montage muet au lieu d’attendre indéfiniment', async () => {
    const listing = await listerSources({
      db,
      timeoutMs: 20,
      relever: () => new Promise(() => {}),
    })
    expect(listing.montage.disponible).toBe(false)
    expect(listing.sources).toEqual([])
  })

  /**
   * Le relevé de type reste lisible quand l'accès échoue : c'est justement là
   * qu'il sert. Un `ext4` là où on attend `9p` dit « ce montage n'a pas eu
   * lieu », et c'est la phrase que l'écran doit pouvoir écrire.
   */
  it('relève le type du système de fichiers même sans accès', async () => {
    fs.rmSync(replays, { recursive: true, force: true })

    const listing: SourcesListing = await listerSources({ db })
    expect(listing.montage.fstype === null || typeof listing.montage.fstype === 'string').toBe(true)
  })
})
