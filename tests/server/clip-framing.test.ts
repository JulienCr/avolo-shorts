import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip } from '@/core/edl'
import { framingWith, clipFraming, projectAnalysis, forgetAnalyses } from '@/server/clip-framing'
import { analysisPath } from '@/server/paths'

/**
 * La résolution du cadrage côté serveur.
 *
 * **Ce que ce fichier garde surtout, c'est ce qui se passe quand
 * `analysis.json` manque.** `src/core/graph.ts` dit noir sur blanc que `renders`
 * ne dépend pas d'`analysis`, et que c'est délibéré : la dépendance ferait
 * recalculer tous les rendus au premier changement de modèle de détection. Rien
 * ne garantit donc qu'un clip demandant « auto » ait des plans sous la main, et
 * un repli silencieux sur un 9:16 centré ne se verrait qu'à l'image, trois
 * minutes d'export plus tard.
 */

const ID = 'projet-de-test'
let root: string
let projects: string
const envStart = { ...process.env }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-cadrage-'))
  projects = path.join(root, 'projects')
  fs.mkdirSync(path.join(projects, ID), { recursive: true })
  process.env.PROJECTS_DIR = projects
  forgetAnalyses()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  process.env = { ...envStart }
  forgetAnalyses()
})

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_0001',
    projectId: ID,
    segments: [{ start: 4, end: 16 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Un titre',
    description: '',
    status: 'kept',
    pass: 1,
    ...overrides,
  }
}

/** Une analyse valide : deux plans, des comédiens serrés à gauche puis au centre. */
function writeAnalysis(content?: unknown): void {
  const boxes: unknown[] = []
  for (let t = 0; t < 20; t += 0.5) {
    const left = t < 10
    boxes.push({
      t,
      x0: left ? 0.1 : 0.4,
      x1: left ? 0.25 : 0.55,
      y0: 0.2,
      y1: 0.95,
      score: 0.9,
    })
  }
  fs.writeFileSync(
    analysisPath(ID),
    JSON.stringify(
      content ?? {
        version: 1,
        fps: 2,
        source: { w: 1920, h: 1080 },
        proxy: { w: 960, h: 540 },
        shots: [
          { start: 0, end: 10 },
          { start: 10, end: 20 },
        ],
        boxes: boxes,
      },
    ),
  )
}

