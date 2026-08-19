import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Les deux décisions de `worker/detect.py` qu'un consommateur TypeScript ne
 * peut pas voir : ce que le fichier écrit dans `score`, et ce que le worker
 * accepte comme seuil de scène.
 *
 * **Python évalué depuis Vitest, plutôt qu'une suite pytest de plus.** Le dépôt
 * a une commande de test et une seule, et `detect.py` n'a que quatre fonctions à
 * éprouver. Un second harnais coûterait son installation, sa place dans le CI et
 * son propre vieillissement pour ces quatre fonctions-là. Ici Python n'est qu'un
 * évaluateur : il rend du JSON, les assertions restent du côté du dépôt.
 *
 * **Aucun de ces tests ne charge torch ni ultralytics.** Les imports lourds de
 * `detect.py` sont dans `main()`, précisément pour qu'un `--help` réponde tout
 * de suite ; importer le module ne coûte donc que la bibliothèque standard, et
 * `worker/venv` — 7,8 Go, absent d'un checkout frais — n'est pas nécessaire.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/**
 * L'environnement des deux lancements Python, `.pyc` en moins : sans cela,
 * `pnpm test` sème un `worker/__pycache__/` que personne n'a demandé. Il est
 * ignoré par git, donc il ne salirait qu'un `ls` — mais un artefact de build
 * qu'aucune commande de build n'a produit se fait chercher longtemps.
 */
const WITHOUT_BYTECODE = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }

/**
 * Évalue `code` avec `detect` importé, et rend ce que le code imprime en JSON.
 *
 * `python3` du système, pas celui de `worker/venv` : ce qui est éprouvé ici ne
 * dépend que de la bibliothèque standard, et exiger le venv rendrait la suite
 * intestable sur une machine qui n'a pas encore lancé `setup.sh`.
 */
function evaluate(code: string): unknown {
  const preamble = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'worker'))})`,
    'import detect',
  ].join('\n')
  let output: string
  try {
    output = execFileSync('python3', ['-c', `${preamble}\n${code}`], {
      encoding: 'utf8',
      env: WITHOUT_BYTECODE,
    })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`python3 n'a pas pu évaluer worker/detect.py : ${detail}`, { cause })
  }
  return JSON.parse(output)
}

/**
 * **Le score écrit ne dépasse jamais le score mesuré.**
 *
 * `src/core/framing.ts` ne garde que les boîtes dont le score atteint 0,5, seuil
 * **inclusif**. Un arrondi au plus proche à trois décimales faisait ressortir une
 * détection à 0,4996 sous la forme `0.5`, qui passait le filtre : le seuil ne
 * valait plus ce qu'il annonçait, et rien ne pouvait le montrer — ni le fichier,
 * ni le cadrage, ni l'image.
 *
 * L'arrondi lui-même n'est pas en cause : il tient la taille du fichier — trente
 * mille boîtes sur une émission — et sa lisibilité. C'est le **sens** de
 * l'arrondi qui l'était. Vers le bas, la valeur écrite est un minorant de la
 * vraie, donc un seuil inclusif posé sur un multiple du millième dit exactement
 * ce qu'il dit. (relevé sur la PR #31, ticket #40)
 */
describe('detect.py — le score écrit dans analysis.json', () => {
  it('n’arrondit pas une détection sous le seuil jusqu’au seuil', () => {
    expect(evaluate('print(json.dumps(detect.arrondi_vers_le_bas(0.4996, 3)))')).toBe(0.499)
    expect(evaluate('print(json.dumps(detect.arrondi_vers_le_bas(0.4999, 3)))')).toBe(0.499)
  })

  it('laisse intact un score qui atteint vraiment le seuil', () => {
    // Le cas symétrique, et celui qui interdit de « régler le problème » en
    // déplaçant le seuil du consommateur : une détection à 0,5 est au-dessus du
    // seuil, et doit le rester.
    expect(evaluate('print(json.dumps(detect.arrondi_vers_le_bas(0.5, 3)))')).toBe(0.5)
    expect(evaluate('print(json.dumps(detect.arrondi_vers_le_bas(0.5004, 3)))')).toBe(0.5)
    expect(evaluate('print(json.dumps(detect.arrondi_vers_le_bas(1.0, 3)))')).toBe(1)
  })

  it('garde trois décimales, ce pour quoi l’arrondi existe', () => {
    // Sans arrondi du tout, `json.dump` écrirait les dix-sept chiffres du
    // flottant : la taille du fichier est l'autre moitié de la décision.
    expect(evaluate('print(json.dumps(detect.arrondi_vers_le_bas(0.876543, 3)))')).toBe(0.876)
  })

  /**
   * Et la preuve que c'est bien branché : un helper juste et jamais appelé
   * n'aurait rien fermé.
   */
  it('écrit ce score-là dans les boîtes, pas un autre', () => {
    const boxes = evaluate(
      [
        'class Tenseur:',
        '    def __init__(self, v): self.v = v',
        '    def tolist(self): return self.v',
        'class Boîtes:',
        '    def __init__(self, xyxy, conf):',
        '        self.xyxy = Tenseur(xyxy)',
        '        self.conf = Tenseur(conf)',
        'class Résultat:',
        '    def __init__(self, b): self.boxes = b',
        'r = Résultat(Boîtes([[96.0, 54.0, 288.0, 486.0]], [0.4996]))',
        'print(json.dumps(detect.boîtes_du_lot([r], 0, 2.0, 960, 540)))',
      ].join('\n'),
    ) as { score: number }[]
    expect(boxes).toHaveLength(1)
    expect(boxes[0].score).toBe(0.499)
  })
})

/**
 * **`gte` et non `gt`, depuis le chantier des bascules de composition.** La
 * collecte de scène était stricte, la rétention (`scene_boundaries`) inclusive
 * — c'est cet écart qu'un des tests plus bas éprouvait déjà par le refus de
 * l'égalité. Ce test-ci est direct : le filtre construit porte bien `gte`, pas
 * `gt`.
 */
describe('detect.py — le filtre de collecte des scores de scène', () => {
  it('construit un filtre inclusif, jamais strict', () => {
    expect(evaluate('print(json.dumps(detect.scene_filter(0.05)))')).toBe(
      "select='gte(scene,0.05)',metadata=print:file=-",
    )
  })
})

