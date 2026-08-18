import { describe, expect, it } from 'vitest'

import type { Ratio, Segment } from '@/core/edl'
import { DURÉE_MINIMALE_MORCEAU, découperParPlan } from '@/core/decoupe'
import type { ShotFraming } from '@/core/framing'

/**
 * Le découpage d'un montage par plan — la pièce entre le cadrage et le rendu.
 *
 * **L'invariant qui porte tout le fichier : la somme des durées ne bouge pas.**
 * Le recalage des sous-titres additionne les durées des entrées dans leur ordre
 * (`retimeWords` puis `renderArgs`), donc un morceau perdu, dupliqué ou raboté
 * décale tous les cartons qui suivent — sans qu'aucun test de durée totale ne le
 * voie, puisque la durée totale, elle, ne change que si on perd le morceau
 * entier.
 */

const DÉFAUT = { ratio: '16:9' as Ratio, cropX: 0.5, cropXNatif: 0.5 }

function plan(start: number, end: number, ratio: Ratio, cropX: number): ShotFraming {
  return {
    shot: { start, end },
    key: Math.round(start * 1000),
    ratio,
    cropX,
    cropXNatif: cropX,
    source: 'auto',
  }
}

const seg = (start: number, end: number): Segment => ({ start, end })

/** La somme des durées, celle sur laquelle les sous-titres sont calés. */
const durée = (l: readonly Segment[]): number => l.reduce((n, s) => n + (s.end - s.start), 0)

