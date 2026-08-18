// @vitest-environment jsdom

/**
 * L'écran des paramètres : les cinq réglages du repérage, leur estimation, et la
 * section du hook qui n'écrit rien.
 *
 * **Ce qu'un écran de réglages rate le plus souvent**, et que ces tests tiennent :
 * afficher le nom technique d'une clé, écrire à chaque frappe, et ne rien dire
 * quand le serveur refuse une valeur.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsScreen } from '@/components/settings/settings-screen'
import { DIMENSIONS_PAR_DÉFAUT } from '@/core/transcript'
import type { Réglages } from '@/lib/api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function reponse(corps: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => corps,
  } as Response
}

const PAR_DÉFAUT: Réglages = { selection: { ...DIMENSIONS_PAR_DÉFAUT } }

/** Un serveur réduit à `/api/settings`, et la liste des corps qu'il a reçus. */
function serveur(options: { lecture?: () => Response; écriture?: () => Response } = {}) {
  const écrits: unknown[] = []
  const faux = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== '/api/settings') throw new Error(`Route inattendue : ${url}`)
    if (init?.method === 'PUT') {
      écrits.push(JSON.parse(String(init.body)))
      return (options.écriture ?? (() => reponse(PAR_DÉFAUT)))()
    }
    return (options.lecture ?? (() => reponse(PAR_DÉFAUT)))()
  })
  vi.stubGlobal('fetch', faux)
  return écrits
}

