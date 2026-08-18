import { describe, expect, it } from 'vitest'

import {
  buildLibrary,
  countsByFilter,
  filterEntries,
  matchesFilter,
  normalizeForSearch,
  showState,
  type LibraryProject,
  type LibrarySource,
} from '@/core/library'
import type { StepName } from '@/core/graph'

const RUNNING = { step: 'transcript' as StepName, progress: 0.4 }

function source(name: string, projectId: string | null = null): LibrarySource {
  return { name, projectId }
}

function project(partial: Partial<LibraryProject> & { id: string }): LibraryProject {
  return {
    title: partial.id,
    durationSec: 5_940,
    running: null,
    error: null,
    ...partial,
  }
}

describe('showState', () => {
  it('dit « neuve » quand aucun projet n’existe', () => {
    expect(showState(null, false)).toBe('new')
  })

  it('dit « analyse » quand la source annonce un projet que la liste ne porte pas encore', () => {
    // Les deux requêtes ne se rafraîchissent pas ensemble :
    // `marquerSourceAnalysée` inscrit le `projectId` dès la réponse de création,
    // la liste des projets arrive au tour suivant. Retomber sur « neuve »
    // pendant cette fenêtre reproposerait de lancer l'analyse, et le second clic
    // rend un 409.
    expect(showState(null, true)).toBe('analyzing')
  })

  it('dit « analyse » dès qu’une exécution tourne, même après un échec précédent', () => {
    expect(showState(project({ id: 'a', running: RUNNING, error: 'tombé' }), true)).toBe(
      'analyzing',
    )
  })

  it('dit « echec » au repos quand la dernière exécution a échoué', () => {
    expect(showState(project({ id: 'a', error: 'ffmpeg est tombé' }), true)).toBe('failed')
  })

  it('dit « interrompue » quand rien ne tourne et que l’ingestion n’a pas sondé la durée', () => {
    // C'est le redémarrage du serveur pendant l'analyse : `progression()` lit
    // une `Map` du processus, qu'un redémarrage vide sans laisser d'erreur.
    // `durationSec` est la seule trace gratuite qu'il reste.
    expect(showState(project({ id: 'a', durationSec: 0 }), true)).toBe('interrupted')
  })

  it('dit « analysée » quand le projet est au repos et que son ingestion a abouti', () => {
    expect(showState(project({ id: 'a' }), true)).toBe('analyzed')
  })
})

describe('buildLibrary', () => {
  it('rend une seule entrée par replay, jamais deux', () => {
    // Le défaut que cet écran ferme : « Projets » et « Replays » montraient la
    // même émission deux fois.
    const entries = buildLibrary(
      [source('2025-06-15-cqlp.mp4', 'cqlp'), source('2026-03-08-caro.mp4')],
      [project({ id: 'cqlp' })],
    )

    expect(entries.map((e) => e.key)).toEqual(['2025-06-15-cqlp.mp4', '2026-03-08-caro.mp4'])
    expect(entries[0].project?.id).toBe('cqlp')
    expect(entries[0].state).toBe('analyzed')
    expect(entries[1].project).toBeNull()
    expect(entries[1].state).toBe('new')
  })

  it('garde l’ordre des replays tel que le serveur le rend', () => {
    const noms = ['c.mp4', 'a.mp4', 'b.mp4']
    const entries = buildLibrary(noms.map((n) => source(n)), [])
    expect(entries.map((e) => e.title)).toEqual(noms)
  })

  it('donne une carte à un projet dont la source a disparu du Drive', () => {
    // Sans elle, le travail fait dessus — clips gardés, montages, rendus —
    // deviendrait inatteignable depuis l'interface, sans qu'aucun écran ne le
    // signale.
    const entries = buildLibrary([source('a.mp4')], [project({ id: 'perdu', title: 'perdu' })])

    expect(entries).toHaveLength(2)
    const orphan = entries[1]
    expect(orphan.source).toBeNull()
    expect(orphan.key).toBe('perdu')
    expect(orphan.title).toBe('perdu')
    expect(orphan.state).toBe('analyzed')
  })

  it('range les orphelins après les replays, jamais mêlés', () => {
    const entries = buildLibrary(
      [source('b.mp4'), source('a.mp4', 'a')],
      [project({ id: 'orphelin' }), project({ id: 'a' })],
    )
    expect(entries.map((e) => e.source === null)).toEqual([false, false, true])
  })

  it('n’orpheline pas un projet que sa source réclame déjà', () => {
    const entries = buildLibrary([source('a.mp4', 'a')], [project({ id: 'a' })])
    expect(entries).toHaveLength(1)
  })
})

