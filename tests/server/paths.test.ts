import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  audioPath,
  candidatesPath,
  placeSidecar,
  projectDir,
  projectIdFromSource,
  proxyPath,
  rendersDir,
  resolveSource,
  sidecarDir,
  stagedPath,
  transcriptPath,
} from '@/server/paths'

/**
 * Spec §5, « où vivent les artefacts ». Ce qui est intrinsèque à la vidéo vit à
 * côté d'elle, le reste vit dans le projet.
 *
 * Ces tests touchent au disque, et c'est voulu : le repli du sidecar est une
 * question d'écriture réelle, pas de bits de permission. Un test qui simulerait
 * le système de fichiers ne prouverait rien de ce que ce fichier promet.
 */

const SOURCE = '2026-03-08-caro-mdlm.mp4'
const ID = '2026-03-08-caro-mdlm'

let racine: string
let replay: string
let stage: string
let projets: string
const envDépart = { ...process.env }

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-paths-'))
  replay = path.join(racine, 'Replay')
  stage = path.join(racine, 'stage')
  projets = path.join(racine, 'projects')
  for (const d of [replay, stage, projets]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projets
})

afterEach(() => {
  // Un test rend le dossier de replays illisible en écriture : le remettre en
  // état, sinon le ménage échoue et le suivant hérite d'un tmpdir de plus.
  try {
    fs.chmodSync(replay, 0o755)
  } catch {
    // Le dossier peut déjà avoir disparu.
  }
  fs.rmSync(racine, { recursive: true, force: true })
  process.env = { ...envDépart }
})

describe('les chemins du projet', () => {
  it('dérive l’identifiant du nom de fichier, sans son extension', () => {
    expect(projectIdFromSource(SOURCE)).toBe(ID)
    expect(projectIdFromSource(path.join(replay, SOURCE))).toBe(ID)
  })

  it('résout un nom nu contre REPLAY_DIR, et laisse un chemin absolu tel quel', () => {
    expect(resolveSource(SOURCE)).toBe(path.join(replay, SOURCE))
    expect(resolveSource(`2026/${SOURCE}`)).toBe(path.join(replay, '2026', SOURCE))
    expect(resolveSource('/ailleurs/x.mp4')).toBe('/ailleurs/x.mp4')
  })

  // `source` arrive du réseau (`POST /api/projects`). Sans ce contrôle, il
  // désigne n'importe quel fichier de la machine.
  it.each(['../evasion.mp4', '../../etc/passwd', 'a/../../evasion.mp4'])(
    'refuse la source %j, qui sort de REPLAY_DIR',
    (mauvaise) => {
      expect(() => resolveSource(mauvaise)).toThrow()
    },
  )

  it('range proxy, audio, candidats et rendus dans le projet', () => {
    expect(proxyPath(ID)).toBe(path.join(projets, ID, 'proxy.mp4'))
    expect(audioPath(ID)).toBe(path.join(projets, ID, 'audio.wav'))
    expect(candidatesPath(ID)).toBe(path.join(projets, ID, 'candidates.json'))
    expect(rendersDir(ID)).toBe(path.join(projets, ID, 'renders'))
  })

  it('garde le nom d’origine pour la copie de travail', () => {
    expect(stagedPath(SOURCE)).toBe(path.join(stage, SOURCE))
  })

  // Un identifiant de projet arrive du réseau (`GET /api/projects/:id`) et sert à
  // construire un chemin. Sans garde-fou, il sort de PROJECTS_DIR.
  it.each(['../etc', 'a/b', '..', '', '.'])(
    'refuse l’identifiant %j, qui sortirait du dossier des projets',
    (mauvais) => {
      expect(() => projectDir(mauvais)).toThrow()
    },
  )
})

describe('le sidecar', () => {
  it('se pose à côté de l’original, sous <nom>.avolo/', () => {
    expect(sidecarDir(SOURCE)).toBe(path.join(replay, `${ID}.avolo`))
    expect(transcriptPath(SOURCE)).toBe(path.join(replay, `${ID}.avolo`, 'transcript.json'))
  })

  // Le point de toute la section : la copie dans `stage/` est transitoire et peut
  // être effacée. Y écrire le transcript reviendrait à le jeter avec elle.
  it('se pose à côté de l’original et non de la copie de travail', () => {
    const { dir, fallback } = placeSidecar(SOURCE, ID)
    expect(dir.startsWith(replay)).toBe(true)
    expect(dir.startsWith(stage)).toBe(false)
    expect(fallback).toBe(false)
    expect(fs.statSync(dir).isDirectory()).toBe(true)
  })

  it('ne laisse pas traîner la sonde d’écriture', () => {
    const { dir } = placeSidecar(SOURCE, ID)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  // Deux façons pour un dossier source de refuser l'écriture. La seconde tient
  // même quand le test tourne en root, pour qui les bits de permission ne
  // veulent rien dire — ce qui est le cas dans un conteneur de CI.
  it.skipIf(process.getuid?.() === 0)('se rabat dans le projet si le dossier source est en lecture seule', () => {
    fs.chmodSync(replay, 0o500)
    const { dir, transcript, fallback } = placeSidecar(SOURCE, ID)
    expect(fallback).toBe(true)
    expect(dir).toBe(path.join(projets, ID, `${ID}.avolo`))
    expect(transcript).toBe(path.join(dir, 'transcript.json'))
    expect(fs.statSync(dir).isDirectory()).toBe(true)
  })

  it('se rabat aussi quand le sidecar ne peut structurellement pas être créé', () => {
    // Un fichier occupe déjà la place du dossier : `mkdir` échoue pour tout le
    // monde, root compris.
    fs.writeFileSync(path.join(replay, `${ID}.avolo`), 'pas un dossier')
    const { dir, fallback } = placeSidecar(SOURCE, ID)
    expect(fallback).toBe(true)
    expect(dir).toBe(path.join(projets, ID, `${ID}.avolo`))
  })

  // Lire n'exige pas d'écrire. Se rabattre ici retranscrirait deux heures
  // cinquante d'audio pour un transcript déjà posé à côté de la vidéo.
  it.skipIf(process.getuid?.() === 0)('garde un transcript déjà calculé même en lecture seule', () => {
    const voulu = path.join(replay, `${ID}.avolo`)
    fs.mkdirSync(voulu)
    fs.writeFileSync(path.join(voulu, 'transcript.json'), '{"segments":[]}')
    fs.chmodSync(replay, 0o500)

    const { dir, fallback } = placeSidecar(SOURCE, ID)
    expect(dir).toBe(voulu)
    expect(fallback).toBe(false)
  })

  it('retrouve un transcript déjà posé dans le projet par une passe précédente', () => {
    const repli = path.join(projets, ID, `${ID}.avolo`)
    fs.mkdirSync(repli, { recursive: true })
    fs.writeFileSync(path.join(repli, 'transcript.json'), '{"segments":[]}')

    const { dir, fallback } = placeSidecar(SOURCE, ID)
    expect(dir).toBe(repli)
    expect(fallback).toBe(true)
  })
})
