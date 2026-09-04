import { describe, expect, it } from 'vitest'

import type { ClipStatus } from '@/core/edl'
import type { StepName } from '@/core/graph'
import { phaseProject, type Phase } from '@/core/phase'
import { path, clipNext, linkClip, linkProject, planningLink, routeId, settingsLink, next } from '@/lib/navigation'

const project = { id: 'p1', title: 'La scène Avolo du 15 juin' }

describe('chemin', () => {
  it('ne donne pas de fil d’Ariane à la racine', () => {
    // La bibliothèque **est** la racine : la marque du produit y suffit, et un
    // fil d'Ariane à un seul cran répéterait le titre de l'écran.
    expect(path({ kind: 'library' })).toEqual([])
  })

  it('nomme le projet, sans lien vers l’écran où l’on est', () => {
    expect(path({ kind: 'project', project })).toEqual([{ label: project.title }])
  })

  it('rend le projet cliquable depuis un clip', () => {
    // C'est la sortie du sous-parcours de montage : chaque niveau se quitte par
    // le haut, et la profondeur ne dépasse jamais trois.
    expect(path({ kind: 'clip', project, clip: { title: 'La chute' } })).toEqual([
      { label: project.title, href: '/projects/p1' },
      { label: 'La chute' },
    ])
  })

  it('encode l’identifiant du projet', () => {
    // Les identifiants viennent du nom du fichier d'origine, accents et espaces
    // compris : sans encodage, la moindre espace casse l'URL.
    const [root] = path({
      kind: 'clip',
      project: { id: '2026-01-11 méchante', title: 'Méchante' },
      clip: { title: 'La chute' },
    })
    expect(root.href).toBe('/projects/2026-01-11%20m%C3%A9chante')
  })

  it('nomme les paramètres, en frère de la racine et non en quatrième étage', () => {
    // Les réglages ne décrivent aucune émission : changer l'un d'eux ne
    // recalcule rien. Les ranger sous une émission aurait suggéré le contraire.
    expect(path({ kind: 'settings' })).toEqual([{ label: 'Paramètres' }])
    expect(settingsLink()).toBe('/settings')
  })

  it('nomme le planning, en frère de la racine et non en quatrième étage', () => {
    expect(path({ kind: 'planning' })).toEqual([{ label: 'Planning' }])
    expect(planningLink()).toBe('/planning')
  })

  it('porte un cran quand l’objet n’est pas encore connu', () => {
    // Le chargement et l'objet introuvable : le fil d'Ariane reste atteignable
    // dans tous les états, y compris « clip introuvable ».
    expect(path({ kind: 'unknown', label: '…' })).toEqual([{ label: '…' }])
  })
})

/**
 * Le test énumère des **entrées**, pas des sorties.
 *
 * Plusieurs couples sont inatteignables — `wait` ne coexiste avec aucun
 * travail décidé sur un projet neuf, faute de candidats — et forcer une action
 * sur un état impossible oblige à en inventer une. On part donc de relevés de
 * présence, d'exécutions en cours et de statuts de clips, on les passe à
 * `phaseProject`, et on regarde ce que `next` en fait.
 */
function readings(): Record<StepName, boolean>[] {
  const steps: StepName[] = ['proxy', 'audio', 'transcript', 'analysis', 'candidates', 'renders']
  const combinations: Record<StepName, boolean>[] = []
  for (let mask = 0; mask < 1 << steps.length; mask++) {
    const reading = {} as Record<StepName, boolean>
    steps.forEach((name, i) => {
      reading[name] = (mask & (1 << i)) !== 0
    })
    combinations.push(reading)
  }
  return combinations
}

const executions = [null, { step: 'proxy' as StepName, progress: 0.3 }]
const errors = [null, 'le repérage a échoué']
const lists: ClipStatus[][] = [
  [],
  ['candidate'],
  ['candidate', 'kept'],
  ['kept'],
  ['kept', 'exported'],
  ['exported'],
  ['discarded'],
  ['exported', 'discarded'],
]

function phasesReachable(): Phase[] {
  const views = new Map<string, Phase>()
  for (const steps of readings()) {
    for (const running of executions) {
      for (const error of errors) {
        for (const statuses of lists) {
          const phase = phaseProject(
            steps,
            running,
            error,
            statuses.map((status) => ({ status })),
          )
          views.set(`${phase.analysis}/${phase.work}`, phase)
        }
      }
    }
  }
  return [...views.values()]
}

