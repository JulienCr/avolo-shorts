/**
 * Planche versionnée — issue #190, commentaire du 26 août 2026.
 *
 * Le propriétaire a nommé **trois replis différents** pour un split rejeté :
 * pas de split, un ratio plus large épinglé, ou un 9:16 sur une seule
 * personne. Cette planche les met côte à côte, au même instant source, sur
 * les huit cas étiquetés du registre — trois `keep`, le témoin négatif.
 */

import { SINGLE_STATE } from '../board/classifiers'
import type { BoardCase, BoardSpec } from '../board/spec'
import { findCase, projectOf, selectCases, type FramingCase } from '../cases'

function caseAsBoardCase(c: FramingCase): BoardCase {
  return {
    id: c.id,
    projectId: projectOf(c),
    at: c.anchor.instants[0],
    clipId: c.scope.over === 'clip' ? c.scope.clipId : null,
    stake: c.probes,
    known: c.label === null ? undefined : { call: c.label.call, on: c.label.on, by: c.label.by, note: c.label.note },
  }
}

/**
 * Le `cropX` de la variante « 9:16 sur une personne », par cas — dérivé, pas
 * choisi à l'œil, contre l'`analysis.json` du 26 août 2026 (voir la bande de
 * reproductibilité de la planche pour le commit du jour du rendu).
 *
 * Méthode, appliquée hors ligne sur chaque plan : sur ses images à exactement
 * deux personnes retenues (`retainedBoxes`), triées gauche/droite par le
 * centre de `personBounds`, on choisit le côté dont la tête (`headBounds`,
 * points de nez/yeux/oreilles au-dessus du seuil) est présente sur le plus
 * grand nombre de ces images ; à égalité de présence, le côté dont le score
 * moyen de ces points est le plus haut. Le `cropX` rendu est la **médiane**
 * du centre de `headBounds` de ce côté, sur les seules images où sa tête est
 * présente.
 *
 * C'est cette règle qui, sur `entre-nous` 3495,867 s, retient la personne
 * opposée à celle que le propriétaire nomme « trop bord cadre » (score de
 * tête moyen 0,864 contre 0,347) — sans connaître son nom, seulement le fait
 * que sa tête se voit mieux. Sur `nabla` 6418,667 s (nuque, `facing ==
 * 'unknown'`), le même calcul retient sans ambiguïté le seul côté dont la
 * tête est identifiable (score 0,826 contre 0,217). Sur `fmr` 1115,733 s,
 * un seul côté a jamais une tête détectée (10/10 contre 0/10) — le cas
 * binaire que #190 nomme explicitement.
 */
const MANUAL_CROP_X: Readonly<Record<string, number>> = {
  'nabla-2056800': 0.2635,
  'nabla-1798867': 0.2438,
  'nabla-1607967': 0.2532,
  'nabla-2077400': 0.3491,
  'nabla-6418667': 0.6784,
  'cqlp-1366033': 0.3117,
  'entre-nous-3495867': 0.5376,
  'fmr-1115733': 0.8346,
}

/** Les huit cas étiquetés d'aujourd'hui — ancré par le compilateur, pas par une relecture. */
const LABELLED_CASE_IDS = Object.keys(MANUAL_CROP_X)

const cases: BoardCase[] = LABELLED_CASE_IDS.map((id) => {
  const c = findCase(id)
  if (c === undefined) {
    throw new Error(`2026-08-27-replis-du-split : cas "${id}" introuvable dans le registre.`)
  }
  return caseAsBoardCase(c)
})

// Recoupe le sélecteur `labelled` du registre : si un neuvième cas est un
// jour étiqueté (ou un des huit retiré), cette planche doit le signaler
// plutôt que de se taire sur un jeu d'épreuve devenu partiel.
const labelledToday = selectCases('labelled')
  .map((c) => c.id)
  .sort()
const expected = [...LABELLED_CASE_IDS].sort()
if (labelledToday.join(',') !== expected.join(',')) {
  throw new Error(
    `2026-08-27-replis-du-split : le registre porte les cas étiquetés [${labelledToday.join(', ')}], ` +
      `cette planche en attend [${expected.join(', ')}]. Ajoute ou retire un \`cropX\` dans ` +
      '`MANUAL_CROP_X` pour la faire correspondre.',
  )
}

const spec: BoardSpec = {
  id: 'replis-du-split-2026-08-27',
  title: 'Les trois replis du split — issue #190',
  eyebrow: 'Cadrage',
  lede:
    'Huit cas étiquetés (cinq à écarter, trois à garder en témoin négatif), quatre variantes au ' +
    'même instant source : split activé, split désactivé, ratio 1:1 épinglé, 9:16 sur une seule ' +
    'personne.',
  callout: {
    title: 'Ce que ça éprouve',
    body:
      "Sur les trois cas « garder », le split doit rester la meilleure image des quatre — sinon " +
      "un des replis vole une victoire qui ne lui revient pas. Sur les cinq « écarter », comparer " +
      'lequel des trois replis convient au défaut nommé par le propriétaire.',
  },
  variants: [
    { id: 'split-on', label: 'Split activé', kind: 'settings', settings: {} },
    { id: 'split-off', label: 'Split désactivé', kind: 'settings', settings: { splitScreen: false } },
    {
      id: 'wide-1-1',
      label: '1:1 épinglé',
      kind: 'options',
      options: {},
      ratio: '1:1',
      why:
        "Repli nommé sur `entre-nous` 3495,867 s : « un seul plan 1:1 ou 4:5 serait bien plus " +
        "intéressant ». 1:1 plutôt que 4:5 pour rester le plus serré des deux qui tienne encore " +
        'les deux comédiens — voir spec §2 sur la part de temps qui y tient.',
    },
    {
      id: 'one-person-9-16',
      label: '9:16 sur une personne',
      kind: 'options',
      options: {},
      ratio: '9:16',
      cropMode: 'manual',
      cropX: MANUAL_CROP_X,
      why:
        "Repli plus radical, du commentaire de l'issue #190 sur ce même plan : « On pourrait même " +
        "faire un 9:16 sur Mathilde uniquement ». `cropX` dérivé par cas — voir `MANUAL_CROP_X` " +
        "ci-dessus pour la méthode. Un crop manuel efface le split (`applyExceptions`, " +
        '`src/core/framing.ts`).',
    },
  ],
  sections: [{ title: 'Cas étiquetés', cases }],
  classifier: SINGLE_STATE.id,
  settled: [],
}

export default spec
