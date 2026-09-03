import { describe, expect, it } from 'vitest'

import type { ClipStatus } from '@/core/edl'
import type { StepName } from '@/core/graph'
import {
  count,
  stepDurationRange,
  phaseProject,
  STEPS,
  LABELS_STEPS,
  type ShowSize,
} from '@/core/phase'

/** Un relevé de présence : ce qui n'est pas nommé est absent. */
function reading(...present: StepName[]): Record<StepName, boolean> {
  const all: Record<StepName, boolean> = {
    proxy: false,
    audio: false,
    transcript: false,
    correction: false,
    analysis: false,
    candidates: false,
    renders: false,
  }
  for (const name of present) all[name] = true
  return all
}

const inCurrent = { step: 'transcript' as StepName, progress: 0.4 }

function clips(...statuses: ClipStatus[]): { status: ClipStatus }[] {
  return statuses.map((status) => ({ status }))
}

describe('phaseProject, l’axe des artefacts', () => {
  it('attend tant que les candidats manquent et qu’une exécution tourne', () => {
    expect(phaseProject(reading('audio'), inCurrent, null, []).analysis).toBe('running')
  })

  it('dit « interrompu » quand il manque une étape et que rien ne tourne', () => {
    // `progression()` lit une `Map` du processus Next : un redémarrage du
    // serveur perd l'exécution sans laisser d'erreur. C'est la seule impasse
    // réelle de l'interface, et la seule valeur qui appelle une réparation.
    expect(phaseProject(reading('audio', 'transcript'), null, null, []).analysis).toBe('interrupted')
  })

  it('dit « interrompu », par défaut, quand rien n’est sur le disque et que rien ne tourne', () => {
    expect(phaseProject(reading(), null, null, []).analysis).toBe('interrupted')
  })

  it('dit « neuf » quand rien n’est sur le disque, rien ne tourne, et status.json n’a jamais été écrit', () => {
    // Depuis le 23 août 2026, `createProject` peut créer un projet sans le
    // lancer (retour d'usage, point A.3) : « aucun artefact, aucune exécution »
    // ne décrit alors plus une exécution morte, mais un projet qui vient d'être
    // créé. `everRan` — tiré de `status.json` — est le seul fait qui distingue
    // les deux, puisque `steps`, `running` et `error` sont identiques.
    expect(phaseProject(reading(), null, null, [], false).analysis).toBe('new')
  })

  it('dit « interrompu », et non « neuf », dès qu’une exécution a laissé un status.json', () => {
    expect(phaseProject(reading(), null, null, [], true).analysis).toBe('interrupted')
  })

  it('dit « echec » quand la dernière exécution a échoué', () => {
    expect(phaseProject(reading('audio'), null, 'Gemini a refusé le lot', []).analysis).toBe('failed')
  })

  it('préfère l’exécution en cours à l’échec de la précédente', () => {
    // `error` décrit la dernière exécution **terminée**. Une exécution en cours
    // la périme : l'écran doit dire ce qui se passe, l'incident s'affiche à côté.
    expect(phaseProject(reading('audio'), inCurrent, 'un échec d’avant', []).analysis).toBe('running')
  })

  it('devient « triable » dès que les candidats sont là, même sans proxy', () => {
    expect(phaseProject(reading('candidates'), null, null, []).analysis).toBe('sortable')
  })

  it('reste « triable » pendant l’encodage du proxy', () => {
    // Une première version portait une valeur `encours` qui recouvrait
    // `triable` : elle aurait affiché le panneau d'attente sur un écran
    // parfaitement triable, pendant les six minutes du proxy.
    expect(phaseProject(reading('candidates'), { step: 'proxy', progress: 0.1 }, null, []).analysis).toBe(
      'sortable',
    )
  })

  it('reste « triable » quand une exécution s’est interrompue après le repérage', () => {
    // La précondition qui compte : `interrompu` et `failure` ne s'appliquent que
    // tant que `candidates` est absent. Sans elle, une exécution morte pendant
    // l'encodage du proxy cacherait la grille de tri au moment précis où elle
    // doit remplacer le panneau.
    expect(phaseProject(reading('candidates'), null, null, []).analysis).toBe('sortable')
    expect(phaseProject(reading('candidates'), null, 'le proxy a échoué', []).analysis).toBe('sortable')
  })

  it('est « complet » quand les candidats et le proxy sont là', () => {
    expect(phaseProject(reading('candidates', 'proxy'), null, null, []).analysis).toBe('complete')
  })

  it('ne cite que les deux étapes qui changent ce qu’on peut faire', () => {
    // Ni le transcript ni l'analyse n'ouvrent quoi que ce soit : la liste reste
    // vide jusqu'à la fin du repérage, et le montage attend le proxy.
    const included = phaseProject(reading('candidates', 'proxy', 'transcript', 'audio', 'analysis'), null, null, [])
    const without = phaseProject(reading('candidates', 'proxy'), null, null, [])
    expect(included).toEqual(without)
  })

  it('ignore une étape inconnue dans le relevé', () => {
    // Retirer une étape du graphe suit le même chemin que d'en ajouter une :
    // un relevé qui porte un nom qu'on ne connaît plus ne change pas la phase.
    const unknown = { ...reading('candidates', 'proxy'), sous_titres: true } as Record<
      StepName,
      boolean
    >
    expect(phaseProject(unknown, null, null, [])).toEqual(
      phaseProject(reading('candidates', 'proxy'), null, null, []),
    )
  })
})