describe('suite', () => {
  it('l’énumération couvre les deux axes en entier', () => {
    // Sans ce contrôle, le test qui suit ne prouverait rien : une énumération
    // qui ne produirait que trois couples les couvrirait tous.
    const phases = phasesReachable()
    expect(new Set(phases.map((p) => p.analysis)).size).toBe(5)
    expect(new Set(phases.map((p) => p.work)).size).toBe(4)
    // Le renommage `waiting` -> `running` ne doit ajouter aucun couple : c'est
    // la preuve qu'il ne déplace rien d'autre que le nom.
    expect(phases.length).toBe(20)
  })

  it('rend un résultat pour chaque couple atteignable', () => {
    // La garantie que porte cette fonction : **aucun état n'est une impasse.**
    // C'est ce que le fait d'être une fonction unique rend testable, et ce qui
    // remplace une relecture des trois écrans.
    for (const phase of phasesReachable()) {
      const issue = next(phase, project)
      expect(issue, `${phase.analysis}/${phase.work}`).toBeTruthy()
      if (issue.kind === 'action') {
        expect(issue.label, `${phase.analysis}/${phase.work}`).not.toBe('')
        expect(issue.target, `${phase.analysis}/${phase.work}`).not.toBe('')
      } else {
        expect(issue.reason, `${phase.analysis}/${phase.work}`).not.toBe('')
      }
    }
  })

  it('propose la reprise quand une exécution est morte', () => {
    // La seule impasse réelle de l'interface : `progression()` lit une `Map` du
    // processus Next, et un redémarrage du serveur perd l'exécution sans laisser
    // d'erreur.
    const issue = next({ analysis: 'interrupted', work: 'none' }, project)
    expect(issue).toEqual({ kind: 'action', label: expect.any(String), target: '/projects/p1' })
  })

  it('propose la reprise après un échec qui n’a rien laissé', () => {
    expect(next({ analysis: 'failed', work: 'none' }, project)).toEqual({
      kind: 'action',
      label: expect.any(String),
      target: '/projects/p1',
    })
  })

  it('ne cache derrière rien le travail que l’humain peut continuer', () => {
    // La règle, une fois pour toutes : **l'état de l'analyse ne commande que
    // lorsqu'il n'y a rien à décider ni à monter.** Une réparation, une attente
    // — l'une comme l'autre remplaceraient une action disponible, alors que les
    // clips de la passe précédente survivent à un repérage forcé qui a échoué,
    // qui tourne encore, ou qu'un redémarrage du serveur a perdu.
    // (relevé par Codex et Copilot)
    for (const work of ['toSort', 'sorted', 'delivered'] as const) {
      for (const analysis of ['running', 'interrupted', 'failed'] as const) {
        expect(next({ analysis, work }, project), `${analysis}/${work}`).toEqual(
          next({ analysis: 'complete', work }, project),
        )
      }
    }
  })

  it('attend les propositions tant que le repérage n’a pas rendu', () => {
    expect(next({ analysis: 'running', work: 'none' }, project)).toEqual({
      kind: 'waiting',
      reason: expect.any(String),
      unblockedBy: 'candidates',
    })
  })

  it('ne cache pas le tri déjà possible pendant un repérage forcé', () => {
    // `eraseArtifact` retire `candidates.json` avant de toucher à la base :
    // pendant un repérage forcé, les clips de la passe précédente sont toujours
    // là. Faire attendre ici cacherait à Julien le travail qu'il vient de
    // faire — c'est l'invariant, la phase ne retire jamais ce qui existe.
    expect(next({ analysis: 'running', work: 'toSort' }, project)).toEqual({
      kind: 'action',
      label: expect.any(String),
      target: '/projects/p1',
    })
  })

  it('ne cache pas le montage déjà possible pendant un repérage forcé', () => {
    // La conception le dit mot pour mot : pendant un repérage forcé, « les clips
    // gardés sont toujours là et toujours montables ».
    expect(next({ analysis: 'running', work: 'sorted' }, project).kind).toBe('action')
  })

  it('ne cache pas un projet déjà livré pendant un repérage forcé', () => {
    expect(next({ analysis: 'running', work: 'delivered' }, project)).toEqual({
      kind: 'action',
      label: expect.any(String),
      target: '/',
    })
  })

  it('attend le proxy quand tout est trié et que le montage ne peut pas s’ouvrir', () => {
    // `{ triable, trie }` est un état réel : Julien a fini de trier avant que le
    // proxy ne soit encodé, et **il n'a aucune action qui fasse avancer le
    // montage**. Forcer une action ici reviendrait à en inventer une.
    expect(next({ analysis: 'sortable', work: 'sorted' }, project)).toEqual({
      kind: 'waiting',
      reason: expect.any(String),
      unblockedBy: 'proxy',
    })
  })

  it('mène au tri tant qu’une proposition reste indécise', () => {
    const issue = next({ analysis: 'complete', work: 'toSort' }, project)
    expect(issue).toEqual({ kind: 'action', label: expect.any(String), target: '/projects/p1' })
  })

  it('propose de relancer le repérage sur une liste vide', () => {
    expect(next({ analysis: 'sortable', work: 'none' }, project).kind).toBe('action')
  })

  it('ramène à la bibliothèque quand tout est livré', () => {
    expect(next({ analysis: 'complete', work: 'delivered' }, project)).toEqual({
      kind: 'action',
      label: expect.any(String),
      target: '/',
    })
  })

  it('ne fait pas attendre le proxy quand tout est déjà livré', () => {
    // `{ triable, livre }` : le proxy a disparu du disque après coup, mais tous
    // les MP4 sont là. Il n'y a rien à attendre.
    expect(next({ analysis: 'sortable', work: 'delivered' }, project).kind).toBe('action')
  })
})