/**
 * **Un argument accepté qui ne fait rien est le défaut qu'on ferme, pas une
 * commodité.**
 *
 * Les frontières de plans se décident en deux temps : ffmpeg ne rapporte que les
 * images au-dessus d'un plancher de collecte (`--scene-floor`, 0,05), et Python
 * applique ensuite le seuil demandé (`--scene-threshold`, 0,4). Un seuil sous le
 * plancher portait donc sur des candidates qui n'avaient jamais été collectées :
 * l'argument était pris, et il n'avait aucun effet.
 *
 * **Refus plutôt qu'un `min()` silencieux.** Abaisser le plancher tout seul
 * reproduirait le défaut un cran plus bas : à plancher nul, `gt(scene, 0)`
 * retient à peu près chaque image d'une émission de deux heures, et
 * `scores_de_scène` ramasse cette sortie en mémoire d'un seul tenant. On refuse
 * en nommant les deux valeurs, ce qui laisse le choix — baisser le plancher
 * aussi — à qui cherche des coupes plus discrètes. C'est-à-dire à la prochaine
 * itération sur le détecteur. (relevé sur la PR #31, ticket #40)
 */
describe('detect.py — le seuil de scène face à son plancher de collecte', () => {
  // Le paramètre est une **expression Python**, pas un nombre : `NaN` et
  // `Infinity` n'ont pas de littéral en Python, et les écrire tels quels
  // lèverait un `NameError` au lieu d'éprouver quoi que ce soit.
  const rejection = (threshold: string, floor: string): unknown =>
    evaluate(`print(json.dumps(detect.refus_du_seuil_de_scène(${threshold}, ${floor})))`)

  it('ne dit rien du couple mesuré', () => {
    expect(rejection('0.4', '0.05')).toBeNull()
    // Juste au-dessus du plancher : c'est le cas limite accepté.
    expect(rejection('0.051', '0.05')).toBeNull()
  })

  it('refuse un seuil sous le plancher, en nommant les deux valeurs', () => {
    const message = rejection('0.02', '0.05')
    expect(typeof message).toBe('string')
    expect(message).toContain('0.02')
    expect(message).toContain('0.05')
    // Le remède, pas seulement le grief : sans lui, le refus déplace la
    // devinette au lieu de la supprimer.
    expect(message).toContain('--scene-floor')
  })

  /**
   * **L'égalité reste refusée, sur une raison qui a changé.** La collecte est
   * désormais inclusive elle aussi — `select='gte(scene, plancher)'` —, comme
   * la rétention l'était déjà : `scene_boundaries` n'écarte que
   * `score < seuil`. À `seuil == plancher`, l'asymétrie qui motivait le refus
   * n'existe plus, mais une autre subsiste : toute candidate collectée —
   * chaque image dont le score atteint le plancher — atteint aussi le seuil,
   * et le plancher de collecte déciderait des coupes à la place du seuil.
   *
   * Strictement au-dessus, les deux gardent leur rôle : `score ≥ seuil >
   * plancher` implique `score > plancher`. (relevé par Copilot et par Codex)
   */
  it('refuse un seuil posé pile sur le plancher, qui laisserait le plancher décider des coupes', () => {
    const message = rejection('0.05', '0.05')
    expect(typeof message).toBe('string')
    expect(message).toContain('--scene-floor')
  })

  it('refuse un seuil nul ou négatif', () => {
    // Un seuil nul ne dit pas « ne coupe pas » : `plans()` n'écarte que
    // `score < seuil`, donc il déclare une coupe à chaque candidate collectée.
    expect(typeof rejection('0', '0')).toBe('string')
    expect(typeof rejection('-1', '0.05')).toBe('string')
  })

  /**
   * **La borne haute compte autant que la basse, et pour une raison plus
   * sournoise.** Le score de scène vit dans [0, 1] ; à `--scene-threshold 4` —
   * la faute de décimale sur 0,4 — aucune image ne dépasse jamais le seuil, donc
   * l'analyse sort **sans une seule frontière**, en un plan unique. Rien
   * n'échoue : le fichier est valide, il passe le schéma, et le graphe par
   * présence le sert à toutes les relances suivantes. C'est le point 1 de ce
   * ticket, atteint par l'autre bout.
   *
   * Le message annonçait déjà le domaine sans le faire respecter à ce
   * bout-là. (relevé par Copilot)
   */
  it('refuse un seuil ou un plancher au-dessus de 1, où rien ne coupe plus', () => {
    expect(typeof rejection('4', '0.05')).toBe('string')
    expect(typeof rejection('0.4', '1.5')).toBe('string')
    // 1 reste dans le domaine : exigeant à l'excès, mais pas hors sujet.
    expect(rejection('1', '0.05')).toBeNull()
  })

  /**
   * **Le plancher aussi**, et pour la raison qui sert à refuser un seuil nul :
   * `--scene-floor 0` lance `gt(scene, 0)`, donc retient à peu près chaque image
   * d'une émission de deux heures, que `scores_de_scène` ramasse en mémoire d'un
   * seul tenant. Valider un des deux nombres et pas l'autre laissait le danger
   * accessible par la porte d'à côté. (relevé par Copilot)
   */
  it('refuse un plancher nul ou négatif', () => {
    expect(typeof rejection('0.4', '0')).toBe('string')
    expect(typeof rejection('0.4', '-0.1')).toBe('string')
  })

  /**
   * **`NaN` passe toutes les comparaisons, donc passait le refus.** Et il ne
   * s'arrête pas là : `plans()` écarte les candidates par `score < seuil`, qui
   * est faux pour `NaN` — donc *chaque* candidate collectée deviendrait une
   * frontière. Un argument accepté qui fait le contraire de ce qu'il dit, sans
   * une ligne de journal. `argparse` prend `nan` et `inf` sans broncher.
   * (relevé par Copilot)
   */
  it('refuse un seuil ou un plancher non fini', () => {
    expect(typeof rejection("float('nan')", '0.05')).toBe('string')
    expect(typeof rejection("float('inf')", '0.05')).toBe('string')
    expect(typeof rejection('0.4', "float('nan')")).toBe('string')
    expect(typeof rejection('0.4', "float('inf')")).toBe('string')
  })
})

/**
 * **Le même refus couvre désormais `--min-shot` et les quatre seuils des
 * bascules de composition** — le chantier des bascules de composition. Chacun
 * est un jumeau d'un défaut déjà fermé plus haut sur `--scene-threshold` et
 * `--scene-floor` : `NaN` qui passe toutes les comparaisons, une borne qui
 * manque d'un côté ou de l'autre. Les valeurs par défaut restent acceptées —
 * sans quoi le refus se retournerait contre le worker lui-même.
 */
