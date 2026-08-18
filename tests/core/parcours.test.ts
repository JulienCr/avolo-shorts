import { describe, expect, it } from 'vitest'

import type { ClipStatus } from '@/core/edl'
import type { StepName } from '@/core/graph'
import { compter, phaseProjet, ÉTAPES, LIBELLES_ETAPES } from '@/core/parcours'

/** Un relevé de présence : ce qui n'est pas nommé est absent. */
function releve(...presents: StepName[]): Record<StepName, boolean> {
  const tout: Record<StepName, boolean> = {
    proxy: false,
    audio: false,
    transcript: false,
    analysis: false,
    candidates: false,
    renders: false,
  }
  for (const nom of presents) tout[nom] = true
  return tout
}

const enCours = { step: 'transcript' as StepName, progress: 0.4 }

function clips(...statuts: ClipStatus[]): { status: ClipStatus }[] {
  return statuts.map((status) => ({ status }))
}

describe('phaseProjet, l’axe des artefacts', () => {
  it('attend tant que les candidats manquent et qu’une exécution tourne', () => {
    expect(phaseProjet(releve('audio'), enCours, null, []).analyse).toBe('attente')
  })

  it('dit « interrompu » quand il manque une étape et que rien ne tourne', () => {
    // `progression()` lit une `Map` du processus Next : un redémarrage du
    // serveur perd l'exécution sans laisser d'erreur. C'est la seule impasse
    // réelle de l'interface, et la seule valeur qui appelle une réparation.
    expect(phaseProjet(releve('audio', 'transcript'), null, null, []).analyse).toBe('interrompu')
  })

  it('n’a pas de valeur « neuf » : rien sur le disque et rien qui tourne est interrompu', () => {
    // `créerProjet` appelle `lancer` avant de répondre, et `lancer` pose sa
    // réservation avant son premier `await` : un projet que le client peut voir
    // a toujours quelque chose qui tourne ou quelque chose sur le disque. La
    // forme « aucun artefact, aucune exécution » décrit une exécution morte.
    expect(phaseProjet(releve(), null, null, []).analyse).toBe('interrompu')
  })

  it('dit « echec » quand la dernière exécution a échoué', () => {
    expect(phaseProjet(releve('audio'), null, 'Gemini a refusé le lot', []).analyse).toBe('echec')
  })

  it('préfère l’exécution en cours à l’échec de la précédente', () => {
    // `error` décrit la dernière exécution **terminée**. Une exécution en cours
    // la périme : l'écran doit dire ce qui se passe, l'incident s'affiche à côté.
    expect(phaseProjet(releve('audio'), enCours, 'un échec d’avant', []).analyse).toBe('attente')
  })

  it('devient « triable » dès que les candidats sont là, même sans proxy', () => {
    expect(phaseProjet(releve('candidates'), null, null, []).analyse).toBe('triable')
  })

  it('reste « triable » pendant l’encodage du proxy', () => {
    // Une première version portait une valeur `encours` qui recouvrait
    // `triable` : elle aurait affiché le panneau d'attente sur un écran
    // parfaitement triable, pendant les six minutes du proxy.
    expect(phaseProjet(releve('candidates'), { step: 'proxy', progress: 0.1 }, null, []).analyse).toBe(
      'triable',
    )
  })

  it('reste « triable » quand une exécution s’est interrompue après le repérage', () => {
    // La précondition qui compte : `interrompu` et `echec` ne s'appliquent que
    // tant que `candidates` est absent. Sans elle, une exécution morte pendant
    // l'encodage du proxy cacherait la grille de tri au moment précis où elle
    // doit remplacer le panneau.
    expect(phaseProjet(releve('candidates'), null, null, []).analyse).toBe('triable')
    expect(phaseProjet(releve('candidates'), null, 'le proxy a échoué', []).analyse).toBe('triable')
  })

  it('est « complet » quand les candidats et le proxy sont là', () => {
    expect(phaseProjet(releve('candidates', 'proxy'), null, null, []).analyse).toBe('complet')
  })

  it('ne cite que les deux étapes qui changent ce qu’on peut faire', () => {
    // Ni le transcript ni l'analyse n'ouvrent quoi que ce soit : la liste reste
    // vide jusqu'à la fin du repérage, et le montage attend le proxy.
    const avec = phaseProjet(releve('candidates', 'proxy', 'transcript', 'audio', 'analysis'), null, null, [])
    const sans = phaseProjet(releve('candidates', 'proxy'), null, null, [])
    expect(avec).toEqual(sans)
  })

  it('ignore une étape inconnue dans le relevé', () => {
    // Retirer une étape du graphe suit le même chemin que d'en ajouter une :
    // un relevé qui porte un nom qu'on ne connaît plus ne change pas la phase.
    const inconnue = { ...releve('candidates', 'proxy'), sous_titres: true } as Record<
      StepName,
      boolean
    >
    expect(phaseProjet(inconnue, null, null, [])).toEqual(
      phaseProjet(releve('candidates', 'proxy'), null, null, []),
    )
  })
})