describe('routeId', () => {
  /**
   * The invariant is the round trip: `linkProject` and `linkClip` encode, and
   * a route hands the segment back still encoded. Assert the pair, not the
   * decoding alone — a decoder that is right about a string nobody builds is
   * worth nothing.
   */
  const segment = (url: string): string => url.slice(url.lastIndexOf('/') + 1)

  it('rend un identifiant accentué à l’identique après l’aller-retour', () => {
    const id = '2026-01-11-méchante'
    expect(segment(linkProject(id))).toBe('2026-01-11-m%C3%A9chante')
    expect(routeId(segment(linkProject(id)))).toBe(id)
  })

  it('rend un identifiant à espaces à l’identique — le cas courant des replays', () => {
    const id = 'Emission du 5 mai'
    expect(segment(linkProject(id))).toBe('Emission%20du%205%20mai')
    expect(routeId(segment(linkProject(id)))).toBe(id)
  })

  it('fait l’aller-retour sur un identifiant de clip, qui hérite de celui du projet', () => {
    const id = '2026-01-11-méchante_005472883-005518477'
    expect(routeId(segment(linkClip(id)))).toBe(id)
  })

  it('rend le segment tel quel plutôt que de lever sur un encodage invalide', () => {
    // A malformed URL names no project: it must end in a 404, never in an
    // error screen.
    expect(routeId('%')).toBe('%')
    expect(routeId('%zz')).toBe('%zz')
  })

  it('laisse intact un identifiant qui n’a rien à décoder', () => {
    expect(routeId('2025-06-15-cqlp')).toBe('2025-06-15-cqlp')
  })
})

describe('clipNext', () => {
  function list(...clips: [string, ClipStatus][]) {
    return clips.map(([id, status]) => ({ id, status }))
  }

  it('rend le prochain clip gardé', () => {
    const clips = list(['a', 'kept'], ['b', 'discarded'], ['c', 'kept'])
    expect(clipNext(clips, 'a')?.id).toBe('c')
  })

  it('compte un clip exporté comme gardé', () => {
    // Rouvrir un clip exporté pour en retoucher le montage est un parcours
    // normal : le sauter ferait sortir de la boucle avant la fin.
    expect(clipNext(list(['a', 'kept'], ['b', 'exported']), 'a')?.id).toBe('b')
  })

  it('ne boucle pas sur le premier depuis le dernier', () => {
    // Le bouton « clip suivant » se désactive sur le dernier : reboucler ferait
    // repasser indéfiniment sur des clips déjà montés sans que rien ne le dise.
    expect(clipNext(list(['a', 'kept'], ['b', 'kept']), 'b')).toBeNull()
  })

  it('rend null sur une liste vide', () => {
    expect(clipNext([], 'a')).toBeNull()
  })

  it('rend null quand il n’y a qu’un clip gardé', () => {
    expect(clipNext(list(['a', 'kept']), 'a')).toBeNull()
  })

  it('rend null quand le clip courant n’est pas dans la liste', () => {
    // Une liste rechargée pendant qu'on montait, un identifiant venu d'ailleurs :
    // sans position de départ, il n'y a pas de suivant. Rendre le premier gardé
    // ferait sauter dans la liste sans que le geste l'explique.
    expect(clipNext(list(['a', 'kept'], ['b', 'kept']), 'z')).toBeNull()
  })

  it('part du clip courant même s’il a été écarté depuis', () => {
    const clips = list(['a', 'kept'], ['b', 'discarded'], ['c', 'kept'])
    expect(clipNext(clips, 'b')?.id).toBe('c')
  })

  it('rend l’élément de la liste, pas une copie', () => {
    // Les écrans en lisent le titre et la vignette : rendre un objet réduit
    // obligerait à retrouver l'entrée d'origine derrière.
    const clips = [
      { id: 'a', status: 'kept' as ClipStatus, title: 'Un' },
      { id: 'b', status: 'kept' as ClipStatus, title: 'Deux' },
    ]
    expect(clipNext(clips, 'a')).toBe(clips[1])
  })
})