describe('detect.py — le refus, étendu à --min-shot et aux bascules de composition', () => {
  // Des valeurs valides quelconques, dans le domaine de chaque paramètre —
  // ni les défauts du code (0.08, 8, 0.3), ni celles retenues par le
  // balayage (docs/ratios-par-clip.md) : seule leur validité compte ici,
  // seul le paramètre sous test s'écarte de cette base.
  const extended = (name: string, expression: string): unknown =>
    evaluate(
      [
        `result = detect.refus_du_seuil_de_scène(`,
        '    0.4, 0.05,',
        `    plan_min=${name === 'plan_min' ? expression : '1.0'},`,
        `    switch_shift=${name === 'switch_shift' ? expression : '0.10'},`,
        `    switch_tolerance=${name === 'switch_tolerance' ? expression : '0.03'},`,
        `    switch_share=${name === 'switch_share' ? expression : '6'},`,
        `    switch_point_score=${name === 'switch_point_score' ? expression : '0.5'},`,
        ')',
        'print(json.dumps(result))',
      ].join('\n'),
    )

  it('laisse passer les cinq valeurs valides, sans rien à leur reprocher', () => {
    expect(extended('plan_min', '1.0')).toBeNull()
  })

  /**
   * **Jumeau exact du `--scene-threshold nan` fermé par l'issue #40.**
   * `--min-shot nan` fait passer toutes les comparaisons de `scene_boundaries`
   * comme fausses — y compris celle qui écarte les frontières trop
   * rapprochées —, ce qui produit des plans de durée quasi nulle que le
   * schéma de l'analyse refuse, après les trois minutes de GPU de la
   * détection de corps.
   */
  it('refuse un --min-shot non fini, nul ou négatif', () => {
    expect(typeof extended('plan_min', "float('nan')")).toBe('string')
    expect(typeof extended('plan_min', "float('inf')")).toBe('string')
    expect(typeof extended('plan_min', '0')).toBe('string')
    expect(typeof extended('plan_min', '-1.0')).toBe('string')
  })

  it('refuse un --switch-shift ou un --switch-tolerance non fini, nul ou négatif', () => {
    for (const name of ['switch_shift', 'switch_tolerance']) {
      expect(typeof extended(name, "float('nan')")).toBe('string')
      expect(typeof extended(name, "float('inf')")).toBe('string')
      expect(typeof extended(name, '0')).toBe('string')
      expect(typeof extended(name, '-0.05')).toBe('string')
    }
  })

  /**
   * **Volontairement sans borne haute.** Une différence d'ancrages n'est pas
   * bornée à 1 : les points de pose qui la fondent ne le sont pas non plus
   * (voir `person_anchor`). Une grande valeur de `--switch-shift` ne fait que
   * ne jamais déclarer de bascule — elle ne casse rien.
   */
  it('accepte un --switch-shift supérieur à 1', () => {
    expect(extended('switch_shift', '1.5')).toBeNull()
  })

  it('refuse un --switch-share hors de [1, 10] ou non entier', () => {
    expect(typeof extended('switch_share', '0')).toBe('string')
    expect(typeof extended('switch_share', '11')).toBe('string')
    expect(typeof extended('switch_share', '6.5')).toBe('string')
    expect(extended('switch_share', '1')).toBeNull()
    expect(extended('switch_share', '10')).toBeNull()
  })

  it('refuse un --switch-point-score hors de [0, 1] ou non fini', () => {
    expect(typeof extended('switch_point_score', '0')).toBe('string')
    expect(typeof extended('switch_point_score', '1.4')).toBe('string')
    expect(typeof extended('switch_point_score', "float('nan')")).toBe('string')
    expect(extended('switch_point_score', '1')).toBeNull()
  })
})

/**
 * **`plans()` scindée en deux, sans changer ce qu'elle rendait.** Cette suite
 * rejoue les garanties que son ancienne docstring énonçait, réparties entre les
 * deux fonctions qui la remplacent : `scene_boundaries` décide *où* couper,
 * `shots_from_boundaries` découpe. La scission existe pour que le croisement
 * avec les bascules de composition s'insère entre les deux, sans dupliquer la
 * logique d'espacement (`--min-shot` reste un seul réglage, partagé).
 */
describe('detect.py — scene_boundaries et shots_from_boundaries', () => {
  const boundariesFrom = (
    events: [number, number][],
    duration: number,
    threshold: number,
    minShot: number,
  ): number[] =>
    evaluate(
      `print(json.dumps(detect.scene_boundaries(${JSON.stringify(events)}, ${duration}, ${threshold}, ${minShot})))`,
    ) as number[]

  const shotsFrom = (
    boundaries: number[],
    duration: number,
  ): { start: number; end: number }[] =>
    evaluate(
      `print(json.dumps(detect.shots_from_boundaries(${JSON.stringify(boundaries)}, ${duration})))`,
    ) as { start: number; end: number }[]

  it('ignore une frontière hors de [0, durée], le score de la première image se comparant à rien', () => {
    expect(
      boundariesFrom(
        [
          [0, 0.9],
          [5, 0.9],
          [12, 0.9],
        ],
        10,
        0.4,
        1.0,
      ),
    ).toEqual([5])
  })

  it('fusionne deux frontières trop rapprochées en une seule', () => {
    // Un éclair de lumière à une image d'intervalle (0,5 s à 2 im/s) : la
    // seconde ne fait pas un plan de 0,5 s.
    expect(
      boundariesFrom(
        [
          [5, 0.9],
          [5.5, 0.9],
        ],
        20,
        0.4,
        1.0,
      ),
    ).toEqual([5])
  })

  it('mesure plan_min depuis 0 et jusqu’à durée, pas seulement entre deux frontières', () => {
    // À 0,4 s du début et 0,3 s de la fin, sous plan_min = 1 : les deux tombent.
    expect(
      boundariesFrom(
        [
          [0.4, 0.9],
          [10, 0.9],
          [19.7, 0.9],
        ],
        20,
        0.4,
        1.0,
      ),
    ).toEqual([10])
  })

  it('écarte un score sous le seuil', () => {
    expect(
      boundariesFrom(
        [
          [5, 0.39],
          [10, 0.4],
        ],
        20,
        0.4,
        1.0,
      ),
    ).toEqual([10])
  })

  it('shots_from_boundaries rend toujours au moins un plan, même sans frontière', () => {
    expect(shotsFrom([], 42.5)).toEqual([{ start: 0, end: 42.5 }])
  })

  it('shots_from_boundaries découpe aux frontières données, plans qui se touchent', () => {
    expect(shotsFrom([12.4, 30], 91.2)).toEqual([
      { start: 0, end: 12.4 },
      { start: 12.4, end: 30 },
      { start: 30, end: 91.2 },
    ])
  })

  it('composées, reproduisent le comportement de l’ancienne plans()', () => {
    const events: [number, number][] = [
      [0.4, 0.9],
      [5.0, 0.35],
      [10.0, 0.9],
      [10.4, 0.9],
      [25.0, 0.9],
      [39.8, 0.9],
    ]
    const boundaries = boundariesFrom(events, 40, 0.4, 1.0)
    expect(shotsFrom(boundaries, 40)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 25 },
      { start: 25, end: 40 },
    ])
  })
})