describe('clipFraming', () => {
  it('calcule un cadre par plan quand l’analyse est là', () => {
    writeAnalysis()
    const framing = clipFraming(clip())
    expect(framing.origin).toBe('computed')
    expect(framing.shots).toHaveLength(2)
    expect(framing.shots.map((p) => p.source)).toEqual(['auto', 'auto'])
    // Deux plans serrés : chacun tient dans un 9:16, et le natif prend le plus
    // large des deux — donc 9:16 aussi.
    expect(framing.shots.map((p) => p.ratio)).toEqual(['9:16', '9:16'])
    expect(framing.ratio).toBe('9:16')
    // Les positions suivent l'action, qui se déplace d'un plan à l'autre.
    expect(framing.shots[0].cropX).toBeLessThan(framing.shots[1].cropX)
  })

  it('ne retient que les plans que les segments traversent', () => {
    writeAnalysis()
    const framing = clipFraming(clip({ segments: [{ start: 1, end: 5 }] }))
    expect(framing.shots.map((p) => p.key)).toEqual([0])
  })

  /**
   * **Le repli, et il se dit.** Sans analyse, le cadrage vaut celui de
   * l'itération 0 : le ratio résolu du clip, et son `cropX` sur toute sa durée.
   * Rien n'est perdu — mais `origin` le nomme, et l'écran l'affiche.
   */
  it('se rabat sur le réglage manuel quand `analysis.json` n’est pas là', () => {
    const framing = clipFraming(clip({ ratio: '1:1', cropX: 0.3 }))
    expect(framing.origin).toBe('no-analysis')
    expect(framing.ratio).toBe('1:1')
    expect(framing.shots).toEqual([
      {
        shot: { start: 4, end: 16 },
        key: 4000,
        ratio: '1:1',
        cropX: 0.3,
        cropXNative: 0.3,
        source: 'manual',
      },
    ])
  })

  // `resolveRatio` est le seul endroit du dépôt où cette valeur par défaut est
  // écrite : sans mesure, « auto » vaut 9:16, et c'est ce que le rendu produira.
  it('résout « auto » en 9:16 dans le repli, comme le rendu le ferait', () => {
    expect(clipFraming(clip()).ratio).toBe('9:16')
  })

  it('couvre le clip entier, même en plusieurs segments', () => {
    const framing = clipFraming(
      clip({ segments: [{ start: 4, end: 8 }, { start: 30, end: 33 }] }),
    )
    expect(framing.shots[0].shot).toEqual({ start: 4, end: 33 })
  })

  it('ne casse pas sur un clip vidé de tous ses segments', () => {
    const framing = clipFraming(clip({ segments: [] }))
    expect(framing.origin).toBe('no-analysis')
    expect(framing.shots).toHaveLength(1)
  })

  /**
   * **Un fichier illisible n'est pas une absence**, et le remède n'est pas le
   * même : l'un attend qu'on lance l'analyse, l'autre qu'on la relance. Le
   * détail du schéma va au journal, jamais à la réponse — c'est un `GET` qui
   * consomme ceci.
   */
  it.each([
    ['un JSON tronqué', '{"version": 1, "sho'],
    ['un JSON qui ne suit pas le contrat', '{"version": 1}'],
    ['une version inconnue', '{"version": 2, "fps": 2}'],
  ])('dit « analyse-illisible » sur %s', (_name, content) => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fs.writeFileSync(analysisPath(ID), content)
    const framing = clipFraming(clip({ ratio: '4:5', cropX: 0.2 }))
    expect(framing.origin).toBe('unreadable-analysis')
    expect(framing.ratio).toBe('4:5')
    expect(framing.shots[0].cropX).toBe(0.2)
    spy.mockRestore()
  })

  /**
   * **Une panne du système de fichiers traverse, elle ne devient pas un
   * « illisible ».**
   *
   * `statSync` réussit sur un fichier qu'on ne peut pas ouvrir — le dépôt
   * documente le cas d'un `chmod 000` dans `src/server/octets.ts` —, et
   * `lireAnalysis` lit avant d'analyser. Avaler son `EACCES` ferait cadrer tout un
   * projet à la main sur une panne de montage, avec un journal qui dit
   * « illisible » d'un fichier parfaitement valide : le sens de la panne irait
   * vers le silence. (relevé par Copilot)
   */
  it('relaie un refus de droits au lieu de le prendre pour un contrat non respecté', () => {
    writeAnalysis()
    fs.chmodSync(analysisPath(ID), 0o000)
    try {
      // Le contrôle qui rend le test honnête : sous root, `chmod 000` n'empêche
      // rien, et l'assertion passerait pour la mauvaise raison.
      let readable = true
      try {
        fs.readFileSync(analysisPath(ID))
      } catch {
        readable = false
      }
      if (readable) return

      expect(() => clipFraming(clip())).toThrow()
    } finally {
      fs.chmodSync(analysisPath(ID), 0o644)
    }
  })

  it('garde le repli pour un JSON qui ne suit pas son contrat', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fs.writeFileSync(analysisPath(ID), '{"version": 1}')
    expect(clipFraming(clip()).origin).toBe('unreadable-analysis')
    spy.mockRestore()
  })

  /**
   * Le cas atteignable sous une analyse pourtant valide : les segments tombent
   * hors de l'étendue analysée. Un rendu sans crop du tout ne veut rien dire, et
   * un repli silencieux ne se verrait qu'à l'image.
   */
  it('dit « sans-plans » quand aucun plan ne recouvre le montage', () => {
    writeAnalysis()
    const framing = clipFraming(clip({ segments: [{ start: 100, end: 110 }] }))
    expect(framing.origin).toBe('no-shots')
    expect(framing.shots).toHaveLength(1)
    expect(framing.shots[0].source).toBe('manual')
  })

  // Le mode est `'auto'` tant que le clip ne porte pas de table de dérogations :
  // `computeFraming` l'ignore alors entièrement, y compris pour le rapport.
  it('ne rejette aucune dérogation, faute d’en poser', () => {
    writeAnalysis()
    expect(clipFraming(clip()).rejectedOverrides).toEqual([])
  })

  /**
   * **Le cache est indexé sur la taille et la date, pas sur le seul chemin.**
   * Relancer l'analyse réécrit le fichier sous le même nom : un cache par chemin
   * servirait les plans d'avant jusqu'au redémarrage du serveur — un cadrage
   * faux, que rien ne signalerait.
   */
  it('relit l’analyse quand le fichier a été réécrit', () => {
    writeAnalysis()
    expect(clipFraming(clip()).shots).toHaveLength(2)

    writeAnalysis({
      version: 1,
      fps: 2,
      source: { w: 1920, h: 1080 },
      proxy: { w: 960, h: 540 },
      shots: [{ start: 0, end: 20 }],
      boxes: [],
    })
    // La date à la seconde près ne suffirait pas : on la déplace franchement,
    // comme une relance d'analyse le ferait.
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(analysisPath(ID), future, future)

    const after = clipFraming(clip())
    expect(after.shots).toHaveLength(1)
    // Plus aucune boîte : le plan est centré par défaut, et ça se voit.
    expect(after.shots[0].source).toBe('default')
    expect(after.ratio).toBe('16:9')
  })
})

/**
 * **La lecture et le calcul sont séparés parce que l'une est faillible et
 * l'autre non.**
 *
 * `PATCH /api/clips/:id` a besoin du cadrage *après* avoir écrit en base. Une
 * erreur de système de fichiers à ce moment-là rendrait 500 sur un montage
 * pourtant enregistré, et l'écriture optimiste de l'interface remettrait
 * l'ancienne version à l'écran pendant que la base porte la nouvelle — la
 * divergence exacte que cette route évite déjà pour les sorties et la vignette.
 * (relevé par Copilot)
 */
describe('framingWith', () => {
  it('calcule sans toucher au disque', () => {
    writeAnalysis()
    const source = projectAnalysis(ID)

    // `PROJECTS_DIR` mis hors d'atteinte : si le calcul lisait quoi que ce soit,
    // il lèverait ou se rabattrait sur `sans-analyse`. Il fait ni l'un ni l'autre.
    process.env.PROJECTS_DIR = path.join(root, 'nulle-part')
    forgetAnalyses()

    const framing = framingWith(clip(), source)
    expect(framing.origin).toBe('computed')
    expect(framing.shots).toHaveLength(2)

    // Et le contrôle négatif, sans lequel le précédent ne prouverait rien : la
    // moitié faillible, elle, voit bien le dossier vide.
    expect(clipFraming(clip()).origin).toBe('no-analysis')
  })

  it('rend le même cadrage que le chemin complet', () => {
    writeAnalysis()
    expect(framingWith(clip(), projectAnalysis(ID))).toEqual(clipFraming(clip()))
  })
})
