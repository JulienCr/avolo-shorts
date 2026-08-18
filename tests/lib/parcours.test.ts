import { describe, expect, it } from 'vitest'

import type { ClipStatus } from '@/core/edl'
import type { StepName } from '@/core/graph'
import { phaseProjet, type Phase } from '@/core/parcours'
import { chemin, clipSuivant, suite } from '@/lib/parcours'

const projet = { id: 'p1', titre: 'La scène Avolo du 15 juin' }

describe('chemin', () => {
  it('ne donne pas de fil d’Ariane à la racine', () => {
    // La bibliothèque **est** la racine : la marque du produit y suffit, et un
    // fil d'Ariane à un seul cran répéterait le titre de l'écran.
    expect(chemin({ kind: 'bibliotheque' })).toEqual([])
  })

  it('nomme le projet, sans lien vers l’écran où l’on est', () => {
    expect(chemin({ kind: 'projet', projet })).toEqual([{ libelle: projet.titre }])
  })

  it('rend le projet cliquable depuis un clip', () => {
    // C'est la sortie du sous-parcours de montage : chaque niveau se quitte par
    // le haut, et la profondeur ne dépasse jamais trois.
    expect(chemin({ kind: 'clip', projet, clip: { titre: 'La chute' } })).toEqual([
      { libelle: projet.titre, href: '/projects/p1' },
      { libelle: 'La chute' },
    ])
  })

  it('encode l’identifiant du projet', () => {
    // Les identifiants viennent du nom du fichier d'origine, accents et espaces
    // compris : sans encodage, la moindre espace casse l'URL.
    const [racine] = chemin({
      kind: 'clip',
      projet: { id: '2026-01-11 méchante', titre: 'Méchante' },
      clip: { titre: 'La chute' },
    })
    expect(racine.href).toBe('/projects/2026-01-11%20m%C3%A9chante')
  })

  it('porte un cran quand l’objet n’est pas encore connu', () => {
    // Le chargement et l'objet introuvable : le fil d'Ariane reste atteignable
    // dans tous les états, y compris « clip introuvable ».
    expect(chemin({ kind: 'inconnu', libelle: '…' })).toEqual([{ libelle: '…' }])
  })
})

/**
 * Le test énumère des **entrées**, pas des sorties.
 *
 * Plusieurs couples sont inatteignables — `attente` ne coexiste avec aucun
 * travail décidé sur un projet neuf, faute de candidats — et forcer une action
 * sur un état impossible oblige à en inventer une. On part donc de relevés de
 * présence, d'exécutions en cours et de statuts de clips, on les passe à
 * `phaseProjet`, et on regarde ce que `suite` en fait.
 */
function relevés(): Record<StepName, boolean>[] {
  const étapes: StepName[] = ['proxy', 'audio', 'transcript', 'analysis', 'candidates', 'renders']
  const combinaisons: Record<StepName, boolean>[] = []
  for (let masque = 0; masque < 1 << étapes.length; masque++) {
    const relevé = {} as Record<StepName, boolean>
    étapes.forEach((nom, i) => {
      relevé[nom] = (masque & (1 << i)) !== 0
    })
    combinaisons.push(relevé)
  }
  return combinaisons
}

const exécutions = [null, { step: 'proxy' as StepName, progress: 0.3 }]
const erreurs = [null, 'le repérage a échoué']
const listes: ClipStatus[][] = [
  [],
  ['candidate'],
  ['candidate', 'kept'],
  ['kept'],
  ['kept', 'exported'],
  ['exported'],
  ['discarded'],
  ['exported', 'discarded'],
]

function phasesAtteignables(): Phase[] {
  const vues = new Map<string, Phase>()
  for (const steps of relevés()) {
    for (const running of exécutions) {
      for (const erreur of erreurs) {
        for (const statuts of listes) {
          const phase = phaseProjet(
            steps,
            running,
            erreur,
            statuts.map((status) => ({ status })),
          )
          vues.set(`${phase.analyse}/${phase.travail}`, phase)
        }
      }
    }
  }
  return [...vues.values()]
}

