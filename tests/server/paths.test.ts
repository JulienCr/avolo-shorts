import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  analysisPath,
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

let root: string
let replay: string
let stage: string
let projects: string
const envStart = { ...process.env }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-paths-'))
  replay = path.join(root, 'Replay')
  stage = path.join(root, 'stage')
  projects = path.join(root, 'projects')
  for (const d of [replay, stage, projects]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(replay, SOURCE), 'pas vraiment une vidéo')

  process.env.REPLAY_DIR = replay
  process.env.STAGE_DIR = stage
  process.env.PROJECTS_DIR = projects
})

afterEach(() => {
  // Un test rend le dossier de replays illisible en écriture : le remettre en
  // état, sinon le ménage échoue et le suivant hérite d'un tmpdir de plus.
  try {
    fs.chmodSync(replay, 0o755)
  } catch {
    // Le dossier peut déjà avoir disparu.
  }
  fs.rmSync(root, { recursive: true, force: true })
  process.env = { ...envStart }
})

describe('les chemins du projet', () => {
  it('dérive l’identifiant du nom de fichier, sans son extension', () => {
    expect(projectIdFromSource(SOURCE)).toBe(ID)
    expect(projectIdFromSource(path.join(replay, SOURCE))).toBe(ID)
  })

  it('déplie les accents du nom de fichier', () => {
    // `é` s'écrit de deux façons distinctes qui s'affichent pareil (`U+00E9`,
    // ou `e` + `U+0301`), et le système de fichiers décide laquelle arrive : le
    // repli enlève la question avant qu'elle n'atteigne un dossier ou une URL.
    fs.writeFileSync(path.join(replay, '2026-01-11-méchante.mp4'), 'pas une vidéo')
    expect(projectIdFromSource('2026-01-11-méchante.mp4')).toBe('2026-01-11-mechante')
  })

  it('rend le même identifiant pour les deux écritures d’un accent', () => {
    const decomposed = '2026-01-11-méchante.mp4'.normalize('NFD')
    fs.writeFileSync(path.join(replay, decomposed), 'pas une vidéo')
    expect(projectIdFromSource(decomposed)).toBe('2026-01-11-mechante')
  })

  it('résout un nom nu contre REPLAY_DIR, chemin complet accepté', () => {
    expect(resolveSource(SOURCE)).toBe(path.join(replay, SOURCE))
    expect(resolveSource(path.join(replay, SOURCE))).toBe(path.join(replay, SOURCE))
  })

  // `source` arrive du réseau (`POST /api/projects`). Sans ce contrôle il
  // désigne n'importe quel fichier de la machine — un chemin absolu compris,
  // qu'aucun code ici ne peut distinguer d'une saisie. (relevé par Copilot et
  // Aristarque)
  //
  // Les sous-dossiers tombent sous la même règle pour une autre raison :
  // `projectIdFromSource` et `stagedPath` ne gardent que le nom du fichier, donc
  // `2025/show.mp4` et `2026/show.mp4` se partageraient un seul projet.
  it.each([
    '../evasion.mp4',
    '../../etc/passwd',
    'a/../../evasion.mp4',
    '/etc/passwd',
    '2026/emission.mp4',
  ])('refuse la source %j, qui n’est pas un fichier de REPLAY_DIR', (bad) => {
    expect(() => resolveSource(bad)).toThrow()
  })

  it('range proxy, audio, analyse, candidats et rendus dans le projet', () => {
    expect(proxyPath(ID)).toBe(path.join(projects, ID, 'proxy.mp4'))
    expect(audioPath(ID)).toBe(path.join(projects, ID, 'audio.wav'))
    expect(analysisPath(ID)).toBe(path.join(projects, ID, 'analysis.json'))
    expect(candidatesPath(ID)).toBe(path.join(projects, ID, 'candidates.json'))
    expect(rendersDir(ID)).toBe(path.join(projects, ID, 'renders'))
  })

  /**
   * **L'analyse n'est pas un sidecar**, et la règle du haut de `paths.ts` le
   * décide toute seule : ses boîtes sont en fractions du proxy, avec le modèle,
   * la cadence et le seuil qui les ont produites. C'est le résultat d'un outil,
   * pas une propriété de la vidéo comme l'est le transcript — qui, lui, n'a
   * aucune raison de bouger quand le modèle change.
   */
  it('ne pose pas l’analyse à côté de l’original', () => {
    expect(analysisPath(ID).startsWith(projects)).toBe(true)
    expect(analysisPath(ID)).not.toContain('.avolo')
  })

  it('garde le nom d’origine pour la copie de travail', () => {
    expect(stagedPath(SOURCE)).toBe(path.join(stage, SOURCE))
  })

  // Un identifiant de projet arrive du réseau (`GET /api/projects/:id`) et sert à
  // construire un chemin. Sans garde-fou, il sort de PROJECTS_DIR.
  it.each(['../etc', 'a/b', '..', '', '.'])(
    'refuse l’identifiant %j, qui sortirait du dossier des projets',
    (bad) => {
      expect(() => projectDir(bad)).toThrow()
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
    expect(dir).toBe(path.join(projects, ID, `${ID}.avolo`))
    expect(transcript).toBe(path.join(dir, 'transcript.json'))
    expect(fs.statSync(dir).isDirectory()).toBe(true)
  })

  it('se rabat aussi quand le sidecar ne peut structurellement pas être créé', () => {
    // Un fichier occupe déjà la place du dossier : `mkdir` échoue pour tout le
    // monde, root compris.
    fs.writeFileSync(path.join(replay, `${ID}.avolo`), 'pas un dossier')
    const { dir, fallback } = placeSidecar(SOURCE, ID)
    expect(fallback).toBe(true)
    expect(dir).toBe(path.join(projects, ID, `${ID}.avolo`))
  })

  // Lire n'exige pas d'écrire. Se rabattre ici retranscrirait deux heures
  // cinquante d'audio pour un transcript déjà posé à côté de la vidéo.
  it.skipIf(process.getuid?.() === 0)('garde un transcript déjà calculé même en lecture seule', () => {
    const desired = path.join(replay, `${ID}.avolo`)
    fs.mkdirSync(desired)
    fs.writeFileSync(path.join(desired, 'transcript.json'), '{"segments":[]}')
    fs.chmodSync(replay, 0o500)

    const { dir, fallback } = placeSidecar(SOURCE, ID)
    expect(dir).toBe(desired)
    expect(fallback).toBe(false)
  })

  // Le ménage après une sonde ratée ne doit emporter que du vide : un `rm -rf`
  // détruirait le transcript qu'un autre processus vient d'écrire entre notre
  // contrôle d'existence et l'échec de la sonde. (relevé par Copilot)
  it.skipIf(process.getuid?.() === 0)(
    'n’efface jamais un sidecar qui contient déjà quelque chose',
    () => {
      // Un sidecar non vide mais sans transcript : la sonde d'écriture s'exécute
      // vraiment, et échoue. Le ménage qui suit ne doit emporter que du vide.
      const desired = path.join(replay, `${ID}.avolo`)
      fs.mkdirSync(desired)
      fs.writeFileSync(path.join(desired, 'meta.json'), '{"version":1}')
      fs.chmodSync(desired, 0o500)

      try {
        const { fallback } = placeSidecar(SOURCE, ID)
        expect(fallback).toBe(true)
        expect(fs.existsSync(path.join(desired, 'meta.json'))).toBe(true)
      } finally {
        fs.chmodSync(desired, 0o755)
      }
    },
  )

  it('retrouve un transcript déjà posé dans le projet par une passe précédente', () => {
    const existingFolder = path.join(projects, ID, `${ID}.avolo`)
    fs.mkdirSync(existingFolder, { recursive: true })
    fs.writeFileSync(path.join(existingFolder, 'transcript.json'), '{"segments":[]}')

    const { dir, fallback } = placeSidecar(SOURCE, ID)
    expect(dir).toBe(existingFolder)
    expect(fallback).toBe(true)
  })
})
