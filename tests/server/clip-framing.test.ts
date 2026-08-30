import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip } from '@/core/edl'
import { framingWith, clipFraming, projectAnalysis, forgetAnalyses } from '@/server/clip-framing'
import { FRAMING_SETTINGS_DEFAULTS } from '@/core/framing'
import type { FramingSettings, FramingStyleOverride } from '@/core/framing'
import { DUBBING_ANCHORS } from '@/core/dubbing'
import { POINT, POINT_COUNT } from '@/core/shots'
import type { PersonBox } from '@/core/shots'
import { applySettings, closeDb, effectiveSettings, getClip, openDb, putClip, upsertProject } from '@/server/db'
import { analysisPath } from '@/server/paths'
import { renderedFraming } from '@/server/steps/render'
import { snapshotEnv } from '../helpers/env'

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
const restoreEnv = snapshotEnv()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-cadrage-'))
  projects = path.join(root, 'projects')
  fs.mkdirSync(path.join(projects, ID), { recursive: true })
  process.env.PROJECTS_DIR = projects
  forgetAnalyses()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  restoreEnv()
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
    footer: true,
    title: 'Un titre',
    description: '',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    framingStyle: {},
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
    const framing = clipFraming(clip(), FRAMING_SETTINGS_DEFAULTS)
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
    const framing = clipFraming(clip({ segments: [{ start: 1, end: 5 }] }), FRAMING_SETTINGS_DEFAULTS)
    expect(framing.shots.map((p) => p.key)).toEqual([0])
  })

  /**
   * **Le repli, et il se dit.** Sans analyse, le cadrage vaut celui de
   * l'itération 0 : le ratio résolu du clip, et son `cropX` sur toute sa durée.
   * Rien n'est perdu — mais `origin` le nomme, et l'écran l'affiche.
   */
  it('se rabat sur le réglage manuel quand `analysis.json` n’est pas là', () => {
    const framing = clipFraming(clip({ ratio: '1:1', cropX: 0.3 }), FRAMING_SETTINGS_DEFAULTS)
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
    expect(clipFraming(clip(), FRAMING_SETTINGS_DEFAULTS).ratio).toBe('9:16')
  })

  it('couvre le clip entier, même en plusieurs segments', () => {
    const framing = clipFraming(
      clip({ segments: [{ start: 4, end: 8 }, { start: 30, end: 33 }] }),
    )
    expect(framing.shots[0].shot).toEqual({ start: 4, end: 33 })
  })

  it('ne casse pas sur un clip vidé de tous ses segments', () => {
    const framing = clipFraming(clip({ segments: [] }), FRAMING_SETTINGS_DEFAULTS)
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
    const framing = clipFraming(clip({ ratio: '4:5', cropX: 0.2 }), FRAMING_SETTINGS_DEFAULTS)
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
   * documente le cas d'un `chmod 000` dans `src/server/bytes.ts` —, et
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

      expect(() => clipFraming(clip(), FRAMING_SETTINGS_DEFAULTS)).toThrow()
    } finally {
      fs.chmodSync(analysisPath(ID), 0o644)
    }
  })

  it('garde le repli pour un JSON qui ne suit pas son contrat', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fs.writeFileSync(analysisPath(ID), '{"version": 1}')
    expect(clipFraming(clip(), FRAMING_SETTINGS_DEFAULTS).origin).toBe('unreadable-analysis')
    spy.mockRestore()
  })

  /**
   * Le cas atteignable sous une analyse pourtant valide : les segments tombent
   * hors de l'étendue analysée. Un rendu sans crop du tout ne veut rien dire, et
   * un repli silencieux ne se verrait qu'à l'image.
   */
  it('dit « sans-plans » quand aucun plan ne recouvre le montage', () => {
    writeAnalysis()
    const framing = clipFraming(clip({ segments: [{ start: 100, end: 110 }] }), FRAMING_SETTINGS_DEFAULTS)
    expect(framing.origin).toBe('no-shots')
    expect(framing.shots).toHaveLength(1)
    expect(framing.shots[0].source).toBe('manual')
  })

  // Le mode est `'auto'` tant que le clip ne porte pas de table de dérogations :
  // `computeFraming` l'ignore alors entièrement, y compris pour le rapport.
  it('ne rejette aucune dérogation, faute d’en poser', () => {
    writeAnalysis()
    expect(clipFraming(clip(), FRAMING_SETTINGS_DEFAULTS).rejectedOverrides).toEqual([])
  })

  /**
   * **Le cache est indexé sur la taille et la date, pas sur le seul chemin.**
   * Relancer l'analyse réécrit le fichier sous le même nom : un cache par chemin
   * servirait les plans d'avant jusqu'au redémarrage du serveur — un cadrage
   * faux, que rien ne signalerait.
   */
  it('relit l’analyse quand le fichier a été réécrit', () => {
    writeAnalysis()
    expect(clipFraming(clip(), FRAMING_SETTINGS_DEFAULTS).shots).toHaveLength(2)

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

    const after = clipFraming(clip(), FRAMING_SETTINGS_DEFAULTS)
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
    expect(clipFraming(clip(), FRAMING_SETTINGS_DEFAULTS).origin).toBe('no-analysis')
  })

  it('rend le même cadrage que le chemin complet', () => {
    writeAnalysis()
    expect(framingWith(clip(), projectAnalysis(ID))).toEqual(clipFraming(clip(), FRAMING_SETTINGS_DEFAULTS))
  })
})

