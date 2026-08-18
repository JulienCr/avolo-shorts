import { describe, it, expect } from 'vitest'
import {
  RATIOS,
  chooseRatio,
  computeFraming,
  cropRect,
  outputSize,
  ratioCoverage,
  requiredWidths,
  resolveRatio,
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
    expect(requiredWidths(boîtes, { margin: 0 })).toEqual([
      expect.closeTo(0.5, 10),
      expect.closeTo(0.1, 10),
    ])
  })

  it("ajoute une marge de chaque côté, et l'air par défaut n'est pas nul", () => {
    expect(requiredWidths([boîte(1, 0.4, 0.6)], { margin: 0.05 })[0]).toBeCloseTo(0.3, 10)
    expect(requiredWidths([boîte(1, 0.4, 0.6)])[0]).toBeGreaterThan(0.2)
  })

  it('borne la largeur à 1 : rien ne dépasse la source', () => {
    expect(requiredWidths([boîte(1, 0, 1)], { margin: 0.1 })).toEqual([1])
  })

  // Une détection douteuse au bord du cadre suffirait à imposer un 16:9.
  it('écarte les boîtes sous le seuil de confiance', () => {
    const boîtes = [boîte(1, 0.4, 0.6, 0.9), boîte(1, 0.95, 0.99, 0.2)]
    expect(requiredWidths(boîtes, { margin: 0, minScore: 0.5 })).toEqual([
      expect.closeTo(0.2, 10),
    ])
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
  const sansMarge = { margin: 0 }

  it('retient le plus petit ratio qui couvre', () => {
    expect(chooseRatio([fixe(0.35, 0.65)], SRC_W, SRC_H, sansMarge)).toBe('9:16')
    expect(chooseRatio([fixe(0.3, 0.7)], SRC_W, SRC_H, sansMarge)).toBe('4:5')
    expect(chooseRatio([fixe(0.25, 0.75)], SRC_W, SRC_H, sansMarge)).toBe('1:1')
    expect(chooseRatio([fixe(0.1, 0.9)], SRC_W, SRC_H, sansMarge)).toBe('16:9')
  })

  it('couvre pile la largeur mesurée, sans marge supplémentaire', () => {
    const w = ratioCoverage('9:16', SRC_W, SRC_H)
    expect(chooseRatio([fixe(0.5 - w / 2, 0.5 + w / 2)], SRC_W, SRC_H, sansMarge)).toBe('9:16')
    expect(
      chooseRatio([fixe(0.5 - w / 2 - 1e-4, 0.5 + w / 2 + 1e-4)], SRC_W, SRC_H, sansMarge),
    ).toBe('4:5')
  })

  // Le cœur de la décision : le seuil est à 90 %, pas au maximum. Deux images
  // sur vingt où quelqu'un traverse ne condamnent pas le clip au 16:9.
  it('absorbe une traversée que le maximum aurait payée en 16:9', () => {
    const plan = [...échantillon(0, 9, [[0.35, 0.65]]), ...échantillon(9, 10, [[0.02, 0.98]])]
    expect(chooseRatio([plan], SRC_W, SRC_H, sansMarge)).toBe('9:16')
    expect(Math.max(...requiredWidths(plan, sansMarge))).toBeGreaterThan(
      ratioCoverage('1:1', SRC_W, SRC_H),
    )
  })

  it('cède quand plus de 10 % des images débordent', () => {
    const plan = [...échantillon(0, 7.5, [[0.35, 0.65]]), ...échantillon(7.5, 10, [[0.02, 0.98]])]
    expect(chooseRatio([plan], SRC_W, SRC_H, sansMarge)).toBe('16:9')
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
    expect(chooseRatio([traversée], SRC_W, SRC_H, sansMarge)).toBe('16:9')
  })

  // Le pendant, sans lequel le précédent inviterait à sur-corriger : entre deux
  // plans le crop a le droit de sauter, puisqu'une coupe existe déjà là.
  it('ne fait pas monter le ratio quand le déplacement est entre deux plans', () => {
    const gauche = échantillon(0, 5, [[0.05, 0.25]])
    const droite = échantillon(5, 10, [[0.75, 0.95]])
    expect(chooseRatio([gauche, droite], SRC_W, SRC_H, sansMarge)).toBe('9:16')
  })

  // Aucune mesure : on ne sait rien de l'endroit où sont les gens. Le 16:9 est
  // le seul choix qui ne perd aucune information — la sortie est visiblement
  // large, donc rattrapable d'un clic, là où un 9:16 aveugle couperait les
  // comédiens sans que rien ne le signale.
  it('sans aucune mesure, prend le ratio le plus large plutôt que de couper à l’aveugle', () => {
    expect(chooseRatio([], SRC_W, SRC_H)).toBe('16:9')
    expect(chooseRatio([[], []], SRC_W, SRC_H)).toBe('16:9')
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
    }
    expect(computeFraming(symétrique).ratio).toBe('16:9')
    expect(computeFraming(symétrique).shots[0].cropX).toBeCloseTo(0.5, 6)

    // Ratio épinglé trop étroit : les deux moitiés s'excluent, aucune ne cadre
    // plus d'images que l'autre, et le départage tombe à gauche.
    const épinglé = computeFraming({ ...symétrique, ratio: '4:5' })
    expect(épinglé.shots[0].cropX).toBeCloseTo(0.305, 6)

    // Et « à gauche » veut bien dire à gauche dans l'image, pas en premier dans
    // le tableau : l'ordre des boîtes dans un JSON n'est pas une décision.
    const àLenvers = computeFraming({
      ...symétrique,
      ratio: '4:5',
      people: [...symétrique.people].reverse(),
    })
    expect(àLenvers.shots[0].cropX).toBeCloseTo(0.305, 6)

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
    expect(presqueÉgal.shots[0].cropX).toBeCloseTo(0.305, 6)
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