function enveloppe() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  function Enveloppe({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return Enveloppe
}

async function monter() {
  const Enveloppe = enveloppe()
  const vue = render(
    <Enveloppe>
      <SettingsScreen />
    </Enveloppe>,
  )
  await waitFor(() => expect(screen.getByLabelText(/tranche de/i)).toBeTruthy())
  return vue
}

describe('les réglages du repérage', () => {
  it('nomme les réglages en français, jamais par leur clé', async () => {
    // Un écran qui afficherait `fenetresParClip: 2` demanderait d'aller lire le
    // code pour savoir s'il faut monter ou descendre.
    serveur()
    await monter()

    expect(document.body.textContent).not.toMatch(/fenetresParClip|clipsMinimum|minutesParClip/)
    expect(screen.getByLabelText(/Fenêtres examinées par proposition/)).toBeTruthy()
  })

  it('explique chaque réglage à côté de sa boîte', async () => {
    serveur()
    await monter()
    const champ = screen.getByLabelText(/tranche de/i)
    const aide = champ.getAttribute('aria-describedby')
    expect(aide).toBeTruthy()
    expect(document.getElementById(aide!)?.textContent).toMatch(/parole/i)
  })

  it('affiche les valeurs du serveur, pas les constantes du code', async () => {
    // `lireRéglages` rend les réglages **effectifs** : la base complétée par les
    // défauts. Afficher les constantes ferait voir le défaut du code là où la
    // base porte autre chose, et personne ne verrait la différence avant le
    // premier repérage.
    serveur({ lecture: () => reponse({ selection: { ...DIMENSIONS_PAR_DÉFAUT, minutesParClip: 9 } }) })
    await monter()
    expect(screen.getByLabelText(/tranche de/i)).toHaveProperty('value', '9')
  })

  it('n’écrit qu’en quittant le champ, jamais à chaque frappe', async () => {
    // Un « 4 » tapé pour faire « 45 » passerait sinon par une valeur écrite,
    // envoyée et appliquée — et une boîte vidée pour être réécrite enverrait un
    // zéro.
    const écrits = serveur()
    await monter()

    const champ = screen.getByLabelText(/tranche de/i)
    await userEvent.clear(champ)
    await userEvent.type(champ, '12')
    expect(écrits).toEqual([])

    await userEvent.tab()
    await waitFor(() => expect(écrits).toEqual([{ selection: { minutesParClip: 12 } }]))
  })

  it('n’envoie que le champ touché', async () => {
    const écrits = serveur()
    await monter()

    const champ = screen.getByLabelText(/Fenêtres examinées au minimum/)
    await userEvent.clear(champ)
    await userEvent.type(champ, '20')
    await userEvent.tab()

    await waitFor(() => expect(écrits).toEqual([{ selection: { fenetresMinimum: 20 } }]))
  })

  it('n’écrit rien quand la valeur validée est déjà celle qui s’applique', async () => {
    const écrits = serveur()
    await monter()

    await userEvent.click(screen.getByLabelText(/tranche de/i))
    await userEvent.tab()
    expect(écrits).toEqual([])
  })

  it('propose de revenir au défaut, et seulement quand il y a de quoi', async () => {
    const écrits = serveur({
      lecture: () => reponse({ selection: { ...DIMENSIONS_PAR_DÉFAUT, minutesParClip: 9 } }),
    })
    await monter()

    // Un seul réglage s'écarte du défaut, donc un seul bouton de retour.
    const retours = screen.getAllByRole('button', { name: /Revenir à/ })
    expect(retours).toHaveLength(1)
    expect(retours[0].textContent).toContain(String(DIMENSIONS_PAR_DÉFAUT.minutesParClip))

    await userEvent.click(retours[0])
    await waitFor(() =>
      expect(écrits).toEqual([
        { selection: { minutesParClip: DIMENSIONS_PAR_DÉFAUT.minutesParClip } },
      ]),
    )
  })

  it('dit ce que les cinq réglages produisent ensemble', async () => {
    // Cinq nombres qui se règlent séparément ne disent rien de ce qu'ils font
    // ensemble.
    serveur()
    await monter()
    const estimation = screen.getByTestId('selection-estimate')
    expect(estimation.textContent).toContain('90 min de parole')
    expect(estimation.textContent).toMatch(/clips demandés/)
  })

  it('bouge l’estimation quand un réglage bouge', async () => {
    serveur({
      écriture: () => reponse({ selection: { ...DIMENSIONS_PAR_DÉFAUT, minutesParClip: 3 } }),
    })
    await monter()
    const avant = screen.getByTestId('selection-estimate').textContent

    const champ = screen.getByLabelText(/tranche de/i)
    await userEvent.clear(champ)
    await userEvent.type(champ, '3')
    await userEvent.tab()

    await waitFor(() =>
      expect(screen.getByTestId('selection-estimate').textContent).not.toBe(avant),
    )
  })
})

describe('les pannes', () => {
  it('dit le refus du serveur plutôt que de laisser le champ revenir tout seul', async () => {
    // Une valeur hors bornes rend un 400, et l'écriture n'est pas optimiste :
    // sans ce mot, le champ reviendrait à sa valeur d'avant et on croirait à un
    // écran qui ne réagit pas.
    serveur({ écriture: () => reponse({ error: 'minutesParClip doit valoir au moins 1.' }, 400) })
    await monter()

    const champ = screen.getByLabelText(/tranche de/i)
    await userEvent.clear(champ)
    await userEvent.type(champ, '99')
    await userEvent.tab()

    await waitFor(() =>
      expect(screen.getByText('minutesParClip doit valoir au moins 1.')).toBeTruthy(),
    )
  })

  it('n’affiche aucune valeur tant que les réglages ne se chargent pas', async () => {
    // Poser les défauts en attendant ferait voir les constantes du code, et le
    // premier geste écrirait une valeur que personne n'a choisie.
    serveur({ lecture: () => reponse({ error: 'La base ne répond pas.' }, 500) })
    const Enveloppe = enveloppe()
    render(
      <Enveloppe>
        <SettingsScreen />
      </Enveloppe>,
    )

    await waitFor(() => expect(screen.getByText('La base ne répond pas.')).toBeTruthy())
    expect(screen.queryByLabelText(/tranche de/i)).toBeNull()
  })
})

describe('la section du hook', () => {
  it('montre la forme retenue et dit qu’elle ne s’enregistre pas', async () => {
    // Inventer une seconde voie d'écriture aurait fait un endroit de plus où le
    // même réglage vit, donc un endroit de plus d'où il diverge.
    serveur()
    await monter()

    expect(screen.getByRole('heading', { name: 'Hook' })).toBeTruthy()
    expect(screen.getByText(/ne s’enregistrent pas encore/)).toBeTruthy()
  })

  it('n’offre que les quatre transitions du premier lot', async () => {
    serveur()
    await monter()

    const apparition = screen.getByLabelText('Effet d’apparition')
    // Le libellé, pas la valeur brute : l'écran dit « Fondu », pas « fade ».
    expect(apparition.textContent).toContain('Fondu')
    expect(document.body.textContent).not.toMatch(/scanline/i)
  })

  it('laisse ses contrôles inertes, sans les sortir de la lecture', async () => {
    // « En lecture seule » et non « absent » : la forme est visible pour la
    // livraison qui branchera le stockage, et aucune écriture n'est ouverte.
    serveur()
    await monter()
    const jeu = document.querySelector('fieldset')
    expect(jeu?.hasAttribute('disabled')).toBe(true)
    expect(jeu?.textContent).toContain('Hook activé par défaut')
  })
})