describe('phaseProjet, l’axe du travail humain', () => {
  const complet = releve('candidates', 'proxy')

  it('dit « rien » sur une liste vide', () => {
    // `triable` teste la présence de l'artefact, pas son contenu : un
    // `candidates.json` vide donne `{ triable, rien }`, et c'est l'axe du
    // travail qui porte le vide. C'est la raison d'être des deux axes.
    expect(phaseProjet(releve('candidates'), null, null, [])).toEqual({
      analyse: 'triable',
      travail: 'rien',
    })
  })

  it('dit « atrier » tant qu’une proposition reste indécise', () => {
    expect(phaseProjet(complet, null, null, clips('kept', 'candidate', 'discarded')).travail).toBe(
      'atrier',
    )
  })

  it('préfère « atrier » à « livre » quand un clip gardé est déjà rendu', () => {
    // L'ordre des tests fait partie du contrat : écrites comme des prédicats
    // indépendants, les conditions se recouvrent et `livre` mordrait sur
    // `atrier` dès le premier clip exporté.
    expect(phaseProjet(complet, null, null, clips('exported', 'candidate')).travail).toBe('atrier')
  })

  it('dit « livre » quand tous les gardés sont exportés', () => {
    expect(phaseProjet(complet, null, null, clips('exported', 'exported', 'discarded')).travail).toBe(
      'livre',
    )
  })

  it('n’annonce pas « livre » sur une liste où tout a été écarté', () => {
    // « Tous les clips gardés sont exportés » est vrai d'une liste vide : la
    // phase terminale annonçait un livrable alors qu'aucun MP4 n'existe.
    expect(phaseProjet(complet, null, null, clips('discarded', 'discarded')).travail).toBe('trie')
  })

  it('dit « trie » quand tout est décidé et qu’il reste à monter', () => {
    expect(phaseProjet(complet, null, null, clips('kept', 'discarded')).travail).toBe('trie')
  })

  it('dit « trie » quand un seul des gardés attend encore son rendu', () => {
    expect(phaseProjet(complet, null, null, clips('exported', 'kept')).travail).toBe('trie')
  })

  it('atteint { attente, trie } pendant un repérage forcé', () => {
    // `effacerArtefact` retire `candidates.json` **avant** de toucher à la
    // base : pendant un repérage forcé, les clips gardés sont toujours là et
    // toujours montables. La phase choisit ce que l'écran met en avant, elle ne
    // retire jamais ce qui existe.
    expect(phaseProjet(releve('proxy'), enCours, null, clips('kept', 'discarded'))).toEqual({
      analyse: 'attente',
      travail: 'trie',
    })
  })
})

describe('le tableau des étapes', () => {
  it('donne un libellé à chaque étape du graphe', () => {
    // `LIBELLES_ETAPES` est un `Record<StepName, string>` exhaustif : c'est le
    // type-check qui refuse l'oubli. Ce test-ci n'attrape que la chaîne vide.
    for (const libelle of Object.values(LIBELLES_ETAPES)) {
      expect(libelle).not.toBe('')
    }
  })

  it('décrit toutes les étapes que le lanceur sait fabriquer', () => {
    // `renders` en est exclu — un rendu se demande par clip, jamais par le
    // graphe — mais aucune autre : une étape ajoutée au graphe et oubliée ici
    // n'apparaîtrait dans aucun panneau d'avancement.
    const décrites = ÉTAPES.map((e) => e.nom)
    const attendues = (Object.keys(LIBELLES_ETAPES) as StepName[]).filter((n) => n !== 'renders')
    expect([...décrites].sort()).toEqual([...attendues].sort())
  })

  it('reprend le libellé de la table, sans le recopier', () => {
    for (const étape of ÉTAPES) {
      expect(étape.libelle).toBe(LIBELLES_ETAPES[étape.nom])
    }
  })

  it('place le proxy après le repérage, comme le lanceur l’exécute', () => {
    // `CIBLES_INITIALES = ['candidates', 'proxy']` : les candidats arrivent
    // avant les images, et c'est ce qui rend le régime « triable » possible.
    const ordre = ÉTAPES.map((e) => e.nom)
    expect(ordre.indexOf('candidates')).toBeLessThan(ordre.indexOf('proxy'))
    expect(ordre.indexOf('audio')).toBeLessThan(ordre.indexOf('transcript'))
    expect(ordre.indexOf('transcript')).toBeLessThan(ordre.indexOf('candidates'))
    expect(ordre.indexOf('proxy')).toBeLessThan(ordre.indexOf('analysis'))
  })

  it('laisse le coût à null là où personne n’a mesuré', () => {
    // On affiche le coût d'une étape, jamais le temps qu'il reste — et jamais
    // une estimation à la place d'une mesure.
    expect(ÉTAPES.find((e) => e.nom === 'analysis')?.coûtSec).toBeNull()
    expect(ÉTAPES.find((e) => e.nom === 'proxy')?.coûtSec).toBe(360)
  })
})

describe('compter', () => {
  function candidat(status: ClipStatus, duree: number) {
    return { status, segments: [{ start: 0, end: duree }] }
  }

  it('ne compte rien sur une liste vide', () => {
    expect(compter([])).toEqual({ aTrier: 0, gardes: 0, ecartes: 0, dureeGardee: 0 })
  })

  it('compte un clip exporté comme gardé', () => {
    // `estGarde` porte la définition unique : `exported` est une décision
    // humaine qui a déjà produit un fichier, pas une proposition en attente.
    expect(compter([candidat('exported', 30)]).gardes).toBe(1)
  })

  it('somme la durée des seuls gardés', () => {
    const compte = compter([
      candidat('kept', 30),
      candidat('exported', 12),
      candidat('discarded', 90),
      candidat('candidate', 45),
    ])
    expect(compte).toEqual({ aTrier: 1, gardes: 2, ecartes: 1, dureeGardee: 42 })
  })

  it('rend une durée nulle quand les gardés n’ont plus de segment', () => {
    expect(compter([{ status: 'kept', segments: [] }]).dureeGardee).toBe(0)
  })
})
