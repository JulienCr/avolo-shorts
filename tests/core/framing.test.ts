import { describe, it, expect } from 'vitest'
import {
  FRAMING_DEFAULTS,
  MIN_PIECE_SEC,
  ORIENTATION_DEFAULTS,
  RATIOS,
  chooseRatio,
  computeFraming,
  computeShotSplit,
  cropRect,
  headBounds,
  isForeground,
  orientationOf,
  outputSize,
  ratioCoverage,
  requiredWidths,
  resolveRatio,
  sizeInCanvas,
  personBounds,
  torsoBounds,
  trimmedBounds,
} from '@/core/framing'
import type { Ratio, Segment } from '@/core/edl'
import { POINT, POINT_COUNT } from '@/core/shots'
import type { PersonBox, Shot } from '@/core/shots'

const ALL: Ratio[] = ['9:16', '4:5', '1:1', '16:9']

describe('RATIOS', () => {
  it('donne la largeur pour une hauteur de 1', () => {
    expect(RATIOS['9:16']).toBeCloseTo(9 / 16, 10)
    expect(RATIOS['4:5']).toBeCloseTo(4 / 5, 10)
    expect(RATIOS['1:1']).toBe(1)
    expect(RATIOS['16:9']).toBeCloseTo(16 / 9, 10)
  })

  it('couvre les quatre ratios et rien de plus', () => {
    expect(Object.keys(RATIOS).sort()).toEqual([...ALL].sort())
  })
})

describe('resolveRatio', () => {
  it("en itération 0, 'auto' vaut 9:16 — il n'y a pas encore de cadrage automatique", () => {
    expect(resolveRatio('auto')).toBe('9:16')
  })

  it('un ratio explicite passe tel quel', () => {
    expect(resolveRatio('1:1')).toBe('1:1')
    for (const r of ALL) expect(resolveRatio(r)).toBe(r)
  })
})

describe('outputSize', () => {
  it('sort en 1080 de large en portrait et en carré, 1920 en paysage', () => {
    expect(outputSize('9:16')).toEqual({ w: 1080, h: 1920 })
    expect(outputSize('4:5')).toEqual({ w: 1080, h: 1350 })
    expect(outputSize('1:1')).toEqual({ w: 1080, h: 1080 })
    expect(outputSize('16:9')).toEqual({ w: 1920, h: 1080 })
  })

  it('respecte le ratio demandé et reste en dimensions paires', () => {
    for (const r of ALL) {
      const { w, h } = outputSize(r)
      expect(w / h).toBeCloseTo(RATIOS[r], 3)
      expect(w % 2).toBe(0)
      expect(h % 2).toBe(0)
    }
  })
})