/**
 * **`scene_boundaries` espace déjà son résultat — l'espacer une seconde fois
 * après union avec les bascules de composition n'est pas associatif.**
 * `_scene_candidates` existe pour que le croisement des deux détecteurs
 * n'espace qu'une seule fois, sur l'union brute. (relevé par Copilot sur la
 * PR #101)
 */
describe('detect.py — _scene_candidates, non espacée', () => {
  const candidatesFrom = (events: [number, number][], threshold: number): number[] =>
    evaluate(
      `print(json.dumps(detect._scene_candidates(${JSON.stringify(events)}, ${threshold})))`,
    ) as number[]

  it("rend toute candidate au-dessus du seuil, sans appliquer d'espacement", () => {
    expect(candidatesFrom([[5.0, 0.9], [5.5, 0.9], [8.0, 0.2]], 0.4)).toEqual([5.0, 5.5])
  })

  it('espacer les frontières de scène seules puis réespacer leur union perdrait une frontière que l’union brute garde', () => {
    // Scores de scène à 5,0 et 5,5 s, bascule à 4,5 s, min_shot = 1 s.
    const scene = [
      [5.0, 0.9],
      [5.5, 0.9],
    ] as [number, number][]
    const switchTime = 4.5

    // L'ancien chemin, fautif : espacer les frontières de scène seules —
    // `scene_boundaries` — élimine 5,5 avant même que la bascule n'entre en
    // jeu.
    const sceneOnlySpaced = evaluate(
      `print(json.dumps(detect.scene_boundaries(${JSON.stringify(scene)}, 10, 0.4, 1.0)))`,
    ) as number[]
    expect(sceneOnlySpaced).toEqual([5.0])
    const doubleSpaced = evaluate(
      `print(json.dumps(detect._spaced_boundaries(${JSON.stringify([...sceneOnlySpaced, switchTime])}, 10, 1.0)))`,
    ) as number[]
    expect(doubleSpaced).toEqual([4.5]) // 5,5 a disparu.

    // Le chemin retenu : `_scene_candidates`, non espacée, unie à la bascule
    // et espacée une seule fois — garde les deux.
    const rawCandidates = candidatesFrom(scene, 0.4)
    const spacedOnce = evaluate(
      `print(json.dumps(detect._spaced_boundaries(${JSON.stringify([...rawCandidates, switchTime])}, 10, 1.0)))`,
    ) as number[]
    expect(spacedOnce).toEqual([4.5, 5.5])
  })
})

/**
 * **Le second détecteur de frontière.** Les boîtes disent qu'une bascule a
 * lieu (`person_anchor`, `collective_shift`, `composition_switches`), les
 * scores de scène donnent l'image exacte (`refine_switch`). Quatre fonctions
 * pures, éprouvées séparément : la lecture d'un défaut sur l'une ne doit pas
 * se chercher dans les trois autres.
 */
describe('detect.py — person_anchor', () => {
  const anchor = (box: Record<string, unknown>, minScore: number): number =>
    evaluate(`print(json.dumps(detect.person_anchor(${JSON.stringify(box)}, ${minScore})))`) as number

  it('repli sur le centre de la boîte quand elle ne porte pas de points', () => {
    expect(anchor({ x0: 0.2, x1: 0.6 }, 0.5)).toBe(0.4)
  })

  it('repli sur le centre de la boîte quand aucun point n’atteint le seuil', () => {
    expect(anchor({ x0: 0.2, x1: 0.6, k: [0.5, 0, 0.2] }, 0.5)).toBe(0.4)
  })

  it('ignore un point sous le seuil, en garde un autre au-dessus', () => {
    // Point à x = 0.9, confiance 0.4 (sous le seuil) ; point à x = 0.1,
    // confiance 0.9 (au-dessus). Seul le second doit compter.
    expect(anchor({ x0: 0, x1: 1, k: [0.9, 0, 0.4, 0.1, 0, 0.9] }, 0.5)).toBe(0.1)
  })

  it('prend la médiane des points confiants, pas leur moyenne', () => {
    const k = [0.1, 0, 0.9, 0.5, 0, 0.9, 0.9, 0, 0.9]
    expect(anchor({ x0: 0, x1: 1, k }, 0.5)).toBe(0.5)
  })

  it('un point isolé loin du groupe ne tire pas la médiane vers lui', () => {
    // Quatre points confiants groupés autour de 0,5, un cinquième à 10 : la
    // moyenne serait tirée vers 10, la médiane reste au groupe.
    const k = [0.48, 0, 0.9, 0.5, 0, 0.9, 0.5, 0, 0.9, 0.52, 0, 0.9, 10.0, 0, 0.9]
    expect(anchor({ x0: 0, x1: 1, k }, 0.5)).toBe(0.5)
  })
})

