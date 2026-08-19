import { describe, it, expect } from 'vitest'
import {
  FRAMING_DEFAULTS,
  MIN_PIECE_SEC,
  RATIOS,
  chooseRatio,
  computeFraming,
  cropRect,
  isForeground,
  outputSize,
  ratioCoverage,
  requiredWidths,
  resolveRatio,
  sizeInCanvas,
  trimmedBounds,
} from '@/core/framing'
import type { Ratio, Segment } from '@/core/edl'
import type { PersonBox, Shot } from '@/core/shots'

const TOUS: Ratio[] = ['9:16', '4:5', '1:1', '16:9']

describe('RATIOS', () => {
  it('donne la largeur pour une hauteur de 1', () => {
    expect(RATIOS['9:16']).toBeCloseTo(9 / 16, 10)
    expect(RATIOS['4:5']).toBeCloseTo(4 / 5, 10)
    expect(RATIOS['1:1']).toBe(1)
    expect(RATIOS['16:9']).toBeCloseTo(16 / 9, 10)
  })

  it('couvre les quatre ratios et rien de plus', () => {
    expect(Object.keys(RATIOS).sort()).toEqual([...TOUS].sort())
  })
})

describe('resolveRatio', () => {
  it("en itération 0, 'auto' vaut 9:16 — il n'y a pas encore de cadrage automatique", () => {
    expect(resolveRatio('auto')).toBe('9:16')
  })

  it('un ratio explicite passe tel quel', () => {
    expect(resolveRatio('1:1')).toBe('1:1')
    for (const r of TOUS) expect(resolveRatio(r)).toBe(r)
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
    for (const r of TOUS) {
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
  ])('retombe sur le centre quand cropX vaut %s', (_nom, cx) => {
    expect(cropRect('9:16', cx, 1920, 1080)).toEqual(cropRect('9:16', 0.5, 1920, 1080))
  })

  // Les dimensions viennent de ffprobe. Un NaN propagé se serait manifesté
  // beaucoup plus loin, en « crop.w doit être un nombre fini » — un message qui
  // désigne le symptôme et cache la cause.
  it.each([
    ['largeur NaN', Number.NaN, 1080],
    ['hauteur NaN', 1920, Number.NaN],
    ['hauteur infinie', 1920, Number.POSITIVE_INFINITY],
  ])('refuse une source aux dimensions non finies (%s)', (_nom, sw, sh) => {
    expect(() => cropRect('9:16', 0.5, sw, sh)).toThrow(/source/)
  })

  it('les dimensions sont paires, sinon libx264 refuse', () => {
    for (const ratio of TOUS) {
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
    const gauche = cropRect('1:1', 0.25, 1920, 1080)
    const centre = cropRect('1:1', 0.5, 1920, 1080)
    expect(gauche.x).toBeLessThan(centre.x)
    expect(centre.x).toBe(Math.trunc((1920 - centre.w) / 2 / 2) * 2)
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
    for (const ratio of TOUS) {
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
const boîte = (t: number, x0: number, x1: number, score = 0.9): PersonBox => ({
  t,
  x0,
  x1,
  y0: 0.1,
  y1: 0.95,
  score,
})

/**
 * Les boîtes d'un intervalle, échantillonnées à 2 images par seconde comme le
 * fait le worker (spec §6), avec les mêmes personnes sur toutes les images.
 */
function échantillon(
  de: number,
  à: number,
  personnes: [number, number][],
  score = 0.9,
): PersonBox[] {
  const out: PersonBox[] = []
  for (let t = de; t < à - 1e-9; t += 0.5) {
    for (const [x0, x1] of personnes) out.push(boîte(Number(t.toFixed(3)), x0, x1, score))
  }
  return out
}

const plan = (start: number, end: number): Shot => ({ start, end })
const seg = (start: number, end: number): Segment => ({ start, end })

// Deux plans, deux positions d'action. Les nombres sont posés pour que les
// crops attendus se calculent à la main :
//   plan A : personnes sur 0,20 à 0,60 → empan 0,44 avec la marge de 2 %
//   plan B : personnes sur 0,55 à 0,90 → empan 0,39
// Le percentile 90 de {20 × 0,39 ; 20 × 0,44} vaut 0,44, que seul le 4:5 couvre.
const PLAN_A = plan(0, 10)
const PLAN_B = plan(10, 20)
const PLANS = [PLAN_A, PLAN_B]
const SEGMENTS = [seg(0, 20)]
const GENS = [
  ...échantillon(0, 10, [
    [0.2, 0.35],
    [0.45, 0.6],
  ]),
  ...échantillon(10, 20, [
    [0.55, 0.7],
    [0.8, 0.9],
  ]),
]

const base = {
  segments: SEGMENTS,
  shots: PLANS,
  people: GENS,
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
    for (const r of TOUS) {
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
    const boîtes = [boîte(1, 0.2, 0.3), boîte(1, 0.6, 0.7), boîte(1.5, 0.4, 0.5)]
    expect(requiredWidths(boîtes, { margin: 0, ...NO_TRIM })).toEqual([
      expect.closeTo(0.5, 10),
      expect.closeTo(0.1, 10),
    ])
  })

  it("ajoute une marge de chaque côté, et l'air par défaut n'est pas nul", () => {
    expect(requiredWidths([boîte(1, 0.4, 0.6)], { margin: 0.05, ...NO_TRIM })[0]).toBeCloseTo(
      0.3,
      10,
    )
    expect(requiredWidths([boîte(1, 0.4, 0.6)], NO_TRIM)[0]).toBeGreaterThan(0.2)
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

    const empan = (marge: number): number =>
      requiredWidths([boîte(1, 0.235, 0.765)], { margin: marge, ...NO_TRIM })[0]
    expect(empan(0)).toBeCloseTo(0.53, 10)
    expect(empan(0.01)).toBeCloseTo(0.55, 10)
    expect(empan(0.02)).toBeCloseTo(0.57, 10)

    const un1x1 = ratioCoverage('1:1', SRC_W, SRC_H)
    expect(empan(FRAMING_DEFAULTS.margin)).toBeLessThanOrEqual(un1x1)
    expect(empan(0.02)).toBeGreaterThan(un1x1)
  })

  it('borne la largeur à 1 : rien ne dépasse la source', () => {
    expect(requiredWidths([boîte(1, 0, 1)], { margin: 0.1, ...NO_TRIM })).toEqual([1])
  })

  // Une détection douteuse au bord du cadre suffirait à imposer un 16:9.
  it('écarte les boîtes sous le seuil de confiance', () => {
    const boîtes = [boîte(1, 0.4, 0.6, 0.9), boîte(1, 0.95, 0.99, 0.2)]
    expect(requiredWidths(boîtes, { margin: 0, minScore: 0.5, ...NO_TRIM })).toEqual([
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
    expect(requiredWidths([boîte(1, 0.4, 0.6, 0.5)], { margin: 0 })).toHaveLength(1)
    expect(requiredWidths([boîte(1, 0.4, 0.6, 0.4999)], { margin: 0 })).toHaveLength(0)
  })

  // Une image sans personne ne vaut pas une largeur de zéro : elle ne dit rien,
  // et la compter tirerait le percentile vers un ratio trop étroit pour les
  // images où il y a quelqu'un.
  it("ne rend rien pour une image dont aucune boîte n'est retenue", () => {
    const boîtes = [boîte(1, 0.4, 0.6, 0.9), boîte(2, 0.1, 0.2, 0.1)]
    expect(requiredWidths(boîtes, { margin: 0 })).toHaveLength(1)
  })

  // `??` ne remplace que `undefined` : un `NaN` se propageait jusqu'à un `cropX`
  // à `NaN` étiqueté `'auto'`, invisible à l'image mais faux dans l'interface.
  it('retombe sur les réglages par défaut quand ils ne sont pas finis', () => {
    const boîtes = [boîte(1, 0.4, 0.6, 0.9), boîte(1, 0.95, 0.99, 0.2)]
    expect(requiredWidths(boîtes, { margin: Number.NaN })).toEqual(requiredWidths(boîtes))
    expect(requiredWidths(boîtes, { minScore: Number.NaN })).toEqual(requiredWidths(boîtes))
  })

  it('ignore une boîte inversée ou aux bornes non finies', () => {
    expect(requiredWidths([boîte(1, 0.6, 0.4)], { margin: 0 })).toEqual([])
    expect(requiredWidths([boîte(1, Number.NaN, 0.4)], { margin: 0 })).toEqual([])
  })
})

describe('chooseRatio', () => {
  /** Un plan de 20 images où l'action ne bouge pas. */
  const fixe = (x0: number, x1: number): PersonBox[] => échantillon(0, 10, [[x0, x1]])
  /** Ni marge ni rognage : ces tests décrivent le choix, pas les réglages. */
  const sansMarge = { margin: 0, ...NO_TRIM }

  it('retient le plus petit ratio qui couvre', () => {
    expect(chooseRatio(fixe(0.35, 0.65), SRC_W, SRC_H, sansMarge)).toBe('9:16')
    expect(chooseRatio(fixe(0.3, 0.7), SRC_W, SRC_H, sansMarge)).toBe('4:5')
    expect(chooseRatio(fixe(0.25, 0.75), SRC_W, SRC_H, sansMarge)).toBe('1:1')
    expect(chooseRatio(fixe(0.1, 0.9), SRC_W, SRC_H, sansMarge)).toBe('16:9')
  })

  it('couvre pile la largeur mesurée, sans marge supplémentaire', () => {
    const w = ratioCoverage('9:16', SRC_W, SRC_H)
    expect(chooseRatio(fixe(0.5 - w / 2, 0.5 + w / 2), SRC_W, SRC_H, sansMarge)).toBe('9:16')
    expect(
      chooseRatio(fixe(0.5 - w / 2 - 1e-4, 0.5 + w / 2 + 1e-4), SRC_W, SRC_H, sansMarge),
    ).toBe('4:5')
  })

  // Le cœur de la décision : le seuil est à 90 %, pas au maximum. Deux images
  // sur vingt où quelqu'un traverse ne condamnent pas le clip au 16:9.
  it('absorbe une traversée que le maximum aurait payée en 16:9', () => {
    const plan = [...échantillon(0, 9, [[0.35, 0.65]]), ...échantillon(9, 10, [[0.02, 0.98]])]
    expect(chooseRatio(plan, SRC_W, SRC_H, sansMarge)).toBe('9:16')
    expect(Math.max(...requiredWidths(plan, sansMarge))).toBeGreaterThan(
      ratioCoverage('1:1', SRC_W, SRC_H),
    )
  })

  it('cède quand plus de 10 % des images débordent', () => {
    const plan = [...échantillon(0, 7.5, [[0.35, 0.65]]), ...échantillon(7.5, 10, [[0.02, 0.98]])]
    expect(chooseRatio(plan, SRC_W, SRC_H, sansMarge)).toBe('16:9')
  })

  // Ce qu'une largeur par image ne peut pas voir, et que la première version de
  // ce module ratait : le crop est **fixe** pour tout le plan. Un sujet étroit
  // qui passe de gauche à droite pendant le plan tient dans un 9:16 image par
  // image — chaque largeur vaut 0,20 — mais aucune position fixe de 9:16 n'en
  // cadre plus de la moitié. C'est le cas que la spec §10 annonce : « un plan de
  // trois minutes où les comédiens traversent le plateau impose un crop large,
  // donc un ratio qui monte, parfois jusqu'au 16:9 ».
  it('fait monter le ratio quand l’action se déplace à l’intérieur d’un plan', () => {
    const traversée = [
      ...échantillon(0, 5, [[0.05, 0.25]]),
      ...échantillon(5, 10, [[0.75, 0.95]]),
    ]
    // Toutes les images tiendraient individuellement dans un 9:16.
    expect(Math.max(...requiredWidths(traversée, sansMarge))).toBeLessThan(
      ratioCoverage('9:16', SRC_W, SRC_H),
    )
    expect(chooseRatio(traversée, SRC_W, SRC_H, sansMarge)).toBe('16:9')
  })

  // Le pendant, sans lequel le précédent inviterait à sur-corriger : entre deux
  // plans le crop a le droit de sauter, puisqu'une coupe existe déjà là. Chaque
  // plan choisit désormais **son** ratio, donc les deux moitiés de cette
  // traversée sortent chacune en 9:16 au lieu de se tirer l'une l'autre vers le
  // haut.
  it('ne fait pas monter le ratio quand le déplacement est entre deux plans', () => {
    const gauche = échantillon(0, 5, [[0.05, 0.25]])
    const droite = échantillon(5, 10, [[0.75, 0.95]])
    expect(chooseRatio(gauche, SRC_W, SRC_H, sansMarge)).toBe('9:16')
    expect(chooseRatio(droite, SRC_W, SRC_H, sansMarge)).toBe('9:16')
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
    const cadrage = computeFraming(base)
    expect(cadrage.ratio).toBe('4:5')
    expect(cadrage.shots).toHaveLength(2)
    expect(cadrage.shots[0]).toMatchObject({ key: 0, source: 'auto' })
    expect(cadrage.shots[0].cropX).toBeCloseTo(0.4, 6)
    expect(cadrage.shots[1]).toMatchObject({ key: 10000, source: 'auto' })
    expect(cadrage.shots[1].cropX).toBeCloseTo(0.725, 6)
    expect(cadrage.rejectedOverrides).toEqual([])
  })

  it('rend les plans dans l’ordre de la source, avec leurs bornes de source', () => {
    const cadrage = computeFraming(base)
    expect(cadrage.shots.map((s) => s.shot)).toEqual([PLAN_A, PLAN_B])
  })

  it('ignore les plans qu’aucun segment ne traverse', () => {
    const cadrage = computeFraming({ ...base, segments: [seg(0, 5)] })
    expect(cadrage.shots.map((s) => s.key)).toEqual([0])
  })

  // Un comédien qui traverse le plateau sur deux images ne doit ni faire monter
  // le ratio, ni tirer le crop du plan derrière lui.
  it('absorbe une traversée de quelques images', () => {
    const traversée = [boîte(4, 0.9, 0.98), boîte(4.5, 0.9, 0.98)]
    const cadrage = computeFraming({ ...base, people: [...GENS, ...traversée] })
    expect(cadrage.ratio).toBe('4:5')
    expect(cadrage.shots[0].cropX).toBeCloseTo(0.4, 6)
  })

  // Le crop couvre l'action, il ne la moyenne pas. Ici les comédiens dérivent
  // vers la droite pendant le plan : le plateau [0,295 ; 0,305] cadre entièrement
  // 16 images sur 20, là où la position la plus peuplée — 0,20, où se trouvent
  // la moitié des images — n'en cadrerait que 10.
  it('cadre le plus d’images possible, et non la position moyenne de l’action', () => {
    const dérive = [
      ...échantillon(0, 5, [[0.1, 0.3]]),
      ...échantillon(5, 8, [[0.3, 0.5]]),
      ...échantillon(8, 10, [[0.5, 0.7]]),
    ]
    const cadrage = computeFraming({
      ...base,
      shots: [PLAN_A],
      segments: [seg(0, 10)],
      people: dérive,
      ratio: '4:5',
    })
    expect(cadrage.shots[0].cropX).toBeCloseTo(0.3, 6)
  })

  // Dans le plateau, on se pose sur le centre médian de l'action et non au
  // milieu du plateau : tout point du plateau cadre les mêmes images, donc la
  // marge que donnerait le milieu ne protège de rien, alors que l'écart au
  // centre de l'action se voit. Ici, 0,35 où sont les douze images contre 0,42
  // au milieu du plateau — 134 px sur 1920.
  it('se pose sur le centre de l’action dans le plateau, pas au milieu du plateau', () => {
    const cadrage = computeFraming({
      ...base,
      shots: [PLAN_A],
      segments: [seg(0, 10)],
      people: [
        ...échantillon(0, 6, [[0.3, 0.4]]),
        ...échantillon(6, 10, [[0.44, 0.54]]),
      ],
      ratio: '1:1',
    })
    expect(cadrage.shots[0].cropX).toBeCloseTo(0.35, 6)
  })

  // Un plan partagé en deux moitiés symétriques n'a pas de bonne réponse. Ce qui
  // compte est que la médiane de l'action tombe au milieu — et non sur la moitié
  // gauche, ce que faisait la médiane basse d'un effectif pair — et que le
  // départage restant soit annoncé : la position la plus à gauche.
  //
  // Le cadrage automatique n'atteint jamais ce cas : un tel plan ne cadre que la
  // moitié de ses images, donc le ratio monte jusqu'à les prendre toutes.
  it('ne penche pas à gauche sur un plan symétrique, et le dit quand il faut trancher', () => {
    const symétrique = {
      ...base,
      shots: [PLAN_A],
      segments: [seg(0, 10)],
      people: [
        ...échantillon(0, 5, [[0.1, 0.3]]),
        ...échantillon(5, 10, [[0.7, 0.9]]),
      ],
      // **La marge est posée ici, et à zéro.** Ce test porte sur le départage
      // entre deux positions à égalité, pas sur l'air laissé autour des gens :
      // laisser le défaut ferait bouger les nombres attendus au prochain
      // réglage de `margin`, sur un test qui ne le mesure pas. Le 18 août 2026,
      // c'est exactement ce qui est arrivé — le défaut est passé de 0,02 à 0,01
      // et trois assertions ont cassé sans qu'aucun comportement ne change.
      margin: 0,
    }
    expect(computeFraming(symétrique).ratio).toBe('16:9')
    expect(computeFraming(symétrique).shots[0].cropX).toBeCloseTo(0.5, 6)

    // Ratio épinglé trop étroit : les deux moitiés s'excluent, aucune ne cadre
    // plus d'images que l'autre, et le départage tombe à gauche.
    const épinglé = computeFraming({ ...symétrique, ratio: '4:5' })
    expect(épinglé.shots[0].cropX).toBeCloseTo(0.325, 6)

    // Et « à gauche » veut bien dire à gauche dans l'image, pas en premier dans
    // le tableau : l'ordre des boîtes dans un JSON n'est pas une décision.
    const àLenvers = computeFraming({
      ...symétrique,
      ratio: '4:5',
      people: [...symétrique.people].reverse(),
    })
    expect(àLenvers.shots[0].cropX).toBeCloseTo(0.325, 6)

    // Le seuil sous lequel deux positions sont réputées à égalité. La moitié
    // droite est ici mathématiquement plus proche du centre de l'action, mais de
    // 5e-10 — soit un millionième de pixel sur 1920. Sans ce seuil, c'est le
    // dernier bit d'un flottant qui cadrerait le plan.
    const presqueÉgal = computeFraming({
      ...symétrique,
      ratio: '4:5',
      people: [
        ...échantillon(0, 5, [[0.1, 0.3]]),
        ...échantillon(5, 10, [[0.7, 0.9 - 5e-10]]),
      ],
    })
    expect(presqueÉgal.shots[0].cropX).toBeCloseTo(0.325, 6)
  })

  it('ne rend jamais un crop qui sortirait du cadre', () => {
    const collé = échantillon(0, 10, [[0.86, 0.99]])
    const cadrage = computeFraming({ ...base, shots: [PLAN_A], segments: [seg(0, 10)], people: collé })
    const r = cropRect(cadrage.ratio, cadrage.shots[0].cropX, SRC_W, SRC_H)
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.x + r.w).toBeLessThanOrEqual(SRC_W)
  })

  it('refuse une source aux dimensions invalides', () => {
    expect(() => computeFraming({ ...base, srcW: Number.NaN })).toThrow(/source/)
  })

  it('ne laisse pas un réglage non fini produire un crop « calculé » qui ne l’est pas', () => {
    const cadrage = computeFraming({ ...base, margin: Number.NaN })
    expect(cadrage).toEqual(computeFraming(base))
    expect(cadrage.shots.every((s) => Number.isFinite(s.cropX))).toBe(true)
  })

  // Le repli de `cropDuPlan` : un ratio épinglé trop étroit pour l'action, donc
  // aucune position ne cadre une image entière. On se pose alors sur le centre
  // **médian** de l'action — 0,325, où sont les 12 premières images — et non sur
  // le milieu de son étendue, qui serait 0,5 et ne montrerait ni l'un ni l'autre.
  it('se pose sur la médiane de l’action quand aucune image ne tient dans la fenêtre', () => {
    const cadrage = computeFraming({
      ...base,
      shots: [PLAN_A],
      segments: [seg(0, 10)],
      people: [
        ...échantillon(0, 6, [[0.1, 0.55]]),
        ...échantillon(6, 10, [[0.45, 0.9]]),
      ],
      ratio: '9:16',
    })
    expect(cadrage.shots[0].source).toBe('auto')
    expect(cadrage.shots[0].cropX).toBeCloseTo(0.325, 6)
  })

  describe('quand le ratio est épinglé', () => {
    // L'action est à droite et déborde du 4:5 : l'automatique prendrait un 1:1.
    const àDroite = {
      ...base,
      shots: [PLAN_A],
      segments: [seg(0, 10)],
      people: échantillon(0, 10, [
        [0.55, 0.7],
        [0.85, 0.99],
      ]),
      // Posée, pour la même raison que plus haut — et ici elle décide en plus du
      // ratio choisi : à marge nulle l'empan tombe à 0,44, que le 4:5 couvre, et
      // le test ne comparerait plus un 9:16 épinglé à un 1:1 automatique.
      margin: 0.02,
    }

    it('saute le choix du ratio mais pas le calcul des crops', () => {
      const auto = computeFraming(àDroite)
      expect(auto.ratio).toBe('1:1')
      expect(auto.shots[0].cropX).toBeCloseTo(0.71875, 6)

      // Le même plan, cadré pour un 9:16 : la fenêtre est plus étroite, donc
      // elle peut se poser plus à droite sans sortir de l'image. Un crop calculé
      // pour le 1:1 et posé dans un canevas 9:16 raterait le bord droit.
      const épinglé = computeFraming({ ...àDroite, ratio: '9:16' })
      expect(épinglé.ratio).toBe('9:16')
      expect(épinglé.shots[0].cropX).toBeCloseTo(0.765, 6)
    })
  })

  describe('les dérogations humaines', () => {
    it('ignore la table en mode auto — un curseur ne bascule pas le mode à lui seul', () => {
      const cadrage = computeFraming({ ...base, crops: { 10000: 0.05 } })
      expect(cadrage.shots[1].cropX).toBeCloseTo(0.725, 6)
      expect(cadrage.shots[1].source).toBe('auto')
      expect(cadrage.rejectedOverrides).toEqual([])
    })

    it('pose la dérogation par-dessus le crop calculé, plan par plan', () => {
      const cadrage = computeFraming({ ...base, cropMode: 'manual', crops: { 10000: 0.05 } })
      // Le plan non dérogé garde son crop calculé.
      expect(cadrage.shots[0]).toMatchObject({ key: 0, source: 'auto' })
      expect(cadrage.shots[0].cropX).toBeCloseTo(0.4, 6)
      expect(cadrage.shots[1]).toMatchObject({ key: 10000, cropX: 0.05, source: 'manual' })
    })

    it('apparie une clé décalée de quelques images', () => {
      const cadrage = computeFraming({ ...base, cropMode: 'manual', crops: { 10120: 0.05 } })
      expect(cadrage.shots[1]).toMatchObject({ key: 10000, cropX: 0.05, source: 'manual' })
      expect(cadrage.rejectedOverrides).toEqual([])
    })

    // Le cas qui se produira le jour où l'analyse sera relancée avec un
    // détecteur modifié. La dérogation est **rendue à l'appelant**, jamais
    // reportée sur la frontière voisine : un cadrage humain posé sur un autre
    // plan est un cadrage faux que rien ne signale.
    it('rejette une dérogation orpheline plutôt que de la reporter sur une voisine', () => {
      const déplacé = [PLAN_A, plan(10.4, 20)]
      const cadrage = computeFraming({
        ...base,
        shots: déplacé,
        cropMode: 'manual',
        crops: { 10000: 0.05 },
      })
      expect(cadrage.rejectedOverrides).toEqual([10000])
      expect(cadrage.shots.map((s) => s.source)).toEqual(['auto', 'auto'])
      expect(cadrage.shots[0].cropX).toBeCloseTo(0.4, 6)
    })

    it('rejette une clé qui ne désigne aucun plan du clip', () => {
      const cadrage = computeFraming({ ...base, cropMode: 'manual', crops: { 42000: 0.05 } })
      expect(cadrage.rejectedOverrides).toEqual([42000])
      expect(cadrage.shots.every((s) => s.source === 'auto')).toBe(true)
    })

    // La plus proche gagne, et pas la dernière lue : l'ordre des clés dans un
    // objet JSON n'est pas une décision humaine, la distance en est une.
    it('garde la plus proche quand deux dérogations visent le même plan', () => {
      const tardive = computeFraming({
        ...base,
        cropMode: 'manual',
        crops: { 9950: 0.2, 10200: 0.8 },
      })
      expect(tardive.shots[1]).toMatchObject({ key: 10000, cropX: 0.2, source: 'manual' })
      expect(tardive.rejectedOverrides).toEqual([10200])

      const précoce = computeFraming({
        ...base,
        cropMode: 'manual',
        crops: { 9800: 0.2, 10050: 0.8 },
      })
      expect(précoce.shots[1]).toMatchObject({ key: 10000, cropX: 0.8, source: 'manual' })
      expect(précoce.rejectedOverrides).toEqual([9800])
    })

    it('borne une valeur hors de [0, 1] au lieu de la rejeter — c’est une intention', () => {
      const cadrage = computeFraming({ ...base, cropMode: 'manual', crops: { 0: 1.4 } })
      expect(cadrage.shots[0]).toMatchObject({ key: 0, cropX: 1, source: 'manual' })
    })

    it('rejette une valeur non finie', () => {
      const cadrage = computeFraming({
        ...base,
        cropMode: 'manual',
        crops: { 0: Number.NaN },
      })
      expect(cadrage.rejectedOverrides).toEqual([0])
      expect(cadrage.shots[0].source).toBe('auto')
    })

    it('rend les rejets triés, sans doublon', () => {
      const cadrage = computeFraming({
        ...base,
        cropMode: 'manual',
        crops: { 42000: 0.5, 5000: 0.5 },
      })
      expect(cadrage.rejectedOverrides).toEqual([5000, 42000])
    })
  })

  describe('quand personne n’est détecté', () => {
    // Aucune mesure sur tout le clip : le 16:9 ne perd rien et se voit, là où un
    // 9:16 aveugle couperait les comédiens en silence.
    it('sur tout le clip, prend le ratio le plus large et centre les crops', () => {
      const cadrage = computeFraming({ ...base, people: [] })
      expect(cadrage.ratio).toBe('16:9')
      expect(cadrage.shots.map((s) => s.source)).toEqual(['default', 'default'])
      expect(cadrage.shots.map((s) => s.cropX)).toEqual([0.5, 0.5])
    })

    // Un plan aveugle n'emprunte pas le crop de son voisin : une frontière de
    // plan est précisément l'endroit où l'axe change.
    it('sur un plan seulement, centre ce plan et laisse les autres tranquilles', () => {
      const cadrage = computeFraming({ ...base, people: échantillon(0, 10, [[0.2, 0.6]]) })
      expect(cadrage.shots[0].source).toBe('auto')
      expect(cadrage.shots[1]).toMatchObject({ key: 10000, cropX: 0.5, source: 'default' })
    })

    it('reste dérogeable : un plan aveugle accepte une dérogation humaine', () => {
      const cadrage = computeFraming({
        ...base,
        people: échantillon(0, 10, [[0.2, 0.6]]),
        cropMode: 'manual',
        crops: { 10000: 0.83 },
      })
      expect(cadrage.shots[1]).toMatchObject({ cropX: 0.83, source: 'manual' })
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
  const cadre = (x0: number, x1: number, y0: number, y1: number, score = 0.9): PersonBox => ({
    t: 1,
    x0,
    x1,
    y0,
    y1,
    score,
  })

  /** Une tête de spectateur au premier rang : le bas de l'image la coupe. */
  const spectateur = cadre(0, 0.18, 0.86, 0.998)
  /** Un comédien debout : ses pieds touchent le bas du cadre, et il est haut. */
  const comédienDebout = cadre(0.3, 0.45, 0.16, 0.99)
  /** Deux comédiens assis dans le noir, à 419 s : courts, mais loin du bord bas. */
  const comédienLointain = cadre(0.41, 0.52, 0.2, 0.47)

  it('écarte une tête tronquée par le bord bas', () => {
    expect(isForeground(spectateur)).toBe(true)
  })

  // 76 % des boîtes de comédiens de `cqlp` touchent le bas de l'image. Un filtre
  // qui ne regarde que le bord bas ne laisse survivre que 16 % des boîtes.
  it('garde un comédien debout dont les pieds touchent le bas', () => {
    expect(isForeground(comédienDebout)).toBe(false)
  })

  // Le contre-exemple trouvé à l'image : une hauteur minimale sans condition de
  // bord vide ce plan-là de ses deux comédiens. Sur `caro-mdlm`, 3 075 boîtes.
  it('garde une boîte courte mais détachée du bord bas', () => {
    expect(isForeground(comédienLointain)).toBe(false)
  })

  it('les deux conditions sont nécessaires, et aucune ne suffit', () => {
    // Courte et collée : écartée. Courte et détachée, haute et collée : gardées.
    expect(isForeground(cadre(0, 0.2, 0.8, 1))).toBe(true)
    expect(isForeground(cadre(0, 0.2, 0.6, 0.8))).toBe(false)
    expect(isForeground(cadre(0, 0.2, 0.1, 1))).toBe(false)
  })

  it('les seuils sont des réglages, pas des constantes gravées', () => {
    expect(isForeground(spectateur, { foregroundMaxHeight: 0.1 })).toBe(false)
    expect(isForeground(comédienDebout, { foregroundMaxHeight: 0.9 })).toBe(true)
    expect(isForeground(spectateur, { bottomEdge: 0.999 })).toBe(false)
  })

  // C'est ce qui rend l'avant/après mesurable sans deux versions du code.
  it('une hauteur maximale nulle éteint le filtre : rien n’est plus court que zéro', () => {
    expect(isForeground(spectateur, { foregroundMaxHeight: 0 })).toBe(false)
    // Une valeur négative ne peut pas retourner le sens du filtre.
    expect(isForeground(spectateur, { foregroundMaxHeight: -1 })).toBe(false)
  })

  // Le bord est inclusif et la hauteur exclusive, comme les seuils de `empans` :
  // une boîte pile au seuil de hauteur est un comédien, pas du public.
  it('tranche les cas pile sur les seuils', () => {
    // Le bord est inclusif : une boîte qui l'atteint est tronquée.
    expect(isForeground(cadre(0, 0.2, 0.7, 0.97), { bottomEdge: 0.97 })).toBe(true)
    expect(isForeground(cadre(0, 0.2, 0.7, 0.9699), { bottomEdge: 0.97 })).toBe(false)
    // La hauteur est exclusive : pile au seuil, c'est un comédien. Les bornes
    // partent de zéro pour que la soustraction soit exacte — `1 - 0.65` ne vaut
    // pas 0,35 en flottant, et un test de borne ne doit pas dépendre de ça.
    const bordPartout = { bottomEdge: 0 }
    expect(isForeground(cadre(0, 0.2, 0, 0.35), { ...bordPartout, foregroundMaxHeight: 0.35 })).toBe(
      false,
    )
    expect(isForeground(cadre(0, 0.2, 0, 0.34), { ...bordPartout, foregroundMaxHeight: 0.35 })).toBe(
      true,
    )
  })

  // Même motif que `margin` et `minScore` : `??` laisserait passer un `NaN`, qui
  // rendrait toute comparaison fausse et éteindrait le filtre en silence.
  it('retombe sur les défauts quand un réglage n’est pas fini', () => {
    expect(isForeground(spectateur, { foregroundMaxHeight: Number.NaN })).toBe(true)
    expect(isForeground(spectateur, { bottomEdge: Number.NaN })).toBe(true)
  })

  // Un filtre qui ne peut pas juger ne rejette pas : la boîte survit et c'est
  // `empans` qui décidera si elle est exploitable.
  it('garde une boîte dont la hauteur ne se mesure pas', () => {
    expect(isForeground(cadre(0, 0.2, Number.NaN, 0.99))).toBe(false)
    expect(isForeground(cadre(0, 0.2, 0.8, Number.NaN))).toBe(false)
  })
})

describe('le premier plan écarté du cadrage', () => {
  /** Un plan de 10 s où deux comédiens tiennent le tiers central du cadre. */
  const comédiens = (t: number): PersonBox[] => [
    { t, x0: 0.37, x1: 0.46, y0: 0.15, y1: 0.99, score: 0.9 },
    { t, x0: 0.54, x1: 0.63, y0: 0.15, y1: 0.99, score: 0.9 },
  ]
  /** Deux têtes de spectateurs, une à chaque bord, qui étalent l'empan à tout. */
  const public_ = (t: number): PersonBox[] => [
    { t, x0: 0, x1: 0.16, y0: 0.85, y1: 0.998, score: 0.7 },
    { t, x0: 0.84, x1: 1, y0: 0.85, y1: 0.998, score: 0.7 },
  ]
  const surDix = (avec: boolean): PersonBox[] => {
    const out: PersonBox[] = []
    for (let t = 0; t < 10 - 1e-9; t += 0.5) {
      out.push(...comédiens(Number(t.toFixed(3))))
      if (avec) out.push(...public_(Number(t.toFixed(3))))
    }
    return out
  }

  it('resserre l’empan sur les comédiens au lieu de l’étaler d’un bord à l’autre', () => {
    const boîtes = surDix(true)
    expect(
      requiredWidths(boîtes, { margin: 0, foregroundMaxHeight: 0, ...NO_TRIM })[0],
    ).toBeCloseTo(1, 10)
    expect(requiredWidths(boîtes, { margin: 0, ...NO_TRIM })[0]).toBeCloseTo(0.26, 10)
  })

  // Le constat qui a motivé la tâche : sans le filtre, tout sort au ratio le
  // plus large, c'est-à-dire à rien.
  it('fait descendre le ratio du 16:9 au 9:16', () => {
    const boîtes = surDix(true)
    expect(chooseRatio(boîtes, SRC_W, SRC_H, { foregroundMaxHeight: 0 })).toBe('16:9')
    expect(chooseRatio(boîtes, SRC_W, SRC_H)).toBe('9:16')
  })

  it('ne change rien à une émission sans public au cadre', () => {
    const boîtes = surDix(false)
    expect(chooseRatio(boîtes, SRC_W, SRC_H, { foregroundMaxHeight: 0 })).toBe(
      chooseRatio(boîtes, SRC_W, SRC_H),
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
    const poisson: PersonBox[] = [{ t: 1, x0: 0, x1: 0.29, y0: 0.74, y1: 0.998, score: 0.57 }]
    expect(chooseRatio(poisson, SRC_W, SRC_H, { foregroundMaxHeight: 0 })).toBe('9:16')
    expect(chooseRatio(poisson, SRC_W, SRC_H)).toBe('16:9')
  })

  it('traverse computeFraming : le réglage passe de la requête aux empans', () => {
    const commun = {
      segments: [seg(0, 10)],
      shots: [plan(0, 10)],
      people: surDix(true),
      srcW: SRC_W,
      srcH: SRC_H,
      ratio: 'auto' as const,
      cropMode: 'auto' as const,
    }
    expect(computeFraming({ ...commun, foregroundMaxHeight: 0 }).ratio).toBe('16:9')
    const cadré = computeFraming(commun)
    expect(cadré.ratio).toBe('9:16')
    expect(cadré.shots[0]).toMatchObject({ source: 'auto' })
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
    const àGauche = (t: number): PersonBox[] => [
      { t, x0: 0, x1: 0.16, y0: 0.85, y1: 0.998, score: 0.7 },
      { t, x0: 0.1, x1: 0.26, y0: 0.85, y1: 0.998, score: 0.7 },
    ]
    const gens: PersonBox[] = []
    for (let t = 0; t < 10 - 1e-9; t += 0.5) {
      const clé = Number(t.toFixed(3))
      gens.push(...comédiens(clé), ...àGauche(clé))
    }
    const commun = {
      segments: [seg(0, 10)],
      shots: [plan(0, 10)],
      people: gens,
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
    const sansFiltre = computeFraming({ ...commun, foregroundMaxHeight: 0 }).shots[0].cropX
    const avecFiltre = computeFraming(commun).shots[0].cropX
    // Le public tire le cadre vers le bord gauche ; les comédiens le posent sur
    // le milieu de l'action, qu'ils occupent symétriquement.
    expect(sansFiltre).toBeCloseTo(0.315, 3)
    expect(avecFiltre).toBeCloseTo(0.5, 3)
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
    for (const r of TOUS) {
      expect(sizeInCanvas(r, VERTICAL).h / VERTICAL.h).toBeCloseTo(
        RATIOS['9:16'] / RATIOS[r],
        3,
      )
    }
  })

  // libx264 refuse une dimension impaire en yuv420p. 1080 / (16/9) vaut 607,5,
  // et c'est le seul des quatre qui ne tombe pas juste.
  it('rend toujours une hauteur paire', () => {
    for (const r of TOUS) expect(sizeInCanvas(r, VERTICAL).h % 2).toBe(0)
  })

  // Dans son propre canevas, un cadre remplit — c'est ce qui fait que le rendu
  // natif ne compose jamais de fond flouté, et que la même fonction sert des
  // deux côtés.
  it('remplit le canevas qui a son propre ratio', () => {
    for (const r of TOUS) {
      const canevas = outputSize(r)
      expect(sizeInCanvas(r, canevas).h).toBe(canevas.h)
    }
  })
})

describe('le ratio par plan', () => {
  // Deux plans très différents : l'un serré à gauche, l'autre large au centre.
  // Un ratio unique pour le clip écraserait le premier sous le second — c'est
  // exactement ce que le modèle par plan évite.
  const TIGHT = échantillon(0, 10, [[0.05, 0.2]])
  const WIDE = échantillon(10, 20, [[0.3, 0.8]])
  const twoShots = {
    ...base,
    people: [...TIGHT, ...WIDE],
    // La marge est posée à zéro : ce bloc mesure le choix du ratio, pas l'air
    // laissé autour des gens, et laisser le défaut ferait bouger les nombres au
    // prochain réglage de `margin`.
    margin: 0,
  }

  it('donne à chaque plan le cadre le plus serré qui tienne chez lui', () => {
    const cadrage = computeFraming(twoShots)
    expect(cadrage.shots.map((p) => p.ratio)).toEqual(['9:16', '1:1'])
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
    const cadrage = computeFraming({ ...twoShots, ratio: '4:5' })
    expect(cadrage.ratio).toBe('4:5')
    for (const p of cadrage.shots) {
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
    const étroit = { ...base, margin: 0, people: échantillon(8, 10, [[0.45, 0.55]]) }
    // Le plan couvre [8, 10], le montage va jusqu'à 14 : quatre secondes que
    // personne n'a mesurées.
    const débordant = computeFraming({
      ...étroit,
      shots: [plan(8, 10)],
      segments: [seg(8, 14)],
    })
    expect(débordant.shots[0].ratio).toBe('9:16')
    expect(débordant.ratio).toBe('16:9')

    // Le même montage entièrement couvert garde le ratio de son plan.
    const couvert = computeFraming({ ...étroit, shots: [plan(8, 14)], segments: [seg(8, 14)] })
    expect(couvert.ratio).toBe('9:16')
  })

  // Sous une image, l'intervalle est absorbé par son voisin dans le découpage et
  // ne porte aucun cadre à lui : l'élargir serait une faute dans l'autre sens.
  it('ignore un débordement plus court qu’une image', () => {
    const cadrage = computeFraming({
      ...base,
      margin: 0,
      people: échantillon(8, 10, [[0.45, 0.55]]),
      shots: [plan(8, 10)],
      segments: [seg(8, 10 + MIN_PIECE_SEC / 2)],
    })
    expect(cadrage.ratio).toBe('9:16')
  })

  // Sans plan du tout, le ratio natif est le plus large — la même réponse que
  // `chooseRatio` quand il ne mesure rien : une sortie visiblement large se
  // rattrape d'un clic, un 9:16 aveugle coupe les comédiens sans un mot.
  it('sans aucun plan, prend le ratio le plus large pour le natif', () => {
    const cadrage = computeFraming({ ...base, shots: [], segments: [seg(0, 20)] })
    expect(cadrage.shots).toHaveLength(0)
    expect(cadrage.ratio).toBe('16:9')
  })

  // Une dérogation est une intention humaine sur *où regarder*, pas sur une
  // fenêtre : la poser d'un seul côté ferait diverger le natif et la variante
  // sur un plan que quelqu'un a cadré exprès, et l'écart ne se verrait qu'en
  // comparant deux fichiers.
  it('une dérogation écrit les deux positions', () => {
    const cadrage = computeFraming({ ...twoShots, cropMode: 'manual', crops: { 0: 0.42 } })
    expect(cadrage.shots[0]).toMatchObject({ source: 'manual', cropX: 0.42, cropXNative: 0.42 })
    expect(cadrage.shots[1].source).toBe('auto')
  })
})

describe('le rognage latéral', () => {
  /** Les deux comédiens de `2025-06-15-cqlp` à 2120 s, relevés dans `analysis.json`. */
  const elle = { x0: 0.106, x1: 0.49 }
  const lui = { x0: 0.523, x1: 0.778 }
  /** Le plan de référence : 61 images, les deux comédiens immobiles. */
  const planDeRéférence = échantillon(0, 30.5, [
    [elle.x0, elle.x1],
    [lui.x0, lui.x1],
  ])

  it('abandonne une part de la largeur de chaque boîte, de chaque côté', () => {
    const b = boîte(0, 0.2, 0.6)
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
    const large = boîte(0, 0.345, 0.881)
    const sansPlafond = trimmedBounds(large, { sideTrim: 0.3, sideTrimMax: 1 })
    expect(large.x1 - sansPlafond.x1).toBeCloseTo(0.161, 3)

    const avecPlafond = trimmedBounds(large, FRAMING_DEFAULTS)
    expect(large.x1 - avecPlafond.x1).toBeCloseTo(FRAMING_DEFAULTS.sideTrimMax, 10)
    expect(avecPlafond.x0 - large.x0).toBeCloseTo(FRAMING_DEFAULTS.sideTrimMax, 10)
  })

  // Une boîte étroite est gouvernée par la part, jamais par le plafond : c'est
  // ce qui protège un comédien lointain, qu'un rognage absolu effacerait.
  it('ne prend jamais plus que la part sur une boîte étroite', () => {
    const lointain = boîte(0, 0.45, 0.55)
    const { x0, x1 } = trimmedBounds(lointain, FRAMING_DEFAULTS)
    expect(x0 - lointain.x0).toBeCloseTo(0.1 * FRAMING_DEFAULTS.sideTrim, 10)
    expect(x1 - x0).toBeGreaterThan(0)
  })

  // Une boîte ne se retourne pas : au pire elle se réduit à son centre. Un empan
  // dont la borne gauche passerait à droite de la droite ne se lit nulle part en
  // aval, et se propagerait en crop absurde.
  it('ne retourne jamais une boîte, quels que soient les réglages', () => {
    const b = boîte(0, 0.4, 0.44)
    const { x0, x1 } = trimmedBounds(b, { sideTrim: 5, sideTrimMax: 10 })
    expect(x1 - x0).toBeGreaterThanOrEqual(0)
    expect(x0).toBeCloseTo(0.42, 10)
    expect(x1).toBeCloseTo(0.42, 10)
  })

  it('retombe sur les défauts quand un réglage n’est pas fini', () => {
    const b = boîte(0, 0.2, 0.6)
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
    const union = lui.x1 - elle.x0
    expect(union).toBeGreaterThan(ratioCoverage('1:1', SRC_W, SRC_H))
    expect(chooseRatio(planDeRéférence, SRC_W, SRC_H, NO_TRIM)).toBe('16:9')
    expect(chooseRatio(planDeRéférence, SRC_W, SRC_H)).toBe('1:1')
  })

  /**
   * **Le rognage est une permission, pas une coupe.** Il ne décide que du
   * ratio ; la fenêtre retenue est plus large que l'empan rogné et rend
   * l'essentiel de ce qui avait été abandonné. Sur ce plan, chacun perd moins du
   * quart de sa largeur là où le réglage l'autorisait à en perdre 30 %.
   */
  it('rend au cadre ce que le rognage avait abandonné', () => {
    const cadrage = computeFraming({
      segments: [seg(0, 30.5)],
      shots: [plan(0, 30.5)],
      people: planDeRéférence,
      srcW: SRC_W,
      srcH: SRC_H,
      ratio: 'auto',
      cropMode: 'auto',
    })
    const largeur = ratioCoverage('1:1', SRC_W, SRC_H)
    const x = cadrage.shots[0].cropX - largeur / 2
    const perte = (b: { x0: number; x1: number }): number =>
      1 - (Math.min(b.x1, x + largeur) - Math.max(b.x0, x)) / (b.x1 - b.x0)
    expect(perte(elle)).toBeLessThan(0.25)
    expect(perte(lui)).toBeLessThan(0.25)
  })

  /**
   * **Le rognage ne peut pas élargir un ratio**, et c'est ce que la campagne du
   * 19 août 2026 a vérifié sur les trois émissions : de 0 à 0,40, aucun clip ni
   * aucune fenêtre ne s'élargit. La propriété se démontre — rogner ne peut que
   * réduire un empan, donc que rendre un ratio candidat plus atteignable — mais
   * une démonstration ne survit pas à une réécriture, et ce test si.
   */
  it('ne fait jamais monter un ratio', () => {
    const configurations: PersonBox[][] = [
      planDeRéférence,
      échantillon(0, 10, [[0.35, 0.65]]),
      échantillon(0, 10, [[0.02, 0.98]]),
      [...échantillon(0, 5, [[0.05, 0.25]]), ...échantillon(5, 10, [[0.75, 0.95]])],
      échantillon(0, 10, [
        [0.05, 0.3],
        [0.4, 0.5],
        [0.7, 0.98],
      ]),
    ]
    for (const gens of configurations) {
      const sans = chooseRatio(gens, SRC_W, SRC_H, NO_TRIM)
      for (const sideTrim of [0.1, 0.2, 0.3, 0.4]) {
        const avec = chooseRatio(gens, SRC_W, SRC_H, { sideTrim })
        expect(RATIOS[avec]).toBeLessThanOrEqual(RATIOS[sans])
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
      chooseRatio(planDeRéférence, SRC_W, SRC_H, { sideTrim, sideTrimMax })
    // Les deux bornes mordent : abaisser l'une ou l'autre sous son seuil rend
    // le 16:9. Aucune des deux n'est décorative.
    expect(ratio(0.2, FRAMING_DEFAULTS.sideTrimMax)).toBe('16:9')
    expect(ratio(FRAMING_DEFAULTS.sideTrim, 0.06)).toBe('16:9')
    expect(ratio(FRAMING_DEFAULTS.sideTrim, FRAMING_DEFAULTS.sideTrimMax)).toBe('1:1')
  })
})