describe('phaseProject, l’axe du travail humain', () => {
  const complete = reading('candidates', 'proxy')

  it('dit « rien » sur une liste vide', () => {
    // `triable` teste la présence de l'artefact, pas son contenu : un
    // `candidates.json` vide donne `{ triable, rien }`, et c'est l'axe du
    // travail qui porte le vide. C'est la raison d'être des deux axes.
    expect(phaseProject(reading('candidates'), null, null, [])).toEqual({
      analysis: 'sortable',
      work: 'none',
    })
  })

  it('dit « atrier » tant qu’une proposition reste indécise', () => {
    expect(phaseProject(complete, null, null, clips('kept', 'candidate', 'discarded')).work).toBe(
      'toSort',
    )
  })

  it('préfère « atrier » à « livre » quand un clip gardé est déjà rendu', () => {
    // L'ordre des tests fait partie du contrat : écrites comme des prédicats
    // indépendants, les conditions se recouvrent et `livre` mordrait sur
    // `atrier` dès le premier clip exporté.
    expect(phaseProject(complete, null, null, clips('exported', 'candidate')).work).toBe('toSort')
  })

  it('dit « livre » quand tous les gardés sont exportés', () => {
    expect(phaseProject(complete, null, null, clips('exported', 'exported', 'discarded')).work).toBe(
      'delivered',
    )
  })

  it('n’annonce pas « livre » sur une liste où tout a été écarté', () => {
    // « Tous les clips gardés sont exportés » est vrai d'une liste vide : la
    // phase terminale annonçait un livrable alors qu'aucun MP4 n'existe.
    expect(phaseProject(complete, null, null, clips('discarded', 'discarded')).work).toBe('sorted')
  })

  it('dit « trie » quand tout est décidé et qu’il reste à monter', () => {
    expect(phaseProject(complete, null, null, clips('kept', 'discarded')).work).toBe('sorted')
  })

  it('dit « trie » quand un seul des gardés attend encore son rendu', () => {
    expect(phaseProject(complete, null, null, clips('exported', 'kept')).work).toBe('sorted')
  })

  it('atteint { running, trie } pendant un repérage forcé', () => {
    // `eraseArtifact` retire `candidates.json` **avant** de toucher à la
    // base : pendant un repérage forcé, les clips gardés sont toujours là et
    // toujours montables. La phase choisit ce que l'écran met en avant, elle ne
    // retire jamais ce qui existe.
    expect(phaseProject(reading('proxy'), inCurrent, null, clips('kept', 'discarded'))).toEqual({
      analysis: 'running',
      work: 'sorted',
    })
  })
})