describe('detect.py — collective_shift', () => {
  const shift = (a: number[], b: number[], tol: number): [number | null, number] =>
    evaluate(
      `print(json.dumps(list(detect.collective_shift(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${tol}))))`,
    ) as [number | null, number]

  it('rend (None, 0) sur une image vide, de part ou d’autre', () => {
    expect(shift([], [0.1], 0.03)).toEqual([null, 0])
    expect(shift([0.1], [], 0.03)).toEqual([null, 0])
  })

  it('trouve le déplacement commun de trois personnes qui glissent ensemble', () => {
    // Trois ancrages qui glissent tous de +0,2, à ±0,01 de bruit, effectifs
    // égaux (3 et 3) : appariement par rang. Les trois différences de rang
    // (0,19 ; 0,2 ; 0,21) tombent à 0,01 de leur médiane, largement sous la
    // tolérance — les trois comptent.
    const a = [0.1, 0.4, 0.7]
    const b = [0.31, 0.59, 0.9]
    const [d, n] = shift(a, b, 0.03)
    expect(d).toBeCloseTo(0.2, 9)
    expect(n).toBe(3)
  })

  /**
   * **Effectifs égaux, appariement par rang — le correctif du 19 août 2026.**
   * Deux personnes glissent chacune d'environ 0,3 (homme +0,277, femme
   * +0,310, mesuré sur `2026-22-02-entre-nous` à t=3 239,5→3 240,0), mais
   * s'écartent l'une de l'autre de 0,033 — sous la tolérance ici, donc déjà
   * détecté par l'ancien mécanisme. Le test suivant reproduit le cas qui ne
   * l'était pas.
   */
  it('apparie par rang quand les effectifs sont égaux, pas par vote', () => {
    const [d, n] = shift([0.1736, 0.5057], [0.8161, 0.4504], 0.04)
    expect(d).toBeCloseTo(0.2936, 4)
    expect(n).toBe(2)
  })

  /**
   * **La bascule que l'ancien mécanisme perdait.** Mêmes deux comédiens,
   * t=3 241,0→3 241,5 : homme +0,294, femme +0,336 — un écart de 0,042 entre
   * les deux, **au-dessus** de `tolerance=0,04`. Votées comme avant (une
   * paire par personne, plus les deux paires croisées, sans réalité
   * physique), les quatre candidates se tenaient à une voix chacune, et le
   * départage par le plus petit `|d|` choisissait la croisée — un
   * `shift≈0,007` sans rapport avec la vraie bascule. Apparié par rang, les
   * deux seules candidates sont les vraies, et chacune tombe à 0,021 de leur
   * médiane commune : bien sous la tolérance, puisqu'à effectif 2 l'écart à
   * la médiane vaut toujours la moitié de l'écart entre les deux valeurs.
   */
  it('retrouve une bascule que l’ancien vote perdait sur un écart de 0,042', () => {
    const [d, n] = shift([0.8068, 0.4639], [0.1703, 0.4711], 0.04)
    expect(d).toBeCloseTo(-0.31465, 4)
    expect(n).toBe(2)
  })

  it('même correctif, l’autre sens (t=3 248,0→3 248,5, écart de 0,052)', () => {
    const [d, n] = shift([0.1648, 0.4669], [0.8112, 0.4567], 0.04)
    expect(d).toBeCloseTo(0.3181, 4)
    expect(n).toBe(2)
  })

  /**
   * **Un seul comédien qui bouge ne doit toujours pas compter comme une
   * bascule.** Effectifs égaux (2 et 2), donc appariement par rang — mais un
   * déplacement de 0,5 et un de 0,02 s'écartent tous deux de 0,24 de leur
   * médiane (0,26), loin au-dessus de la tolérance : aucun des deux ne
   * rejoint l'autre, `matched` tombe à 0. C'est la propriété que l'ancien
   * vote ne pouvait pas rendre — il retournait toujours un candidat, juste ou
   * non.
   */
  it('ne fait pas consensus quand une seule des deux personnes a bougé', () => {
    expect(shift([0.1, 0.4], [0.6, 0.42], 0.04)).toEqual([null, 0])
  })

  /**
   * **Départage à égalité par le plus petit `|d|`.** Effectifs inégaux (1 et
   * 2) : repli sur le vote. Une seule personne dans la première image, deux
   * hypothèses de déplacement possibles à une voix chacune (aucune autre
   * paire pour départager par le vote) : celle de plus petite amplitude
   * l'emporte.
   */
  it('départage une égalité de votes par le plus petit déplacement (effectifs inégaux)', () => {
    expect(shift([0], [0.05, -0.2], 0.03)).toEqual([0.05, 1])
  })

  it('un appariement glouton, chaque ancrage ne sert qu’une fois (effectifs inégaux)', () => {
    // Deux personnes qui glissent de +0,2 (0,1→0,3 et 0,4→0,6), une
    // troisième sans correspondance dans la seconde image (elle est sortie
    // du cadre) : effectifs inégaux (3 et 2), donc repli sur le vote, qui
    // désigne +0,2 sans ambiguïté ; seules les deux personnes qui ont bougé
    // ensemble sont comptées.
    const [d, n] = shift([0.1, 0.4, 0.9], [0.3, 0.6], 0.03)
    expect(d).toBeCloseTo(0.2, 9)
    expect(n).toBe(2)
  })
})

describe('detect.py — composition_switches', () => {
  const switches = (
    boxes: { t: number; x0: number; x1: number }[],
    fps: number,
    minPointScore: number,
    tolerance: number,
    part: number,
    minShift: number,
  ): [number, number][] =>
    evaluate(
      `print(json.dumps(detect.composition_switches(${JSON.stringify(boxes)}, ${fps}, ${minPointScore}, ${tolerance}, ${part}, ${minShift})))`,
    ) as [number, number][]

  // Trois personnes qui glissent toutes de +0,2 entre deux images
  // consécutives (fps = 2, donc un pas de 0,5 s).
  const THREE_SLIDING = [
    { t: 0.0, x0: 0.05, x1: 0.15 },
    { t: 0.0, x0: 0.35, x1: 0.45 },
    { t: 0.0, x0: 0.65, x1: 0.75 },
    { t: 0.5, x0: 0.26, x1: 0.36 },
    { t: 0.5, x0: 0.54, x1: 0.64 },
    { t: 0.5, x0: 0.85, x1: 0.95 },
  ]

  it('déclare une bascule quand trois personnes glissent ensemble au-dessus du seuil', () => {
    expect(switches(THREE_SLIDING, 2.0, 0.5, 0.03, 6, 0.1)).toEqual([[0.0, 0.5]])
  })

  it('ne compare jamais par-dessus un trou de détection', () => {
    // Même glissement, mais entre deux images séparées d'un pas double :
    // aucune détection à mi-chemin. La condition 1 doit refuser la paire.
    const withGap = [
      { t: 0.0, x0: 0.05, x1: 0.15 },
      { t: 0.0, x0: 0.35, x1: 0.45 },
      { t: 0.0, x0: 0.65, x1: 0.75 },
      { t: 1.0, x0: 0.26, x1: 0.36 },
      { t: 1.0, x0: 0.54, x1: 0.64 },
      { t: 1.0, x0: 0.85, x1: 0.95 },
    ]
    expect(switches(withGap, 2.0, 0.5, 0.03, 6, 0.1)).toEqual([])
  })

  it('refuse un seul comédien apparié, qui ne prouve rien', () => {
    const onePerson = [
      { t: 0.0, x0: 0.05, x1: 0.15 },
      { t: 0.5, x0: 0.26, x1: 0.36 },
    ]
    expect(switches(onePerson, 2.0, 0.5, 0.03, 6, 0.1)).toEqual([])
  })

  it('refuse un déplacement sous le seuil de la part appariée — entrée ou sortie de cadre', () => {
    // Cinq personnes dans chaque image : `len(a) == len(b) == 5` emprunte
    // l'appariement par rang, pas le vote sur toutes les paires. Les trois
    // positions de remplissage sont choisies pour qu'aucune différence de
    // rang ne retombe dans la tolérance de la médiane — donc `matched`
    // rend 0, en dessous du minimum de deux personnes appariées, quel que
    // soit `part`. Ce ne sont pas des coordonnées plausibles d'écran,
    // seulement des valeurs qui ne se recroisent nulle part à 0,03 près.
    const entryExit = [
      { t: 0.0, x0: 0.05, x1: 0.15 },
      { t: 0.0, x0: 0.35, x1: 0.45 },
      { t: 0.0, x0: 6.0654, x1: 6.1654 },
      { t: 0.0, x0: 1.1501, x1: 1.2501 },
      { t: 0.0, x0: 3.1502, x1: 3.2502 },
      { t: 0.5, x0: 0.26, x1: 0.36 },
      { t: 0.5, x0: 0.54, x1: 0.64 },
      { t: 0.5, x0: -7.2643, x1: -7.1643 },
      { t: 0.5, x0: -3.1582, x1: -3.0582 },
      { t: 0.5, x0: -3.6364, x1: -3.5364 },
    ]
    expect(switches(entryExit, 2.0, 0.5, 0.03, 6, 0.1)).toEqual([])
  })

  it('refuse un déplacement collectif réel mais trop petit', () => {
    const shrunk = THREE_SLIDING.map((b) => ({ ...b }))
    // Même trio, glissement ramené à 0,02 (sous min_shift = 0,1).
    shrunk[3] = { t: 0.5, x0: 0.07, x1: 0.17 }
    shrunk[4] = { t: 0.5, x0: 0.37, x1: 0.47 }
    shrunk[5] = { t: 0.5, x0: 0.67, x1: 0.77 }
    expect(switches(shrunk, 2.0, 0.5, 0.03, 6, 0.1)).toEqual([])
  })
})