/**
 * Le critère d'acceptation n° 5 : `framing.splitScreen` passé **par le
 * registre**, pas construit à la main comme `FramingOptions` — c'est le
 * câblage de `clipFraming`/`framingWith` vers `effectiveSettings` qui est sous
 * test ici, l'équivalence elle-même l'est déjà au niveau `FramingOptions`
 * (`tests/core/framing.test.ts`, « le split-screen dans computeFraming »).
 */
/**
 * Les dix-sept points COCO d'une personne, en fractions — assez pour que le
 * tronc par défaut (`torso: 'bust'`, nez/yeux/oreilles/épaules) se calcule
 * sans repli sur la boîte brute. Partagé par les deux blocs qui construisent
 * des analyses à deux personnes plus bas dans ce fichier.
 */
function personKeypoints(centerX: number, eyeY: number, shoulderY: number, halfWidth: number): number[] {
  const k = Array.from({ length: POINT_COUNT * 3 }, () => 0)
  const put = (point: keyof typeof POINT, x: number, y: number, score: number): void => {
    k[POINT[point] * 3] = x
    k[POINT[point] * 3 + 1] = y
    k[POINT[point] * 3 + 2] = score
  }
  put('NOSE', centerX, eyeY, 0.9)
  put('LEFT_EYE', centerX - 0.01, eyeY, 0.9)
  put('RIGHT_EYE', centerX + 0.01, eyeY, 0.9)
  put('LEFT_EAR', centerX - halfWidth, eyeY, 0.9)
  put('RIGHT_EAR', centerX + halfWidth, eyeY, 0.9)
  put('LEFT_SHOULDER', centerX - halfWidth, shoulderY, 0.9)
  put('RIGHT_SHOULDER', centerX + halfWidth, shoulderY, 0.9)
  return k
}

function personBox(
  t: number,
  centerX: number,
  eyeY: number,
  shoulderY: number,
  halfWidth: number,
  y0: number = eyeY - 0.1,
  y1: number = shoulderY + 0.5,
): PersonBox {
  return {
    t,
    x0: centerX - halfWidth * 2,
    x1: centerX + halfWidth * 2,
    y0,
    y1,
    score: 0.9,
    k: personKeypoints(centerX, eyeY, shoulderY, halfWidth),
  }
}

/** Une analyse `version: 2` à deux points de pose, sur un unique plan `[0, end]`. */
function writeTwoPersonAnalysis(id: string, boxes: PersonBox[], end: number): void {
  fs.mkdirSync(path.join(projects, id), { recursive: true })
  fs.writeFileSync(
    analysisPath(id),
    JSON.stringify({
      version: 2,
      keypoints: 'coco17',
      fps: 2,
      source: { w: 1920, h: 1080 },
      proxy: { w: 960, h: 540 },
      shots: [{ start: 0, end }],
      boxes,
    }),
  )
  forgetAnalyses()
}