describe('suite', () => {
  it('l’énumération couvre les deux axes en entier', () => {
    // Sans ce contrôle, le test qui suit ne prouverait rien : une énumération
    // qui ne produirait que trois couples les couvrirait tous.
    const phases = phasesAtteignables()
    expect(new Set(phases.map((p) => p.analyse)).size).toBe(5)
    expect(new Set(phases.map((p) => p.travail)).size).toBe(4)
  })

  it('rend un résultat pour chaque couple atteignable', () => {
    // La garantie que porte cette fonction : **aucun état n'est une impasse.**
    // C'est ce que le fait d'être une fonction unique rend testable, et ce qui
    // remplace une relecture des trois écrans.
    for (const phase of phasesAtteignables()) {
      const issue = suite(phase, projet)
      expect(issue, `${phase.analyse}/${phase.travail}`).toBeTruthy()
      if (issue.kind === 'action') {
        expect(issue.libelle, `${phase.analyse}/${phase.travail}`).not.toBe('')
        expect(issue.cible, `${phase.analyse}/${phase.travail}`).not.toBe('')
      } else {
        expect(issue.raison, `${phase.analyse}/${phase.travail}`).not.toBe('')
      }
    }
  })

  it('propose la reprise quand une exécution est morte', () => {
    // La seule impasse réelle de l'interface : `progression()` lit une `Map` du
    // processus Next, et un redémarrage du serveur perd l'exécution sans laisser
    // d'erreur.
    const issue = suite({ analyse: 'interrompu', travail: 'rien' }, projet)
    expect(issue).toEqual({ kind: 'action', libelle: expect.any(String), cible: '/projects/p1' })
  })

  it('propose la reprise après un échec', () => {
    expect(suite({ analyse: 'echec', travail: 'atrier' }, projet).kind).toBe('action')
  })

  it('attend les propositions tant que le repérage n’a pas rendu', () => {
    expect(suite({ analyse: 'attente', travail: 'rien' }, projet)).toEqual({
      kind: 'attente',
      raison: expect.any(String),
      debloquePar: 'candidates',
    })
  })

  it('attend le proxy quand tout est trié et que le montage ne peut pas s’ouvrir', () => {
    // `{ triable, trie }` est un état réel : Julien a fini de trier avant que le
    // proxy ne soit encodé, et **il n'a aucune action qui fasse avancer le
    // montage**. Forcer une action ici reviendrait à en inventer une.
    expect(suite({ analyse: 'triable', travail: 'trie' }, projet)).toEqual({
      kind: 'attente',
      raison: expect.any(String),
      debloquePar: 'proxy',
    })
  })

  it('mène au tri tant qu’une proposition reste indécise', () => {
    const issue = suite({ analyse: 'complet', travail: 'atrier' }, projet)
    expect(issue).toEqual({ kind: 'action', libelle: expect.any(String), cible: '/projects/p1' })
  })

  it('propose de relancer le repérage sur une liste vide', () => {
    expect(suite({ analyse: 'triable', travail: 'rien' }, projet).kind).toBe('action')
  })

  it('ramène à la bibliothèque quand tout est livré', () => {
    expect(suite({ analyse: 'complet', travail: 'livre' }, projet)).toEqual({
      kind: 'action',
      libelle: expect.any(String),
      cible: '/',
    })
  })

  it('ne fait pas attendre le proxy quand tout est déjà livré', () => {
    // `{ triable, livre }` : le proxy a disparu du disque après coup, mais tous
    // les MP4 sont là. Il n'y a rien à attendre.
    expect(suite({ analyse: 'triable', travail: 'livre' }, projet).kind).toBe('action')
  })
})

describe('clipSuivant', () => {
  function liste(...clips: [string, ClipStatus][]) {
    return clips.map(([id, status]) => ({ id, status }))
  }

  it('rend le prochain clip gardé', () => {
    const clips = liste(['a', 'kept'], ['b', 'discarded'], ['c', 'kept'])
    expect(clipSuivant(clips, 'a')?.id).toBe('c')
  })

  it('compte un clip exporté comme gardé', () => {
    // Rouvrir un clip exporté pour en retoucher le montage est un parcours
    // normal : le sauter ferait sortir de la boucle avant la fin.
    expect(clipSuivant(liste(['a', 'kept'], ['b', 'exported']), 'a')?.id).toBe('b')
  })

  it('ne boucle pas sur le premier depuis le dernier', () => {
    // Le bouton « clip suivant » se désactive sur le dernier : reboucler ferait
    // repasser indéfiniment sur des clips déjà montés sans que rien ne le dise.
    expect(clipSuivant(liste(['a', 'kept'], ['b', 'kept']), 'b')).toBeNull()
  })

  it('rend null sur une liste vide', () => {
    expect(clipSuivant([], 'a')).toBeNull()
  })

  it('rend null quand il n’y a qu’un clip gardé', () => {
    expect(clipSuivant(liste(['a', 'kept']), 'a')).toBeNull()
  })

  it('rend null quand le clip courant n’est pas dans la liste', () => {
    // Une liste rechargée pendant qu'on montait, un identifiant venu d'ailleurs :
    // sans position de départ, il n'y a pas de suivant. Rendre le premier gardé
    // ferait sauter dans la liste sans que le geste l'explique.
    expect(clipSuivant(liste(['a', 'kept'], ['b', 'kept']), 'z')).toBeNull()
  })

  it('part du clip courant même s’il a été écarté depuis', () => {
    const clips = liste(['a', 'kept'], ['b', 'discarded'], ['c', 'kept'])
    expect(clipSuivant(clips, 'b')?.id).toBe('c')
  })

  it('rend l’élément de la liste, pas une copie', () => {
    // Les écrans en lisent le titre et la vignette : rendre un objet réduit
    // obligerait à retrouver l'entrée d'origine derrière.
    const clips = [
      { id: 'a', status: 'kept' as ClipStatus, title: 'Un' },
      { id: 'b', status: 'kept' as ClipStatus, title: 'Deux' },
    ]
    expect(clipSuivant(clips, 'a')).toBe(clips[1])
  })
})