describe('detect.py — refine_switch', () => {
  const refine = (
    t1: number,
    t2: number,
    events: [number, number][],
    fps: number,
  ): [number, boolean] =>
    evaluate(
      `print(json.dumps(list(detect.refine_switch(${t1}, ${t2}, ${JSON.stringify(events)}, ${fps}))))`,
    ) as [number, boolean]

  it('trouve le score maximal dans (t1, t2 + 1/(2·fps)]', () => {
    const events: [number, number][] = [
      [10.0, 0.9], // == t1, exclu : la fenêtre est ouverte à gauche
      [10.2, 0.5],
      [10.6, 0.7],
      [10.75, 0.95], // == borne haute, inclus : la fenêtre est fermée à droite
      [10.76, 0.99], // juste après la borne, exclu
    ]
    expect(refine(10.0, 10.5, events, 2.0)).toEqual([10.75, true])
  })

  it('replie sur le milieu de l’intervalle de contenu, sans évènement dans la fenêtre', () => {
    expect(refine(10.0, 10.5, [], 2.0)).toEqual([10.375, false])
  })
})

/**
 * **La lecture, extraite pour que `--replay` la partage sans lancer ffmpeg.**
 * `scores_de_scène` l'applique à la sortie d'un sous-processus ; `--replay`
 * l'applique au contenu d'un fichier capturé une fois. Même fonction, pure.
 */
describe('detect.py — parse_scene_scores', () => {
  const parse = (text: string): [number, number][] =>
    evaluate(`print(json.dumps(detect.parse_scene_scores(${JSON.stringify(text)})))`) as [
      number,
      number,
    ][]

  it('lit les couples (instant, score) écrits par metadata=print', () => {
    const text = [
      'frame:0    pts:1224192 pts_time:79.7',
      'lavfi.scene_score=0.529416',
      'frame:1    pts:1234192 pts_time:80.1',
      'lavfi.scene_score=0.048000',
    ].join('\n')
    expect(parse(text)).toEqual([
      [79.7, 0.529416],
      [80.1, 0.048],
    ])
  })

  it('rend une liste vide sur un texte sans couple', () => {
    expect(parse('rien à voir ici\n')).toEqual([])
  })
})

/**
 * **Le rejeu, tel que le calibrage l'utilise : par le CLI, sur des fichiers
 * réels.** `run_replay` n'est pas pure — elle lit deux fichiers et en écrit
 * un — donc éprouvée ici plutôt que par `evaluate()`, avec le même patron que
 * la suite du refus en ligne de commande ci-dessous.
 */