describe('le split-screen à travers le registre des réglages', () => {
  const SPLIT_ID = 'projet-a-deux'

  /** Deux personnes bien séparées, à chaque image d'un plan unique de 20 s. */
  function writeSplitAnalysis(): void {
    const boxes: PersonBox[] = []
    for (let t = 0; t < 20; t += 0.5) {
      boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05))
      boxes.push(personBox(t, 0.64, 0.35, 0.45, 0.04))
    }
    writeTwoPersonAnalysis(SPLIT_ID, boxes, 20)
  }

  function splitClip(): Clip {
    return {
      id: 'clip_split',
      projectId: SPLIT_ID,
      // Ratio épinglé plutôt que « auto » : ce test porte sur `splitScreen`,
      // pas sur le choix du ratio, que `chooseRatio` pourrait faire varier
      // sans rapport avec le réglage sous test.
      segments: [{ start: 0, end: 20 }],
      ratio: '1:1',
      cropX: 0.5,
      captions: true,
      branding: false,
      footer: false,
      title: 'Un duo',
      description: '',
      status: 'kept',
      pass: 1,
      hookText: '',
      hookBadge: '',
      hookStyle: {},
      framingStyle: {},
    }
  }

  it('pose un split par défaut, et plus aucun quand `splitScreen` passe à `false` par la base', () => {
    fs.mkdirSync(path.join(projects, SPLIT_ID), { recursive: true })
    writeSplitAnalysis()
    forgetAnalyses()

    const db = openDb(':memory:')
    try {
      const withDefault = clipFraming(splitClip(), effectiveSettings(db).framing)
      expect(withDefault.shots[0].split).toBeDefined()

      applySettings(db, { framing: { splitScreen: false } })
      const withoutSplit = clipFraming(splitClip(), effectiveSettings(db).framing)

      // **L'interrupteur reproduit le cadrage d'avant le split** : `split`
      // disparaît, et rien d'autre ne bouge — même test que celui déjà fait au
      // niveau `FramingOptions`, mais câblé cette fois par la base.
      expect(withoutSplit.shots[0].split).toBeUndefined()
      expect(withoutSplit.ratio).toBe(withDefault.ratio)
      expect(withoutSplit.shots[0].ratio).toBe(withDefault.shots[0].ratio)
      expect(withoutSplit.shots[0].cropX).toBeCloseTo(withDefault.shots[0].cropX, 10)
      expect(withoutSplit.shots[0].cropXNative).toBeCloseTo(withDefault.shots[0].cropXNative, 10)
    } finally {
      closeDb()
    }
  })

  /**
   * Le même interrupteur, câblé cette fois par `clip.framingStyle` plutôt que
   * par la base — la surcharge par clip (issue #180, seconde moitié). **Écrit
   * en base puis relu**, jamais comparé en mémoire seule : c'est la leçon de
   * la PR #176, où une comparaison en mémoire avait laissé passer un défaut
   * que seul l'aller-retour par la base révélait.
   */
  it('un clip dont `framingStyle.splitScreen` diffère du global produit un cadrage différent', () => {
    fs.mkdirSync(path.join(projects, SPLIT_ID), { recursive: true })
    writeSplitAnalysis()
    forgetAnalyses()

    const db = openDb(':memory:')
    try {
      upsertProject(db, {
        id: SPLIT_ID,
        sourcePath: '/replay/a-deux.mp4',
        stagedPath: null,
        durationSec: null,
        sizeBytes: null,
        mtimeMs: null,
        createdAt: 0,
      })
      putClip(db, splitClip())
      putClip(db, {
        ...splitClip(),
        id: 'clip_split_override',
        framingStyle: { splitScreen: false },
      })

      const plain = renderedFraming(
        clipFraming(getClip(db, 'clip_split')!, FRAMING_SETTINGS_DEFAULTS),
      )
      const overridden = renderedFraming(
        clipFraming(getClip(db, 'clip_split_override')!, FRAMING_SETTINGS_DEFAULTS),
      )

      expect(plain.shots[0].split).toBeDefined()
      expect(overridden.shots[0].split).toBeUndefined()
      expect(overridden).not.toEqual(plain)
    } finally {
      closeDb()
    }
  })

  /**
   * Le contrôle négatif du test précédent : une surcharge qui répète la valeur
   * globale ne change rien à ce que `computeFraming` produit, donc l'empreinte
   * ne doit pas bouger — sans quoi ouvrir puis refermer le panneau de cadrage
   * périmerait tous les exports.
   */
  it('un `framingStyle` qui répète le global ne fait pas bouger le cadrage', () => {
    fs.mkdirSync(path.join(projects, SPLIT_ID), { recursive: true })
    writeSplitAnalysis()
    forgetAnalyses()

    const db = openDb(':memory:')
    try {
      upsertProject(db, {
        id: SPLIT_ID,
        sourcePath: '/replay/a-deux.mp4',
        stagedPath: null,
        durationSec: null,
        sizeBytes: null,
        mtimeMs: null,
        createdAt: 0,
      })
      putClip(db, { ...splitClip(), id: 'clip_split_plain' })
      // Le global vaut déjà `splitScreen: true` (`FRAMING_SETTINGS_DEFAULTS`) :
      // cette surcharge le répète, elle ne le change pas.
      putClip(db, {
        ...splitClip(),
        id: 'clip_split_noop',
        framingStyle: { splitScreen: true },
      })

      const plain = renderedFraming(
        clipFraming(getClip(db, 'clip_split_plain')!, FRAMING_SETTINGS_DEFAULTS),
      )
      const noop = renderedFraming(
        clipFraming(getClip(db, 'clip_split_noop')!, FRAMING_SETTINGS_DEFAULTS),
      )

      expect(noop).toEqual(plain)
    } finally {
      closeDb()
    }
  })
})

