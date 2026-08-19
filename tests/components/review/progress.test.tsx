// @vitest-environment jsdom

/**
 * Le panneau d'avancement, et l'invariant qui le gouverne.
 *
 * **La phase choisit ce que l'écran met en avant, elle ne retire jamais ce qui
 * existe.** Trois relectures successives ont trouvé trois façons différentes de
 * violer cet invariant, ce qui veut dire que le défaut n'est pas dans une valeur
 * mais dans la manière de s'en servir : d'où une fonction, et un test.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { StepName } from '@/core/graph'
import { phaseProject, type ShowSize } from '@/core/phase'
import { layoutProgress } from '@/components/review/template'
import { AnnouncementDStep, StripProgress, PanelProgress } from '@/components/review/progress'

afterEach(cleanup)

function reading(made: StepName[]): Record<StepName, boolean> {
  const all: StepName[] = ['proxy', 'audio', 'transcript', 'analysis', 'candidates', 'renders']
  return Object.fromEntries(all.map((n) => [n, made.includes(n)])) as Record<StepName, boolean>
}

const inCurrent = { step: 'transcript' as StepName, progress: 0.42 }

describe('dispositionAvancement', () => {
  it('remplace la grille seulement quand la grille serait vide', () => {
    const phase = phaseProject(reading([]), inCurrent, null, [])
    expect(layoutProgress(phase, inCurrent, true)).toBe('panneau')
  })

  it('se replie en bande dès qu’il y a quelque chose à trier', () => {
    // Régime 2 : les candidats sont là, le proxy s'encode encore. Le panneau
    // qui prendrait la page annulerait les six minutes pendant lesquelles on
    // travaille déjà.
    const clips = [{ status: 'candidate' as const }]
    const phase = phaseProject(reading(['candidates']), { step: 'proxy', progress: 0.3 }, null, clips)
    expect(layoutProgress(phase, { step: 'proxy', progress: 0.3 }, false)).toBe('bande')
  })

  it('ne cache pas un tri déjà fait derrière une reprise', () => {
    // `effacerArtefact` retire `candidates.json` **avant** de toucher à la base :
    // pendant un repérage forcé, les clips gardés sont toujours là. Un
    // redémarrage du serveur au milieu donne `{ interrompu, trie }`, et le
    // panneau ne doit pas manger la liste.
    const clips = [{ status: 'kept' as const }]
    const phase = phaseProject(reading(['proxy']), null, null, clips)
    expect(phase).toEqual({ analyse: 'interrompu', travail: 'trie' })
    expect(layoutProgress(phase, null, false)).toBe('rien')
  })

  it('ne montre rien quand tout est là et que rien ne tourne', () => {
    const phase = phaseProject(reading(['candidates', 'proxy']), null, null, [])
    expect(layoutProgress(phase, null, true)).toBe('rien')
  })

  it('prend la page sur l’impasse, pour y poser la reprise', () => {
    // « Aucun artefact, aucune exécution » ne décrit pas un projet neuf mais une
    // exécution morte : c'est `interrompu`, et c'est aujourd'hui sans issue.
    const phase = phaseProject(reading([]), null, null, [])
    expect(phase.analysis).toBe('interrompu')
    expect(layoutProgress(phase, null, true)).toBe('panneau')
  })
})

/** L'émission de référence, 1 h 39, celle de toutes les mesures du dépôt. */
const CQLP: ShowSize = { durationSec: 5_940, sizeBytes: 4_300_000_000, windows: 83 }

