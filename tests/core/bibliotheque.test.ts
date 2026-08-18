import { describe, expect, it } from 'vitest'

import {
  bibliothèque,
  comptesParFiltre,
  filtrer,
  normaliser,
  retenuParFiltre,
  étatDÉmission,
  type Filtre,
  type ProjetLisible,
  type SourceLisible,
} from '@/core/bibliotheque'
import type { StepName } from '@/core/graph'

const EN_COURS = { step: 'transcript' as StepName, progress: 0.4 }

function source(name: string, projectId: string | null = null): SourceLisible {
  return { name, projectId }
}

function projet(partiel: Partial<ProjetLisible> & { id: string }): ProjetLisible {
  return {
    title: partiel.id,
    durationSec: 5_940,
    running: null,
    error: null,
    ...partiel,
  }
}

describe('étatDÉmission', () => {
  it('dit « neuve » quand aucun projet n’existe', () => {
    expect(étatDÉmission(null, false)).toBe('neuve')
  })

  it('dit « analyse » quand la source annonce un projet que la liste ne porte pas encore', () => {
    // Les deux requêtes ne se rafraîchissent pas ensemble :
    // `marquerSourceAnalysée` inscrit le `projectId` dès la réponse de création,
    // la liste des projets arrive au tour suivant. Retomber sur « neuve »
    // pendant cette fenêtre reproposerait de lancer l'analyse, et le second clic
    // rend un 409.
    expect(étatDÉmission(null, true)).toBe('analyse')
  })

  it('dit « analyse » dès qu’une exécution tourne, même après un échec précédent', () => {
    expect(étatDÉmission(projet({ id: 'a', running: EN_COURS, error: 'tombé' }), true)).toBe(
      'analyse',
    )
  })

  it('dit « echec » au repos quand la dernière exécution a échoué', () => {
    expect(étatDÉmission(projet({ id: 'a', error: 'ffmpeg est tombé' }), true)).toBe('echec')
  })

  it('dit « interrompue » quand rien ne tourne et que l’ingestion n’a pas sondé la durée', () => {
    // C'est le redémarrage du serveur pendant l'analyse : `progression()` lit
    // une `Map` du processus, qu'un redémarrage vide sans laisser d'erreur.
    // `durationSec` est la seule trace gratuite qu'il reste.
    expect(étatDÉmission(projet({ id: 'a', durationSec: 0 }), true)).toBe('interrompue')
  })

  it('dit « analysée » quand le projet est au repos et que son ingestion a abouti', () => {
    expect(étatDÉmission(projet({ id: 'a' }), true)).toBe('analysée')
  })
})

describe('bibliothèque', () => {
  it('rend une seule entrée par replay, jamais deux', () => {
    // Le défaut que cet écran ferme : « Projets » et « Replays » montraient la
    // même émission deux fois.
    const entrées = bibliothèque(
      [source('2025-06-15-cqlp.mp4', 'cqlp'), source('2026-03-08-caro.mp4')],
      [projet({ id: 'cqlp' })],
    )

    expect(entrées.map((e) => e.clé)).toEqual(['2025-06-15-cqlp.mp4', '2026-03-08-caro.mp4'])
    expect(entrées[0].projet?.id).toBe('cqlp')
    expect(entrées[0].état).toBe('analysée')
    expect(entrées[1].projet).toBeNull()
    expect(entrées[1].état).toBe('neuve')
  })

  it('garde l’ordre des replays tel que le serveur le rend', () => {
    const noms = ['c.mp4', 'a.mp4', 'b.mp4']
    const entrées = bibliothèque(noms.map((n) => source(n)), [])
    expect(entrées.map((e) => e.titre)).toEqual(noms)
  })

  it('donne une carte à un projet dont la source a disparu du Drive', () => {
    // Sans elle, le travail fait dessus — clips gardés, montages, rendus —
    // deviendrait inatteignable depuis l'interface, sans qu'aucun écran ne le
    // signale.
    const entrées = bibliothèque([source('a.mp4')], [projet({ id: 'perdu', title: 'perdu' })])

    expect(entrées).toHaveLength(2)
    const orpheline = entrées[1]
    expect(orpheline.source).toBeNull()
    expect(orpheline.clé).toBe('perdu')
    expect(orpheline.titre).toBe('perdu')
    expect(orpheline.état).toBe('analysée')
  })

  it('range les orphelins après les replays, jamais mêlés', () => {
    const entrées = bibliothèque(
      [source('b.mp4'), source('a.mp4', 'a')],
      [projet({ id: 'orphelin' }), projet({ id: 'a' })],
    )
    expect(entrées.map((e) => e.source === null)).toEqual([false, false, true])
  })

  it('n’orpheline pas un projet que sa source réclame déjà', () => {
    const entrées = bibliothèque([source('a.mp4', 'a')], [projet({ id: 'a' })])
    expect(entrées).toHaveLength(1)
  })
})