/**
 * `dubbingLayout` (PR4, issue #180) : comme `splitScreen`, un booléen qui ne
 * passe par aucune division. Sa surcharge par clip doit arriver jusqu'à
 * `computeFraming` telle quelle — c'est le point que
 * `src/server/clip-framing.ts` teste ailleurs pour les cinq réglages
 * numériques, et qui manquait pour celui-ci.
 */
describe('`dubbingLayout` à travers le registre des réglages', () => {
  const DUBBING_ID = 'projet-doublage'
  const ANCHOR = DUBBING_ANCHORS[0]

  /** Une boîte de comédien, entièrement contenue dans l'ancre de doublage. */
  function dubBox(t: number): PersonBox {
    return {
      t,
      x0: ANCHOR.pip.x0 + 0.02,
      x1: ANCHOR.pip.x1 - 0.02,
      y0: ANCHOR.pip.y0 + 0.02,
      y1: ANCHOR.pip.y1 - 0.02,
      score: 0.9,
    }
  }

  function writeDubbingAnalysis(): void {
    // Une image par seconde, largement au-delà du délai d'entrée de 30 s.
    const boxes: PersonBox[] = []
    for (let t = 0; t <= 69; t += 1) boxes.push(dubBox(t))
    writeTwoPersonAnalysis(DUBBING_ID, boxes, 69)
  }

  function dubbingClip(framingStyle: FramingStyleOverride = {}): Clip {
    return {
      id: 'clip_dubbing',
      projectId: DUBBING_ID,
      segments: [{ start: 20, end: 40 }],
      ratio: 'auto',
      cropX: 0.5,
      captions: true,
      branding: false,
      footer: false,
      title: 'Une scène doublée',
      description: '',
      status: 'kept',
      pass: 1,
      hookText: '',
      hookBadge: '',
      hookStyle: {},
      framingStyle,
    }
  }

  it('pose `dubbing` par défaut, et plus aucun quand `framingStyle.dubbingLayout` vaut `false`', () => {
    writeDubbingAnalysis()

    const withDefault = framingWith(
      dubbingClip(),
      projectAnalysis(DUBBING_ID),
      FRAMING_SETTINGS_DEFAULTS,
    )
    expect(withDefault.shots[0].dubbing).toBeDefined()

    const withOverride = framingWith(
      dubbingClip({ dubbingLayout: false }),
      projectAnalysis(DUBBING_ID),
      FRAMING_SETTINGS_DEFAULTS,
    )
    expect(withOverride.shots[0].dubbing).toBeUndefined()
  })
})