describe('découperParPlan', () => {
  it('laisse un segment entier quand il tient dans un seul plan', () => {
    const m = découperParPlan([seg(2, 8)], [plan(0, 10, '1:1', 0.3)], DÉFAUT)
    expect(m).toEqual([{ start: 2, end: 8, ratio: '1:1', cropX: 0.3, cropXNatif: 0.3 }])
  })

  // Le cœur : un segment qui traverse une frontière devient deux entrées, et
  // chacune porte le cadre de son plan.
  it('coupe un segment sur la frontière qu’il traverse', () => {
    const m = découperParPlan(
      [seg(5, 15)],
      [plan(0, 10, '9:16', 0.2), plan(10, 20, '1:1', 0.8)],
      DÉFAUT,
    )
    expect(m).toEqual([
      { start: 5, end: 10, ratio: '9:16', cropX: 0.2, cropXNatif: 0.2 },
      { start: 10, end: 15, ratio: '1:1', cropX: 0.8, cropXNatif: 0.8 },
    ])
  })

  it('coupe autant de fois qu’il traverse de plans', () => {
    const plans = [
      plan(0, 4, '9:16', 0.1),
      plan(4, 8, '4:5', 0.2),
      plan(8, 12, '1:1', 0.3),
      plan(12, 16, '16:9', 0.4),
      plan(16, 20, '1:1', 0.5),
    ]
    const m = découperParPlan([seg(1, 19)], plans, DÉFAUT)
    expect(m.map((x) => [x.start, x.end])).toEqual([
      [1, 4],
      [4, 8],
      [8, 12],
      [12, 16],
      [16, 19],
    ])
    expect(m.map((x) => x.ratio)).toEqual(['9:16', '4:5', '1:1', '16:9', '1:1'])
  })

  // **L'invariant du recalage.** Les bornes intermédiaires sont recopiées, pas
  // recalculées : la somme des durées vaut celle du montage, au bit près.
  it('couvre exactement le montage, sans trou ni recouvrement', () => {
    const segments = [seg(1, 19), seg(30, 33.5)]
    const plans = [plan(0, 4, '9:16', 0.1), plan(4, 12, '4:5', 0.2), plan(12, 40, '1:1', 0.3)]
    const m = découperParPlan(segments, plans, DÉFAUT)
    expect(durée(m)).toBe(durée(segments))
    for (let i = 1; i < m.length; i += 1) expect(m[i].start).toBeGreaterThanOrEqual(m[i - 1].end)
  })

  // **Une borne qui tombe pile sur une frontière appartient au plan qui
  // commence.** Le cadre se résout sur le *milieu* du morceau et non sur son
  // début : sinon `start` appartiendrait au plan qui se termine là, et le morceau
  // prendrait le cadrage du plan d'avant sur toute sa durée.
  it('donne à un segment commencé sur une frontière le cadre du plan qui commence', () => {
    const m = découperParPlan(
      [seg(10, 15)],
      [plan(0, 10, '9:16', 0.2), plan(10, 20, '1:1', 0.8)],
      DÉFAUT,
    )
    expect(m).toEqual([{ start: 10, end: 15, ratio: '1:1', cropX: 0.8, cropXNatif: 0.8 }])
  })

  // **Un morceau plus court qu'une image ouvre un décodeur qui ne rend rien**,
  // ou une image de trop : la somme des durées demandées cesse alors de décrire
  // ce que le fichier contient, et les sous-titres glissent. La frontière est
  // absorbée par le plan voisin plutôt que de produire une entrée impossible.
  it('n’ouvre pas d’entrée plus courte qu’une image', () => {
    const trois = DURÉE_MINIMALE_MORCEAU / 3
    const m = découperParPlan(
      [seg(10 - trois, 20)],
      [plan(0, 10, '9:16', 0.2), plan(10, 20, '1:1', 0.8)],
      DÉFAUT,
    )
    expect(m).toHaveLength(1)
    expect(m[0].start).toBe(10 - trois)
    expect(m[0].end).toBe(20)
    // Et le cadre reste celui du plan qui porte l'essentiel du morceau.
    expect(m[0].ratio).toBe('1:1')
  })

  it('n’ouvre pas non plus d’entrée trop courte à la fin d’un segment', () => {
    const trois = DURÉE_MINIMALE_MORCEAU / 3
    const m = découperParPlan(
      [seg(0, 10 + trois)],
      [plan(0, 10, '9:16', 0.2), plan(10, 20, '1:1', 0.8)],
      DÉFAUT,
    )
    expect(m).toHaveLength(1)
    expect(m[0].ratio).toBe('9:16')
  })

  // Sans plan, il reste un montage à rendre : c'est le repli du serveur quand
  // `analysis.json` manque, et il ne doit ni disparaître ni se découper.
  it('rend le montage tel quel avec le cadre par défaut quand aucun plan ne le couvre', () => {
    const m = découperParPlan([seg(0, 10), seg(20, 25)], [], DÉFAUT)
    expect(m).toEqual([
      { start: 0, end: 10, ...DÉFAUT },
      { start: 20, end: 25, ...DÉFAUT },
    ])
  })

  // Les plans partitionnent la durée du **proxy** ; la source peut finir
  // quelques images plus loin. L'intervalle découvert prend le cadre par défaut
  // plutôt que d'ouvrir un trou dans la couverture.
  it('couvre au cadre par défaut ce qu’aucun plan n’atteint', () => {
    const segments = [seg(8, 14)]
    const m = découperParPlan(segments, [plan(0, 10, '9:16', 0.2)], DÉFAUT)
    expect(durée(m)).toBe(durée(segments))
    expect(m).toEqual([
      { start: 8, end: 10, ratio: '9:16', cropX: 0.2, cropXNatif: 0.2 },
      { start: 10, end: 14, ...DÉFAUT },
    ])
  })

  it('normalise le montage avant de le découper', () => {
    // Deux segments qui se touchent n'en valent qu'un ; un segment vide, zéro.
    const m = découperParPlan(
      [seg(5, 8), seg(8, 9), seg(3, 3)],
      [plan(0, 20, '1:1', 0.5)],
      DÉFAUT,
    )
    expect(m).toEqual([{ start: 5, end: 9, ratio: '1:1', cropX: 0.5, cropXNatif: 0.5 }])
  })

  it('ne dépend ni de l’ordre des plans ni de leur contiguïté', () => {
    const désordre = [plan(10, 20, '1:1', 0.8), plan(0, 10, '9:16', 0.2)]
    const m = découperParPlan([seg(5, 15)], désordre, DÉFAUT)
    expect(m.map((x) => x.ratio)).toEqual(['9:16', '1:1'])
  })

  it('écarte un plan aux bornes non finies au lieu de propager le NaN', () => {
    const cassé: ShotFraming = {
      shot: { start: Number.NaN, end: 10 },
      key: 0,
      ratio: '9:16',
      cropX: 0.2,
      cropXNatif: 0.2,
      source: 'auto',
    }
    const m = découperParPlan([seg(0, 20)], [cassé, plan(0, 20, '1:1', 0.5)], DÉFAUT)
    expect(m).toEqual([{ start: 0, end: 20, ratio: '1:1', cropX: 0.5, cropXNatif: 0.5 }])
  })

  /**
   * **Deux plans consécutifs au même cadre ne valent qu'une entrée**, et c'est
   * le cas courant : sur `2026-22-02-entre-nous`, un clip de 13 plans les rend
   * tous en 16:9 pleine largeur — donc au même rectangle exactement — et
   * s'ouvrirait sinon treize décodeurs pour ne rien changer à l'image. Le graphe
   * est mesuré bon jusqu'à une dizaine d'entrées.
   *
   * Ça resserre aussi le recalage plutôt que de le desserrer : chaque coupe
   * interne est un endroit où la durée demandée s'arrondit à l'image, et en
   * retirer une retire un arrondi.
   */
  it('fusionne deux plans consécutifs au même cadre', () => {
    const m = découperParPlan(
      [seg(0, 30)],
      [plan(0, 10, '16:9', 0.5), plan(10, 20, '16:9', 0.5), plan(20, 30, '16:9', 0.5)],
      DÉFAUT,
    )
    expect(m).toEqual([{ start: 0, end: 30, ratio: '16:9', cropX: 0.5, cropXNatif: 0.5 }])
  })

  it('ne fusionne pas deux plans dont le cadre diffère', () => {
    const parRatio = découperParPlan(
      [seg(0, 20)],
      [plan(0, 10, '16:9', 0.5), plan(10, 20, '1:1', 0.5)],
      DÉFAUT,
    )
    expect(parRatio).toHaveLength(2)

    const parPosition = découperParPlan(
      [seg(0, 20)],
      [plan(0, 10, '1:1', 0.3), plan(10, 20, '1:1', 0.7)],
      DÉFAUT,
    )
    expect(parPosition).toHaveLength(2)
  })

  // **La fusion ne franchit pas une coupe du montage.** Deux segments séparés
  // par un retrait ne se touchent pas : les recoller ferait revenir le passage
  // retiré, sans erreur ni trace.
  it('ne fusionne jamais par-dessus un passage retiré', () => {
    const m = découperParPlan(
      [seg(0, 10), seg(20, 30)],
      [plan(0, 40, '16:9', 0.5)],
      DÉFAUT,
    )
    expect(m).toEqual([
      { start: 0, end: 10, ratio: '16:9', cropX: 0.5, cropXNatif: 0.5 },
      { start: 20, end: 30, ratio: '16:9', cropX: 0.5, cropXNatif: 0.5 },
    ])
  })

  // La fusion se fait sur les **trois** composantes du cadre : deux plans au même
  // ratio et à la même position dans la variante peuvent différer dans le natif,
  // et les recoller poserait le cadre de l'un sur l'autre dans le fichier du feed.
  it('ne fusionne pas quand seule la position du natif diffère', () => {
    const a = { ...plan(0, 10, '9:16', 0.2), cropXNatif: 0.3 }
    const b = { ...plan(10, 20, '9:16', 0.2), cropXNatif: 0.7 }
    expect(découperParPlan([seg(0, 20)], [a, b], DÉFAUT)).toHaveLength(2)
  })

  it('rend une liste vide pour un montage vide', () => {
    expect(découperParPlan([], [plan(0, 10, '1:1', 0.5)], DÉFAUT)).toEqual([])
  })
})