describe('les filtres', () => {
  const états = {
    neuve: 'aanalyser',
    analyse: 'encours',
    analysée: 'analysees',
  } as const

  for (const [état, filtre] of Object.entries(états)) {
    it(`« ${filtre} » retient exactement « ${état} »`, () => {
      expect(retenuParFiltre(état as never, filtre as Filtre)).toBe(true)
      expect(retenuParFiltre('echec', filtre as Filtre)).toBe(false)
    })
  }

  it('range « interrompue » avec « echec » sous « Erreurs »', () => {
    // C'est le regroupement du retour d'usage — « analyse interrompue / en
    // erreur » y est un seul état — et les deux appellent le même geste.
    expect(retenuParFiltre('interrompue', 'erreurs')).toBe(true)
    expect(retenuParFiltre('echec', 'erreurs')).toBe(true)
    expect(retenuParFiltre('analysée', 'erreurs')).toBe(false)
  })

  it('« tous » ne retire rien', () => {
    for (const état of ['neuve', 'analyse', 'interrompue', 'echec', 'analysée'] as const) {
      expect(retenuParFiltre(état, 'tous')).toBe(true)
    }
  })
})

describe('la recherche', () => {
  it('ignore les accents et la casse', () => {
    // Les noms de replays viennent de titres saisis à la main, et personne ne
    // tape les accents dans une boîte de recherche.
    expect(normaliser('2026-03-08-CARÓ-MDLM.mp4')).toBe('2026-03-08-caro-mdlm.mp4')
  })

  it('retient les entrées dont le titre contient la requête', () => {
    const entrées = bibliothèque(
      [source('2026-22-02-entre-nous.mp4'), source('2025-06-15-cqlp.mp4')],
      [],
    )
    expect(filtrer(entrées, 'tous', 'ENTRE').map((e) => e.clé)).toEqual([
      '2026-22-02-entre-nous.mp4',
    ])
  })

  it('ne retire rien sur une requête vide ou blanche', () => {
    const entrées = bibliothèque([source('a.mp4'), source('b.mp4')], [])
    expect(filtrer(entrées, 'tous', '')).toHaveLength(2)
    expect(filtrer(entrées, 'tous', '   ')).toHaveLength(2)
  })

  it('se compose avec le filtre', () => {
    const entrées = bibliothèque(
      [source('cqlp-a.mp4', 'a'), source('cqlp-b.mp4')],
      [projet({ id: 'a', running: EN_COURS })],
    )
    expect(filtrer(entrées, 'encours', 'cqlp').map((e) => e.clé)).toEqual(['cqlp-a.mp4'])
  })
})

describe('comptesParFiltre', () => {
  it('compte chaque entrée sous « tous » et sous son filtre', () => {
    const entrées = bibliothèque(
      [source('a.mp4', 'a'), source('b.mp4', 'b'), source('c.mp4')],
      [projet({ id: 'a', running: EN_COURS }), projet({ id: 'b', error: 'tombé' })],
    )

    expect(comptesParFiltre(entrées)).toEqual({
      tous: 3,
      aanalyser: 1,
      encours: 1,
      analysees: 0,
      erreurs: 1,
    })
  })

  it('compte sur l’ensemble, sans tenir compte d’une recherche', () => {
    // Ces comptes servent à choisir un filtre : les faire fondre au fil de la
    // frappe ferait dire « Erreurs 0 » là où quelque chose a échoué.
    const entrées = bibliothèque([source('a.mp4'), source('b.mp4')], [])
    expect(comptesParFiltre(entrées).tous).toBe(2)
    expect(comptesParFiltre(filtrer(entrées, 'tous', 'a')).tous).toBe(1)
  })
})