/**
 * Une conversion inversée (`* 1000` au lieu de `/ 1000`) sature en silence à
 * `1,0` via `bound(...)` (`computeShotSplit`) : un scénario « tout accepter »
 * ne voit donc pas la différence entre 0,08 et 1,0. Chaque test choisit une
 * valeur médiane où le résultat correct diffère du résultat saturé, et a été
 * vérifié en inversant sa conversion une seule à la fois.
 *
 * Géométrie à points de pose complets, pas la fixture `torso: 'off'` de
 * `@/core/framing` : elle ne survit pas aux réglages par défaut réels.
 */
describe('la conversion millièmes/ms → fraction/seconde, réglage par réglage', () => {
  function withSettings(patch: Partial<FramingSettings>): FramingSettings {
    return { ...FRAMING_SETTINGS_DEFAULTS, ...patch }
  }

  // `framingStyle` par défaut à `{}` : les cinq tests existants ne changent
  // donc pas de comportement. Les cinq nouveaux, plus bas, le fournissent à
  // la place de `withSettings` (ADDENDUM 2 : épingler la surcharge, pas une suite parallèle).
  function clipOn(id: string, end: number, framingStyle: FramingStyleOverride = {}): Clip {
    return {
      id: 'clip_pin',
      projectId: id,
      segments: [{ start: 0, end }],
      ratio: '1:1',
      cropX: 0.5,
      captions: true,
      branding: false,
      footer: false,
      title: 'Épingle de conversion',
      description: '',
      status: 'kept',
      pass: 1,
      hookText: '',
      hookBadge: '',
      hookStyle: {},
      framingStyle,
    }
  }

  it('`splitMinShotMs` : un plan de 3 s accepte à 2500 ms (2,5 s)', () => {
    const id = 'pin-min-shot'
    const boxes: PersonBox[] = []
    for (let t = 0; t < 3; t += 0.5) {
      boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05))
      boxes.push(personBox(t, 0.64, 0.35, 0.45, 0.04))
    }
    writeTwoPersonAnalysis(id, boxes, 3)
    const framing = framingWith(
      clipOn(id, 3),
      projectAnalysis(id),
      withSettings({ splitMinShotMs: 2500 }),
    )
    // Une conversion inversée donnerait 2 500 000 s : bien au-delà des 3 s
    // montées, donc `tooShort` au lieu d'un split.
    expect(framing.shots[0].split).toBeDefined()
  })

  it('`splitMinCellWidthPermille` : une cellule de largeur 0,6 à 600 ‰', () => {
    const id = 'pin-min-width'
    const boxes: PersonBox[] = []
    for (let t = 0; t < 20; t += 0.5) {
      boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05))
      boxes.push(personBox(t, 0.64, 0.35, 0.45, 0.04))
    }
    writeTwoPersonAnalysis(id, boxes, 20)
    const framing = framingWith(
      clipOn(id, 20),
      projectAnalysis(id),
      withSettings({ splitMinCellWidthPermille: 600 }),
    )
    // Une conversion inversée sature à 1,0 : la cellule dépasse la hauteur
    // atteignable et le split se refuse (`tooNarrowForSource`).
    expect(framing.shots[0].split?.[0]).toBeDefined()
    const cell = framing.shots[0].split![0]
    expect(cell.x1 - cell.x0).toBeCloseTo(0.6, 5)
  })

  it('`splitBleedTolerancePermille` : un débordement de 0,12 refuse à 50 ‰ (0,05)', () => {
    const id = 'pin-tolerance'
    const boxes: PersonBox[] = []
    for (let t = 0; t < 20; t += 0.5) {
      boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05))
      // Assez proche du premier pour déborder dans sa boîte de 0,12 —
      // mesuré, pas visé au jugé (voir le corps de la PR).
      boxes.push(personBox(t, 0.42, 0.35, 0.45, 0.04))
    }
    writeTwoPersonAnalysis(id, boxes, 20)
    const framing = framingWith(
      clipOn(id, 20),
      projectAnalysis(id),
      withSettings({ splitBleedTolerancePermille: 50 }),
    )
    // Une conversion inversée sature à 1,0 : n'importe quel débordement passe,
    // et ce test verrait `split` défini au lieu de `undefined`.
    expect(framing.shots[0].split).toBeUndefined()
  })

  it('`splitBleedSharePermille` : 9 images conformes sur 10 acceptent à 500 ‰ (0,5)', () => {
    const id = 'pin-share'
    const boxes: PersonBox[] = []
    for (let i = 0; i < 10; i += 1) {
      const t = i * 0.5
      boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05))
      // Une seule image déborde (débordement mesuré : 0,105, au-dessus de la
      // tolérance par défaut de 0,08) ; les neuf autres non.
      boxes.push(i === 0 ? personBox(t, 0.42, 0.35, 0.45, 0.04) : personBox(t, 0.64, 0.35, 0.45, 0.04))
    }
    writeTwoPersonAnalysis(id, boxes, 5)
    const framing = framingWith(
      clipOn(id, 5),
      projectAnalysis(id),
      withSettings({ splitBleedSharePermille: 500 }),
    )
    // Une conversion inversée sature à 1,0 (100 % des images exigées) : avec
    // 90 % de conformes, ce test verrait `split` refusé au lieu d'accepté.
    expect(framing.shots[0].split).toBeDefined()
  })

  it('`sizeFloorPermille` : une troisième boîte à 0,5 de la plus haute refuse le split à 200 ‰ (0,2)', () => {
    const id = 'pin-size-floor'
    const boxes: PersonBox[] = []
    for (let t = 0; t < 20; t += 0.5) {
      boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05, 0.2, 0.9)) // hauteur 0,7
      boxes.push(personBox(t, 0.64, 0.35, 0.45, 0.04, 0.25, 0.95)) // hauteur 0,7
      // Hauteur 0,35, soit 0,5 de la plus haute — au-dessus du plancher à
      // 0,2, donc comptée comme une troisième personne.
      boxes.push(personBox(t, 0.44, 0.5, 0.6, 0.05, 0.4, 0.75))
    }
    writeTwoPersonAnalysis(id, boxes, 20)
    const framing = framingWith(
      clipOn(id, 20),
      projectAnalysis(id),
      withSettings({ sizeFloorPermille: 200 }),
    )
    // Une conversion inversée sature à 1,0 : seule la plus haute boîte compte,
    // la troisième sort du décompte, et ce test verrait `split` défini.
    expect(framing.shots[0].split).toBeUndefined()
  })

  /**
   * Les cinq épingles ci-dessus, rejouées avec le réglage porté par
   * `clip.framingStyle` plutôt que par la base. Sans ces cinq-là, un merge
   * qui n'étalerait que `splitScreen` (ou une autre clé) laisserait les
   * quatre conversions numériques rester inertes depuis une surcharge par
   * clip : tous les tests ci-dessus resteraient verts, câblés qu'ils sont sur
   * `withSettings`.
   *
   * **Le global n'est pas partout `FRAMING_SETTINGS_DEFAULTS`.** Pour la
   * tolérance, la part et le plancher, la revue de Copilot sur cette PR a
   * montré que le global par défaut donnait déjà, seul, le verdict attendu —
   * la surcharge n'était alors testée par rien. Ces trois-là passent un
   * global contradictoire (`withSettings({...})`), choisi pour donner le
   * verdict inverse sans la surcharge ; les deux autres gardent le défaut
   * parce que leur assertion en dépend déjà (durée du plan trop courte au
   * défaut ; largeur de cellule vérifiée à la valeur exacte de la surcharge).
   */
  describe('les mêmes épingles, câblées par `clip.framingStyle`', () => {
    it('`splitMinShotMs` en surcharge par clip', () => {
      const id = 'pin-min-shot-override'
      const boxes: PersonBox[] = []
      for (let t = 0; t < 3; t += 0.5) {
        boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05))
        boxes.push(personBox(t, 0.64, 0.35, 0.45, 0.04))
      }
      writeTwoPersonAnalysis(id, boxes, 3)
      const framing = framingWith(
        clipOn(id, 3, { splitMinShotMs: 2500 }),
        projectAnalysis(id),
        FRAMING_SETTINGS_DEFAULTS,
      )
      expect(framing.shots[0].split).toBeDefined()
    })

    it('`splitMinCellWidthPermille` en surcharge par clip', () => {
      const id = 'pin-min-width-override'
      const boxes: PersonBox[] = []
      for (let t = 0; t < 20; t += 0.5) {
        boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05))
        boxes.push(personBox(t, 0.64, 0.35, 0.45, 0.04))
      }
      writeTwoPersonAnalysis(id, boxes, 20)
      const framing = framingWith(
        clipOn(id, 20, { splitMinCellWidthPermille: 600 }),
        projectAnalysis(id),
        FRAMING_SETTINGS_DEFAULTS,
      )
      expect(framing.shots[0].split?.[0]).toBeDefined()
      const cell = framing.shots[0].split![0]
      expect(cell.x1 - cell.x0).toBeCloseTo(0.6, 5)
    })

    it('`splitBleedTolerancePermille` en surcharge par clip', () => {
      const id = 'pin-tolerance-override'
      const boxes: PersonBox[] = []
      for (let t = 0; t < 20; t += 0.5) {
        boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05))
        boxes.push(personBox(t, 0.42, 0.35, 0.45, 0.04))
      }
      writeTwoPersonAnalysis(id, boxes, 20)
      // Global contradictoire (990‰, quasi 1,0) : sans la surcharge à 50‰, le
      // débordement de 0,105 passerait — la revue de Copilot sur cette PR a
      // relevé que le global par défaut (80‰) le rejetait déjà tout seul.
      const framing = framingWith(
        clipOn(id, 20, { splitBleedTolerancePermille: 50 }),
        projectAnalysis(id),
        withSettings({ splitBleedTolerancePermille: 990 }),
      )
      expect(framing.shots[0].split).toBeUndefined()
    })

    it('`splitBleedSharePermille` en surcharge par clip', () => {
      const id = 'pin-share-override'
      const boxes: PersonBox[] = []
      for (let i = 0; i < 10; i += 1) {
        const t = i * 0.5
        boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05))
        boxes.push(i === 0 ? personBox(t, 0.42, 0.35, 0.45, 0.04) : personBox(t, 0.64, 0.35, 0.45, 0.04))
      }
      writeTwoPersonAnalysis(id, boxes, 5)
      // Global contradictoire (1000‰, 100 % exigé) : les 9/10 images conformes
      // ne suffisent plus sans la surcharge à 500‰ — le global par défaut
      // (900‰) les acceptait déjà seul.
      const framing = framingWith(
        clipOn(id, 5, { splitBleedSharePermille: 500 }),
        projectAnalysis(id),
        withSettings({ splitBleedSharePermille: 1000 }),
      )
      expect(framing.shots[0].split).toBeDefined()
    })

    it('`sizeFloorPermille` en surcharge par clip', () => {
      const id = 'pin-size-floor-override'
      const boxes: PersonBox[] = []
      for (let t = 0; t < 20; t += 0.5) {
        boxes.push(personBox(t, 0.25, 0.3, 0.4, 0.05, 0.2, 0.9))
        boxes.push(personBox(t, 0.64, 0.35, 0.45, 0.04, 0.25, 0.95))
        boxes.push(personBox(t, 0.44, 0.5, 0.6, 0.05, 0.4, 0.75))
      }
      writeTwoPersonAnalysis(id, boxes, 20)
      // Global contradictoire (1000‰, quasi 1,0) : sans la surcharge à 200‰,
      // la troisième boîte sortirait du décompte et le split serait défini —
      // le global par défaut (500‰) l'excluait déjà tout seul, à la limite.
      const framing = framingWith(
        clipOn(id, 20, { sizeFloorPermille: 200 }),
        projectAnalysis(id),
        withSettings({ sizeFloorPermille: 1000 }),
      )
      expect(framing.shots[0].split).toBeUndefined()
    })
  })
})
