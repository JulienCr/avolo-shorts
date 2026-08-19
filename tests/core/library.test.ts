import { describe, expect, it } from 'vitest'

import {
  buildLibrary,
  countsByFilter,
  filterEntries,
  matchesFilter,
  normalizeForSearch,
  showState,
  withoutExtension,
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
    stopped: false,
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

  it('dit « analyse » dès qu’une exécution tourne, même après un arrêt précédent', () => {
    // Le serveur tait déjà `stopped` pendant qu'une exécution tourne ; l'écran
    // ne s'y fie pas et fait le même arbitrage, pour que la règle tienne des
    // deux côtés.
    expect(showState(project({ id: 'a', running: RUNNING, stopped: true }), true)).toBe(
      'analyzing',
    )
  })

  it('dit « echec » au repos quand la dernière exécution a échoué', () => {
    expect(showState(project({ id: 'a', error: 'ffmpeg est tombé' }), true)).toBe('failed')
  })

  it('dit « interrompue » sur ce que le serveur a marqué arrêté', () => {
    // Un arrêt demandé ne laisse ni `running`, ni `error`, ni artefact
    // particulier : `stopped` est le seul chemin, et il couvre aussi l'exécution
    // qu'un redémarrage du serveur a emportée.
    expect(showState(project({ id: 'a', stopped: true }), true)).toBe('interrupted')
  })

  it('ne déduit plus l’interruption de la durée', () => {
    // **La déduction précédente mentait dans les deux sens.** Elle lisait
    // `durationSec === 0` : une analyse arrêtée *après* l'ingestion s'affichait
    // « Analysée » — le cas qu'on vient de provoquer d'un clic, sur la carte
    // qu'on regarde —, et un projet sans durée mais bel et bien terminé aurait
    // dit le contraire.
    expect(showState(project({ id: 'a', durationSec: 0 }), true)).toBe('analyzed')
    expect(showState(project({ id: 'a', durationSec: 5_940, stopped: true }), true)).toBe(
      'interrupted',
    )
  })

  it('dit « analysée » quand le projet est au repos, sans échec ni arrêt', () => {
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
    const names = ['c.mp4', 'a.mp4', 'b.mp4']
    const entries = buildLibrary(names.map((n) => source(n)), [])
    expect(entries.map((e) => e.fileName)).toEqual(names)
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
    // Le titre vient du serveur : sans fichier, l'identifiant est tout ce qui
    // reste, et c'est de lui que `titreProjet` le tire déjà là-bas.
    expect(orphan.title).toBe('perdu')
    expect(orphan.fileName).toBeNull()
    expect(orphan.state).toBe('analyzed')
  })

  it('ne déclare pas orphelin ce qu’on n’a pas pu chercher', () => {
    // **`GET /api/sources` en échec ne prouve rien sur les fichiers.** Les
    // projets restent des entrées — sinon leurs clips et leurs rendus
    // deviendraient inatteignables sur une panne qui ne les concerne pas —,
    // mais aucun n'est orphelin : on n'a pas regardé. (relevé par Copilot)
    const [entry] = buildLibrary([], [project({ id: 'a' })], false)
    expect(entry.replay).toBe('unknown')
    expect(entry.project?.id).toBe('a')

    const [orphan] = buildLibrary([], [project({ id: 'a' })])
    expect(orphan.replay).toBe('missing')
  })

  it('marque « present » un replay que la liste porte', () => {
    const [entry] = buildLibrary([source('a.mp4')], [])
    expect(entry.replay).toBe('present')
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

describe('le titre affiché', () => {
  it('est celui de l’émission, pas le nom du fichier', () => {
    // Dans une bibliothèque d'émissions, `2025-06-15-cqlp.mp4` n'est pas un
    // titre : la date en tête sert à trier un dossier, elle ne se lit pas.
    const [entry] = buildLibrary([source('2025-06-15-cqlp.mp4')], [])
    expect(entry.title).toBe('cqlp — 15 juin 2025')
    expect(entry.fileName).toBe('2025-06-15-cqlp.mp4')
  })

  it('ne change pas au moment où l’émission est analysée', () => {
    // **C'est la propriété qui autorise ce titre.** `titreProjet` est une
    // fonction pure de l'identifiant, et l'identifiant est le nom de fichier
    // sans son extension : la même chaîne entre, la même sort. Un titre qui
    // basculerait au lancement de l'analyse aurait été une raison de garder le
    // nom de fichier.
    const name = '2025-06-15-cqlp.mp4'
    const [before] = buildLibrary([source(name)], [])
    const [during] = buildLibrary(
      [source(name, 'cqlp')],
      [project({ id: 'cqlp', running: RUNNING })],
    )
    const [after] = buildLibrary([source(name, 'cqlp')], [project({ id: 'cqlp' })])
    expect(during.title).toBe(before.title)
    expect(after.title).toBe(before.title)
  })

  it('rend lisible un nom qui ne suit aucune convention', () => {
    // La spec §12 l'exige : un nom qui ne suit pas la convention ressort tel
    // quel plutôt que d'être deviné. Le renommage d'une bibliothèque entière en
    // charabia est précisément ce qu'elle interdit.
    for (const [name, expected] of [
      ['randrom.mp4', 'randrom'],
      ['22026-04-26-baba-jeu.mp4', '22026-04-26-baba-jeu'],
      ['2026--faq.mp4', '2026--faq'],
      ['2026-02-31-impossible.mp4', '2026-02-31-impossible'],
    ] as const) {
      const [entry] = buildLibrary([source(name)], [])
      expect(entry.title).toBe(expected)
    }
  })
})

describe('withoutExtension', () => {
  it('retire la dernière extension, et elle seule', () => {
    expect(withoutExtension('2025-06-15-cqlp.mp4')).toBe('2025-06-15-cqlp')
    expect(withoutExtension('deux.points.mp4')).toBe('deux.points')
  })

  it('rend le nom entier quand il n’a pas d’extension', () => {
    expect(withoutExtension('sans-extension')).toBe('sans-extension')
  })

  it('ne prend pas un point de tête pour une extension', () => {
    // C'est la règle de `path.extname`, que `projectIdFromSource` suit côté
    // serveur : `.env` n'a pas d'extension.
    expect(withoutExtension('.env')).toBe('.env')
  })

  it('ne rend jamais une chaîne vide', () => {
    // Le `|| nom` de l'original : un identifiant vide ne nommerait aucun projet.
    expect(withoutExtension('.')).toBe('.')
    expect(withoutExtension('')).toBe('')
  })
})

describe('les filtres', () => {
  const exclusive = [
    ['new', 'toAnalyze'],
    ['analyzing', 'running'],
    ['analyzed', 'analyzed'],
  ] as const

  for (const [state, filter] of exclusive) {
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

  it('mord sur le titre affiché, date remise en français comprise', () => {
    // `2025-06-15-cqlp.mp4` s'affiche « cqlp — 15 juin 2025 » : chercher « juin »
    // doit trouver ce que l'écran montre, sans quoi la recherche porterait sur
    // une chaîne que personne ne voit.
    const entries = buildLibrary([source('2025-06-15-cqlp.mp4'), source('autre.mp4')], [])
    expect(filterEntries(entries, 'all', 'juin').map((e) => e.fileName)).toEqual([
      '2025-06-15-cqlp.mp4',
    ])
  })

  it('mord aussi sur le nom de fichier, qui est affiché à côté', () => {
    // Quelqu'un qui a le nom sous les yeux dans son explorateur doit pouvoir le
    // taper. « 2025-06 » n'apparaît nulle part dans « cqlp — 15 juin 2025 ».
    const entries = buildLibrary([source('2025-06-15-cqlp.mp4'), source('autre.mp4')], [])
    expect(filterEntries(entries, 'all', '2025-06').map((e) => e.fileName)).toEqual([
      '2025-06-15-cqlp.mp4',
    ])
    expect(filterEntries(entries, 'all', '.mp4')).toHaveLength(2)
  })

  it('ne cherche pas dans le nom de fichier d’une entrée qui n’en a plus', () => {
    const entries = buildLibrary([], [project({ id: 'perdu', title: 'perdu' })])
    expect(filterEntries(entries, 'all', 'perdu')).toHaveLength(1)
    expect(filterEntries(entries, 'all', '.mp4')).toHaveLength(0)
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