describe('cropRect', () => {
  it("un 9:16 pleine hauteur couvre 31,6 % de la largeur d'une image 16:9", () => {
    const r = cropRect('9:16', 0.5, 1920, 1080)
    expect(r.h).toBe(1080)
    expect(r.w).toBe(608) // 1080 * 9/16 = 607,5, arrondi au pair
    expect(r.x).toBe(656) // centré
    expect(r.y).toBe(0)
  })

  it("un 16:9 prend toute l'image", () => {
    expect(cropRect('16:9', 0.5, 1920, 1080)).toMatchObject({ w: 1920, x: 0 })
  })

  it('ne sort jamais du cadre, quel que soit cropX', () => {
    for (const cx of [0, 0.01, 0.5, 0.99, 1]) {
      const r = cropRect('1:1', cx, 1920, 1080)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(1920)
    }
  })

  // Les valeurs viennent d'une base et d'un curseur d'interface : une borne
  // dépassée ne doit pas produire un rectangle hors cadre, qui ferait échouer
  // ffmpeg au lieu de rogner.
  it('borne cropX hors de [0, 1] au lieu de le propager', () => {
    expect(cropRect('9:16', -3, 1920, 1080).x).toBe(0)
    expect(cropRect('9:16', 4, 1920, 1080).x).toBe(1920 - 608)
  })

  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('retombe sur le centre quand cropX vaut %s', (_name, cx) => {
    expect(cropRect('9:16', cx, 1920, 1080)).toEqual(cropRect('9:16', 0.5, 1920, 1080))
  })

  // Les dimensions viennent de ffprobe. Un NaN propagé se serait manifesté
  // beaucoup plus loin, en « crop.w doit être un nombre fini » — un message qui
  // désigne le symptôme et cache la cause.
  it.each([
    ['largeur NaN', Number.NaN, 1080],
    ['hauteur NaN', 1920, Number.NaN],
    ['hauteur infinie', 1920, Number.POSITIVE_INFINITY],
  ])('refuse une source aux dimensions non finies (%s)', (_name, sw, sh) => {
    expect(() => cropRect('9:16', 0.5, sw, sh)).toThrow(/source/)
  })

  it('les dimensions sont paires, sinon libx264 refuse', () => {
    for (const ratio of ALL) {
      const r = cropRect(ratio, 0.5, 1920, 1080)
      expect(r.w % 2).toBe(0)
      expect(r.h % 2).toBe(0)
    }
  })

  // yuv420p sous-échantillonne la chrominance d'un facteur deux : une origine
  // impaire décale le plan de chrominance d'un demi-pixel.
  it("l'origine aussi est paire, à n'importe quel cropX", () => {
    for (const cx of [0, 0.077, 0.31, 0.5, 0.618, 0.93, 1]) {
      const r = cropRect('4:5', cx, 1920, 1080)
      expect(r.x % 2).toBe(0)
      expect(r.y % 2).toBe(0)
    }
  })

  it('suit cropX : plus il monte, plus le rectangle va vers la droite', () => {
    const left = cropRect('1:1', 0.25, 1920, 1080)
    const center = cropRect('1:1', 0.5, 1920, 1080)
    expect(left.x).toBeLessThan(center.x)
    expect(center.x).toBe(Math.trunc((1920 - center.w) / 2 / 2) * 2)
  })

  // Le crop est pleine hauteur *dans une image 16:9*. Sur une source plus
  // étroite — un 4:3, un portrait — la pleine hauteur déborderait en largeur :
  // c'est alors la largeur qui borne, et le ratio demandé est conservé.
  it('bascule sur la pleine largeur quand la pleine hauteur ne tient pas', () => {
    const r = cropRect('16:9', 0.5, 1440, 1080)
    expect(r.w).toBeLessThanOrEqual(1440)
    expect(r.h).toBeLessThanOrEqual(1080)
    expect(r.w / r.h).toBeCloseTo(16 / 9, 2)
    expect(r.y).toBeGreaterThan(0)
    expect(r.y + r.h).toBeLessThanOrEqual(1080)
  })

  it('reste dans le cadre sur toutes les combinaisons ratio × source', () => {
    for (const ratio of ALL) {
      for (const [sw, sh] of [
        [1920, 1080],
        [1440, 1080],
        [1080, 1920],
        [3840, 2160],
      ]) {
        const r = cropRect(ratio, 0.5, sw, sh)
        expect(r.w).toBeGreaterThan(0)
        expect(r.h).toBeGreaterThan(0)
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(sw)
        expect(r.y + r.h).toBeLessThanOrEqual(sh)
        expect(r.w % 2).toBe(0)
        expect(r.h % 2).toBe(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Le cadrage automatique (itération 1).
// ---------------------------------------------------------------------------

const SRC_W = 1920
const SRC_H = 1080

/**
 * Le rognage latéral éteint.
 *
 * Les tests qui le passent décrivent la **géométrie** du choix — ce qu'un empan
 * vaut, quel ratio le couvre, où la position se pose —, et ils posent leurs
 * boîtes à la main pour ça. Le rognage y ajouterait un second réglage à défaire
 * de tête à chaque lecture, pour ne rien éprouver de plus.
 *
 * Ce qu'il fait, lui, est éprouvé dans son propre bloc plus bas, et sur les
 * valeurs par défaut : sans quoi personne ne verrait qu'elles ont bougé.
 */
const NO_TRIM = { sideTrim: 0, sideTrimMax: 0 } as const

/** Une boîte de personne. La hauteur ne sert à rien ici : le crop est pleine hauteur. */
const box = (t: number, x0: number, x1: number, score = 0.9): PersonBox => ({
  t,
  x0,
  x1,
  y0: 0.1,
  y1: 0.95,
  score,
})

/** Une boîte de personne dont la hauteur visible compte, pour le plancher de taille. */
const boxH = (
  t: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  score = 0.9,
): PersonBox => ({ t, x0, x1, y0, y1, score })

/**
 * Les boîtes d'un intervalle, échantillonnées à 2 images par seconde comme le
 * fait le worker (spec §6), avec les mêmes personnes sur toutes les images.
 */
function sample(
  from: number,
  to: number,
  people: [number, number][],
  score = 0.9,
): PersonBox[] {
  const out: PersonBox[] = []
  for (let t = from; t < to - 1e-9; t += 0.5) {
    for (const [x0, x1] of people) out.push(box(Number(t.toFixed(3)), x0, x1, score))
  }
  return out
}

const shot = (start: number, end: number): Shot => ({ start, end })
const seg = (start: number, end: number): Segment => ({ start, end })

// Deux plans, deux positions d'action. Les nombres sont posés pour que les
// crops attendus se calculent à la main :
//   plan A : personnes sur 0,20 à 0,60 → empan 0,44 avec la marge de 2 %
//   plan B : personnes sur 0,55 à 0,90 → empan 0,39
// Le percentile 90 de {20 × 0,39 ; 20 × 0,44} vaut 0,44, que seul le 4:5 couvre.
const SHOT_A = shot(0, 10)
const SHOT_B = shot(10, 20)
const SHOTS = [SHOT_A, SHOT_B]
const SEGMENTS = [seg(0, 20)]
const PEOPLE = [
  ...sample(0, 10, [
    [0.2, 0.35],
    [0.45, 0.6],
  ]),
  ...sample(10, 20, [
    [0.55, 0.7],
    [0.8, 0.9],
  ]),
]

const base = {
  segments: SEGMENTS,
  shots: SHOTS,
  people: PEOPLE,
  srcW: SRC_W,
  srcH: SRC_H,
  ratio: 'auto' as const,
  cropMode: 'auto' as const,
  // Rognage éteint, voir `NO_TRIM` : ce jeu de plans sert à éprouver le
  // découpage, les positions et les dérogations, pas la valeur d'un réglage.
  ...NO_TRIM,
}

describe('ratioCoverage', () => {
  // Les trois pourcentages de la table de la spec §2, qui fondent tout le reste.
  it('retrouve les couvertures mesurées', () => {
    expect(ratioCoverage('9:16', 1920, 1080)).toBeCloseTo(0.316, 3)
    expect(ratioCoverage('4:5', 1920, 1080)).toBeCloseTo(0.45, 5)
    expect(ratioCoverage('1:1', 1920, 1080)).toBeCloseTo(0.5625, 5)
    expect(ratioCoverage('16:9', 1920, 1080)).toBe(1)
  })

  it('ne dépasse jamais 1, même sur une source plus étroite que le ratio', () => {
    for (const r of ALL) {
      expect(ratioCoverage(r, 1080, 1920)).toBeLessThanOrEqual(1)
      expect(ratioCoverage(r, 1080, 1920)).toBeGreaterThan(0)
    }
    expect(ratioCoverage('16:9', 1080, 1920)).toBe(1)
  })

  it('refuse une source aux dimensions invalides', () => {
    expect(() => ratioCoverage('9:16', Number.NaN, 1080)).toThrow(/source/)
    expect(() => ratioCoverage('9:16', 1920, 0)).toThrow(/source/)
  })
})

describe('requiredWidths', () => {
  it('mesure une largeur par image, pas une par personne', () => {
    const boxes = [box(1, 0.2, 0.3), box(1, 0.6, 0.7), box(1.5, 0.4, 0.5)]
    expect(requiredWidths(boxes, { margin: 0, ...NO_TRIM })).toEqual([
      expect.closeTo(0.5, 10),
      expect.closeTo(0.1, 10),
    ])
  })

  it("ajoute une marge de chaque côté, et l'air par défaut n'est pas nul", () => {
    expect(requiredWidths([box(1, 0.4, 0.6)], { margin: 0.05, ...NO_TRIM })[0]).toBeCloseTo(
      0.3,
      10,
    )
    expect(requiredWidths([box(1, 0.4, 0.6)], NO_TRIM)[0]).toBeGreaterThan(0.2)
  })

  // **La marge compte deux fois**, une fois de chaque côté, et c'est ce qui rend
  // son défaut cher : à 0,02 elle dépensait 0,04 de largeur là où un 1:1 n'en
  // couvre que 0,5625. Le balayage du 18 août 2026 l'a fait tomber à 0,01, et ce
  // test dit ce que la baisse achète — l'empan brut de 0,53 ci-dessous, qui est
  // l'ordre de grandeur des deux clips de `2025-06-15-cqlp` qui basculent, tient
  // dans un 1:1 à 0,01 et n'y tient pas à 0,02. Le détail et les images sont dans
  // `docs/ratios-par-clip.md`.
  it('coûte deux fois sa valeur, et le défaut arbitre le seuil du 1:1', () => {
    expect(FRAMING_DEFAULTS.margin).toBe(0.01)

    const span = (margin: number): number =>
      requiredWidths([box(1, 0.235, 0.765)], { margin: margin, ...NO_TRIM })[0]
    expect(span(0)).toBeCloseTo(0.53, 10)
    expect(span(0.01)).toBeCloseTo(0.55, 10)
    expect(span(0.02)).toBeCloseTo(0.57, 10)

    const a1X1 = ratioCoverage('1:1', SRC_W, SRC_H)
    expect(span(FRAMING_DEFAULTS.margin)).toBeLessThanOrEqual(a1X1)
    expect(span(0.02)).toBeGreaterThan(a1X1)
  })

  it('borne la largeur à 1 : rien ne dépasse la source', () => {
    expect(requiredWidths([box(1, 0, 1)], { margin: 0.1, ...NO_TRIM })).toEqual([1])
  })

  // Une détection douteuse au bord du cadre suffirait à imposer un 16:9.
  it('écarte les boîtes sous le seuil de confiance', () => {
    const boxes = [box(1, 0.4, 0.6, 0.9), box(1, 0.95, 0.99, 0.2)]
    expect(requiredWidths(boxes, { margin: 0, minScore: 0.5, ...NO_TRIM })).toEqual([
      expect.closeTo(0.2, 10),
    ])
  })

  /**
   * **Le seuil est inclusif, et c'est un contrat avec `worker/detect.py`.**
   *
   * Le worker arrondissait ses scores au millième le plus proche : une détection
   * à 0,4996 ressortait à `0.5` et passait ici, alors qu'elle était sous le
   * seuil. Il tronque maintenant vers le bas, ce qui suppose que 0,5 pile compte
   * — sans quoi la moitié des boîtes justes se perdrait à l'autre bout.
   *
   * Déplacer ce seuil d'un epsilon aurait été l'autre correctif possible : il
   * écarterait les détections à 0,5 exactement, qui sont réelles, et il changerait
   * la lecture des `analysis.json` déjà écrits. C'est pour cela qu'on a corrigé
   * le producteur. (ticket #40)
   */
  it('garde une boîte pile au seuil, écarte celle qui est juste dessous', () => {
    expect(requiredWidths([box(1, 0.4, 0.6, 0.5)], { margin: 0 })).toHaveLength(1)
    expect(requiredWidths([box(1, 0.4, 0.6, 0.4999)], { margin: 0 })).toHaveLength(0)
  })

  // Une image sans personne ne vaut pas une largeur de zéro : elle ne dit rien,
  // et la compter tirerait le percentile vers un ratio trop étroit pour les
  // images où il y a quelqu'un.
  it("ne rend rien pour une image dont aucune boîte n'est retenue", () => {
    const boxes = [box(1, 0.4, 0.6, 0.9), box(2, 0.1, 0.2, 0.1)]
    expect(requiredWidths(boxes, { margin: 0 })).toHaveLength(1)
  })

  // `??` ne remplace que `undefined` : un `NaN` se propageait jusqu'à un `cropX`
  // à `NaN` étiqueté `'auto'`, invisible à l'image mais faux dans l'interface.
  it('retombe sur les réglages par défaut quand ils ne sont pas finis', () => {
    const boxes = [box(1, 0.4, 0.6, 0.9), box(1, 0.95, 0.99, 0.2)]
    expect(requiredWidths(boxes, { margin: Number.NaN })).toEqual(requiredWidths(boxes))
    expect(requiredWidths(boxes, { minScore: Number.NaN })).toEqual(requiredWidths(boxes))
  })

  it('ignore une boîte inversée ou aux bornes non finies', () => {
    expect(requiredWidths([box(1, 0.6, 0.4)], { margin: 0 })).toEqual([])
    expect(requiredWidths([box(1, Number.NaN, 0.4)], { margin: 0 })).toEqual([])
  })

  // Le plancher de taille : une boîte nettement plus courte que la plus haute
  // de la même image n'est pas quelqu'un à cadrer — voir `FRAMING_DEFAULTS` et
  // la spec du 25 août 2026, section « Le plancher de taille ».
  // Plancher non passé, exprès : c'est `FRAMING_DEFAULTS.sizeFloor` qu'on
  // vérifie ici, pas l'algorithme. Une régression du défaut vers 0 ou 0,05
  // laisserait ce test vert s'il fixait sa propre valeur. (relevé par Copilot)
  it('exclut une boîte nettement plus courte que la plus haute de la même image', () => {
    const tall = boxH(1, 0.4, 0.6, 0, 1)
    const short = boxH(1, 0.8, 0.9, 0.6, 0.8)
    expect(requiredWidths([tall, short], { margin: 0, ...NO_TRIM })).toEqual([
      expect.closeTo(0.2, 10),
    ])
  })

  it('sizeFloor à 0 reproduit exactement le calcul sans plancher, sur un cas où il déclenche', () => {
    const tall = boxH(1, 0.4, 0.6, 0, 1)
    const short = boxH(1, 0.8, 0.9, 0.6, 0.8)
    expect(requiredWidths([tall, short], { margin: 0, sizeFloor: 0.5, ...NO_TRIM })[0]).toBeCloseTo(
      0.2,
      10,
    )
    expect(requiredWidths([tall, short], { margin: 0, sizeFloor: 0, ...NO_TRIM })).toEqual([
      expect.closeTo(0.5, 10),
    ])
  })

  // Sans le plafond à 1, un plancher > 1 rejette même la plus haute boîte de
  // l'image (elle ne peut jamais valoir floor fois elle-même pour floor > 1) :
  // l'image entière disparaît et le clip retombe sur le ratio le plus large —
  // un plancher trop haut élargirait alors paradoxalement le cadrage.
  // (relevé par Copilot et Aristarque)
  it('plafonne le plancher à 1 plutôt que de vider toute image', () => {
    const tall = boxH(1, 0.4, 0.6, 0, 1)
    const short = boxH(1, 0.8, 0.9, 0.6, 0.8)
    expect(requiredWidths([tall, short], { margin: 0, sizeFloor: 1.5, ...NO_TRIM })).toEqual(
      requiredWidths([tall, short], { margin: 0, sizeFloor: 1, ...NO_TRIM }),
    )
  })

  // Deux images distinctes : une implémentation qui comparerait à la plus
  // haute boîte de tout l'appel plutôt que de sa propre image rejetterait à
  // tort la petite boîte de la seconde image (0,2 contre la boîte de 1 de la
  // première), alors qu'elle est seule dans la sienne et doit y survivre.
  // (relevé par Copilot)
  it('compare chaque boîte à la plus haute de sa propre image, pas de tout l’appel', () => {
    const tallFrame1 = boxH(1, 0.4, 0.6, 0, 1)
    const shortFrame1 = boxH(1, 0.8, 0.9, 0.6, 0.8)
    const soloFrame2 = boxH(2, 0.1, 0.2, 0.3, 0.5)
    const [w1, w2] = requiredWidths([tallFrame1, shortFrame1, soloFrame2], {
      margin: 0,
      sizeFloor: 0.5,
      ...NO_TRIM,
    })
    expect(w1).toBeCloseTo(0.2, 10)
    expect(w2).toBeCloseTo(0.1, 10)
  })

  it("ignore une boîte dont la hauteur n'est pas finie, avant même le plancher", () => {
    const tall = boxH(1, 0.4, 0.6, 0, 1)
    const nanHeight = boxH(1, 0.7, 0.8, Number.NaN, 0.5)
    expect(requiredWidths([tall, nanHeight], { margin: 0, sizeFloor: 0.5, ...NO_TRIM })).toEqual([
      expect.closeTo(0.2, 10),
    ])
  })

  it('écarte une boîte dont le bas ne dépasse pas le haut', () => {
    const tall = boxH(1, 0.4, 0.6, 0, 1)
    const inverted = boxH(1, 0.7, 0.8, 0.9, 0.9)
    // `sizeFloor: 0` isole ce garde du plancher : une boîte inversée a une
    // hauteur nulle, que le plancher par défaut écarterait de toute façon.
    expect(
      requiredWidths([tall, inverted], { margin: 0, sizeFloor: 0, ...NO_TRIM }),
    ).toEqual([expect.closeTo(0.2, 10)])
  })
})

describe('chooseRatio', () => {
  /** Un plan de 20 images où l'action ne bouge pas. */
  const fixed = (x0: number, x1: number): PersonBox[] => sample(0, 10, [[x0, x1]])
  /** Ni marge ni rognage : ces tests décrivent le choix, pas les réglages. */
  const withoutMargin = { margin: 0, ...NO_TRIM }

  it('retient le plus petit ratio qui couvre', () => {
    expect(chooseRatio(fixed(0.35, 0.65), SRC_W, SRC_H, withoutMargin)).toBe('9:16')
    expect(chooseRatio(fixed(0.3, 0.7), SRC_W, SRC_H, withoutMargin)).toBe('4:5')
    expect(chooseRatio(fixed(0.25, 0.75), SRC_W, SRC_H, withoutMargin)).toBe('1:1')
    expect(chooseRatio(fixed(0.1, 0.9), SRC_W, SRC_H, withoutMargin)).toBe('16:9')
  })

  it('couvre pile la largeur mesurée, sans marge supplémentaire', () => {
    const w = ratioCoverage('9:16', SRC_W, SRC_H)
    expect(chooseRatio(fixed(0.5 - w / 2, 0.5 + w / 2), SRC_W, SRC_H, withoutMargin)).toBe('9:16')
    expect(
      chooseRatio(fixed(0.5 - w / 2 - 1e-4, 0.5 + w / 2 + 1e-4), SRC_W, SRC_H, withoutMargin),
    ).toBe('4:5')
  })

  // Le cœur de la décision : le seuil est à 90 %, pas au maximum. Deux images
  // sur vingt où quelqu'un traverse ne condamnent pas le clip au 16:9.
  it('absorbe une traversée que le maximum aurait payée en 16:9', () => {
    const shot = [...sample(0, 9, [[0.35, 0.65]]), ...sample(9, 10, [[0.02, 0.98]])]
    expect(chooseRatio(shot, SRC_W, SRC_H, withoutMargin)).toBe('9:16')
    expect(Math.max(...requiredWidths(shot, withoutMargin))).toBeGreaterThan(
      ratioCoverage('1:1', SRC_W, SRC_H),
    )
  })

  it('cède quand plus de 10 % des images débordent', () => {
    const shot = [...sample(0, 7.5, [[0.35, 0.65]]), ...sample(7.5, 10, [[0.02, 0.98]])]
    expect(chooseRatio(shot, SRC_W, SRC_H, withoutMargin)).toBe('16:9')
  })

  // Ce qu'une largeur par image ne peut pas voir, et que la première version de
  // ce module ratait : le crop est **fixe** pour tout le plan. Un sujet étroit
  // qui passe de gauche à droite pendant le plan tient dans un 9:16 image par
  // image — chaque largeur vaut 0,20 — mais aucune position fixe de 9:16 n'en
  // cadre plus de la moitié. C'est le cas que la spec §10 annonce : « un plan de
  // trois minutes où les comédiens traversent le plateau impose un crop large,
  // donc un ratio qui monte, parfois jusqu'au 16:9 ».
  it('fait monter le ratio quand l’action se déplace à l’intérieur d’un plan', () => {
    const traversal = [
      ...sample(0, 5, [[0.05, 0.25]]),
      ...sample(5, 10, [[0.75, 0.95]]),
    ]
    // Toutes les images tiendraient individuellement dans un 9:16.
    expect(Math.max(...requiredWidths(traversal, withoutMargin))).toBeLessThan(
      ratioCoverage('9:16', SRC_W, SRC_H),
    )
    expect(chooseRatio(traversal, SRC_W, SRC_H, withoutMargin)).toBe('16:9')
  })

  // Le pendant, sans lequel le précédent inviterait à sur-corriger : entre deux
  // plans le crop a le droit de sauter, puisqu'une coupe existe déjà là. Chaque
  // plan choisit désormais **son** ratio, donc les deux moitiés de cette
  // traversée sortent chacune en 9:16 au lieu de se tirer l'une l'autre vers le
  // haut.
  it('ne fait pas monter le ratio quand le déplacement est entre deux plans', () => {
    const left = sample(0, 5, [[0.05, 0.25]])
    const right = sample(5, 10, [[0.75, 0.95]])
    expect(chooseRatio(left, SRC_W, SRC_H, withoutMargin)).toBe('9:16')
    expect(chooseRatio(right, SRC_W, SRC_H, withoutMargin)).toBe('9:16')
  })

  // Aucune mesure : on ne sait rien de l'endroit où sont les gens. Le 16:9 est
  // le seul choix qui ne perd aucune information — la sortie est visiblement
  // large, donc rattrapable d'un clic, là où un 9:16 aveugle couperait les
  // comédiens sans que rien ne le signale.
  it('sans aucune mesure, prend le ratio le plus large plutôt que de couper à l’aveugle', () => {
    expect(chooseRatio([], SRC_W, SRC_H)).toBe('16:9')
  })
})

describe('computeFraming', () => {
  it('choisit un ratio pour le clip et un crop par plan', () => {
    const framing = computeFraming(base)
    expect(framing.ratio).toBe('4:5')
    expect(framing.shots).toHaveLength(2)
    expect(framing.shots[0]).toMatchObject({ key: 0, source: 'auto' })
    expect(framing.shots[0].cropX).toBeCloseTo(0.4, 6)
    expect(framing.shots[1]).toMatchObject({ key: 10000, source: 'auto' })
    expect(framing.shots[1].cropX).toBeCloseTo(0.725, 6)
    expect(framing.rejectedOverrides).toEqual([])
  })

  it('rend les plans dans l’ordre de la source, avec leurs bornes de source', () => {
    const framing = computeFraming(base)
    expect(framing.shots.map((s) => s.shot)).toEqual([SHOT_A, SHOT_B])
  })

  it('ignore les plans qu’aucun segment ne traverse', () => {
    const framing = computeFraming({ ...base, segments: [seg(0, 5)] })
    expect(framing.shots.map((s) => s.key)).toEqual([0])
  })

  // Un comédien qui traverse le plateau sur deux images ne doit ni faire monter
  // le ratio, ni tirer le crop du plan derrière lui.
  it('absorbe une traversée de quelques images', () => {
    const traversal = [box(4, 0.9, 0.98), box(4.5, 0.9, 0.98)]
    const framing = computeFraming({ ...base, people: [...PEOPLE, ...traversal] })
    expect(framing.ratio).toBe('4:5')
    expect(framing.shots[0].cropX).toBeCloseTo(0.4, 6)
  })

  // Le crop couvre l'action, il ne la moyenne pas. Ici les comédiens dérivent
  // vers la droite pendant le plan : le plateau [0,295 ; 0,305] cadre entièrement
  // 16 images sur 20, là où la position la plus peuplée — 0,20, où se trouvent
  // la moitié des images — n'en cadrerait que 10.
  it('cadre le plus d’images possible, et non la position moyenne de l’action', () => {
    const drift = [
      ...sample(0, 5, [[0.1, 0.3]]),
      ...sample(5, 8, [[0.3, 0.5]]),
      ...sample(8, 10, [[0.5, 0.7]]),
    ]
    const framing = computeFraming({
      ...base,
      shots: [SHOT_A],
      segments: [seg(0, 10)],
      people: drift,
      ratio: '4:5',
    })
    expect(framing.shots[0].cropX).toBeCloseTo(0.3, 6)
  })

  // Dans le plateau, on se pose sur le centre médian de l'action et non au
  // milieu du plateau : tout point du plateau cadre les mêmes images, donc la
  // marge que donnerait le milieu ne protège de rien, alors que l'écart au
  // centre de l'action se voit. Ici, 0,35 où sont les douze images contre 0,42
  // au milieu du plateau — 134 px sur 1920.
  it('se pose sur le centre de l’action dans le plateau, pas au milieu du plateau', () => {
    const framing = computeFraming({
      ...base,
      shots: [SHOT_A],
      segments: [seg(0, 10)],
      people: [
        ...sample(0, 6, [[0.3, 0.4]]),
        ...sample(6, 10, [[0.44, 0.54]]),
      ],
      ratio: '1:1',
    })
    expect(framing.shots[0].cropX).toBeCloseTo(0.35, 6)
  })

  // Un plan partagé en deux moitiés symétriques n'a pas de bonne réponse. Ce qui
  // compte est que la médiane de l'action tombe au milieu — et non sur la moitié
  // gauche, ce que faisait la médiane basse d'un effectif pair — et que le
  // départage restant soit annoncé : la position la plus à gauche.
  //
  // Le cadrage automatique n'atteint jamais ce cas : un tel plan ne cadre que la
  // moitié de ses images, donc le ratio monte jusqu'à les prendre toutes.
  it('ne penche pas à gauche sur un plan symétrique, et le dit quand il faut trancher', () => {
    const symmetric = {
      ...base,
      shots: [SHOT_A],
      segments: [seg(0, 10)],
      people: [
        ...sample(0, 5, [[0.1, 0.3]]),
        ...sample(5, 10, [[0.7, 0.9]]),
      ],
      // **La marge est posée ici, et à zéro.** Ce test porte sur le départage
      // entre deux positions à égalité, pas sur l'air laissé autour des gens :
      // laisser le défaut ferait bouger les nombres attendus au prochain
      // réglage de `margin`, sur un test qui ne le mesure pas. Le 18 août 2026,
      // c'est exactement ce qui est arrivé — le défaut est passé de 0,02 à 0,01
      // et trois assertions ont cassé sans qu'aucun comportement ne change.
      margin: 0,
    }
    expect(computeFraming(symmetric).ratio).toBe('16:9')
    expect(computeFraming(symmetric).shots[0].cropX).toBeCloseTo(0.5, 6)

    // Ratio épinglé trop étroit : les deux moitiés s'excluent, aucune ne cadre
    // plus d'images que l'autre, et le départage tombe à gauche.
    const pinned = computeFraming({ ...symmetric, ratio: '4:5' })
    expect(pinned.shots[0].cropX).toBeCloseTo(0.325, 6)

    // Et « à gauche » veut bien dire à gauche dans l'image, pas en premier dans
    // le tableau : l'ordre des boîtes dans un JSON n'est pas une décision.
    const toReversed = computeFraming({
      ...symmetric,
      ratio: '4:5',
      people: [...symmetric.people].reverse(),
    })
    expect(toReversed.shots[0].cropX).toBeCloseTo(0.325, 6)

    // Le seuil sous lequel deux positions sont réputées à égalité. La moitié
    // droite est ici mathématiquement plus proche du centre de l'action, mais de
    // 5e-10 — soit un millionième de pixel sur 1920. Sans ce seuil, c'est le
    // dernier bit d'un flottant qui cadrerait le plan.
    const almostEqual = computeFraming({
      ...symmetric,
      ratio: '4:5',
      people: [
        ...sample(0, 5, [[0.1, 0.3]]),
        ...sample(5, 10, [[0.7, 0.9 - 5e-10]]),
      ],
    })
    expect(almostEqual.shots[0].cropX).toBeCloseTo(0.325, 6)
  })

  it('ne rend jamais un crop qui sortirait du cadre', () => {
    const stuck = sample(0, 10, [[0.86, 0.99]])
    const framing = computeFraming({ ...base, shots: [SHOT_A], segments: [seg(0, 10)], people: stuck })
    const r = cropRect(framing.ratio, framing.shots[0].cropX, SRC_W, SRC_H)
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.x + r.w).toBeLessThanOrEqual(SRC_W)
  })

  it('refuse une source aux dimensions invalides', () => {
    expect(() => computeFraming({ ...base, srcW: Number.NaN })).toThrow(/source/)
  })

  it('ne laisse pas un réglage non fini produire un crop « calculé » qui ne l’est pas', () => {
    const framing = computeFraming({ ...base, margin: Number.NaN })
    expect(framing).toEqual(computeFraming(base))
    expect(framing.shots.every((s) => Number.isFinite(s.cropX))).toBe(true)
  })

  // Le repli de `shotCrop` : un ratio épinglé trop étroit pour l'action, donc
  // aucune position ne cadre une image entière. On se pose alors sur le centre
  // **médian** de l'action — 0,325, où sont les 12 premières images — et non sur
  // le milieu de son étendue, qui serait 0,5 et ne montrerait ni l'un ni l'autre.
  it('se pose sur la médiane de l’action quand aucune image ne tient dans la fenêtre', () => {
    const framing = computeFraming({
      ...base,
      shots: [SHOT_A],
      segments: [seg(0, 10)],
      people: [
        ...sample(0, 6, [[0.1, 0.55]]),
        ...sample(6, 10, [[0.45, 0.9]]),
      ],
      ratio: '9:16',
    })
    expect(framing.shots[0].source).toBe('auto')
    expect(framing.shots[0].cropX).toBeCloseTo(0.325, 6)
  })

  describe('quand le ratio est épinglé', () => {
    // L'action est à droite et déborde du 4:5 : l'automatique prendrait un 1:1.
    const toRight = {
      ...base,
      shots: [SHOT_A],
      segments: [seg(0, 10)],
      people: sample(0, 10, [
        [0.55, 0.7],
        [0.85, 0.99],
      ]),
      // Posée, pour la même raison que plus haut — et ici elle décide en plus du
      // ratio choisi : à marge nulle l'empan tombe à 0,44, que le 4:5 couvre, et
      // le test ne comparerait plus un 9:16 épinglé à un 1:1 automatique.
      margin: 0.02,
    }

    it('saute le choix du ratio mais pas le calcul des crops', () => {
      const auto = computeFraming(toRight)
      expect(auto.ratio).toBe('1:1')
      expect(auto.shots[0].cropX).toBeCloseTo(0.71875, 6)

      // Le même plan, cadré pour un 9:16 : la fenêtre est plus étroite, donc
      // elle peut se poser plus à droite sans sortir de l'image. Un crop calculé
      // pour le 1:1 et posé dans un canevas 9:16 raterait le bord droit.
      const pinned = computeFraming({ ...toRight, ratio: '9:16' })
      expect(pinned.ratio).toBe('9:16')
      expect(pinned.shots[0].cropX).toBeCloseTo(0.765, 6)
    })
  })

  describe('les dérogations humaines', () => {
    it('ignore la table en mode auto — un curseur ne bascule pas le mode à lui seul', () => {
      const framing = computeFraming({ ...base, crops: { 10000: 0.05 } })
      expect(framing.shots[1].cropX).toBeCloseTo(0.725, 6)
      expect(framing.shots[1].source).toBe('auto')
      expect(framing.rejectedOverrides).toEqual([])
    })

    it('pose la dérogation par-dessus le crop calculé, plan par plan', () => {
      const framing = computeFraming({ ...base, cropMode: 'manual', crops: { 10000: 0.05 } })
      // Le plan non dérogé garde son crop calculé.
      expect(framing.shots[0]).toMatchObject({ key: 0, source: 'auto' })
      expect(framing.shots[0].cropX).toBeCloseTo(0.4, 6)
      expect(framing.shots[1]).toMatchObject({ key: 10000, cropX: 0.05, source: 'manual' })
    })

    it('apparie une clé décalée de quelques images', () => {
      const framing = computeFraming({ ...base, cropMode: 'manual', crops: { 10120: 0.05 } })
      expect(framing.shots[1]).toMatchObject({ key: 10000, cropX: 0.05, source: 'manual' })
      expect(framing.rejectedOverrides).toEqual([])
    })

    // Le cas qui se produira le jour où l'analyse sera relancée avec un
    // détecteur modifié. La dérogation est **rendue à l'appelant**, jamais
    // reportée sur la frontière voisine : un cadrage humain posé sur un autre
    // plan est un cadrage faux que rien ne signale.
    it('rejette une dérogation orpheline plutôt que de la reporter sur une voisine', () => {
      const moved = [SHOT_A, shot(10.4, 20)]
      const framing = computeFraming({
        ...base,
        shots: moved,
        cropMode: 'manual',
        crops: { 10000: 0.05 },
      })
      expect(framing.rejectedOverrides).toEqual([10000])
      expect(framing.shots.map((s) => s.source)).toEqual(['auto', 'auto'])
      expect(framing.shots[0].cropX).toBeCloseTo(0.4, 6)
    })

    it('rejette une clé qui ne désigne aucun plan du clip', () => {
      const framing = computeFraming({ ...base, cropMode: 'manual', crops: { 42000: 0.05 } })
      expect(framing.rejectedOverrides).toEqual([42000])
      expect(framing.shots.every((s) => s.source === 'auto')).toBe(true)
    })

    // La plus proche gagne, et pas la dernière lue : l'ordre des clés dans un
    // objet JSON n'est pas une décision humaine, la distance en est une.
    it('garde la plus proche quand deux dérogations visent le même plan', () => {
      const late = computeFraming({
        ...base,
        cropMode: 'manual',
        crops: { 9950: 0.2, 10200: 0.8 },
      })
      expect(late.shots[1]).toMatchObject({ key: 10000, cropX: 0.2, source: 'manual' })
      expect(late.rejectedOverrides).toEqual([10200])

      const early = computeFraming({
        ...base,
        cropMode: 'manual',
        crops: { 9800: 0.2, 10050: 0.8 },
      })
      expect(early.shots[1]).toMatchObject({ key: 10000, cropX: 0.8, source: 'manual' })
      expect(early.rejectedOverrides).toEqual([9800])
    })

    it('borne une valeur hors de [0, 1] au lieu de la rejeter — c’est une intention', () => {
      const framing = computeFraming({ ...base, cropMode: 'manual', crops: { 0: 1.4 } })
      expect(framing.shots[0]).toMatchObject({ key: 0, cropX: 1, source: 'manual' })
    })

    it('rejette une valeur non finie', () => {
      const framing = computeFraming({
        ...base,
        cropMode: 'manual',
        crops: { 0: Number.NaN },
      })
      expect(framing.rejectedOverrides).toEqual([0])
      expect(framing.shots[0].source).toBe('auto')
    })

    it('rend les rejets triés, sans doublon', () => {
      const framing = computeFraming({
        ...base,
        cropMode: 'manual',
        crops: { 42000: 0.5, 5000: 0.5 },
      })
      expect(framing.rejectedOverrides).toEqual([5000, 42000])
    })
  })

  describe('quand personne n’est détecté', () => {
    // Aucune mesure sur tout le clip : le 16:9 ne perd rien et se voit, là où un
    // 9:16 aveugle couperait les comédiens en silence.
    it('sur tout le clip, prend le ratio le plus large et centre les crops', () => {
      const framing = computeFraming({ ...base, people: [] })
      expect(framing.ratio).toBe('16:9')
      expect(framing.shots.map((s) => s.source)).toEqual(['default', 'default'])
      expect(framing.shots.map((s) => s.cropX)).toEqual([0.5, 0.5])
    })

    // Un plan aveugle n'emprunte pas le crop de son voisin : une frontière de
    // plan est précisément l'endroit où l'axe change.
    it('sur un plan seulement, centre ce plan et laisse les autres tranquilles', () => {
      const framing = computeFraming({ ...base, people: sample(0, 10, [[0.2, 0.6]]) })
      expect(framing.shots[0].source).toBe('auto')
      expect(framing.shots[1]).toMatchObject({ key: 10000, cropX: 0.5, source: 'default' })
    })

    it('reste dérogeable : un plan aveugle accepte une dérogation humaine', () => {
      const framing = computeFraming({
        ...base,
        people: sample(0, 10, [[0.2, 0.6]]),
        cropMode: 'manual',
        crops: { 10000: 0.83 },
      })
      expect(framing.shots[1]).toMatchObject({ cropX: 0.83, source: 'manual' })
    })
  })
})

/**
 * Le filtre du premier plan.
 *
 * Les nombres viennent de `docs/premier-plan.md`, qui les a comptés sur
 * `2025-06-15-cqlp` et `2026-03-08-caro-mdlm`. Ce qui est fixé ici, c'est la
 * **règle**, pas les seuils : les seuils sont des réglages et tombent dans un
 * creux de la distribution, donc les déplacer de quelques centièmes ne doit
 * casser aucun de ces tests.
 */
describe('isForeground', () => {
  /** Une boîte avec ses quatre bords, puisque c'est de hauteur qu'il s'agit. */
  const frame = (x0: number, x1: number, y0: number, y1: number, score = 0.9): PersonBox => ({
    t: 1,
    x0,
    x1,
    y0,
    y1,
    score,
  })

  /** Une tête de spectateur au premier rang : le bas de l'image la coupe. */
  const spectator = frame(0, 0.18, 0.86, 0.998)
  /** Un comédien debout : ses pieds touchent le bas du cadre, et il est haut. */
  const performerStanding = frame(0.3, 0.45, 0.16, 0.99)
  /** Deux comédiens assis dans le noir, à 419 s : courts, mais loin du bord bas. */
  const performerDistant = frame(0.41, 0.52, 0.2, 0.47)

  it('écarte une tête tronquée par le bord bas', () => {
    expect(isForeground(spectator)).toBe(true)
  })

  // 76 % des boîtes de comédiens de `cqlp` touchent le bas de l'image. Un filtre
  // qui ne regarde que le bord bas ne laisse survivre que 16 % des boîtes.
  it('garde un comédien debout dont les pieds touchent le bas', () => {
    expect(isForeground(performerStanding)).toBe(false)
  })

  // Le contre-exemple trouvé à l'image : une hauteur minimale sans condition de
  // bord vide ce plan-là de ses deux comédiens. Sur `caro-mdlm`, 3 075 boîtes.
  it('garde une boîte courte mais détachée du bord bas', () => {
    expect(isForeground(performerDistant)).toBe(false)
  })

  it('les deux conditions sont nécessaires, et aucune ne suffit', () => {
    // Courte et collée : écartée. Courte et détachée, haute et collée : gardées.
    expect(isForeground(frame(0, 0.2, 0.8, 1))).toBe(true)
    expect(isForeground(frame(0, 0.2, 0.6, 0.8))).toBe(false)
    expect(isForeground(frame(0, 0.2, 0.1, 1))).toBe(false)
  })

  it('les seuils sont des réglages, pas des constantes gravées', () => {
    expect(isForeground(spectator, { foregroundMaxHeight: 0.1 })).toBe(false)
    expect(isForeground(performerStanding, { foregroundMaxHeight: 0.9 })).toBe(true)
    expect(isForeground(spectator, { bottomEdge: 0.999 })).toBe(false)
  })

  // C'est ce qui rend l'avant/après mesurable sans deux versions du code.
  it('une hauteur maximale nulle éteint le filtre : rien n’est plus court que zéro', () => {
    expect(isForeground(spectator, { foregroundMaxHeight: 0 })).toBe(false)
    // Une valeur négative ne peut pas retourner le sens du filtre.
    expect(isForeground(spectator, { foregroundMaxHeight: -1 })).toBe(false)
  })

  // Le bord est inclusif et la hauteur exclusive, comme les seuils de `empans` :
  // une boîte pile au seuil de hauteur est un comédien, pas du public.
  it('tranche les cas pile sur les seuils', () => {
    // Le bord est inclusif : une boîte qui l'atteint est tronquée.
    expect(isForeground(frame(0, 0.2, 0.7, 0.97), { bottomEdge: 0.97 })).toBe(true)
    expect(isForeground(frame(0, 0.2, 0.7, 0.9699), { bottomEdge: 0.97 })).toBe(false)
    // La hauteur est exclusive : pile au seuil, c'est un comédien. Les bornes
    // partent de zéro pour que la soustraction soit exacte — `1 - 0.65` ne vaut
    // pas 0,35 en flottant, et un test de borne ne doit pas dépendre de ça.
    const edgeEverywhere = { bottomEdge: 0 }
    expect(isForeground(frame(0, 0.2, 0, 0.35), { ...edgeEverywhere, foregroundMaxHeight: 0.35 })).toBe(
      false,
    )
    expect(isForeground(frame(0, 0.2, 0, 0.34), { ...edgeEverywhere, foregroundMaxHeight: 0.35 })).toBe(
      true,
    )
  })

  // Même motif que `margin` et `minScore` : `??` laisserait passer un `NaN`, qui
  // rendrait toute comparaison fausse et éteindrait le filtre en silence.
  it('retombe sur les défauts quand un réglage n’est pas fini', () => {
    expect(isForeground(spectator, { foregroundMaxHeight: Number.NaN })).toBe(true)
    expect(isForeground(spectator, { bottomEdge: Number.NaN })).toBe(true)
  })

  // Un filtre qui ne peut pas juger ne rejette pas : la boîte survit et c'est
  // `empans` qui décidera si elle est exploitable.
  it('garde une boîte dont la hauteur ne se mesure pas', () => {
    expect(isForeground(frame(0, 0.2, Number.NaN, 0.99))).toBe(false)
    expect(isForeground(frame(0, 0.2, 0.8, Number.NaN))).toBe(false)
  })
})

// `sizeFloor: 0` accompagne `foregroundMaxHeight: 0` ci-dessous : le public est
// aussi bien plus court que les comédiens, et sans l'éteindre le plancher de
// taille l'écarterait à leur place, ce que ce bloc ne teste pas.
describe('le premier plan écarté du cadrage', () => {
  /** Un plan de 10 s où deux comédiens tiennent le tiers central du cadre. */
  const performers = (t: number): PersonBox[] => [
    { t, x0: 0.37, x1: 0.46, y0: 0.15, y1: 0.99, score: 0.9 },
    { t, x0: 0.54, x1: 0.63, y0: 0.15, y1: 0.99, score: 0.9 },
  ]
  /** Deux têtes de spectateurs, une à chaque bord, qui étalent l'empan à tout. */
  const public_ = (t: number): PersonBox[] => [
    { t, x0: 0, x1: 0.16, y0: 0.85, y1: 0.998, score: 0.7 },
    { t, x0: 0.84, x1: 1, y0: 0.85, y1: 0.998, score: 0.7 },
  ]
  const onTen = (included: boolean): PersonBox[] => {
    const out: PersonBox[] = []
    for (let t = 0; t < 10 - 1e-9; t += 0.5) {
      out.push(...performers(Number(t.toFixed(3))))
      if (included) out.push(...public_(Number(t.toFixed(3))))
    }
    return out
  }

  it('resserre l’empan sur les comédiens au lieu de l’étaler d’un bord à l’autre', () => {
    const boxes = onTen(true)
    expect(
      requiredWidths(boxes, { margin: 0, foregroundMaxHeight: 0, sizeFloor: 0, ...NO_TRIM })[0],
    ).toBeCloseTo(1, 10)
    // `sizeFloor: 0` ici aussi : le public synthétique est bien plus court que
    // les comédiens, donc le plancher par défaut l'écarterait seul — cette
    // branche doit isoler `foregroundMaxHeight`, pas les cumuler. (relevé par
    // Copilot)
    expect(
      requiredWidths(boxes, { margin: 0, sizeFloor: 0, ...NO_TRIM })[0],
    ).toBeCloseTo(0.26, 10)
  })

  // Le constat qui a motivé la tâche : sans le filtre, tout sort au ratio le
  // plus large, c'est-à-dire à rien.
  it('fait descendre le ratio du 16:9 au 9:16', () => {
    const boxes = onTen(true)
    expect(chooseRatio(boxes, SRC_W, SRC_H, { foregroundMaxHeight: 0, sizeFloor: 0 })).toBe(
      '16:9',
    )
    // `sizeFloor: 0` : isole `foregroundMaxHeight`, sans quoi le plancher par
    // défaut écarterait déjà le public seul. (relevé par Copilot)
    expect(chooseRatio(boxes, SRC_W, SRC_H, { sizeFloor: 0 })).toBe('9:16')
  })

  it('ne change rien à une émission sans public au cadre', () => {
    const boxes = onTen(false)
    expect(chooseRatio(boxes, SRC_W, SRC_H, { foregroundMaxHeight: 0 })).toBe(
      chooseRatio(boxes, SRC_W, SRC_H),
    )
  })

  /**
   * **Le filtre peut faire monter un ratio, et c'est voulu.**
   *
   * Une image dont toutes les boîtes sont du premier plan ne rend plus rien —
   * elle ne dit pas que le cadre peut être serré, elle ne dit rien. Un clip
   * entier dans ce cas prend le ratio le plus large, comme n'importe quel clip
   * sans mesure.
   *
   * Le cas est réel et il a été vu : à 9 071 s de `2026-03-08-caro-mdlm`, la
   * seule détection de trente secondes est un **poisson rouge** du générique de
   * fin, à 0,57 de confiance. Sans le filtre, la fenêtre se cadrait en 9:16 sur
   * le poisson ; avec, elle sort en 16:9. Entre une faute silencieuse et une
   * faute voyante, on prend la voyante (voir `chooseRatio`).
   */
  it('rend le ratio le plus large quand il ne reste plus rien à mesurer', () => {
    const fish: PersonBox[] = [{ t: 1, x0: 0, x1: 0.29, y0: 0.74, y1: 0.998, score: 0.57 }]
    expect(chooseRatio(fish, SRC_W, SRC_H, { foregroundMaxHeight: 0 })).toBe('9:16')
    expect(chooseRatio(fish, SRC_W, SRC_H)).toBe('16:9')
  })

  it('traverse computeFraming : le réglage passe de la requête aux empans', () => {
    const common = {
      segments: [seg(0, 10)],
      shots: [shot(0, 10)],
      people: onTen(true),
      srcW: SRC_W,
      srcH: SRC_H,
      ratio: 'auto' as const,
      cropMode: 'auto' as const,
    }
    expect(computeFraming({ ...common, foregroundMaxHeight: 0, sizeFloor: 0 }).ratio).toBe(
      '16:9',
    )
    // `sizeFloor: 0` : isole `foregroundMaxHeight`, même raison que ci-dessus.
    // (relevé par Copilot)
    const frame = computeFraming({ ...common, sizeFloor: 0 })
    expect(frame.ratio).toBe('9:16')
    expect(frame.shots[0]).toMatchObject({ source: 'auto' })
  })

  /**
   * **Le crop se déplace aussi, et ce test-là doit être capable de le voir.**
   *
   * Sa première version comparait `cropX` à 0,5 sur un public symétrique : les
   * deux populations avaient le même centre, donc une régression qui aurait
   * continué de cadrer sur le public serait passée. Il faut un public **d'un seul
   * côté**, et une comparaison **à ratio égal** — en `'auto'` la version sans
   * filtre monte au 16:9, dont le crop couvre toute la largeur et vaut donc 0,5
   * quoi qu'il arrive. (relevé par Copilot)
   */
  it('déplace le crop, et pas seulement le ratio', () => {
    const toLeft = (t: number): PersonBox[] => [
      { t, x0: 0, x1: 0.16, y0: 0.85, y1: 0.998, score: 0.7 },
      { t, x0: 0.1, x1: 0.26, y0: 0.85, y1: 0.998, score: 0.7 },
    ]
    const people: PersonBox[] = []
    for (let t = 0; t < 10 - 1e-9; t += 0.5) {
      const key = Number(t.toFixed(3))
      people.push(...performers(key), ...toLeft(key))
    }
    const common = {
      segments: [seg(0, 10)],
      shots: [shot(0, 10)],
      people: people,
      srcW: SRC_W,
      srcH: SRC_H,
      // Épinglé : c'est la seule façon de comparer deux positions comparables.
      ratio: '1:1' as const,
      cropMode: 'auto' as const,
      // Et la marge posée, pour que le déplacement mesuré soit celui du filtre
      // et non celui d'un réglage qui bouge à côté. Même raison pour le rognage.
      margin: 0,
      ...NO_TRIM,
    }
    const withoutFilter = computeFraming({
      ...common,
      foregroundMaxHeight: 0,
      sizeFloor: 0,
    }).shots[0].cropX
    // `sizeFloor: 0` : le public d'un seul côté est aussi bien plus court que
    // les comédiens, isole `foregroundMaxHeight` pour la même raison qu'au-
    // dessus. (relevé par Copilot)
    const withFilter = computeFraming({ ...common, sizeFloor: 0 }).shots[0].cropX
    // Le public tire le cadre vers le bord gauche ; les comédiens le posent sur
    // le milieu de l'action, qu'ils occupent symétriquement.
    expect(withoutFilter).toBeCloseTo(0.315, 3)
    expect(withFilter).toBeCloseTo(0.5, 3)
  })
})

describe('sizeInCanvas', () => {
  const VERTICAL = { w: 1080, h: 1920 }

  // La table de la conception : ce qu'un cadre occupe du canevas vertical.
  it('donne la place de chaque ratio dans le canevas 9:16', () => {
    expect(sizeInCanvas('9:16', VERTICAL)).toEqual({ w: 1080, h: 1920 })
    expect(sizeInCanvas('4:5', VERTICAL)).toEqual({ w: 1080, h: 1350 })
    expect(sizeInCanvas('1:1', VERTICAL)).toEqual({ w: 1080, h: 1080 })
    expect(sizeInCanvas('16:9', VERTICAL)).toEqual({ w: 1080, h: 608 })
  })

  // Les parts annoncées : 100 %, 70,3 %, 56,3 %, 31,6 % de la hauteur. Comparées
  // à la part **nominale** et non au chiffre arrondi de la table : 608 pixels
  // sur 1920 font 31,67 % et non 31,6 %, parce que la hauteur est arrondie au
  // pair — ce que libx264 exige. L'écart est de deux dixièmes de pixel.
  it('retrouve les parts de hauteur de la conception', () => {
    for (const r of ALL) {
      expect(sizeInCanvas(r, VERTICAL).h / VERTICAL.h).toBeCloseTo(
        RATIOS['9:16'] / RATIOS[r],
        3,
      )
    }
  })

  // libx264 refuse une dimension impaire en yuv420p. 1080 / (16/9) vaut 607,5,
  // et c'est le seul des quatre qui ne tombe pas juste.
  it('rend toujours une hauteur paire', () => {
    for (const r of ALL) expect(sizeInCanvas(r, VERTICAL).h % 2).toBe(0)
  })

  // Dans son propre canevas, un cadre remplit — c'est ce qui fait que le rendu
  // natif ne compose jamais de fond flouté, et que la même fonction sert des
  // deux côtés.
  it('remplit le canevas qui a son propre ratio', () => {
    for (const r of ALL) {
      const canvas = outputSize(r)
      expect(sizeInCanvas(r, canvas).h).toBe(canvas.h)
    }
  })
})

describe('le ratio par plan', () => {
  // Deux plans très différents : l'un serré à gauche, l'autre large au centre.
  // Un ratio unique pour le clip écraserait le premier sous le second — c'est
  // exactement ce que le modèle par plan évite.
  const TIGHT = sample(0, 10, [[0.05, 0.2]])
  const WIDE = sample(10, 20, [[0.3, 0.8]])
  const twoShots = {
    ...base,
    people: [...TIGHT, ...WIDE],
    // La marge est posée à zéro : ce bloc mesure le choix du ratio, pas l'air
    // laissé autour des gens, et laisser le défaut ferait bouger les nombres au
    // prochain réglage de `margin`.
    margin: 0,
  }

  it('donne à chaque plan le cadre le plus serré qui tienne chez lui', () => {
    const framing = computeFraming(twoShots)
    expect(framing.shots.map((p) => p.ratio)).toEqual(['9:16', '1:1'])
  })

  // Le natif, celui du feed, garde **un seul** ratio : une vidéo dont les bandes
  // latérales apparaîtraient et disparaîtraient au fil des plans serait le
  // défaut que le fond flouté existe pour éviter.
  it('prend le plus large des plans pour le fichier natif', () => {
    expect(computeFraming(twoShots).ratio).toBe('1:1')
  })

  // **Deux positions, et elles diffèrent.** Une position optimisée pour un 9:16
  // posée dans une fenêtre 1:1 n'est pas fausse — elle est bornée dans l'image —
  // mais elle n'est plus celle qui cadre le plus d'images, et rien ne le dirait.
  it('calcule une position par fenêtre, celle du plan et celle du natif', () => {
    const [tight, wide] = computeFraming(twoShots).shots
    // Le plan serré, dans sa fenêtre 9:16 : collé à la butée gauche.
    expect(tight.cropX).toBeCloseTo(ratioCoverage('9:16', SRC_W, SRC_H) / 2, 6)
    // Le même plan, dans la fenêtre 1:1 du natif : la butée est plus loin.
    expect(tight.cropXNative).toBeCloseTo(ratioCoverage('1:1', SRC_W, SRC_H) / 2, 6)
    expect(tight.cropXNative).toBeGreaterThan(tight.cropX)
    // Le plan large est déjà au ratio du natif : les deux coïncident.
    expect(wide.ratio).toBe('1:1')
    expect(wide.cropXNative).toBeCloseTo(wide.cropX, 10)
  })

  // Un ratio épinglé est une contrainte sur le **cadre**, pas sur le format du
  // fichier : il vaut pour tous les plans, et les deux positions coïncident.
  it('épinglé, le ratio vaut pour tous les plans et les deux positions se rejoignent', () => {
    const framing = computeFraming({ ...twoShots, ratio: '4:5' })
    expect(framing.ratio).toBe('4:5')
    for (const p of framing.shots) {
      expect(p.ratio).toBe('4:5')
      expect(p.cropXNative).toBeCloseTo(p.cropX, 10)
    }
  })

  /**
   * **Un intervalle qu'aucun plan ne couvre compte comme un 16:9.**
   *
   * `splitByShot` lui donne le cadre le plus large, centré : on ne sait rien de
   * ce qui s'y passe. Mais le natif force *toutes* ses entrées au ratio du clip,
   * et ne produit pas de variante quand ce ratio vaut déjà 9:16 — un plan étroit
   * voisin d'un intervalle découvert faisait donc sortir le natif en 9:16, et la
   * queue s'y retrouvait rognée à l'aveugle. Le cas est atteignable : les plans
   * partitionnent la durée du *proxy*, la source peut finir plus loin.
   * (relevé par Codex et Copilot)
   */
  it('élargit le ratio natif quand le montage déborde des plans analysés', () => {
    const narrow = { ...base, margin: 0, people: sample(8, 10, [[0.45, 0.55]]) }
    // Le plan couvre [8, 10], le montage va jusqu'à 14 : quatre secondes que
    // personne n'a mesurées.
    const overflowing = computeFraming({
      ...narrow,
      shots: [shot(8, 10)],
      segments: [seg(8, 14)],
    })
    expect(overflowing.shots[0].ratio).toBe('9:16')
    expect(overflowing.ratio).toBe('16:9')

    // Le même montage entièrement couvert garde le ratio de son plan.
    const covered = computeFraming({ ...narrow, shots: [shot(8, 14)], segments: [seg(8, 14)] })
    expect(covered.ratio).toBe('9:16')
  })

  // Sous une image, l'intervalle est absorbé par son voisin dans le découpage et
  // ne porte aucun cadre à lui : l'élargir serait une faute dans l'autre sens.
  it('ignore un débordement plus court qu’une image', () => {
    const framing = computeFraming({
      ...base,
      margin: 0,
      people: sample(8, 10, [[0.45, 0.55]]),
      shots: [shot(8, 10)],
      segments: [seg(8, 10 + MIN_PIECE_SEC / 2)],
    })
    expect(framing.ratio).toBe('9:16')
  })

  // Sans plan du tout, le ratio natif est le plus large — la même réponse que
  // `chooseRatio` quand il ne mesure rien : une sortie visiblement large se
  // rattrape d'un clic, un 9:16 aveugle coupe les comédiens sans un mot.
  it('sans aucun plan, prend le ratio le plus large pour le natif', () => {
    const framing = computeFraming({ ...base, shots: [], segments: [seg(0, 20)] })
    expect(framing.shots).toHaveLength(0)
    expect(framing.ratio).toBe('16:9')
  })

  // Une dérogation est une intention humaine sur *où regarder*, pas sur une
  // fenêtre : la poser d'un seul côté ferait diverger le natif et la variante
  // sur un plan que quelqu'un a cadré exprès, et l'écart ne se verrait qu'en
  // comparant deux fichiers.
  it('une dérogation écrit les deux positions', () => {
    const framing = computeFraming({ ...twoShots, cropMode: 'manual', crops: { 0: 0.42 } })
    expect(framing.shots[0]).toMatchObject({ source: 'manual', cropX: 0.42, cropXNative: 0.42 })
    expect(framing.shots[1].source).toBe('auto')
  })
})

describe('le rognage latéral', () => {
  /** Les deux comédiens de `2025-06-15-cqlp` à 2120 s, relevés dans `analysis.json`. */
  const leftPerson = { x0: 0.106, x1: 0.49 }
  const rightPerson = { x0: 0.523, x1: 0.778 }
  /** Le plan de référence : 61 images, les deux comédiens immobiles. */
  const referenceShot = sample(0, 30.5, [
    [leftPerson.x0, leftPerson.x1],
    [rightPerson.x0, rightPerson.x1],
  ])

  it('abandonne une part de la largeur de chaque boîte, de chaque côté', () => {
    const b = box(0, 0.2, 0.6)
    expect(trimmedBounds(b, { sideTrim: 0.25, sideTrimMax: 1 })).toEqual({
      x0: expect.closeTo(0.3, 10),
      x1: expect.closeTo(0.5, 10),
    })
    expect(trimmedBounds(b, NO_TRIM)).toEqual({ x0: 0.2, x1: 0.6 })
  })

  /**
   * **Le plafond est ce qui empêche une boîte très large d'abandonner une tête.**
   *
   * Le cas est mesuré : sur `2026-03-08-caro-mdlm` à 7250 s, un comédien assis
   * jambes tendues donne une boîte de 0,536 de large dont la tête occupe
   * l'extrémité droite. Sans plafond, 30 % de chaque côté font 0,161 de l'image
   * et son visage tombe hors du cadre pendant les 28 secondes du plan.
   */
  it('plafonne ce qu’une boîte large peut abandonner', () => {
    const wideBox = box(0, 0.345, 0.881)
    const withoutCap = trimmedBounds(wideBox, { sideTrim: 0.3, sideTrimMax: 1 })
    expect(wideBox.x1 - withoutCap.x1).toBeCloseTo(0.161, 3)

    const withCap = trimmedBounds(wideBox, FRAMING_DEFAULTS)
    expect(wideBox.x1 - withCap.x1).toBeCloseTo(FRAMING_DEFAULTS.sideTrimMax, 10)
    expect(withCap.x0 - wideBox.x0).toBeCloseTo(FRAMING_DEFAULTS.sideTrimMax, 10)
  })

  // Une boîte étroite est gouvernée par la part, jamais par le plafond : c'est
  // ce qui protège un comédien lointain, qu'un rognage absolu effacerait.
  it('ne prend jamais plus que la part sur une boîte étroite', () => {
    const distantBox = box(0, 0.45, 0.55)
    const { x0, x1 } = trimmedBounds(distantBox, FRAMING_DEFAULTS)
    expect(x0 - distantBox.x0).toBeCloseTo(0.1 * FRAMING_DEFAULTS.sideTrim, 10)
    expect(x1 - x0).toBeGreaterThan(0)
  })

  // Une boîte ne se retourne pas : au pire elle se réduit à son centre. Un empan
  // dont la borne gauche passerait à droite de la droite ne se lit nulle part en
  // aval, et se propagerait en crop absurde.
  it('ne retourne jamais une boîte, quels que soient les réglages', () => {
    const b = box(0, 0.4, 0.44)
    const { x0, x1 } = trimmedBounds(b, { sideTrim: 5, sideTrimMax: 10 })
    expect(x1 - x0).toBeGreaterThanOrEqual(0)
    expect(x0).toBeCloseTo(0.42, 10)
    expect(x1).toBeCloseTo(0.42, 10)
  })

  it('retombe sur les défauts quand un réglage n’est pas fini', () => {
    const b = box(0, 0.2, 0.6)
    expect(trimmedBounds(b, { sideTrim: Number.NaN })).toEqual(trimmedBounds(b))
    expect(trimmedBounds(b, { sideTrimMax: Number.NaN })).toEqual(trimmedBounds(b))
  })

  /**
   * **Le cas qui a motivé le réglage, réduit à ses nombres.**
   *
   * Sur `2025-06-15-cqlp` à 2120 s, l'union des deux boîtes fait 0,672 quand un
   * 1:1 en couvre 0,5625 : **aucune** des 61 images ne tient, à aucun
   * percentile, donc aucun seuil n'aurait pu produire un 1:1. Vérifié à l'image,
   * le 1:1 garde pourtant les deux visages et les deux bustes.
   */
  it('fait basculer en 1:1 le plan que l’union des boîtes entières condamnait', () => {
    const union = rightPerson.x1 - leftPerson.x0
    expect(union).toBeGreaterThan(ratioCoverage('1:1', SRC_W, SRC_H))
    expect(chooseRatio(referenceShot, SRC_W, SRC_H, NO_TRIM)).toBe('16:9')
    expect(chooseRatio(referenceShot, SRC_W, SRC_H)).toBe('1:1')
  })

  /**
   * **Le rognage est une permission, pas une coupe.** Il ne décide que du
   * ratio ; la fenêtre retenue est plus large que l'empan rogné et rend
   * l'essentiel de ce qui avait été abandonné. Sur ce plan, chacun perd moins du
   * quart de sa largeur là où le réglage l'autorisait à en perdre 30 %.
   */
  it('rend au cadre ce que le rognage avait abandonné', () => {
    const framing = computeFraming({
      segments: [seg(0, 30.5)],
      shots: [shot(0, 30.5)],
      people: referenceShot,
      srcW: SRC_W,
      srcH: SRC_H,
      ratio: 'auto',
      cropMode: 'auto',
    })
    const width = ratioCoverage('1:1', SRC_W, SRC_H)
    const x = framing.shots[0].cropX - width / 2
    const loss = (b: { x0: number; x1: number }): number =>
      1 - (Math.min(b.x1, x + width) - Math.max(b.x0, x)) / (b.x1 - b.x0)
    expect(loss(leftPerson)).toBeLessThan(0.25)
    expect(loss(rightPerson)).toBeLessThan(0.25)
  })

  /**
   * **Le rognage ne peut pas élargir un ratio**, et c'est ce que la campagne du
   * 19 août 2026 a vérifié sur les trois émissions : de 0 à 0,40, aucun clip ni
   * aucune fenêtre ne s'élargit. La propriété se démontre — rogner ne peut que
   * réduire un empan, donc que rendre un ratio candidat plus atteignable — mais
   * une démonstration ne survit pas à une réécriture, et ce test si.
   */
  it('ne fait jamais monter un ratio', () => {
    const layouts: PersonBox[][] = [
      referenceShot,
      sample(0, 10, [[0.35, 0.65]]),
      sample(0, 10, [[0.02, 0.98]]),
      [...sample(0, 5, [[0.05, 0.25]]), ...sample(5, 10, [[0.75, 0.95]])],
      sample(0, 10, [
        [0.05, 0.3],
        [0.4, 0.5],
        [0.7, 0.98],
      ]),
    ]
    for (const people of layouts) {
      const withoutTrim = chooseRatio(people, SRC_W, SRC_H, NO_TRIM)
      for (const sideTrim of [0.1, 0.2, 0.3, 0.4]) {
        const withTrim = chooseRatio(people, SRC_W, SRC_H, { sideTrim })
        expect(RATIOS[withTrim]).toBeLessThanOrEqual(RATIOS[withoutTrim])
      }
    }
  })

  /**
   * Les deux valeurs, épinglées — même rôle que le test de la marge : elles ont
   * été choisies par une campagne, et les déplacer doit se voir.
   *
   * **Les seuils vérifiés ici sont ceux du plan reconstitué, pas ceux de la
   * campagne**, et l'écart mérite d'être dit plutôt que maquillé : les boîtes
   * posées ici sont immobiles, alors que les vraies bougent d'une image à
   * l'autre. Sur les 61 vraies images, le plan bascule à partir d'une part de
   * 0,30 et d'un plafond de 0,09 ; ici, où rien ne remue, 0,21 et 0,07
   * suffisent. Un test qui recopierait les seuils de la campagne mesurerait donc
   * autre chose qu'eux, et échouerait pour une raison qui n'est pas la bonne.
   *
   * Ce que la campagne a établi, et que `docs/ratios-par-clip.md` détaille : le
   * visage de `caro-mdlm` tombe à partir d'un plafond de 0,15, le plan de
   * référence exige 0,09, et le plafond retenu est au milieu de cet intervalle.
   */
  it('porte les valeurs de la campagne du 19 août 2026', () => {
    expect(FRAMING_DEFAULTS.sideTrim).toBe(0.3)
    expect(FRAMING_DEFAULTS.sideTrimMax).toBe(0.12)

    const ratio = (sideTrim: number, sideTrimMax: number): Ratio =>
      chooseRatio(referenceShot, SRC_W, SRC_H, { sideTrim, sideTrimMax })
    // Les deux bornes mordent : abaisser l'une ou l'autre sous son seuil rend
    // le 16:9. Aucune des deux n'est décorative.
    expect(ratio(0.2, FRAMING_DEFAULTS.sideTrimMax)).toBe('16:9')
    expect(ratio(FRAMING_DEFAULTS.sideTrim, 0.06)).toBe('16:9')
    expect(ratio(FRAMING_DEFAULTS.sideTrim, FRAMING_DEFAULTS.sideTrimMax)).toBe('1:1')
  })
})

// ---------------------------------------------------------------------------

/**
 * Un squelette COCO à plat, à partir des seules abscisses qui nous intéressent.
 *
 * Les points non nommés sortent à confiance nulle : c'est ce que le détecteur
 * fait d'un membre qu'il ne voit pas, et c'est le cas qu'il faut éprouver — un
 * point invisible arrive avec une position quand même, souvent au milieu du
 * corps, et le compter resserre le tronc sans rien signaler.
 */
function skeleton(xByPoint: Partial<Record<keyof typeof POINT, number>>): number[] {
  const k = Array.from({ length: POINT_COUNT * 3 }, () => 0)
  for (const [name, x] of Object.entries(xByPoint)) {
    const index = POINT[name as keyof typeof POINT]
    k[index * 3] = x as number
    k[index * 3 + 1] = 0.4
    k[index * 3 + 2] = 0.9
  }
  return k
}

/** Une boîte de personne qui porte un squelette. */
function withPosed(
  t: number,
  x0: number,
  x1: number,
  xByPoint: Partial<Record<keyof typeof POINT, number>>,
  score = 0.9,
): PersonBox {
  return { ...box(t, x0, x1, score), k: skeleton(xByPoint) }
}

describe('le tronc déduit des points de pose', () => {
  /**
   * **Le cas de l'issue #69, relevé dans l'analyse du 19 août 2026.**
   *
   * Sur `2026-22-02-entre-nous` à 2 973 s, deux comédiennes assises. La boîte de
   * l'une va de 0,304 à 0,827 : ses jambes sont tendues vers la droite et sa
   * cheville est à 0,757, alors que sa tête tient entre 0,417 et 0,482. La
   * seconde va de 0,008 à 0,410 pour une tête entre 0,181 et 0,305.
   *
   * L'union des boîtes fait 0,819 quand un 1:1 en couvre 0,5625 ; celle des
   * troncs fait 0,454. Le ratio était décidé par des jambes que personne ne
   * regarde.
   */
  const extendedLegs = [
    withPosed(0, 0.304, 0.827, {
      NOSE: 0.482,
      RIGHT_EYE: 0.469,
      RIGHT_EAR: 0.417,
      LEFT_SHOULDER: 0.409,
      RIGHT_SHOULDER: 0.379,
      LEFT_KNEE: 0.663,
      LEFT_ANKLE: 0.743,
      RIGHT_ANKLE: 0.757,
    }),
    withPosed(0, 0.008, 0.41, {
      NOSE: 0.305,
      LEFT_EYE: 0.298,
      RIGHT_EYE: 0.271,
      RIGHT_EAR: 0.181,
      LEFT_SHOULDER: 0.309,
      RIGHT_SHOULDER: 0.078,
    }),
  ]

  it('ignore les jambes, que le cadre n’a aucune raison de contenir', () => {
    const torso = torsoBounds(extendedLegs[0], { torsoPad: 0, torsoTrim: 0 })
    expect(torso).not.toBeNull()
    // Les épaules et le nez, pas la cheville à 0,757.
    expect(torso?.x0).toBeCloseTo(0.379, 10)
    expect(torso?.x1).toBeCloseTo(0.482, 10)
  })

  it('fait tomber sous le 16:9 le plan que les jambes y maintenaient', () => {
    const shot = []
    for (let t = 0; t < 10; t += 0.5) {
      for (const p of extendedLegs) shot.push({ ...p, t })
    }
    expect(chooseRatio(shot, SRC_W, SRC_H, { torso: 'off' })).toBe('16:9')
    // 4:5 et non 1:1 : aux réglages retenus, les troncs rognés font une union de
    // 0,370 quand un 4:5 en couvre 0,450. L'issue #69 comptait les têtes seules
    // et annonçait 0,45 — les épaules et le rembourrage ajoutent le reste.
    expect(chooseRatio(shot, SRC_W, SRC_H)).toBe('4:5')
  })

  /**
   * **Le contre-exemple qui a posé le plafond du rognage latéral, et que le
   * tronc rend sans objet.**
   *
   * Sur `2026-03-08-caro-mdlm` à 7 250 s, un comédien assis jambes tendues vers
   * la gauche : boîte de 0,332 à 0,873, tête entre 0,704 et 0,813 — à
   * l'extrémité **droite** de sa boîte. Le rognage latéral, qui abandonne une
   * part de chaque côté sans savoir ce qu'elle contient, s'arrête à 0,711 sans
   * plafond : son visage tombe dehors pendant les 28 secondes du plan. Le tronc
   * n'a pas besoin du plafond, parce qu'il ne devine pas où est la tête.
   */
  it('garde la tête d’une boîte large dont la tête est à un bout', () => {
    const seated = withPosed(0, 0.332, 0.873, {
      NOSE: 0.722,
      LEFT_EYE: 0.751,
      RIGHT_EYE: 0.727,
      LEFT_EAR: 0.801,
      LEFT_SHOULDER: 0.813,
      RIGHT_SHOULDER: 0.704,
      LEFT_ANKLE: 0.36,
    })
    // Ce que le rognage latéral faisait, plafond retiré : le visage dehors.
    const withoutCap = trimmedBounds(seated, { sideTrim: 0.3, sideTrimMax: 1 })
    expect(withoutCap.x1).toBeLessThan(0.722)

    const torso = torsoBounds(seated, { torsoPad: 0, torsoTrim: 0 })
    expect(torso?.x0).toBeCloseTo(0.704, 10)
    expect(torso?.x1).toBeCloseTo(0.813, 10)
    // Et le tronc y arrive **sans plafond** : le réglage qui protégeait la tête
    // par un pari ne sert plus à rien là où les points la nomment.
    expect(personBounds(seated, { sideTrimMax: 1 })).toEqual(personBounds(seated))
  })

  it('n’écoute pas un point que le réseau n’a pas vu', () => {
    // Une hanche à confiance nulle posée loin sur la gauche : elle ne doit pas
    // entrer dans un tronc qui l'inclut, sinon un membre invisible décide du
    // cadre — le défaut qu'on répare, retourné.
    const k = skeleton({ LEFT_SHOULDER: 0.4, RIGHT_SHOULDER: 0.5 })
    k[POINT.LEFT_HIP * 3] = 0.05
    k[POINT.LEFT_HIP * 3 + 2] = 0.01
    const b: PersonBox = { ...box(0, 0.02, 0.6), k }
    const torso = torsoBounds(b, { torso: 'bust-hips', torsoPad: 0, torsoTrim: 0 })
    expect(torso?.x0).toBeCloseTo(0.4, 10)
  })

  /**
   * **Un seul point n'est pas un tronc.** L'intervalle serait de largeur nulle :
   * ce n'est pas un cadrage serré, c'est une personne réduite à un nez. On rend
   * `null`, et l'appelant retombe sur la boîte — c'est-à-dire sur le
   * comportement mesuré du 19 août, qui marchait.
   */
  it('retombe sur la boîte rognée quand le tronc n’est pas lisible', () => {
    const noseOnly = withPosed(0, 0.2, 0.6, { NOSE: 0.4 })
    expect(torsoBounds(noseOnly)).toBeNull()
    expect(personBounds(noseOnly)).toEqual(trimmedBounds(noseOnly))

    const withoutKeypoints = box(0, 0.2, 0.6)
    expect(torsoBounds(withoutKeypoints)).toBeNull()
    expect(personBounds(withoutKeypoints)).toEqual(trimmedBounds(withoutKeypoints))
  })

  it('refuse un squelette de la mauvaise longueur plutôt que de le lire à moitié', () => {
    const truncated: PersonBox = { ...box(0, 0.2, 0.6), k: skeleton({ NOSE: 0.4 }).slice(0, 30) }
    expect(torsoBounds(truncated)).toBeNull()
  })

  it('éteint le tronc sur demande, et rend alors exactement la boîte rognée', () => {
    const b = extendedLegs[0]
    expect(torsoBounds(b, { torso: 'off' })).toBeNull()
    expect(personBounds(b, { torso: 'off' })).toEqual(trimmedBounds(b))
  })

  /**
   * **Le rembourrage existe parce qu'un point d'épaule est le centre d'une
   * articulation**, pas le bord de la silhouette. Sans lui, le cadre passe au
   * milieu de chaque épaule.
   */
  it('élargit le tronc à proportion de sa largeur', () => {
    const b = withPosed(0, 0.2, 0.8, { LEFT_SHOULDER: 0.4, RIGHT_SHOULDER: 0.6, NOSE: 0.5 })
    const { x0, x1 } = torsoBounds(b, { torsoPad: 0.15, torsoTrim: 0 }) ?? { x0: 0, x1: 0 }
    expect(x0).toBeCloseTo(0.4 - 0.03, 10)
    expect(x1).toBeCloseTo(0.6 + 0.03, 10)
  })

  /**
   * **Le rognage du tronc ne touche pas à la tête, et c'est ce qui le sépare de
   * `sideTrim`.** Celui-là abandonne des extrémités sans savoir ce qu'elles
   * contiennent, d'où son plafond ; celui-ci sait, donc il remet la tête dedans.
   */
  it('rogne les épaules, jamais la tête', () => {
    const profileView = withPosed(0, 0.2, 0.8, {
      NOSE: 0.3,
      RIGHT_EAR: 0.28,
      LEFT_SHOULDER: 0.7,
      RIGHT_SHOULDER: 0.5,
    })
    const { x0, x1 } = torsoBounds(profileView, { torsoPad: 0, torsoTrim: 0.5 }) ?? { x0: 0, x1: 0 }
    // Le tronc brut va de 0,28 à 0,70 ; rogné de moitié il se réduirait à son
    // milieu, 0,49. La tête le tire jusqu'à 0,28 et pas plus loin.
    expect(x0).toBeCloseTo(0.28, 10)
    expect(x1).toBeCloseTo(0.49, 10)
  })

  it('retombe sur les défauts quand un réglage n’est pas fini', () => {
    const b = extendedLegs[0]
    expect(torsoBounds(b, { torsoPad: Number.NaN })).toEqual(torsoBounds(b))
    expect(torsoBounds(b, { torsoTrim: Number.NaN })).toEqual(torsoBounds(b))
    expect(torsoBounds(b, { torsoMinScore: Number.NaN })).toEqual(torsoBounds(b))
  })

  /**
   * Les valeurs, épinglées — même rôle que pour la marge et le rognage latéral :
   * elles sortent d'une campagne, et les déplacer doit se voir.
   *
   * Ce que la campagne du 19 août 2026 a établi sur trois émissions, points de
   * pose compris (`docs/ratios-par-clip.md`) : le rognage du tronc a son coude à
   * 0,30 — de 0,20 à 0,30 il gagne cinq à six points de temps de montage sous le
   * 16:9, de 0,30 à 0,40 il n'en gagne que deux et commence à couper le tronc.
   * Le rembourrage, lui, ferme le rognage du tronc par lui-même dès 0,10 ; 0,15
   * est le point où le tronc n'est plus jamais coupé sur deux émissions sur
   * trois.
   */
  it('porte les valeurs de la campagne du 19 août 2026', () => {
    expect(FRAMING_DEFAULTS.torso).toBe('bust')
    expect(FRAMING_DEFAULTS.torsoMinScore).toBe(0.5)
    expect(FRAMING_DEFAULTS.torsoPad).toBe(0.15)
    expect(FRAMING_DEFAULTS.torsoTrim).toBe(0.3)
  })

  /**
   * **Le tronc ne remplace pas la boîte, et le filtre du premier plan le
   * prouve.** Sa géométrie — bord bas à 0,97, hauteur sous 0,35 — décrit une
   * troncature par le bas de l'image, ce qu'aucun squelette ne dit. Sur
   * `2025-06-15-cqlp`, c'est 30 % des boîtes.
   */
  it('laisse le filtre du premier plan lire la boîte, pas le tronc', () => {
    const spectator: PersonBox = {
      ...withPosed(0, 0.02, 0.2, { NOSE: 0.1, LEFT_EAR: 0.05, RIGHT_EAR: 0.15 }),
      y0: 0.8,
      y1: 0.999,
    }
    expect(isForeground(spectator)).toBe(true)
    // Même avec un tronc parfaitement lisible, il ne compte pas dans l'empan.
    expect(torsoBounds(spectator)).not.toBeNull()
    expect(requiredWidths([spectator, ...extendedLegs])).toEqual(
      requiredWidths(extendedLegs),
    )
  })

  /**
   * **Deux points vus ne font pas une largeur**, et le compte ne suffit donc pas
   * à décider du repli.
   *
   * Deux façons d'arriver à un tronc plat, toutes deux atteignables : le fichier
   * arrondit les abscisses au dix-millième, donc un profil pose l'œil sur
   * l'oreille ; et un `torsoTrim` de 0,5 rabat sur son milieu un tronc dont la
   * tête ne rattrape rien, faute de tête. Sans la garde, `torsoBounds` rendait
   * un intervalle de largeur nulle — exactement la « personne réduite à un
   * pixel » que sa documentation dit refuser —, et le crop se posait dessus.
   * (relevé par Copilot)
   */
  it('retombe sur la boîte quand le tronc n’a aucune largeur', () => {
    const coincident = withPosed(0, 0.2, 0.6, { LEFT_EAR: 0.37, LEFT_EYE: 0.37 })
    expect(torsoBounds(coincident)).toBeNull()
    expect(personBounds(coincident)).toEqual(trimmedBounds(coincident))

    // L'autre chemin : pas de tête pour servir de plancher, et tout le tronc
    // abandonné.
    const backView = withPosed(0, 0.2, 0.8, {
      LEFT_SHOULDER: 0.4,
      RIGHT_SHOULDER: 0.6,
      LEFT_HIP: 0.42,
      RIGHT_HIP: 0.58,
    })
    expect(torsoBounds(backView, { torso: 'shoulders-hips', torsoTrim: 0.5 })).toBeNull()
    expect(personBounds(backView, { torso: 'shoulders-hips', torsoTrim: 0.5 })).toEqual(
      trimmedBounds(backView),
    )
    // Et le même tronc, non rogné, reste bien lisible : c'est la largeur qui
    // décide, pas la définition.
    expect(torsoBounds(backView, { torso: 'shoulders-hips', torsoTrim: 0 })).not.toBeNull()
  })

  /**
   * **Un empan lu sur des points peut sortir de l'image en entier**, ce qu'un
   * empan lu sur des boîtes ne pouvait pas : `detect.py` borne les boîtes à
   * [0, 1] et laisse exprès les points en dehors, parce qu'une épaule que le
   * bord coupe est une information.
   *
   * Le bornage final ne ramenait alors qu'une extrémité de son côté — `g` à 0,
   * `d` laissé négatif — et rendait une largeur **négative**, qui traversait le
   * choix du ratio et la position sans rien signaler. (relevé par Copilot, dans
   * son bloc replié)
   */
  it('ne rend jamais une largeur négative, même pour un tronc hors cadre', () => {
    const offLeft = withPosed(0, 0.001, 0.02, { NOSE: -0.6, LEFT_EAR: -0.7, LEFT_EYE: -0.65 })
    const offRight = withPosed(1, 0.98, 0.999, { NOSE: 1.6, LEFT_EAR: 1.7, LEFT_EYE: 1.65 })
    for (const width of requiredWidths([offLeft, offRight])) {
      expect(width).toBeGreaterThanOrEqual(0)
    }
    // Et le ratio qui en sort reste le plus étroit, pas un 16:9 tiré d'un empan
    // aberrant.
    expect(chooseRatio([offLeft], SRC_W, SRC_H)).toBe('9:16')
  })
})

describe('headBounds', () => {
  it('rend les bornes des points de tête, pas ceux du reste du squelette', () => {
    const b = withPosed(0, 0.3, 0.5, {
      NOSE: 0.42,
      LEFT_EYE: 0.41,
      RIGHT_EYE: 0.44,
      LEFT_EAR: 0.39,
      RIGHT_SHOULDER: 0.47,
    })
    const head = headBounds(b)
    expect(head).not.toBeNull()
    expect(head?.x0).toBeCloseTo(0.39, 10)
    expect(head?.x1).toBeCloseTo(0.44, 10)
    // `skeleton()` pose y = 0.4 sur chaque point nommé : mêmes bornes en y.
    expect(head?.y0).toBeCloseTo(0.4, 10)
    expect(head?.y1).toBeCloseTo(0.4, 10)
  })

  it('rend null sans points de pose', () => {
    expect(headBounds(box(0, 0.3, 0.5, 0.9))).toBeNull()
  })

  it('rend null quand aucun point de tête ne passe le seuil de confiance', () => {
    const b = withPosed(0, 0.3, 0.5, { NOSE: 0.42 })
    expect(headBounds(b, { torsoMinScore: 0.95 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------

/** Une boîte de personne qui porte un squelette complet, donné brut. */
function personWithK(t: number, k: number[]): PersonBox {
  return { ...box(t, 0, 1), k }
}

describe('orientationOf', () => {
  // Quatre personnes réelles de `2026-05-31-nabla`, relevées à la main — voir
  // le rapport du spike pour le détail des écarts entre ce calcul et celui de
  // la demande d'origine.
  const personA = personWithK(770, [
    0.2812, 0.3218, 0.99, 0.3031, 0.2824, 0.99, 0.2629, 0.2794, 0.99, 0.3474, 0.2681, 0.97, 0.2411,
    0.2655, 0.4, 0.4112, 0.4269, 0.99, 0.1966, 0.4174, 0.99, 0.4198, 0.7324, 0.99, 0.1513, 0.6769,
    0.99, 0.2898, 0.8194, 0.99, 0.1557, 0.7903, 0.99, 0.3654, 0.8222, 0.98, 0.2154, 0.806, 0.99,
    0.387, 0.8944, 0.66, 0.1007, 0.887, 0.77, 0.3677, 1, 0.04, 0.1266, 1, 0.07,
  ])
  const personB = personWithK(770, [
    0.6568, 0.5065, 0.93, 0.6651, 0.4968, 0.97, 0.6823, 0.4741, 0.15, 0.7078, 0.5894, 0.99, 0.7594,
    0.5287, 0.01, 0.7911, 0.8343, 0.97, 0.813, 0.6769, 0.98, 0.7177, 1, 0.29, 0.7068, 0.9074, 0.71,
    0.6354, 0.9981, 0.2, 0.5906, 0.9704, 0.48, 0.8208, 1, 0.01, 0.8453, 0.9889, 0.03, 0.6307, 0.9602,
    0, 0.6625, 0.7324, 0, 0.6172, 1, 0, 0.6823, 0.9556, 0,
  ])
  const personC = personWithK(7160, [
    0.674, 0.2463, 0.99, 0.6948, 0.2222, 0.99, 0.6687, 0.2144, 0.95, 0.7438, 0.2359, 0.99, 0.6698,
    0.2141, 0.13, 0.7995, 0.3778, 0.99, 0.6307, 0.3491, 0.99, 0.8094, 0.6181, 0.99, 0.5677, 0.5588,
    0.99, 0.724, 0.7074, 0.99, 0.6344, 0.6375, 0.99, 0.7703, 0.725, 0.99, 0.6615, 0.7157, 0.99, 0.788,
    0.9199, 0.76, 0.6568, 0.919, 0.75, 0.7688, 0.9907, 0.03, 0.6865, 1, 0.03,
  ])
  const personD = personWithK(7160, [
    0.3141, 0.2991, 0.99, 0.3159, 0.266, 0.8, 0.2938, 0.2699, 0.99, 0.2935, 0.2667, 0.03, 0.237,
    0.2796, 0.99, 0.3005, 0.3838, 0.99, 0.1495, 0.431, 0.99, 0.3359, 0.588, 0.99, 0.1392, 0.7162,
    0.99, 0.4042, 0.6519, 0.99, 0.2812, 0.7394, 0.99, 0.2421, 0.7148, 0.98, 0.1435, 0.7556, 0.98,
    0.3031, 0.8301, 0.77, 0.1971, 0.8787, 0.81, 0.2241, 0.9032, 0.09, 0.1971, 0.9833, 0.08,
  ])

  it('rend la frontalité et le facing des quatre personnes de référence', () => {
    const a = orientationOf(personA)
    expect(a.terms.eyeTerm).toBe(1)
    expect(a.terms.earAsymmetry).toBeCloseTo(0.416, 2)
    expect(a.terms.shoulderRatio).toBeCloseTo(2.14, 1)
    expect(a.frontality).toBeCloseTo(0.861, 2)
    expect(a.facing).toBe('frontal')

    const b = orientationOf(personB)
    expect(b.terms.eyeTerm).toBe(0)
    expect(b.terms.earAsymmetry).toBeCloseTo(0.98, 2)
    expect(b.terms.shoulderRatio).toBeCloseTo(0.088, 2)
    expect(b.frontality).toBeCloseTo(0.036, 2)
    expect(b.facing).toBe('profile')

    const c = orientationOf(personC)
    expect(c.terms.eyeTerm).toBe(1)
    expect(c.terms.earAsymmetry).toBeCloseTo(0.767, 2)
    expect(c.terms.shoulderRatio).toBeCloseTo(1.44, 1)
    expect(c.frontality).toBeCloseTo(0.744, 2)
    expect(c.facing).toBe('frontal')

    const d = orientationOf(personD)
    expect(d.terms.eyeTerm).toBe(1)
    expect(d.terms.earAsymmetry).toBeCloseTo(0.941, 2)
    expect(d.terms.shoulderRatio).toBeCloseTo(1.39, 1)
    expect(d.frontality).toBeCloseTo(0.686, 2)
    expect(d.facing).toBe('frontal')
  })

  /**
   * **`side` sur B, C et D suit la demande d'origine ; A s'en écarte, et c'est
   * la formule qui fait foi.** Pour A, l'asymétrie d'oreille vaut 0,416 —
   * l'oreille gauche domine, mais l'écart reste *sous* `sideDeadband` (0,5) :
   * la formule dit donc `side = 0`, pas `-1`. La demande avait fixé `-1` à la
   * main sur la seule observation « l'oreille gauche domine », sans repasser
   * par le seuil de la zone morte. Voir le rapport du spike.
   */
  it('rend le côté vers lequel la personne est tournée', () => {
    expect(orientationOf(personA).side).toBe(0)
    expect(orientationOf(personB).side).toBe(-1)
    expect(orientationOf(personC).side).toBe(-1)
    expect(orientationOf(personD).side).toBe(1)
  })

  /**
   * **Une egalite parfaite n'est pas un cote, c'est une absence de cote.** Sous
   * `sideDeadband: 0`, deux confiances d'oreille egales et positives donnent
   * `earAsymmetry === 0`, qui franchit le seuil inclusif -- et le ternaire
   * tranchait alors au hasard, vers `1`. C'est la regle du depot : un defaut
   * prudent est juste face a une information absente, faux face a une information
   * ambigue. Deux hypotheses a une voix chacune se rejettent. (releve par Copilot)
   */
  it('garde `side` a 0 quand les deux oreilles sont a egalite', () => {
    const k = [...personA.k!]
    k[POINT.LEFT_EAR * 3 + 2] = 0.8
    k[POINT.RIGHT_EAR * 3 + 2] = 0.8
    const tied = personWithK(770, k)

    expect(orientationOf(tied).terms.earAsymmetry).toBe(0)
    expect(orientationOf(tied, { sideDeadband: 0 }).side).toBe(0)
    // Le meme squelette avec un ecart minuscule tranche, lui : c'est bien
    // l'egalite qu'on refuse, pas le seuil qu'on a deplace.
    const nudged = [...k]
    nudged[POINT.LEFT_EAR * 3 + 2] = 0.81
    expect(orientationOf(personWithK(770, nudged), { sideDeadband: 0 }).side).toBe(-1)
  })

  it('rend `unknown` et `frontality` `null` sans points de pose', () => {
    const result = orientationOf(box(0, 0.2, 0.6))
    expect(result.facing).toBe('unknown')
    expect(result.frontality).toBeNull()
    expect(result.side).toBe(0)
    expect(result.terms).toEqual({ earAsymmetry: null, eyeTerm: null, shoulderRatio: null })
  })

  it('rend `unknown` pour un squelette de la mauvaise longueur', () => {
    const tooShort = personWithK(0, personA.k!.slice(0, 50))
    const tooLong = personWithK(0, [...personA.k!, 0])
    expect(orientationOf(tooShort).facing).toBe('unknown')
    expect(orientationOf(tooLong).facing).toBe('unknown')
  })

  it('rend `unknown` quand toutes les confiances sont nulles — aucun terme disponible', () => {
    const nobody = personWithK(0, skeleton({}))
    const result = orientationOf(nobody)
    expect(result.facing).toBe('unknown')
    expect(result.frontality).toBeNull()
    expect(result.terms).toEqual({ earAsymmetry: null, eyeTerm: null, shoulderRatio: null })
  })

  /**
   * **La règle des deux termes.** Un seul signal disponible — ici les deux
   * yeux, sans oreille ni épaule confiantes — ne doit pas suffire à trancher
   * entre face et profil : c'est exactement ce qui empêche une oreille seule
   * de décider à la place du reste du visage.
   */
  it('rend `unknown` quand un seul terme est disponible', () => {
    const onlyEyes = personWithK(0, skeleton({ LEFT_EYE: 0.4, RIGHT_EYE: 0.6 }))
    const result = orientationOf(onlyEyes)
    expect(result.terms.eyeTerm).toBe(1)
    expect(result.terms.earAsymmetry).toBeNull()
    expect(result.terms.shoulderRatio).toBeNull()
    expect(result.facing).toBe('unknown')
    expect(result.frontality).toBeNull()
  })

  /**
   * **Les coordonnées ne sont pas bornées à [0, 1]**, côté épaules et nez
   * comme ailleurs dans ce fichier. Décaler nez et épaules d'un même montant —
   * positif ou négatif, largement hors de l'image — ne change ni `span` ni
   * `scale`, qui ne dépendent que de différences : le résultat doit rester
   * fini et de même nature qu'avant le décalage.
   */
  it('reste fini et de même nature avec des coordonnées d’épaule et de nez hors [0, 1]', () => {
    const reference = orientationOf(personA)
    for (const offset of [10, -10]) {
      const shifted = [...personA.k!]
      // NOSE (rang 0) et les deux épaules (rangs 5 et 6) : x et y.
      for (const rank of [0, 5, 6]) {
        shifted[rank * 3] += offset
        shifted[rank * 3 + 1] += offset
      }
      const result = orientationOf(personWithK(770, shifted))
      expect(Number.isFinite(result.frontality)).toBe(true)
      expect(result.facing).toBe(reference.facing)
      expect(result.terms.shoulderRatio).toBeCloseTo(reference.terms.shoulderRatio!, 6)
      expect(result.frontality).toBeCloseTo(reference.frontality!, 6)
    }
  })

  /**
   * **Une confiance à `NaN` tombe du côté écarté**, comme partout ailleurs
   * dans ce fichier — jamais un `frontality` à `NaN`.
   */
  it('écarte une confiance à NaN plutôt que de la laisser produire un NaN', () => {
    const withNaNEars = [...personA.k!]
    withNaNEars[POINT.LEFT_EAR * 3 + 2] = Number.NaN
    withNaNEars[POINT.RIGHT_EAR * 3 + 2] = Number.NaN
    const result = orientationOf(personWithK(770, withNaNEars))
    expect(result.terms.earAsymmetry).toBeNull()
    expect(result.frontality).not.toBeNaN()
    expect(Number.isFinite(result.frontality)).toBe(true)
    // Il ne reste que eyeTerm et shoulderRatio : la moyenne des deux.
    expect(result.frontality).toBeCloseTo(
      (1 + Math.min(1, result.terms.shoulderRatio!)) / 2,
      10,
    )

    const withNaNShoulder = [...personA.k!]
    withNaNShoulder[POINT.LEFT_SHOULDER * 3 + 2] = Number.NaN
    const shoulderResult = orientationOf(personWithK(770, withNaNShoulder))
    expect(shoulderResult.terms.shoulderRatio).toBeNull()
    expect(shoulderResult.frontality).not.toBeNaN()
  })

  /**
   * **`frontality` est `null` si et seulement si `facing` vaut `'unknown'`.**
   * Vérifié sur un échantillon qui couvre les deux régimes, pas sur une seule
   * entrée.
   */
  it('rend `frontality` null exactement quand `facing` vaut `unknown`', () => {
    const cases = [
      orientationOf(personA),
      orientationOf(personB),
      orientationOf(personC),
      orientationOf(personD),
      orientationOf(box(0, 0.2, 0.6)),
      orientationOf(personWithK(0, skeleton({}))),
      orientationOf(personWithK(0, skeleton({ LEFT_EYE: 0.4, RIGHT_EYE: 0.6 }))),
    ]
    for (const result of cases) {
      expect(result.frontality === null).toBe(result.facing === 'unknown')
    }
  })

  it('retombe sur les défauts quand un réglage n’est pas fini', () => {
    expect(orientationOf(personA, { pointMinScore: Number.NaN })).toEqual(orientationOf(personA))
    expect(orientationOf(personA, { shoulderRatioFull: Number.NaN })).toEqual(
      orientationOf(personA),
    )
    expect(orientationOf(personA, { frontalThreshold: Number.NaN })).toEqual(
      orientationOf(personA),
    )
    expect(orientationOf(personA, { sideDeadband: Number.NaN })).toEqual(orientationOf(personA))
  })

  /**
   * **Zero et negatif sont aussi invalides qu'un `NaN` sur un reglage qui
   * divise.** `setting` n'ecartait que le non-fini, donc `0` passait, la division
   * rendait `NaN`, et `facing` sortait decide sous une `frontality` `NaN` --
   * l'invariant d'au-dessus, franchi en silence. (releve par Copilot et Aristarque)
   */
  it('retombe sur le defaut quand shoulderRatioFull ne peut pas diviser', () => {
    for (const shoulderRatioFull of [0, -1, -0.5]) {
      const result = orientationOf(personA, { shoulderRatioFull })
      expect(result).toEqual(orientationOf(personA))
      expect(result.frontality).not.toBeNaN()
      expect(result.frontality === null).toBe(result.facing === 'unknown')
    }
  })

  /**
   * Les `y` des epaules portent l'echelle. Non gardes, un `Infinity` y donnait
   * `scale = Infinity`, donc un rapport de **0** -- un profil franc tire du neant,
   * que le garde `!(scale > 0)` laisse passer puisque `Infinity > 0`.
   * (releve par Aristarque)
   */
  it('ecarte une ordonnee d epaule infinie plutot que d en tirer un profil franc', () => {
    for (const point of ['LEFT_SHOULDER', 'RIGHT_SHOULDER'] as const) {
      for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const k = [...personA.k!]
        k[POINT[point] * 3 + 1] = bad
        const result = orientationOf(personWithK(770, k))
        expect(result.terms.shoulderRatio).toBeNull()
        expect(result.frontality).not.toBeNaN()
        expect(result.frontality === null).toBe(result.facing === 'unknown')
      }
    }
  })

  /**
   * **Le meme trou, une troisieme fois -- dans le repli sur les hanches.** Le nez
   * etait deja garde par son `Number.isFinite`, les epaules le sont depuis le
   * correctif precedent, mais les hanches portent l'echelle quand le nez manque
   * et personne ne les verifiait : `!(scale > 0)` laisse passer `Infinity`. Trois
   * emplacements pour un defaut, dont deux trouves dans du code que le correctif
   * du premier venait de toucher -- ce que la skill `cadrage` avait deja mesure
   * sur le bornage des abscisses. (releve par Copilot)
   */
  it('ecarte une echelle de hanches infinie quand le nez manque', () => {
    for (const point of ['LEFT_HIP', 'RIGHT_HIP'] as const) {
      for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const k = [...personA.k!]
        // Nez ecarte : c'est le repli sur les hanches qui porte alors l'echelle.
        k[POINT.NOSE * 3 + 2] = 0
        k[POINT.LEFT_HIP * 3 + 2] = 1
        k[POINT.RIGHT_HIP * 3 + 2] = 1
        k[POINT[point] * 3 + 1] = bad
        const result = orientationOf(personWithK(770, k))
        expect(result.terms.shoulderRatio).toBeNull()
        expect(result.frontality).not.toBeNaN()
        expect(result.frontality === null).toBe(result.facing === 'unknown')
      }
    }
  })

  it('porte les défauts documentés', () => {
    expect(ORIENTATION_DEFAULTS.pointMinScore).toBe(FRAMING_DEFAULTS.torsoMinScore)
    expect(ORIENTATION_DEFAULTS.shoulderRatioFull).toBe(1)
    // Relevé de 0,35 le 20 août 2026 : à 0,35, la fonction disait `'frontal'`
    // sur des profils francs jusqu'à 0,54 sur une planche-contact, et rangeait
    // 97,7 % des 17 927 images du jeu auto-supervisé du même côté.
    expect(ORIENTATION_DEFAULTS.frontalThreshold).toBe(0.6)
    expect(ORIENTATION_DEFAULTS.sideDeadband).toBe(0.5)
  })

  // Le seuil ne décide rien du cadrage — la règle est un écart entre deux
  // personnes du même plan — mais le relever ne doit pas non plus déplacer les
  // quatre cas réels sur lesquels la formule a été étalonnée.
  it("relever le seuil à 0,6 ne fait basculer aucun cas d'étalonnage", () => {
    for (const box of [personA, personC, personD]) {
      expect(orientationOf(box).facing).toBe('frontal')
      expect(orientationOf(box, { frontalThreshold: 0.35 }).facing).toBe('frontal')
    }
    expect(orientationOf(personB).facing).toBe('profile')
    expect(orientationOf(personB, { frontalThreshold: 0.35 }).facing).toBe('profile')
  })
})


// ---------------------------------------------------------------------------

/** Torse éteint, aucun rognage latéral : `personBounds` rend les bornes brutes de la boîte. */
const RAW_BOUNDS = { ...NO_TRIM, torso: 'off' } as const

/**
 * Une personne dont on contrôle tout ce que le split lit : la boîte (donc le
 * niveau d'yeux et la largeur de tronc, torse éteint), et `side` par
 * l'asymétrie brute des confiances d'oreille — jamais leur position, jamais la
 * frontalité, que le split n'utilise plus que pour rien.
 */
function splitPerson(
  t: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  eyeY: number,
  side: -1 | 0 | 1,
): PersonBox {
  const k = Array.from({ length: POINT_COUNT * 3 }, () => 0)
  const put = (point: keyof typeof POINT, x: number, y: number, score: number): void => {
    k[POINT[point] * 3] = x
    k[POINT[point] * 3 + 1] = y
    k[POINT[point] * 3 + 2] = score
  }
  const mid = (x0 + x1) / 2
  put('LEFT_EYE', mid, eyeY, 0.9)
  put('RIGHT_EYE', mid, eyeY, 0.9)
  const earLeftScore = side === -1 ? 0.9 : side === 1 ? 0.1 : 0.5
  const earRightScore = side === -1 ? 0.1 : side === 1 ? 0.9 : 0.5
  put('LEFT_EAR', x0, y0, earLeftScore)
  put('RIGHT_EAR', x1, y0, earRightScore)
  return { t, x0, x1, y0, y1, score: 0.9, k }
}

type SplitGeometry = { x0: number; x1: number; y0: number; y1: number; eyeY: number; side: -1 | 0 | 1 }

/** Deux personnes à chaque image du plan, à 2 images par seconde comme le worker. */
function splitFrames(from: number, to: number, left: SplitGeometry, right: SplitGeometry): PersonBox[] {
  const out: PersonBox[] = []
  for (let t = from; t < to - 1e-9; t += 0.5) {
    const at = Number(t.toFixed(3))
    out.push(splitPerson(at, left.x0, left.x1, left.y0, left.y1, left.eyeY, left.side))
    out.push(splitPerson(at, right.x0, right.x1, right.y0, right.y1, right.eyeY, right.side))
  }
  return out
}

// Deux torses de 0,10 et 0,08 : `3 ×` reste sous le plancher par défaut de
// 0,38, donc c'est lui qui fixe la largeur des deux cellules — la première
// chose que ces fixtures éprouvent.
const LEFT_GEOMETRY: SplitGeometry = { x0: 0.2, x1: 0.3, y0: 0.2, y1: 0.9, eyeY: 0.3, side: 0 }
const RIGHT_GEOMETRY: SplitGeometry = { x0: 0.6, x1: 0.68, y0: 0.25, y1: 0.85, eyeY: 0.35, side: 0 }

describe('computeShotSplit', () => {
  it('refuse un plan trop court', () => {
    const boxes = splitFrames(0, 3, LEFT_GEOMETRY, RIGHT_GEOMETRY)
    const result = computeShotSplit(boxes, shot(0, 3), '1:1', SRC_W, SRC_H, RAW_BOUNDS)
    expect(result.cells).toBeNull()
    expect(result.rejection).toBe('tooShort')
    // Aucune géométrie ne s'est calculée : rien à désigner.
    expect(result.bleed).toBeNull()
    expect(result.worstBleedAt).toBeNull()
  })

  it("refuse un plan dont l'image médiane ne porte pas exactement deux personnes", () => {
    // Plancher de taille éteint : ce test éprouve l'effectif, pas le plancher.
    const pair = splitFrames(0, 10, LEFT_GEOMETRY, RIGHT_GEOMETRY)
    const third = Array.from({ length: 20 }, (_, i) => splitPerson(i * 0.5, 0.42, 0.48, 0.3, 0.6, 0.4, 0))
    const { cells, rejection } = computeShotSplit(
      [...pair, ...third],
      shot(0, 10),
      '1:1',
      SRC_W,
      SRC_H,
      { ...RAW_BOUNDS, sizeFloor: 0 },
    )
    expect(cells).toBeNull()
    expect(rejection).toBe('notTwoPeople')
  })

  it('refuse un ratio déjà 9:16 : le splitter ne gagnerait rien', () => {
    const boxes = splitFrames(0, 10, LEFT_GEOMETRY, RIGHT_GEOMETRY)
    const { cells, rejection } = computeShotSplit(boxes, shot(0, 10), '9:16', SRC_W, SRC_H, RAW_BOUNDS)
    expect(cells).toBeNull()
    expect(rejection).toBe('ratioNotWide')
  })

  it("refuse quand aucune image ne porte exactement deux personnes bien que la médiane vaille deux", () => {
    // Dix images à une personne, dix à trois : la médiane du compte trié vaut
    // (1 + 3) / 2 = 2 sans qu'aucune image n'en porte réellement deux.
    const ones = Array.from({ length: 10 }, (_, i) => splitPerson(i * 0.5, 0.2, 0.3, 0.2, 0.9, 0.3, 0))
    const threes = Array.from({ length: 10 }, (_, i) => {
      const t = (i + 10) * 0.5
      return [
        splitPerson(t, 0.2, 0.3, 0.2, 0.9, 0.3, 0),
        splitPerson(t, 0.42, 0.48, 0.3, 0.6, 0.4, 0),
        splitPerson(t, 0.6, 0.68, 0.25, 0.85, 0.35, 0),
      ]
    }).flat()
    const { cells, rejection } = computeShotSplit(
      [...ones, ...threes],
      shot(0, 10),
      '1:1',
      SRC_W,
      SRC_H,
      { ...RAW_BOUNDS, sizeFloor: 0 },
    )
    expect(cells).toBeNull()
    expect(rejection).toBe('noPairs')
  })

  it('pose deux cellules quand les trois conditions tiennent, le plancher de largeur fixant leur taille', () => {
    const boxes = splitFrames(0, 10, LEFT_GEOMETRY, RIGHT_GEOMETRY)
    const { cells, rejection } = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, RAW_BOUNDS)
    expect(rejection).toBeNull()
    expect(cells).not.toBeNull()
    const [top, bottom] = cells!
    // `3 × 0,10` et `3 × 0,08` valent 0,30 et 0,24, tous deux sous le plancher
    // par défaut de 0,38 : c'est lui qui fixe la largeur des deux cellules.
    expect(top.x1 - top.x0).toBeCloseTo(0.38, 6)
    expect(bottom.x1 - bottom.x0).toBeCloseTo(0.38, 6)
    // Aucun recouvrement : les deux centres sont assez loin l'un de l'autre.
    expect(top.x1).toBeLessThan(bottom.x0)
  })

  it("place en haut celui qui regarde à droite, même quand il est à droite de l'image", () => {
    const boxes = splitFrames(0, 10, { ...LEFT_GEOMETRY, side: 0 }, { ...RIGHT_GEOMETRY, side: 1 })
    const { cells } = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, RAW_BOUNDS)
    const [top] = cells!
    const topCenter = (top.x0 + top.x1) / 2
    const rightCenter = (RIGHT_GEOMETRY.x0 + RIGHT_GEOMETRY.x1) / 2
    const leftCenter = (LEFT_GEOMETRY.x0 + LEFT_GEOMETRY.x1) / 2
    expect(Math.abs(topCenter - rightCenter)).toBeLessThan(Math.abs(topCenter - leftCenter))
  })

  it("la gauche va en haut par défaut quand personne ne tranche — le cas cqlp, où l'homme de droite sort à `side` nul", () => {
    const boxes = splitFrames(0, 10, { ...LEFT_GEOMETRY, side: 0 }, { ...RIGHT_GEOMETRY, side: 0 })
    const { cells } = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, RAW_BOUNDS)
    const [top] = cells!
    const topCenter = (top.x0 + top.x1) / 2
    const leftCenter = (LEFT_GEOMETRY.x0 + LEFT_GEOMETRY.x1) / 2
    expect(Math.abs(topCenter - leftCenter)).toBeLessThan(1e-9)
  })

  it('clampe une largeur de cellule qui dépasserait la source, plutôt que de la déformer', () => {
    // Un tronc de 0,5 : `3 ×` vaut 1,5, clampé à 1 — une cellule ne peut pas
    // être plus large que sa source. La hauteur qui s'ensuit (1920 / 1,125 /
    // 1080 ≈ 1,58) dépasse la source : pas de géométrie exploitable.
    const wide: SplitGeometry = { x0: 0.2, x1: 0.7, y0: 0.1, y1: 0.95, eyeY: 0.3, side: 0 }
    const boxes = splitFrames(0, 10, wide, RIGHT_GEOMETRY)
    const { cells, rejection } = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, RAW_BOUNDS)
    expect(cells).toBeNull()
    expect(rejection).toBe('tooNarrowForSource')
  })

  // Une personne près du coin haut-gauche : le centre et le niveau d'yeux
  // poussent la cellule hors cadre des deux côtés (x et y) si rien ne la
  // décale. `x1 - x0` reste invariant du décalage — seules les bornes le
  // trahissent.
  it('décale une cellule au bord de la source plutôt que de la tronquer', () => {
    const nearEdge: SplitGeometry = { x0: 0.01, x1: 0.11, y0: 0, y1: 0.6, eyeY: 0.02, side: 0 }
    const boxes = splitFrames(0, 10, nearEdge, RIGHT_GEOMETRY)
    const { cells, rejection } = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, RAW_BOUNDS)
    expect(rejection).toBeNull()
    const [top] = cells!
    expect(top.x0).toBeGreaterThanOrEqual(0)
    expect(top.y0).toBeGreaterThanOrEqual(0)
    expect(top.x1 - top.x0).toBeCloseTo(FRAMING_DEFAULTS.splitMinCellWidth, 6)
  })

  // **Les cellules ont le droit de se recouvrir** : les deux plans approuvés
  // le 25 août se recouvraient déjà sur les images soumises au jugement, sans
  // qu'aucun contrôle de recouvrement n'existe alors. Ce qui compte est le
  // débordement dans la boîte de l'autre personne, mesuré plus bas.
  it('accepte un recouvrement de cellules qui ne mord pas dans la boîte de l’autre au-delà de la tolérance', () => {
    const left: SplitGeometry = { x0: 0.2, x1: 0.3, y0: 0.2, y1: 0.9, eyeY: 0.3, side: 0 }
    const right: SplitGeometry = { x0: 0.43, x1: 0.51, y0: 0.25, y1: 0.85, eyeY: 0.35, side: 0 }
    const boxes = splitFrames(0, 10, left, right)
    const result = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, RAW_BOUNDS)

    expect(result.cells).not.toBeNull()
    expect(result.bleed).not.toBeNull()
    expect(result.bleed as number).toBeGreaterThan(0)
    expect(result.bleed as number).toBeLessThanOrEqual(FRAMING_DEFAULTS.splitBleedTolerance)
  })

  it('refuse un débordement qui mord dans la boîte de l’autre au-delà de la tolérance', () => {
    // Un tronc large côté gauche (0,2, contre 0,08 à droite) : sa cellule
    // (3 × 0,2 = 0,6) mord loin dans la boîte étroite de droite.
    const left: SplitGeometry = { x0: 0.2, x1: 0.4, y0: 0.2, y1: 0.9, eyeY: 0.3, side: 0 }
    const right: SplitGeometry = { x0: 0.5, x1: 0.58, y0: 0.25, y1: 0.85, eyeY: 0.35, side: 0 }
    const boxes = splitFrames(0, 10, left, right)
    const result = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, RAW_BOUNDS)

    expect(result.cells).toBeNull()
    expect(result.rejection).toBe('bleedsIntoOther')
    expect(result.bleed as number).toBeGreaterThan(FRAMING_DEFAULTS.splitBleedTolerance)
  })

  it('la tolérance se clampe des deux côtés et retombe sur le défaut hors de [0, 1]', () => {
    const left: SplitGeometry = { x0: 0.2, x1: 0.4, y0: 0.2, y1: 0.9, eyeY: 0.3, side: 0 }
    const right: SplitGeometry = { x0: 0.5, x1: 0.58, y0: 0.25, y1: 0.85, eyeY: 0.35, side: 0 }
    const boxes = splitFrames(0, 10, left, right)

    // Une tolérance de 1 laisse tout passer, y compris le cas rejeté ci-dessus.
    const loose = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, {
      ...RAW_BOUNDS,
      splitBleedTolerance: 1,
    })
    expect(loose.cells).not.toBeNull()

    // Une tolérance négative se clampe à 0 : rien ne passe.
    const strict = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, {
      ...RAW_BOUNDS,
      splitBleedTolerance: -1,
    })
    expect(strict.cells).toBeNull()
    expect(strict.rejection).toBe('bleedsIntoOther')
  })

  /**
   * Une image mesurée à un instant donné plutôt que sur tout `[from, to)` —
   * pour mélanger des géométries différentes dans un même plan (contrat,
   * § « adopter le percentile »).
   */
  function framesAt(times: number[], seq: (t: number) => [SplitGeometry, SplitGeometry]): PersonBox[] {
    const out: PersonBox[] = []
    for (const t of times) {
      const [l, r] = seq(t)
      out.push(splitPerson(t, l.x0, l.x1, l.y0, l.y1, l.eyeY, l.side))
      out.push(splitPerson(t, r.x0, r.x1, r.y0, r.y1, r.eyeY, r.side))
    }
    return out
  }

  // Le tronc et le centre médians restent ceux du repos (`RIGHT_GEOMETRY`,
  // minoritaire écarté) : seul `x0` s'étend vers la gauche, comme un bras qui
  // se tend un instant — la cellule, elle, reste fixe et posée sur le repos.
  const BLEEDING_RIGHT: SplitGeometry = { ...RIGHT_GEOMETRY, x0: 0.3 }
  const BLEEDING_PAIR: [SplitGeometry, SplitGeometry] = [LEFT_GEOMETRY, BLEEDING_RIGHT]
  const CLEAN_PAIR: [SplitGeometry, SplitGeometry] = [LEFT_GEOMETRY, RIGHT_GEOMETRY]
  const TWENTY_HALF_SECOND_STEPS = Array.from({ length: 20 }, (_, i) => i * 0.5)

  // **La cellule est fixe pour tout le plan, comme le crop du ratio** :
  // `chooseRatioFromSpans` accepte déjà un ratio dont 10 % des images
  // débordent entièrement, donc exiger que 100 % des images tiennent sous la
  // tolérance du split serait une norme plus stricte que celle que le dépôt
  // applique déjà ailleurs à la même contrainte structurelle.
  it('accepte un débordement isolé sur 10 % des images, sous le seuil de 90 %', () => {
    const boxes = framesAt(TWENTY_HALF_SECOND_STEPS, (t) => (t >= 9 ? BLEEDING_PAIR : CLEAN_PAIR))
    const result = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, RAW_BOUNDS)

    expect(result.cells).not.toBeNull()
    // Le pire cas reste rapporté, même accepté : c'est lui qu'il faut pouvoir
    // retrouver et regarder à l'image (contrat, § « rendre le cas marginal »).
    expect(result.bleed as number).toBeGreaterThan(FRAMING_DEFAULTS.splitBleedTolerance)
    // Et il désigne l'image précise du débordement, pas seulement le plan.
    expect(result.worstBleedAt as number).toBeGreaterThanOrEqual(9)
  })

  it('refuse quand plus de 10 % des images débordent', () => {
    const boxes = framesAt(TWENTY_HALF_SECOND_STEPS, (t) => (t >= 6 ? BLEEDING_PAIR : CLEAN_PAIR))
    const result = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, RAW_BOUNDS)

    expect(result.cells).toBeNull()
    expect(result.rejection).toBe('bleedsIntoOther')
  })

  it('la part se clampe des deux côtés', () => {
    const boxes = framesAt(TWENTY_HALF_SECOND_STEPS, (t) => (t >= 9 ? BLEEDING_PAIR : CLEAN_PAIR))

    // Une part de 1 (clampée depuis au-delà de 1) exige que toutes les images
    // tiennent : le débordement isolé ci-dessus la fait alors échouer.
    const strictShare = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, {
      ...RAW_BOUNDS,
      splitBleedShare: 1.5,
    })
    expect(strictShare.cells).toBeNull()

    // Une part de 0 (clampée depuis en dessous de 0) accepte n'importe quoi.
    const looseShare = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, {
      ...RAW_BOUNDS,
      splitBleedShare: -1,
    })
    expect(looseShare.cells).not.toBeNull()
  })

  // La table ci-dessus ne distingue pas le clampage de son absence : 1,5 et
  // -1 y retombent sur le même verdict avec ou sans `bound(...)`, à 18/20
  // images sous tolérance. Ici les 20 images tiennent : une part clampée à 1
  // exige exactement ça et accepte, une part brute au-dessus de 1 exigerait
  // plus que la totalité et refuserait — les deux verdicts divergent.
  it('une part au-dessus de 1 se clampe à 1, et non à une exigence plus stricte que 100 %', () => {
    const boxes = splitFrames(0, 10, LEFT_GEOMETRY, RIGHT_GEOMETRY)
    const result = computeShotSplit(boxes, shot(0, 10), '1:1', SRC_W, SRC_H, {
      ...RAW_BOUNDS,
      splitBleedShare: 1.01,
    })
    expect(result.cells).not.toBeNull()
  })

  it("le plancher de taille de la PR #177 exclut une boîte trop petite et permet au split de se déclencher", () => {
    // Une troisième boîte, nettement plus courte que les deux comédiens :
    // sans le plancher, l'image médiane porterait trois personnes retenues
    // et le split se refuserait sur `notTwoPeople`.
    const pair = splitFrames(0, 10, LEFT_GEOMETRY, RIGHT_GEOMETRY)
    const printed = Array.from({ length: 20 }, (_, i) => splitPerson(i * 0.5, 0.42, 0.48, 0.4, 0.42, 0.41, 0))
    const withoutFloor = computeShotSplit(
      [...pair, ...printed],
      shot(0, 10),
      '1:1',
      SRC_W,
      SRC_H,
      { ...RAW_BOUNDS, sizeFloor: 0 },
    )
    expect(withoutFloor.rejection).toBe('notTwoPeople')

    const withFloor = computeShotSplit(
      [...pair, ...printed],
      shot(0, 10),
      '1:1',
      SRC_W,
      SRC_H,
      { ...RAW_BOUNDS, sizeFloor: FRAMING_DEFAULTS.sizeFloor },
    )
    expect(withFloor.cells).not.toBeNull()
  })

  it('porte les défauts documentés', () => {
    expect(FRAMING_DEFAULTS.splitScreen).toBe(true)
    expect(FRAMING_DEFAULTS.splitMinShot).toBe(4)
    expect(FRAMING_DEFAULTS.splitMinCellWidth).toBe(0.38)
    expect(FRAMING_DEFAULTS.splitBleedTolerance).toBe(0.05)
    expect(FRAMING_DEFAULTS.splitBleedShare).toBe(0.9)
  })
})