describe('detect.py — --replay', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-replay-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  // Deux personnes qui glissent de +0,2 entre t = 0 et t = 0,5 (fps = 2) :
  // une bascule franche, mais sans le moindre score de scène pour la
  // confirmer — un seul signal sur les deux exigés, donc rejetée plutôt que
  // posée au milieu de la fenêtre (voir le test juste en dessous).
  const ANALYSIS: Record<string, unknown> = {
    version: 2,
    fps: 2.0,
    model: 'yolo11m-pose.pt',
    source: { w: 1920, h: 1080 },
    proxy: { w: 960, h: 540 },
    shots: [{ start: 0, end: 20 }],
    boxes: [
      { t: 0.0, x0: 0.05, x1: 0.15, y0: 0, y1: 1, score: 0.9 },
      { t: 0.0, x0: 0.35, x1: 0.45, y0: 0, y1: 1, score: 0.9 },
      { t: 0.5, x0: 0.26, x1: 0.36, y0: 0, y1: 1, score: 0.9 },
      { t: 0.5, x0: 0.54, x1: 0.64, y0: 0, y1: 1, score: 0.9 },
    ],
  }

  const runReplay = (
    analysis: Record<string, unknown>,
    sceneScores: string,
  ): { status: number | null; stderr: string; out: string } => {
    const analysisPath = path.join(root, 'analysis.json')
    const scoresPath = path.join(root, 'scene.txt')
    const outPath = path.join(root, 'out.json')
    fs.writeFileSync(analysisPath, JSON.stringify(analysis))
    fs.writeFileSync(scoresPath, sceneScores)
    const r = spawnSync(
      'python3',
      [
        path.join(ROOT, 'worker', 'detect.py'),
        '--replay', analysisPath,
        '--scene-scores', scoresPath,
        '--out', outPath,
        // `--min-shot` abaissé : la bascule tombe à 0,375 s du début, sous le
        // défaut de 1 s, ce qui n'est pas ce que ce test éprouve.
        '--min-shot', '0.1',
        '--switch-shift', '0.1',
        '--switch-tolerance', '0.03',
        '--switch-share', '6',
        '--switch-point-score', '0.5',
      ],
      { encoding: 'utf8', env: WITHOUT_BYTECODE },
    )
    return {
      status: r.status,
      stderr: r.stderr,
      out: fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '',
    }
  }

  // **`--out` ne doit jamais désigner `--replay`** (relevé par Copilot sur la
  // PR #101, garde ajoutée, puis renforcée pour couvrir les liens). Un chemin
  // identique et un lien symbolique vers l'analyse rejouée doivent tous deux
  // être refusés, sans rien écrire.
  it("refuse --out égal à --replay, sans écrire", () => {
    const analysisPath = path.join(root, 'analysis.json')
    fs.writeFileSync(analysisPath, JSON.stringify(ANALYSIS))
    const scoresPath = path.join(root, 'scene.txt')
    fs.writeFileSync(scoresPath, '')
    const before = fs.readFileSync(analysisPath, 'utf8')
    const r = spawnSync(
      'python3',
      [
        path.join(ROOT, 'worker', 'detect.py'),
        '--replay', analysisPath,
        '--scene-scores', scoresPath,
        '--out', analysisPath,
      ],
      { encoding: 'utf8', env: WITHOUT_BYTECODE },
    )
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('désigne le même fichier')
    // L'analyse d'origine n'a pas été écrasée.
    expect(fs.readFileSync(analysisPath, 'utf8')).toBe(before)
  })

  it("refuse --out désignant --replay via un lien symbolique, sans écrire", () => {
    const analysisPath = path.join(root, 'analysis.json')
    fs.writeFileSync(analysisPath, JSON.stringify(ANALYSIS))
    const scoresPath = path.join(root, 'scene.txt')
    fs.writeFileSync(scoresPath, '')
    const linkPath = path.join(root, 'link-to-analysis.json')
    fs.symlinkSync(analysisPath, linkPath)
    const before = fs.readFileSync(analysisPath, 'utf8')
    const r = spawnSync(
      'python3',
      [
        path.join(ROOT, 'worker', 'detect.py'),
        '--replay', analysisPath,
        '--scene-scores', scoresPath,
        '--out', linkPath,
      ],
      { encoding: 'utf8', env: WITHOUT_BYTECODE },
    )
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('désigne le même fichier')
    expect(fs.readFileSync(analysisPath, 'utf8')).toBe(before)
  })

  it("refuse --out désignant --replay via un lien physique, sans écrire", () => {
    const analysisPath = path.join(root, 'analysis.json')
    fs.writeFileSync(analysisPath, JSON.stringify(ANALYSIS))
    const scoresPath = path.join(root, 'scene.txt')
    fs.writeFileSync(scoresPath, '')
    const hardLinkPath = path.join(root, 'hard-link-to-analysis.json')
    fs.linkSync(analysisPath, hardLinkPath)
    const before = fs.readFileSync(analysisPath, 'utf8')
    const r = spawnSync(
      'python3',
      [
        path.join(ROOT, 'worker', 'detect.py'),
        '--replay', analysisPath,
        '--scene-scores', scoresPath,
        '--out', hardLinkPath,
      ],
      { encoding: 'utf8', env: WITHOUT_BYTECODE },
    )
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('désigne le même fichier')
    expect(fs.readFileSync(analysisPath, 'utf8')).toBe(before)
  })

  it('rejette une bascule dont le raffinement échoue, plutôt que de la poser au milieu', () => {
    const { status, out, stderr } = runReplay(ANALYSIS, '')
    expect(status).toBe(0)
    const result = JSON.parse(out)
    expect(result.version).toBe(2)
    expect(result.model).toBe('yolo11m-pose.pt')
    expect(result.boxes).toEqual(ANALYSIS.boxes)
    // La bascule à 0,2 de déplacement collectif est détectée, mais sans score
    // de scène dans la fenêtre (0, 0,5 + 1/(2·2)] = (0, 0,75] pour la
    // confirmer : un seul signal sur les deux exigés, donc rejetée — le plan
    // unique d'origine reste intact plutôt que de se couper à son milieu.
    expect(result.shots).toEqual([{ start: 0, end: 20 }])
    expect(stderr).toContain('0 bascules retenues sur 1 candidates, 1 rejetées')
  })

  it('retient une bascule dont le raffinement confirme l’image exacte', () => {
    // Même bascule que ci-dessus, mais un score de scène tombe cette fois
    // dans la fenêtre (0, 0,75] : le second signal confirme le premier, la
    // frontière est posée à l'instant exact plutôt que rejetée.
    const sceneScores = ['frame:0    pts:100 pts_time:0.6', 'lavfi.scene_score=0.500000'].join(
      '\n',
    )
    const { status, out, stderr } = runReplay(ANALYSIS, sceneScores)
    expect(status).toBe(0)
    const result = JSON.parse(out)
    expect(result.shots).toEqual([
      { start: 0, end: 0.6 },
      { start: 0.6, end: 20 },
    ])
    expect(stderr).toContain('1 bascules retenues sur 1 candidates, 0 rejetées')
  })

  it('sort par 2 sans --scene-scores', () => {
    const analysisPath = path.join(root, 'analysis.json')
    fs.writeFileSync(analysisPath, JSON.stringify(ANALYSIS))
    const r = spawnSync(
      'python3',
      [
        path.join(ROOT, 'worker', 'detect.py'),
        '--replay', analysisPath,
        '--out', path.join(root, 'out.json'),
      ],
      { encoding: 'utf8', env: WITHOUT_BYTECODE },
    )
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--scene-scores')
  })

  it('sort par 2 sur une analyse sans plan', () => {
    const { status, stderr } = runReplay({ ...ANALYSIS, shots: [] }, '')
    expect(status).toBe(2)
    expect(stderr).toContain('rien à rejouer')
  })
})

/**
 * Le refus, tel que Node le rencontre : par un code de sortie et une ligne de
 * stderr, pas par une valeur de retour. Une fonction juste et jamais appelée
 * n'aurait rien fermé — c'est exactement le défaut que ce ticket ferme un cran
 * plus haut, dans `steps/analysis.ts`.
 *
 * Le contrôle est placé avant la passe ffmpeg et avant le chargement du modèle :
 * ces essais ne coûtent ni l'un ni l'autre.
 */
describe('detect.py — le refus, en ligne de commande', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avolo-detect-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const launch = (threshold: string): { status: number | null; stderr: string } => {
    for (const name of ['proxy.mp4', 'yolo11m.pt']) fs.writeFileSync(path.join(root, name), '')
    // `--ffmpeg /bin/false` : si le refus ne partait pas, la passe de scène
    // échouerait — ce qui est précisément le témoin du second essai.
    const r = spawnSync(
      'python3',
      [
        path.join(ROOT, 'worker', 'detect.py'),
        '--proxy', path.join(root, 'proxy.mp4'),
        '--out', path.join(root, 'analysis.json'),
        '--ffmpeg', '/bin/false',
        '--model', path.join(root, 'yolo11m.pt'),
        '--proxy-size', '960x540',
        '--source-size', '1920x1080',
        '--duration', '10',
        '--scene-threshold', threshold,
      ],
      { encoding: 'utf8', env: WITHOUT_BYTECODE },
    )
    return { status: r.status, stderr: r.stderr }
  }

  it('sort par 2 quand le seuil demandé est sous le plancher', () => {
    const { status, stderr } = launch('0.02')
    expect(status).toBe(2)
    expect(stderr).toContain('--scene-floor')
    // Rien n'a été écrit : on refuse avant de faire quoi que ce soit.
    expect(fs.existsSync(path.join(root, 'analysis.json'))).toBe(false)
  })

  it('sort par 2 sur un seuil que seul argparse aurait accepté', () => {
    // `--scene-threshold nan` : `type=float` le prend, et sans le contrôle de
    // finitude il ferait de chaque candidate une frontière.
    const { status, stderr } = launch('nan')
    expect(status).toBe(2)
    expect(stderr).toContain('--scene-threshold')
  })

  it('laisse passer le seuil mesuré, et va jusqu’à la passe de scène', () => {
    // Le témoin : sans lui, un refus posé sur tous les seuils passerait le test
    // ci-dessus sans rien dire.
    const { status, stderr } = launch('0.4')
    expect(status).not.toBe(2)
    expect(stderr).not.toContain('--scene-floor')
    expect(stderr).toContain('ffmpeg a échoué')
  })
})

