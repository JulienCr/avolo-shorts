import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip } from '@/core/edl'
import { cadrageDuClip, oublierLesAnalyses } from '@/server/cadrage'
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
let racine: string
let projets: string
const envDépart = { ...process.env }

beforeEach(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-cadrage-'))
  projets = path.join(racine, 'projects')
  fs.mkdirSync(path.join(projets, ID), { recursive: true })
  process.env.PROJECTS_DIR = projets
  oublierLesAnalyses()
})

afterEach(() => {
  fs.rmSync(racine, { recursive: true, force: true })
  process.env = { ...envDépart }
  oublierLesAnalyses()
})

function clip(surcharges: Partial<Clip> = {}): Clip {
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
    ...surcharges,
  }
}

/** Une analyse valide : deux plans, des comédiens serrés à gauche puis au centre. */
function écrireAnalyse(contenu?: unknown): void {
  const boîtes: unknown[] = []
  for (let t = 0; t < 20; t += 0.5) {
    const gauche = t < 10
    boîtes.push({
      t,
      x0: gauche ? 0.1 : 0.4,
      x1: gauche ? 0.25 : 0.55,
      y0: 0.2,
      y1: 0.95,
      score: 0.9,
    })
  }
  fs.writeFileSync(
    analysisPath(ID),
    JSON.stringify(
      contenu ?? {
        version: 1,
        fps: 2,
        source: { w: 1920, h: 1080 },
        proxy: { w: 960, h: 540 },
        shots: [
          { start: 0, end: 10 },
          { start: 10, end: 20 },
        ],
        boxes: boîtes,
      },
    ),
  )
}

describe('cadrageDuClip', () => {
  it('calcule un cadre par plan quand l’analyse est là', () => {
    écrireAnalyse()
    const cadrage = cadrageDuClip(clip())
    expect(cadrage.origine).toBe('calculé')
    expect(cadrage.shots).toHaveLength(2)
    expect(cadrage.shots.map((p) => p.source)).toEqual(['auto', 'auto'])
    // Deux plans serrés : chacun tient dans un 9:16, et le natif prend le plus
    // large des deux — donc 9:16 aussi.
    expect(cadrage.shots.map((p) => p.ratio)).toEqual(['9:16', '9:16'])
    expect(cadrage.ratio).toBe('9:16')
    // Les positions suivent l'action, qui se déplace d'un plan à l'autre.
    expect(cadrage.shots[0].cropX).toBeLessThan(cadrage.shots[1].cropX)
  })

  it('ne retient que les plans que les segments traversent', () => {
    écrireAnalyse()
    const cadrage = cadrageDuClip(clip({ segments: [{ start: 1, end: 5 }] }))
    expect(cadrage.shots.map((p) => p.key)).toEqual([0])
  })

  /**
   * **Le repli, et il se dit.** Sans analyse, le cadrage vaut celui de
   * l'itération 0 : le ratio résolu du clip, et son `cropX` sur toute sa durée.
   * Rien n'est perdu — mais `origine` le nomme, et l'écran l'affiche.
   */
  it('se rabat sur le réglage manuel quand `analysis.json` n’est pas là', () => {
    const cadrage = cadrageDuClip(clip({ ratio: '1:1', cropX: 0.3 }))
    expect(cadrage.origine).toBe('sans-analyse')
    expect(cadrage.ratio).toBe('1:1')
    expect(cadrage.shots).toEqual([
      {
        shot: { start: 4, end: 16 },
        key: 4000,
        ratio: '1:1',
        cropX: 0.3,
        cropXNatif: 0.3,
        source: 'manual',
      },
    ])
  })

  // `resolveRatio` est le seul endroit du dépôt où cette valeur par défaut est
  // écrite : sans mesure, « auto » vaut 9:16, et c'est ce que le rendu produira.
  it('résout « auto » en 9:16 dans le repli, comme le rendu le ferait', () => {
    expect(cadrageDuClip(clip()).ratio).toBe('9:16')
  })

  it('couvre le clip entier, même en plusieurs segments', () => {
    const cadrage = cadrageDuClip(
      clip({ segments: [{ start: 4, end: 8 }, { start: 30, end: 33 }] }),
    )
    expect(cadrage.shots[0].shot).toEqual({ start: 4, end: 33 })
  })

  it('ne casse pas sur un clip vidé de tous ses segments', () => {
    const cadrage = cadrageDuClip(clip({ segments: [] }))
    expect(cadrage.origine).toBe('sans-analyse')
    expect(cadrage.shots).toHaveLength(1)
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
  ])('dit « analyse-illisible » sur %s', (_nom, contenu) => {
    const espion = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fs.writeFileSync(analysisPath(ID), contenu)
    const cadrage = cadrageDuClip(clip({ ratio: '4:5', cropX: 0.2 }))
    expect(cadrage.origine).toBe('analyse-illisible')
    expect(cadrage.ratio).toBe('4:5')
    expect(cadrage.shots[0].cropX).toBe(0.2)
    espion.mockRestore()
  })

  /**
   * Le cas atteignable sous une analyse pourtant valide : les segments tombent
   * hors de l'étendue analysée. Un rendu sans crop du tout ne veut rien dire, et
   * un repli silencieux ne se verrait qu'à l'image.
   */
  it('dit « sans-plans » quand aucun plan ne recouvre le montage', () => {
    écrireAnalyse()
    const cadrage = cadrageDuClip(clip({ segments: [{ start: 100, end: 110 }] }))
    expect(cadrage.origine).toBe('sans-plans')
    expect(cadrage.shots).toHaveLength(1)
    expect(cadrage.shots[0].source).toBe('manual')
  })

  // Le mode est `'auto'` tant que le clip ne porte pas de table de dérogations :
  // `computeFraming` l'ignore alors entièrement, y compris pour le rapport.
  it('ne rejette aucune dérogation, faute d’en poser', () => {
    écrireAnalyse()
    expect(cadrageDuClip(clip()).rejectedOverrides).toEqual([])
  })

  /**
   * **Le cache est indexé sur la taille et la date, pas sur le seul chemin.**
   * Relancer l'analyse réécrit le fichier sous le même nom : un cache par chemin
   * servirait les plans d'avant jusqu'au redémarrage du serveur — un cadrage
   * faux, que rien ne signalerait.
   */
  it('relit l’analyse quand le fichier a été réécrit', () => {
    écrireAnalyse()
    expect(cadrageDuClip(clip()).shots).toHaveLength(2)

    écrireAnalyse({
      version: 1,
      fps: 2,
      source: { w: 1920, h: 1080 },
      proxy: { w: 960, h: 540 },
      shots: [{ start: 0, end: 20 }],
      boxes: [],
    })
    // La date à la seconde près ne suffirait pas : on la déplace franchement,
    // comme une relance d'analyse le ferait.
    const futur = new Date(Date.now() + 5000)
    fs.utimesSync(analysisPath(ID), futur, futur)

    const après = cadrageDuClip(clip())
    expect(après.shots).toHaveLength(1)
    // Plus aucune boîte : le plan est centré par défaut, et ça se voit.
    expect(après.shots[0].source).toBe('default')
    expect(après.ratio).toBe('16:9')
  })
})
