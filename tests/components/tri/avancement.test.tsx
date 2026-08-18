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
import { phaseProjet } from '@/core/parcours'
import { dispositionAvancement } from '@/components/tri/modele'
import { BandeAvancement, PanneauAvancement } from '@/components/tri/avancement'

afterEach(cleanup)

function releve(faites: StepName[]): Record<StepName, boolean> {
  const toutes: StepName[] = ['proxy', 'audio', 'transcript', 'analysis', 'candidates', 'renders']
  return Object.fromEntries(toutes.map((n) => [n, faites.includes(n)])) as Record<StepName, boolean>
}

const enCours = { step: 'transcript' as StepName, progress: 0.42 }

describe('dispositionAvancement', () => {
  it('remplace la grille seulement quand la grille serait vide', () => {
    const phase = phaseProjet(releve([]), enCours, null, [])
    expect(dispositionAvancement(phase, enCours, true)).toBe('panneau')
  })

  it('se replie en bande dès qu’il y a quelque chose à trier', () => {
    // Régime 2 : les candidats sont là, le proxy s'encode encore. Le panneau
    // qui prendrait la page annulerait les six minutes pendant lesquelles on
    // travaille déjà.
    const clips = [{ status: 'candidate' as const }]
    const phase = phaseProjet(releve(['candidates']), { step: 'proxy', progress: 0.3 }, null, clips)
    expect(dispositionAvancement(phase, { step: 'proxy', progress: 0.3 }, false)).toBe('bande')
  })

  it('ne cache pas un tri déjà fait derrière une reprise', () => {
    // `effacerArtefact` retire `candidates.json` **avant** de toucher à la base :
    // pendant un repérage forcé, les clips gardés sont toujours là. Un
    // redémarrage du serveur au milieu donne `{ interrompu, trie }`, et le
    // panneau ne doit pas manger la liste.
    const clips = [{ status: 'kept' as const }]
    const phase = phaseProjet(releve(['proxy']), null, null, clips)
    expect(phase).toEqual({ analyse: 'interrompu', travail: 'trie' })
    expect(dispositionAvancement(phase, null, false)).toBe('rien')
  })

  it('ne montre rien quand tout est là et que rien ne tourne', () => {
    const phase = phaseProjet(releve(['candidates', 'proxy']), null, null, [])
    expect(dispositionAvancement(phase, null, true)).toBe('rien')
  })

  it('prend la page sur l’impasse, pour y poser la reprise', () => {
    // « Aucun artefact, aucune exécution » ne décrit pas un projet neuf mais une
    // exécution morte : c'est `interrompu`, et c'est aujourd'hui sans issue.
    const phase = phaseProjet(releve([]), null, null, [])
    expect(phase.analyse).toBe('interrompu')
    expect(dispositionAvancement(phase, null, true)).toBe('panneau')
  })
})

describe('PanneauAvancement', () => {
  function monter(faites: StepName[], running = enCours, erreur: string | null = null) {
    return render(
      <PanneauAvancement
        steps={releve(faites)}
        running={running}
        erreur={erreur}
        reprise={<button type="button">Reprendre l’analyse</button>}
      />,
    )
  }

  it('n’affiche jamais le temps restant', () => {
    // Le coût d'une étape est une mesure ; le restant est une extrapolation à
    // partir de deux points sur une seule émission, et une estimation fausse
    // coûte plus cher qu'une absence d'estimation.
    monter(['audio'])
    expect(document.body.textContent).not.toMatch(/restant|il reste|dans \d+\s*(min|s)/i)
  })

  it('liste les étapes dans l’ordre, en marquant celles qui sont faites', () => {
    monter(['audio'])
    const etapes = screen.getAllByRole('listitem').map((e) => e.textContent ?? '')
    expect(etapes[0]).toContain('Audio')
    expect(etapes[1]).toContain('Transcription')
    expect(etapes[2]).toContain('Repérage')
    expect(screen.getByTestId('etape-audio').getAttribute('data-etat')).toBe('faite')
    expect(screen.getByTestId('etape-transcript').getAttribute('data-etat')).toBe('encours')
    expect(screen.getByTestId('etape-proxy').getAttribute('data-etat')).toBe('attendue')
  })

  it('n’annonce pas les rendus, qui ne passent jamais par le graphe', () => {
    // Un rendu se demande par clip : le lanceur refuse `renders` comme cible.
    monter(['audio'])
    expect(screen.queryByTestId('etape-renders')).toBeNull()
  })

  it('donne le coût mesuré d’une étape, et rien pour celle qu’on n’a pas mesurée', () => {
    monter(['audio'])
    expect(screen.getByTestId('etape-proxy').textContent).toMatch(/6 min/)
    expect(screen.getByTestId('etape-analysis').textContent).not.toMatch(/min|\bs\b/)
  })

  it('met la progression dans un « progressbar », pas dans une région live', () => {
    // L'écran interroge l'état toutes les deux secondes : une région live sur le
    // pourcentage produirait une annonce toutes les deux secondes pendant neuf
    // minutes.
    monter(['audio'])
    const barre = screen.getByRole('progressbar')
    expect(barre.getAttribute('aria-valuenow')).toBe('42')
    expect(barre.closest('[aria-live]')).toBeNull()
  })

  it('n’annonce à voix haute que l’étape, dans une région polie', () => {
    monter(['audio'])
    const région = screen.getByTestId('annonce')
    expect(région.getAttribute('aria-live')).toBe('polite')
    expect(région.textContent).toContain('Transcription')
    expect(région.textContent).not.toContain('42')
  })

  it('dit ce qui devient possible ensuite, jamais quand', () => {
    monter(['audio'])
    expect(screen.getByTestId('ensuite').textContent).toMatch(/tri/i)
  })

  it('annonce le montage une fois les propositions là', () => {
    monter(['audio', 'transcript', 'candidates'], { step: 'proxy', progress: 0.1 })
    expect(screen.getByTestId('ensuite').textContent).toMatch(/montage|proxy/i)
  })

  it('porte la reprise, et le message du serveur, quand la dernière analyse a échoué', () => {
    monter(['audio'], null, 'ffmpeg a rendu 1')
    expect(screen.getByText('ffmpeg a rendu 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: /reprendre/i })).toBeTruthy()
  })

  it('porte la reprise sur une exécution morte, sans message d’erreur', () => {
    // Le cas qui n'a aujourd'hui aucune issue : rien ne tourne, rien n'a échoué,
    // et il manque une étape.
    monter([], null)
    expect(screen.getByRole('button', { name: /reprendre/i })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ne compte pas le temps depuis le lancement quand il ne l’a pas vu', () => {
    // `ProjectStatus` ne publie pas l'instant du lancement : ce qu'on sait
    // mesurer, c'est le temps depuis qu'on regarde. Le dire autrement serait
    // inventer une donnée.
    monter(['audio'])
    expect(screen.getByTestId('ecoule').textContent).toMatch(/écran/i)
  })
})

describe('BandeAvancement', () => {
  it('tient l’étape et sa progression, sans région live', () => {
    render(<BandeAvancement running={enCours} />)
    expect(screen.getByText('Transcription')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByRole('progressbar').closest('[aria-live]')).toBeNull()
  })

  it('borne une progression aberrante', () => {
    // La progression vient d'une marque de temps de ffmpeg rapportée à une durée
    // sondée : les deux peuvent se contredire d'un cheveu en fin d'encodage.
    render(<BandeAvancement running={{ step: 'proxy', progress: 1.4 }} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  })
})