describe('les filtres', () => {
  const exclusifs = [
    ['new', 'toAnalyze'],
    ['analyzing', 'running'],
    ['analyzed', 'analyzed'],
  ] as const

  for (const [state, filter] of exclusifs) {
    it(`« ${filter} » retient exactement « ${state} »`, () => {
      expect(matchesFilter(state, filter)).toBe(true)
      expect(matchesFilter('failed', filter)).toBe(false)
    })
  }

  it('range l’interrompue avec l’échouée sous « Erreurs »', () => {
    // C'est le regroupement du retour d'usage — « analyse interrompue / en
    // erreur » y est un seul état — et les deux appellent le même geste.
    expect(matchesFilter('interrupted', 'errors')).toBe(true)
    expect(matchesFilter('failed', 'errors')).toBe(true)
    expect(matchesFilter('analyzed', 'errors')).toBe(false)
  })

  it('« Tous » ne retire rien', () => {
    for (const state of ['new', 'analyzing', 'interrupted', 'failed', 'analyzed'] as const) {
      expect(matchesFilter(state, 'all')).toBe(true)
    }
  })
})

describe('la recherche', () => {
  it('ignore les accents et la casse', () => {
    // Les noms de replays viennent de titres saisis à la main, et personne ne
    // tape les accents dans une boîte de recherche.
    expect(normalizeForSearch('2026-03-08-CARÓ-MDLM.mp4')).toBe('2026-03-08-caro-mdlm.mp4')
  })

  it('retient les entrées dont le titre contient la requête', () => {
    const entries = buildLibrary(
      [source('2026-22-02-entre-nous.mp4'), source('2025-06-15-cqlp.mp4')],
      [],
    )
    expect(filterEntries(entries, 'all', 'ENTRE').map((e) => e.key)).toEqual([
      '2026-22-02-entre-nous.mp4',
    ])
  })

  it('ne retire rien sur une requête vide ou blanche', () => {
    const entries = buildLibrary([source('a.mp4'), source('b.mp4')], [])
    expect(filterEntries(entries, 'all', '')).toHaveLength(2)
    expect(filterEntries(entries, 'all', '   ')).toHaveLength(2)
  })

  it('se compose avec le filtre', () => {
    const entries = buildLibrary(
      [source('cqlp-a.mp4', 'a'), source('cqlp-b.mp4')],
      [project({ id: 'a', running: RUNNING })],
    )
    expect(filterEntries(entries, 'running', 'cqlp').map((e) => e.key)).toEqual(['cqlp-a.mp4'])
  })
})

describe('countsByFilter', () => {
  it('compte chaque entrée sous « tous » et sous son filtre', () => {
    const entries = buildLibrary(
      [source('a.mp4', 'a'), source('b.mp4', 'b'), source('c.mp4')],
      [project({ id: 'a', running: RUNNING }), project({ id: 'b', error: 'tombé' })],
    )

    expect(countsByFilter(entries)).toEqual({
      all: 3,
      toAnalyze: 1,
      running: 1,
      analyzed: 0,
      errors: 1,
    })
  })

  it('compte sur l’ensemble, sans tenir compte d’une recherche', () => {
    // Ces comptes servent à choisir un filtre : les faire fondre au fil de la
    // frappe ferait dire « Erreurs 0 » là où quelque chose a échoué.
    const entries = buildLibrary([source('a.mp4'), source('b.mp4')], [])
    expect(countsByFilter(entries).all).toBe(2)
    expect(countsByFilter(filterEntries(entries, 'all', 'a')).all).toBe(1)
  })
})