describe('le split-screen dans computeFraming', () => {
  const SHOTS_ONE = [shot(0, 10)]
  const SEGMENTS_ONE = [seg(0, 10)]

  function bothWays(people: PersonBox[]) {
    const request = {
      segments: SEGMENTS_ONE,
      shots: SHOTS_ONE,
      people,
      srcW: SRC_W,
      srcH: SRC_H,
      ratio: 'auto' as const,
      cropMode: 'auto' as const,
      ...RAW_BOUNDS,
    }
    return {
      off: computeFraming({ ...request, splitScreen: false }),
      on: computeFraming({ ...request, splitScreen: true }),
    }
  }

  it('pose `split` sur le plan qui remplit les trois conditions', () => {
    const { on } = bothWays(splitFrames(0, 10, LEFT_GEOMETRY, RIGHT_GEOMETRY))
    expect(on.shots[0].split).toBeDefined()
  })

  it("l'interrupteur reproduit exactement le cadrage d'avant : `split` reste absent, rien d'autre ne bouge", () => {
    const { off, on } = bothWays(splitFrames(0, 10, LEFT_GEOMETRY, RIGHT_GEOMETRY))
    expect(off.shots[0].split).toBeUndefined()
    expect(off.ratio).toBe(on.ratio)
    expect(off.shots[0].ratio).toBe(on.shots[0].ratio)
    expect(off.shots[0].cropX).toBeCloseTo(on.shots[0].cropX, 10)
    expect(off.shots[0].cropXNative).toBeCloseTo(on.shots[0].cropXNative, 10)
  })

  it('ne déplace ni le ratio natif ni sa position, split posé ou non', () => {
    const { off, on } = bothWays(splitFrames(0, 10, LEFT_GEOMETRY, RIGHT_GEOMETRY))
    expect(on.ratio).toBe(off.ratio)
    expect(on.shots[0].cropXNative).toBeCloseTo(off.shots[0].cropXNative, 10)
  })

  it('un plan déjà 9:16 ne split pas, même à deux personnes', () => {
    const request = {
      segments: SEGMENTS_ONE,
      shots: SHOTS_ONE,
      people: splitFrames(0, 10, LEFT_GEOMETRY, RIGHT_GEOMETRY),
      srcW: SRC_W,
      srcH: SRC_H,
      ratio: '9:16' as const,
      cropMode: 'auto' as const,
      ...RAW_BOUNDS,
    }
    const framing = computeFraming(request)
    expect(framing.shots[0].split).toBeUndefined()
  })
})