describe('PanneauAvancement', () => {
  function mount(
    made: StepName[],
    running: { step: StepName; progress: number } | null = inCurrent,
    error: string | null = null,
    size = CQLP,
  ) {
    return render(
      <PanelProgress
        steps={reading(made)}
        running={running}
        error={error}
        size={size}
        resume={<button type="button">Reprendre l’analyse</button>}
        shutdown={<button type="button">Arrêter l’analyse</button>}
      />,
    )
  }

  it('n’affiche jamais le temps restant', () => {
    // Le coût d'une étape est une mesure ; le restant est une extrapolation à
    // partir de deux points sur une seule émission, et une estimation fausse
    // coûte plus cher qu'une absence d'estimation.
    mount(['audio'])
    expect(document.body.textContent).not.toMatch(/restant|il reste|dans \d+\s*(min|s)/i)
  })

  it('liste les étapes dans l’ordre, en marquant celles qui sont faites', () => {
    mount(['audio'])
    const steps = screen.getAllByRole('listitem').map((e) => e.textContent ?? '')
    expect(steps[0]).toContain('Audio')
    expect(steps[1]).toContain('Transcription')
    expect(steps[2]).toContain('Repérage')
    expect(screen.getByTestId('etape-audio').getAttribute('data-etat')).toBe('faite')
    expect(screen.getByTestId('etape-transcript').getAttribute('data-etat')).toBe('encours')
    expect(screen.getByTestId('etape-proxy').getAttribute('data-etat')).toBe('attendue')
  })

  it('dit l’état de chaque étape autrement que par une icône', () => {
    // L'icône est `aria-hidden`, `data-etat` est un attribut de test et la
    // couleur ne se lit pas : un lecteur d'écran entendait les noms et les coûts
    // sans savoir ce qui est fait, en cours ou attendu. (relevé par Copilot)
    mount(['audio'])
    expect(screen.getByTestId('etape-audio').textContent).toMatch(/terminée/i)
    expect(screen.getByTestId('etape-transcript').textContent).toMatch(/en cours/i)
    expect(screen.getByTestId('etape-proxy').textContent).toMatch(/à venir/i)
  })

  it('n’annonce pas les rendus, qui ne passent jamais par le graphe', () => {
    // Un rendu se demande par clip : le lanceur refuse `renders` comme cible.
    mount(['audio'])
    expect(screen.queryByTestId('etape-renders')).toBeNull()
  })

  it('donne une fourchette, jamais une seconde près, et rien sans mesure', () => {
    // Le proxy coûte 6 min sur cette émission-ci : la fourchette l'encadre à
    // 25 %, soit 5 à 8 min. `analysis` n'a jamais été chronométrée sur une
    // émission entière — une absence se lit mieux qu'un chiffre inventé.
    mount(['audio'])
    expect(screen.getByTestId('etape-proxy').textContent).toMatch(/environ 5–8 min/)
    expect(screen.getByTestId('etape-analysis').textContent).not.toMatch(/environ/)
  })

  it('n’annonce pas la même durée à une capsule qu’à une émission entière', () => {
    // C'est tout l'objet du changement : les cinq coûts étaient mesurés une
    // seule fois, sur 1 h 39, et s'affichaient à l'identique pour vingt minutes.
    mount(['audio'])
    const long = screen.getByTestId('etape-proxy').textContent
    cleanup()

    mount(['audio'], inCurrent, null, { durationSec: 20 * 60, sizeBytes: null, windows: 17 })
    expect(screen.getByTestId('etape-proxy').textContent).not.toBe(long)
  })

  it('parle dès la copie, en suppléant la durée par la taille du fichier', () => {
    // C'est l'état d'un projet créé il y a trois secondes : la durée arrive avec
    // l'ingestion, la taille est connue avant même que la copie commence. Sans
    // elle, le panneau se taisait pendant l'étape la plus longue d'un fichier de
    // 12 Go — la seule qu'on regarde vraiment.
    mount(['audio'], inCurrent, null, {
      durationSec: null,
      sizeBytes: 4_300_000_000,
      windows: null,
    })
    expect(screen.getByTestId('etape-proxy').textContent).toMatch(/environ/)
  })

  it('n’annonce rien quand l’émission n’a livré ni durée ni taille', () => {
    mount(['audio'], inCurrent, null, { durationSec: null, sizeBytes: null, windows: null })
    expect(screen.getByTestId('etape-proxy').textContent).not.toMatch(/environ/)
  })

  it('porte l’arrêt tant qu’une exécution tourne, et jamais avec la reprise', () => {
    // « Arrêter » et non « pause » : rien ne reprend exactement un processus là
    // où il s'est interrompu. Et les deux boutons ne s'adressent pas au même
    // état — les poser côte à côte demanderait de choisir alors que le projet a
    // déjà choisi.
    mount(['audio'])
    expect(screen.getByRole('button', { name: /arrêter/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /reprendre/i })).toBeNull()
  })

  it('met la progression dans un « progressbar », pas dans une région live', () => {
    // L'écran interroge l'état toutes les deux secondes : une région live sur le
    // pourcentage produirait une annonce toutes les deux secondes pendant neuf
    // minutes.
    mount(['audio'])
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(bar.closest('[aria-live]')).toBeNull()
  })

  it('dit ce qui devient possible ensuite, jamais quand', () => {
    mount(['audio'])
    expect(screen.getByTestId('ensuite').textContent).toMatch(/tri/i)
  })

  it('annonce le montage une fois les propositions là', () => {
    mount(['audio', 'transcript', 'candidates'], { step: 'proxy', progress: 0.1 })
    expect(screen.getByTestId('ensuite').textContent).toMatch(/montage|proxy/i)
  })

  it('porte la reprise, et le message du serveur, quand la dernière analyse a échoué', () => {
    mount(['audio'], null, 'ffmpeg a rendu 1')
    expect(screen.getByText('ffmpeg a rendu 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: /reprendre/i })).toBeTruthy()
  })

  it('porte la reprise sur une exécution morte, sans message d’erreur', () => {
    // Le cas qui n'a aujourd'hui aucune issue : rien ne tourne, rien n'a échoué,
    // et il manque une étape.
    mount([], null)
    expect(screen.getByRole('button', { name: /reprendre/i })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ne compte pas le temps depuis le lancement quand il ne l’a pas vu', () => {
    // `ProjectStatus` ne publie pas l'instant du lancement : ce qu'on sait
    // mesurer, c'est le temps depuis qu'on regarde. Le dire autrement serait
    // inventer une donnée.
    mount(['audio'])
    expect(screen.getByTestId('ecoule').textContent).toMatch(/écran/i)
  })
})

describe('AnnonceDÉtape', () => {
  it('n’annonce que l’étape, dans une région polie, sans la progression', () => {
    render(<AnnouncementDStep running={inCurrent} steps={reading(['audio'])} connu />)
    const region = screen.getByTestId('annonce')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent).toContain('Transcription')
    expect(region.textContent).not.toContain('42')
  })

  it('annonce la fin quand toutes les étapes du graphe sont là', () => {
    render(
      <AnnouncementDStep
        running={null}
        steps={reading(['audio', 'transcript', 'candidates', 'proxy', 'analysis'])}
        connu
      />,
    )
    expect(screen.getByTestId('annonce').textContent).toMatch(/terminée/i)
  })

  it('se tait tant que l’état du projet n’a pas répondu', () => {
    // Sinon elle annonce « l'analyse s'est arrêtée » sur le seul fait qu'on ne
    // sait encore rien — et c'est le premier mot qu'entendrait un lecteur
    // d'écran en ouvrant la page.
    render(<AnnouncementDStep running={null} steps={reading([])} connu={false} />)
    expect(screen.getByTestId('annonce').textContent).toBe('')
  })

  it('distingue une analyse arrêtée d’une analyse terminée', () => {
    // `renders` ne passe jamais par le graphe : l'exiger empêcherait toute
    // analyse d'être jamais annoncée comme terminée.
    render(<AnnouncementDStep running={null} steps={reading(['audio'])} connu />)
    expect(screen.getByTestId('annonce').textContent).toMatch(/arrêtée/i)
  })
})

describe('BandeAvancement', () => {
  it('tient l’étape et sa progression, sans région live', () => {
    render(<StripProgress running={inCurrent} />)
    expect(screen.getByText('Transcription')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByRole('progressbar').closest('[aria-live]')).toBeNull()
  })

  it('borne une progression aberrante', () => {
    // La progression vient d'une marque de temps de ffmpeg rapportée à une durée
    // sondée : les deux peuvent se contredire d'un cheveu en fin d'encodage.
    render(<StripProgress running={{ step: 'proxy', progress: 1.4 }} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  })
})