/**
 * **Le chemin de pose, que la suite ne couvrait pas** — relevé par Copilot sur
 * la PR #83. Deux invariants y tiennent tout le reste, et aucun n'échoue
 * bruyamment quand il casse : un squelette attribué à la mauvaise personne
 * ressemble à un squelette, et une confiance arrondie vers le haut ressemble à
 * une confiance.
 */
describe('detect.py — les points de pose écrits à côté des boîtes', () => {
  /**
   * Le décor minimal : un résultat ultralytics factice, boîtes et points, tel
   * que `boîtes_du_lot` le lit. Même patron que le test du score plus haut —
   * Python n'est ici qu'un évaluateur, et rien de tout cela ne charge torch.
   */
  const FIXTURE = [
    'class Tensor:',
    '    def __init__(self, v): self.v = v',
    '    def tolist(self): return self.v',
    'class Points:',
    '    def __init__(self, v): self.data = Tensor(v)',
    'class Boxes:',
    '    def __init__(self, xyxy, conf):',
    '        self.xyxy = Tensor(xyxy)',
    '        self.conf = Tensor(conf)',
    'class Result:',
    '    def __init__(self, b, k=None):',
    '        self.boxes = b',
    '        self.keypoints = k',
    // Dix-sept points identiques, sauf ceux qu'on précise : de quoi écrire un
    // squelette de la bonne longueur sans le recopier à la main.
    'def skeleton(x, y, c, **at):',
    '    pts = [[float(x), float(y), float(c)] for _ in range(17)]',
    '    for index, v in at.items():',
    '        pts[int(index[1:])] = [float(v[0]), float(v[1]), float(v[2])]',
    '    return pts',
  ].join('\n')

  it('aplatit dix-sept triplets en fractions de l’image', () => {
    const k = evaluate(
      'print(json.dumps(detect.flatten_keypoints([[480.0, 270.0, 0.9]] * 17, 960, 540)))',
    ) as number[]
    expect(k).toHaveLength(51)
    expect(k.slice(0, 3)).toEqual([0.5, 0.5, 0.9])
  })

  /**
   * **La confiance est tronquée vers le bas, pas arrondie au plus proche.**
   * `torsoMinScore` la lit avec un seuil inclusif : à 0,496 arrondi, un point
   * que le réseau n'a pas vu entrait dans le tronc et déplaçait le crop. C'est
   * le défaut déjà fermé pour `score` (ticket #40), reparu un champ plus loin.
   */
  it('ne remonte jamais une confiance jusqu’au seuil qui la lit', () => {
    const k = evaluate(
      'print(json.dumps(detect.flatten_keypoints([[0.0, 0.0, 0.496]] * 17, 960, 540)))',
    ) as number[]
    expect(k[2]).toBe(0.49)
    const just = evaluate(
      'print(json.dumps(detect.flatten_keypoints([[0.0, 0.0, 0.5]] * 17, 960, 540)))',
    ) as number[]
    expect(just[2]).toBe(0.5)
  })

  /**
   * **Un point non fini sort à confiance nulle, position comprise.** Sans cette
   * garde, `json.dump` écrit un littéral `NaN` que `JSON.parse` refuse : trois
   * minutes de GPU produisent alors un `analysis.json` illisible, sans que rien
   * n'ait échoué au moment de l'écrire. (relevé par Aristarque)
   */
  it('neutralise un point non fini au lieu d’écrire un JSON illisible', () => {
    const k = evaluate(
      "print(json.dumps(detect.flatten_keypoints([[float('nan'), 0.0, 0.9], " +
        "[0.0, float('inf'), 0.9], [480.0, 270.0, float('nan')]] + [[480.0, 270.0, 0.9]] * 14, 960, 540)))",
    ) as number[]
    expect(k.slice(0, 9)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(k.slice(9, 12)).toEqual([0.5, 0.5, 0.9])
    expect(k.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('borne la confiance dans [0, 1], ce que le schéma exige', () => {
    const k = evaluate(
      'print(json.dumps(detect.flatten_keypoints([[0.0, 0.0, 1.4]] * 17, 960, 540)))',
    ) as number[]
    expect(k[2]).toBe(1)
  })

  /**
   * **L'invariant qui n'échoue pas bruyamment.** Une boîte d'aire nulle sort de
   * la boucle par un `continue` ; un itérateur parallèle sur les squelettes
   * décalerait alors tous les suivants d'un cran, et chaque personne hériterait
   * des points de sa voisine. Le fichier resterait parfaitement valide.
   */
  it('n’attribue pas le squelette d’une personne à sa voisine', () => {
    const boxes = evaluate(
      [
        FIXTURE,
        // La première boîte est d'aire nulle une fois bornée : elle disparaît.
        'b = Boxes([[0.0, 0.0, 0.0, 0.0], [96.0, 54.0, 288.0, 486.0]], [0.9, 0.9])',
        'k = Points([skeleton(0, 0, 0.9), skeleton(480, 270, 0.9)])',
        'print(json.dumps(detect.boîtes_du_lot([Result(b, k)], 0, 2.0, 960, 540)))',
      ].join('\n'),
    ) as { x0: number; k: number[] }[]
    expect(boxes).toHaveLength(1)
    // Celui de la seconde personne, à 0,5 — pas celui de la première, à 0.
    expect(boxes[0].k.slice(0, 3)).toEqual([0.5, 0.5, 0.9])
  })

  it('n’écrit aucun `k` quand le modèle ne rend pas de points', () => {
    const boxes = evaluate(
      [
        FIXTURE,
        'b = Boxes([[96.0, 54.0, 288.0, 486.0]], [0.9])',
        'print(json.dumps(detect.boîtes_du_lot([Result(b)], 0, 2.0, 960, 540)))',
      ].join('\n'),
    ) as Record<string, unknown>[]
    expect(boxes).toHaveLength(1)
    expect('k' in boxes[0]).toBe(false)
  })
})