describe('le tableau des étapes', () => {
  it('donne un libellé à chaque étape du graphe', () => {
    // `LABELS_STEPS` est un `Record<StepName, string>` exhaustif : c'est le
    // type-check qui refuse l'oubli. Ce test-ci n'attrape que la chaîne vide.
    for (const label of Object.values(LABELS_STEPS)) {
      expect(label).not.toBe('')
    }
  })

  it('décrit toutes les étapes que le lanceur sait fabriquer', () => {
    // `renders` en est exclu — un rendu se demande par clip, jamais par le
    // graphe — mais aucune autre : une étape ajoutée au graphe et oubliée ici
    // n'apparaîtrait dans aucun panneau d'avancement.
    const described = STEPS.map((e) => e.name)
    const expected = (Object.keys(LABELS_STEPS) as StepName[]).filter((n) => n !== 'renders')
    expect([...described].sort()).toEqual([...expected].sort())
  })

  it('reprend le libellé de la table, sans le recopier', () => {
    for (const step of STEPS) {
      expect(step.label).toBe(LABELS_STEPS[step.name])
    }
  })

  it('place le proxy après le repérage, comme le lanceur l’exécute', () => {
    // `TARGETS_INITIAL = ['candidates', 'proxy']` : les candidats arrivent
    // avant les images, et c'est ce qui rend le régime « triable » possible.
    const order = STEPS.map((e) => e.name)
    expect(order.indexOf('candidates')).toBeLessThan(order.indexOf('proxy'))
    expect(order.indexOf('audio')).toBeLessThan(order.indexOf('transcript'))
    expect(order.indexOf('transcript')).toBeLessThan(order.indexOf('candidates'))
    expect(order.indexOf('proxy')).toBeLessThan(order.indexOf('analysis'))
  })

  // Sa position d'exécution (spec §5, §9, correction du 23 août 2026) : le
  // repérage doit lire le texte qu'elle vient de corriger.
  it('place la correction entre le transcript et le repérage', () => {
    const order = STEPS.map((e) => e.name)
    expect(order.indexOf('transcript')).toBeLessThan(order.indexOf('correction'))
    expect(order.indexOf('correction')).toBeLessThan(order.indexOf('candidates'))
  })

  it('ne porte plus de coût : il dépend de l’émission, pas de l’étape', () => {
    // Les cinq `coûtSec` étaient mesurés une seule fois, sur une émission
    // d'1 h 40, et s'affichaient à l'identique pour une capsule de vingt
    // minutes. `stepDurationRange` les remplace, et deux tables sur la même
    // question auraient fini par diverger.
    for (const step of STEPS) {
      expect(Object.keys(step).toSorted()).toEqual(['label', 'name'])
    }
  })
})

describe('compter', () => {
  function candidate(status: ClipStatus, duration: number) {
    return { status, segments: [{ start: 0, end: duration }] }
  }

  it('ne compte rien sur une liste vide', () => {
    expect(count([])).toEqual({ aSort: 0, guards: 0, discarded: 0, durationKept: 0 })
  })

  it('compte un clip exporté comme gardé', () => {
    // `isGuard` porte la définition unique : `exported` est une décision
    // humaine qui a déjà produit un fichier, pas une proposition en attente.
    expect(count([candidate('exported', 30)]).guards).toBe(1)
  })

  it('somme la durée des seuls gardés', () => {
    const result = count([
      candidate('kept', 30),
      candidate('exported', 12),
      candidate('discarded', 90),
      candidate('candidate', 45),
    ])
    expect(result).toEqual({ aSort: 1, guards: 2, discarded: 1, durationKept: 42 })
  })

  it('rend une durée nulle quand les gardés n’ont plus de segment', () => {
    expect(count([{ status: 'kept', segments: [] }]).durationKept).toBe(0)
  })
})

/**
 * L'émission de référence de `ROADMAP.md` : 1 h 39, 4,3 Go, 83 fenêtres. Les
 * constantes du module en sortent, donc elle doit se retrouver à la seconde.
 */
const CQLP: ShowSize = { durationSec: 5_940, sizeBytes: 4_300_000_000, windows: 83 }

/** Une émission de vingt minutes, celle du §4.2 du retour d'usage. */
const TWENTY_MINUTES: ShowSize = { durationSec: 1_200, sizeBytes: null, windows: null }

/** Le centre de la fourchette, arrondi à la seconde. */
function midpoint(f: { lowSec: number; highSec: number } | null): number {
  if (f === null) throw new Error('fourchette absente')
  return Math.round((f.lowSec + f.highSec) / 2)
}

describe('stepDurationRange', () => {
  /**
   * **Les quatre mesures de `ROADMAP.md`, retrouvées sur l'émission dont elles
   * sortent.** Ce test croisait les deux tables tant qu'elles coexistaient —
   * `STEPS` portait un `coûtSec` constant, celle-ci le rapporte à l'émission
   * qu'on regarde, et elles devaient s'accorder sur la référence. `coûtSec` est
   * retiré depuis : il ne reste qu'un côté, et ce sont les valeurs elles-mêmes
   * qui l'ancrent. C'est d'ailleurs ce que la boucle d'alors ne garantissait
   * pas seule — son propre commentaire le disait, un `STEPS` vidé l'aurait
   * fait passer sans rien vérifier. (relevé par Aristarque)
   */
  it('retrouve, sur l’émission de référence, les quatre coûts mesurés', () => {
    expect(midpoint(stepDurationRange('audio', CQLP))).toBe(6)
    expect(midpoint(stepDurationRange('transcript', CQLP))).toBe(101)
    expect(midpoint(stepDurationRange('proxy', CQLP))).toBe(360)
    expect(midpoint(stepDurationRange('candidates', CQLP))).toBe(30)
  })

  it('annonce beaucoup moins sur une émission de vingt minutes', () => {
    // C'est tout l'objet de la fonction : une émission cinq fois plus courte ne
    // doit pas annoncer les six minutes de proxy de l'émission de référence.
    const proxy = stepDurationRange('proxy', TWENTY_MINUTES)
    expect(midpoint(proxy)).toBe(73)
    expect(proxy!.highSec).toBeLessThan(360)
  })

  it('reste proportionnelle : doubler la durée double le coût', () => {
    const a = midpoint(stepDurationRange('proxy', { ...CQLP, windows: null }))
    const two = midpoint(
      stepDurationRange('proxy', { durationSec: 11_880, sizeBytes: null, windows: null }),
    )
    expect(two).toBe(a * 2)
  })

  it('compte le repérage en fenêtres quand on les connaît', () => {
    // Deux fois plus de fenêtres pour la même durée : le repérage coûte le
    // double, alors que le proxy ne bouge pas.
    const included = stepDurationRange('candidates', { ...CQLP, windows: 166 })
    expect(midpoint(included)).toBe(60)
  })

  it('déduit une durée de la taille du fichier, et élargit la fourchette', () => {
    const fromSize = stepDurationRange('proxy', {
      durationSec: null,
      sizeBytes: 4_300_000_000,
      windows: null,
    })
    // Le centre est le même — c'est le débit de la même émission — mais la
    // fourchette est deux fois plus large, parce que le débit vidéo n'a jamais
    // été relevé sur plus d'un fichier.
    expect(midpoint(fromSize)).toBe(360)
    const fromDuration = stepDurationRange('proxy', CQLP)
    expect(fromSize!.highSec - fromSize!.lowSec).toBeGreaterThan(
      fromDuration!.highSec - fromDuration!.lowSec,
    )
  })

  it('préfère la durée à la taille quand les deux sont là', () => {
    // Une taille aberrante ne doit rien changer tant que la durée est connue.
    const f = stepDurationRange('proxy', { ...CQLP, sizeBytes: 1 })
    expect(midpoint(f)).toBe(360)
  })

  it('n’annonce rien pour une étape jamais chronométrée', () => {
    // `analysis` est absente de la table des débits parce que personne ne l'a
    // chronométrée sur une émission entière — elle reste dans `STEPS`, qui
    // décrit l'ordre du plan et non son prix.
    expect(stepDurationRange('analysis', CQLP)).toBeNull()
    expect(STEPS.some((step) => step.name === 'analysis')).toBe(true)
  })

  it('n’annonce rien pour la correction, jamais chronométrée non plus', () => {
    // `null` dit « on ne sait pas », pas « instantanée » — CLAUDE.md sur les
    // valeurs notées comparées à un seuil s'applique par analogie à la règle
    // sœur de ce dépôt : ne jamais inventer un chiffre qui n'est adossé à rien.
    expect(stepDurationRange('correction', CQLP)).toBeNull()
    expect(STEPS.some((step) => step.name === 'correction')).toBe(true)
  })

  it('n’annonce rien pour les rendus, qui ne passent pas par le graphe', () => {
    expect(stepDurationRange('renders', CQLP)).toBeNull()
  })

  it('n’annonce rien quand l’émission n’a livré ni durée ni taille', () => {
    const unknown: ShowSize = { durationSec: null, sizeBytes: null, windows: null }
    for (const step of ['audio', 'transcript', 'proxy', 'candidates'] as const) {
      expect(stepDurationRange(step, unknown)).toBeNull()
    }
  })

  it('traite zéro et les valeurs aberrantes comme une absence', () => {
    expect(
      stepDurationRange('proxy', { durationSec: 0, sizeBytes: 0, windows: 0 }),
    ).toBeNull()
    expect(
      stepDurationRange('proxy', {
        durationSec: Number.NaN,
        sizeBytes: Number.POSITIVE_INFINITY,
        windows: null,
      }),
    ).toBeNull()
  })

  it('compte encore le repérage quand seules les fenêtres sont connues', () => {
    // L'ordre du graphe le permet : les fenêtres se comptent sur le transcript,
    // et rien n'oblige la durée à être en base pour autant.
    const f = stepDurationRange('candidates', {
      durationSec: null,
      sizeBytes: null,
      windows: 83,
    })
    expect(midpoint(f)).toBe(30)
  })

  it('rend une borne basse jamais négative', () => {
    for (const step of ['audio', 'transcript', 'proxy', 'candidates'] as const) {
      const f = stepDurationRange(step, TWENTY_MINUTES)
      expect(f!.lowSec).toBeGreaterThanOrEqual(0)
      expect(f!.lowSec).toBeLessThanOrEqual(f!.highSec)
    }
  })
})
