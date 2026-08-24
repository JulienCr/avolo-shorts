// @vitest-environment jsdom

/**
 * L'écran des paramètres : les cinq réglages du repérage, leur estimation, et la
 * section du hook, qui écrit ses onze champs comme les autres réglages.
 *
 * **Ce qu'un écran de réglages rate le plus souvent**, et que ces tests tiennent :
 * afficher le nom technique d'une clé, écrire à chaque frappe, et ne rien dire
 * quand le serveur refuse une valeur.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsScreen } from '@/components/settings/settings-screen'
import { DEFAULT_SELECTION_DIMENSIONS } from '@/core/transcript'
import { HOOK_BOUNDS, HOOK_DEFAULTS } from '@/lib/api'
import type { Settings } from '@/lib/api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
  } as Response
}

/**
 * Les défauts de la famille `ai`, recopiés de `db.ts` (`AI_FIELDS`) : ce test
 * ne les importe pas du serveur pour rester montable sous jsdom sans charger
 * `better-sqlite3`, comme le reste de cet écran.
 */
const AI_DEFAULTS: Settings['ai'] = {
  selectionProvider: 'gemini',
  selectionModel: 'gemini-3.1-flash-lite',
  correctionProvider: 'gemini',
  correctionModel: 'gemini-3.1-flash-lite',
  hookProvider: 'gemini',
  hookModel: 'gemini-3.1-flash-lite',
  ollamaBaseUrl: '',
}

/** Le défaut de la famille `ingestion`, recopié de `db.ts` pour la même raison. */
const INGESTION_DEFAULTS: Settings['ingestion'] = { copySourceLocally: true }

/** Le défaut de la famille `publication`, recopié de `db.ts` pour la même raison. */
const PUBLICATION_DEFAULTS: Settings['publication'] = {
  instagram: 'auto',
  facebook: 'auto',
  tiktok: 'auto',
  youtube: 'auto',
}

const DEFAULTS: Settings = {
  selection: { ...DEFAULT_SELECTION_DIMENSIONS },
  ai: { ...AI_DEFAULTS },
  ingestion: { ...INGESTION_DEFAULTS },
  hook: { ...HOOK_DEFAULTS },
  publication: { ...PUBLICATION_DEFAULTS },
}

/** Un serveur réduit à `/api/settings`, et la liste des corps qu'il a reçus. */
function server(options: { read?: () => Response; write?: () => Response } = {}) {
  const writes: unknown[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== '/api/settings') throw new Error(`Route inattendue : ${url}`)
    if (init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)))
      return (options.write ?? (() => response(DEFAULTS)))()
    }
    return (options.read ?? (() => response(DEFAULTS)))()
  })
  vi.stubGlobal('fetch', fetchMock)
  return writes
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return Wrapper
}

async function mountScreen() {
  const Wrapper = wrapper()
  const view = render(
    <Wrapper>
      <SettingsScreen />
    </Wrapper>,
  )
  await waitFor(() => expect(screen.getByLabelText(/tranche de/i)).toBeTruthy())
  return view
}

describe('les réglages du repérage', () => {
  it('nomme les réglages en français, jamais par leur clé', async () => {
    // Un écran qui afficherait `windowsPerClip: 2` demanderait d'aller lire le
    // code pour savoir s'il faut monter ou descendre.
    server()
    await mountScreen()

    expect(document.body.textContent).not.toMatch(/windowsPerClip|minimumClips|minutesPerClip/)
    expect(screen.getByLabelText(/Fenêtres examinées par proposition/)).toBeTruthy()
  })

  it('explique chaque réglage à côté de sa boîte', async () => {
    server()
    await mountScreen()
    const field = screen.getByLabelText(/tranche de/i)
    const help = field.getAttribute('aria-describedby')
    expect(help).toBeTruthy()
    expect(document.getElementById(help!)?.textContent).toMatch(/parole/i)
  })

  it('affiche les valeurs du serveur, pas les constantes du code', async () => {
    // `lireRéglages` rend les réglages **effectifs** : la base complétée par les
    // défauts. Afficher les constantes ferait voir le défaut du code là où la
    // base porte autre chose, et personne ne verrait la différence avant le
    // premier repérage.
    server({ read: () => response({ selection: { ...DEFAULT_SELECTION_DIMENSIONS, minutesPerClip: 9 }, ai: AI_DEFAULTS, ingestion: INGESTION_DEFAULTS, publication: PUBLICATION_DEFAULTS }) })
    await mountScreen()
    expect(screen.getByLabelText(/tranche de/i)).toHaveProperty('value', '9')
  })

  it('n’écrit qu’en quittant le field, jamais à chaque frappe', async () => {
    // Un « 4 » tapé pour faire « 45 » passerait sinon par une valeur écrite,
    // envoyée et appliquée — et une boîte vidée pour être réécrite enverrait un
    // zéro.
    const writes = server()
    await mountScreen()

    const field = screen.getByLabelText(/tranche de/i)
    await userEvent.clear(field)
    await userEvent.type(field, '12')
    expect(writes).toEqual([])

    await userEvent.tab()
    await waitFor(() => expect(writes).toEqual([{ selection: { minutesPerClip: 12 } }]))
  })

  it('n’envoie que le champ touché', async () => {
    const writes = server()
    await mountScreen()

    const field = screen.getByLabelText(/Fenêtres examinées au minimum/)
    await userEvent.clear(field)
    await userEvent.type(field, '20')
    await userEvent.tab()

    await waitFor(() => expect(writes).toEqual([{ selection: { minimumWindows: 20 } }]))
  })

  it('ne prend pas une boîte vide pour un zéro', async () => {
    // **`Number('')` vaut `0`, un nombre fini.** Effacer un champ puis en sortir
    // enregistrait donc son minimum en silence — et sur « Propositions demandées
    // au maximum », dont le plancher est zéro, ça activait « illimité » sans que
    // personne ne l'ait demandé. (relevé par Copilot)
    const writes = server()
    await mountScreen()

    const max = screen.getByLabelText(/Propositions demandées au maximum/)
    await userEvent.clear(max)
    await userEvent.tab()

    expect(writes).toEqual([])
    expect(max).toHaveProperty('value', String(DEFAULTS.selection.maximumClips))
  })

  it('ne laisse pas un refus du bouton « Revenir à » partir en rejet nu', async () => {
    // Le gestionnaire du bouton appelait `onChange` sans rien faire de la
    // promesse : un refus produisait un rejet non géré en plus du bandeau.
    // (relevé par Copilot)
    const rejections: unknown[] = []
    const onRejection = (e: PromiseRejectionEvent) => {
      e.preventDefault()
      rejections.push(e.reason)
    }
    window.addEventListener('unhandledrejection', onRejection)
    try {
      server({
        read: () => response({ selection: { ...DEFAULT_SELECTION_DIMENSIONS, minutesPerClip: 9 }, ai: AI_DEFAULTS, ingestion: INGESTION_DEFAULTS, publication: PUBLICATION_DEFAULTS }),
        write: () => response({ error: 'refusé' }, 400),
      })
      await mountScreen()

      await userEvent.click(screen.getByRole('button', { name: /Revenir à/ }))
      await waitFor(() => expect(screen.getByText('refusé')).toBeTruthy())
      await new Promise((r) => setTimeout(r, 0))
      expect(rejections).toEqual([])
    } finally {
      window.removeEventListener('unhandledrejection', onRejection)
    }
  })

  it('n’écrit rien quand la valeur validée est déjà celle qui s’applique', async () => {
    const writes = server()
    await mountScreen()

    await userEvent.click(screen.getByLabelText(/tranche de/i))
    await userEvent.tab()
    expect(writes).toEqual([])
  })

  it('propose de revenir au défaut, et seulement quand il y a de quoi', async () => {
    const writes = server({
      read: () => response({ selection: { ...DEFAULT_SELECTION_DIMENSIONS, minutesPerClip: 9 }, ai: AI_DEFAULTS, ingestion: INGESTION_DEFAULTS, publication: PUBLICATION_DEFAULTS }),
    })
    await mountScreen()

    // Un seul réglage s'écarte du défaut, donc un seul bouton de retour.
    const resets = screen.getAllByRole('button', { name: /Revenir à/ })
    expect(resets).toHaveLength(1)
    expect(resets[0].textContent).toContain(String(DEFAULT_SELECTION_DIMENSIONS.minutesPerClip))

    await userEvent.click(resets[0])
    await waitFor(() =>
      expect(writes).toEqual([
        { selection: { minutesPerClip: DEFAULT_SELECTION_DIMENSIONS.minutesPerClip } },
      ]),
    )
  })

  it('dit ce que les cinq réglages produisent ensemble', async () => {
    // Cinq nombres qui se règlent séparément ne disent rien de ce qu'ils font
    // ensemble.
    server()
    await mountScreen()
    const estimate = screen.getByTestId('selection-estimate')
    expect(estimate.textContent).toContain('90 min de parole')
    expect(estimate.textContent).toMatch(/clips demandés/)
  })

  it('bouge l’estimation quand un réglage bouge', async () => {
    server({
      write: () => response({ selection: { ...DEFAULT_SELECTION_DIMENSIONS, minutesPerClip: 3 }, ai: AI_DEFAULTS, ingestion: INGESTION_DEFAULTS, publication: PUBLICATION_DEFAULTS }),
    })
    await mountScreen()
    const before = screen.getByTestId('selection-estimate').textContent

    const field = screen.getByLabelText(/tranche de/i)
    await userEvent.clear(field)
    await userEvent.type(field, '3')
    await userEvent.tab()

    await waitFor(() =>
      expect(screen.getByTestId('selection-estimate').textContent).not.toBe(before),
    )
  })
})

describe('les pannes', () => {
  it('dit le refus du serveur plutôt que de laisser le champ revenir tout seul', async () => {
    // Une valeur hors bornes rend un 400, et l'écriture n'est pas optimiste :
    // sans ce mot, le champ reviendrait à sa valeur d'avant et on croirait à un
    // écran qui ne réagit pas.
    server({ write: () => response({ error: 'minutesPerClip doit valoir au moins 1.' }, 400) })
    await mountScreen()

    const field = screen.getByLabelText(/tranche de/i)
    await userEvent.clear(field)
    await userEvent.type(field, '99')
    await userEvent.tab()

    await waitFor(() =>
      expect(screen.getByText('minutesPerClip doit valoir au moins 1.')).toBeTruthy(),
    )
  })

  it('reprend la valeur qui s’applique quand le serveur refuse', async () => {
    // **Le champ ne garde pas ce que le serveur vient de rejeter.** L'écriture
    // n'est pas optimiste : un 400 ne touche pas au cache, donc `value` ne bouge
    // pas et le recalage sur `value` seul ne se déclenchait jamais — le bandeau
    // disait « pas enregistré » pendant que la boîte affichait toujours le
    // nombre refusé. (relevé par Copilot)
    server({ write: () => response({ error: 'minutesPerClip doit valoir au moins 1.' }, 400) })
    await mountScreen()

    const field = screen.getByLabelText(/tranche de/i)
    await userEvent.clear(field)
    await userEvent.type(field, '99')
    await userEvent.tab()

    await waitFor(() => expect(screen.getByText(/au moins 1/)).toBeTruthy())
    expect(field).toHaveProperty('value', String(DEFAULT_SELECTION_DIMENSIONS.minutesPerClip))
  })

  it('reprend la valeur à chaque refus, y compris au second d’affilée', async () => {
    // Deux refus de suite portent le même message : c'est le compte des refus,
    // et non le fait qu'il y en ait eu un, qui distingue le second du premier.
    server({ write: () => response({ error: 'hors bornes' }, 400) })
    await mountScreen()

    const field = screen.getByLabelText(/tranche de/i)
    for (const typed of ['99', '98']) {
      await userEvent.clear(field)
      await userEvent.type(field, typed)
      await userEvent.tab()
      await waitFor(() =>
        expect(field).toHaveProperty('value', String(DEFAULT_SELECTION_DIMENSIONS.minutesPerClip)),
      )
    }
  })

  it('n’affiche aucune valeur tant que les réglages ne se chargent pas', async () => {
    // Poser les défauts en attendant ferait voir les constantes du code, et le
    // premier geste écrirait une valeur que personne n'a choisie.
    server({ read: () => response({ error: 'La base ne répond pas.' }, 500) })
    const Wrapper = wrapper()
    render(
      <Wrapper>
        <SettingsScreen />
      </Wrapper>,
    )

    await waitFor(() => expect(screen.getByText('La base ne répond pas.')).toBeTruthy())
    expect(screen.queryByLabelText(/tranche de/i)).toBeNull()
  })
})

describe('la section du hook', () => {
  /**
   * **Le contrôle d'exhaustivité, et il ferme un piège éprouvé.**
   *
   * `durationMs` a vécu une PR entière en étant réglable en base, surchargeable
   * par l'API et présent dans l'empreinte du rendu — sans aucun contrôle dans
   * l'écran Clip (relevé par Copilot, PR #117). Rien ne l'avait signalé, parce
   * que rien ne le pouvait : une liste de champs ne casse pas au type-check
   * quand elle en oublie un. `CLAUDE.md` demande alors la question qui suit un
   * défaut de forme — « quels autres champs ont cette forme » —, et l'écran des
   * réglages globaux avait la même faiblesse, sans même une liste.
   *
   * Ce test parcourt le registre lui-même : un réglage de la famille `hook`
   * ajouté à `HookSettings` sans contrôle ici fait tomber la suite, au lieu de
   * disparaître en silence. Le libellé attendu est déclaré à côté, ce qui rend
   * l'oubli impossible à commettre en deux temps.
   */
  const HOOK_LABELS: Record<keyof typeof HOOK_DEFAULTS, string> = {
    enabled: 'Hook activé par défaut',
    durationMs: 'Durée',
    font: 'Police',
    sizePermille: 'Taille',
    cornerRadiusPermille: 'Rayon des coins',
    uppercase: 'Capitales',
    position: 'Position',
    alignment: 'Alignement',
    textColor: 'Couleur du texte',
    backgroundColor: 'Couleur du fond',
    backgroundOpacity: 'Opacité du fond',
    enter: 'Effet d’apparition',
    exit: 'Effet de disparition',
    badgeColor: 'Badge — texte',
    badgeBackground: 'Badge — fond',
  }

  it('offre un contrôle pour CHAQUE réglage de la famille hook, sans exception', async () => {
    server()
    await mountScreen()

    // **Scopé à la section du hook**, pas à l'écran entier : « Durée » et
    // « Taille » existent aussi ailleurs, et une recherche globale les y
    // trouverait — le test passerait alors sur un contrôle qui n'est pas
    // celui-là.
    const section = within(screen.getByRole('region', { name: /hook/i }))
    for (const [field, label] of Object.entries(HOOK_LABELS)) {
      // `queryAll`, pas `query` : la bascule « Hook activé par défaut » porte
      // son libellé sur deux nœuds. Ce test compte les absences, pas les
      // doublons.
      expect(
        section.queryAllByLabelText(label).length,
        `réglage sans contrôle : ${field}`,
      ).toBeGreaterThan(0)
    }
  })

  it('affiche les valeurs de la base, jamais les constantes du code', async () => {
    // Servir `sizePermille: 150` dans la fixture : l'écran doit montrer 150,
    // pas le défaut du code (90). Afficher une constante ferait croire à une
    // valeur enregistrée là où la base porte autre chose.
    server({
      read: () => response({ ...DEFAULTS, hook: { ...HOOK_DEFAULTS, sizePermille: 150 } }),
    })
    await mountScreen()

    expect(screen.getByLabelText('Taille')).toHaveProperty('value', '150')
  })

  it('ouvre les quatre transitions du premier lot, deux d’entre elles inertes', async () => {
    // La liste **s'ouvre** désormais — la fermer était l'effet de bord d'un
    // stockage qui n'existait pas encore, pas une règle en soi.
    server()
    await mountScreen()

    const trigger = screen.getByLabelText('Effet d’apparition')
    // **« Aucune », parce que c'est le défaut depuis le 20 août 2026** : un
    // fondu d'entrée laisse le hook à opacité nulle sur la première image,
    // dont Instagram fait la vignette du fil (voir `HOOK_DEFAULTS`).
    expect(trigger.textContent).toContain('Aucune')
    // Le libellé, pas la valeur brute : l'écran dit « Fondu », pas « fade ».
    // Vérifié sur la disparition, qui garde ce défaut — la sortie ne se joue
    // sur aucune vignette.
    expect(screen.getByLabelText('Effet de disparition').textContent).toContain('Fondu')

    await userEvent.click(trigger)
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(4)

    const glitch = options.find((o) => o.textContent?.includes('Glitch'))
    const scanline = options.find((o) => o.textContent?.includes('Scanline'))
    expect(glitch?.getAttribute('aria-disabled')).toBe('true')
    expect(scanline?.getAttribute('aria-disabled')).toBe('true')
  })

  it('enregistre un choix de position', async () => {
    const writes = server()
    await mountScreen()

    await userEvent.click(screen.getByLabelText('Position'))
    await userEvent.click(await screen.findByRole('option', { name: /Tiers inférieur/ }))

    await waitFor(() => expect(writes).toEqual([{ hook: { position: 'bottom' } }]))
  })

  it('convertit les secondes saisies en millisecondes à l’écriture', async () => {
    // `durationMs` est ce qui se stocke ; le champ affiche des secondes. La
    // conversion vit dans `DurationField` et n'était couverte par aucun test
    // de composant. (relevé par Copilot)
    const writes = server()
    await mountScreen()

    const field = screen.getByLabelText('Durée')
    await userEvent.clear(field)
    await userEvent.type(field, '2.5')
    await userEvent.tab()

    await waitFor(() => expect(writes).toEqual([{ hook: { durationMs: 2500 } }]))
  })

  it('borne la durée saisie aux limites du registre avant de l’envoyer', async () => {
    const writes = server()
    await mountScreen()

    const field = screen.getByLabelText('Durée')
    await userEvent.clear(field)
    await userEvent.type(field, '99')
    await userEvent.tab()

    await waitFor(() =>
      expect(writes).toEqual([{ hook: { durationMs: HOOK_BOUNDS.durationMs.max } }]),
    )
  })

  it('désactive chaque contrôle lui-même, sans compter sur le fieldset, pendant le chargement', async () => {
    // **`fieldset[disabled]` ne désactive que les contrôles de formulaire
    // natifs.** Mesuré : le déclencheur de `Select` rend un
    // `<button role="combobox">` et tombe sous la règle, la case rend un
    // `<span role="checkbox">` que le `fieldset` ignore complètement. Sans un
    // `disabled` par contrôle, l'inertie de la section dépendait du tag que la
    // primitive choisit de rendre — et un changement de version l'aurait défaite
    // en silence. (relevé par Aristarque)
    //
    // **Ce qui change avec le stockage réel, c'est le moment de l'inertie** :
    // elle ne dure plus toute la vie de l'écran, seulement le temps que
    // `GET /api/settings` réponde. La section reste montée avant cette
    // réponse — contrairement à `SelectionSection`/`AiSection` — donc c'est ce
    // court moment qu'il faut prouver, avant tout `await`.
    server()
    const Wrapper = wrapper()
    render(
      <Wrapper>
        <SettingsScreen />
      </Wrapper>,
    )

    expect(screen.getByLabelText('Effet d’apparition')).toHaveProperty('disabled', true)
    const box = screen.getAllByLabelText('Hook activé par défaut')[0]
    expect(box.getAttribute('aria-disabled')).toBe('true')

    await waitFor(() => expect(screen.getByLabelText(/tranche de/i)).toBeTruthy())
  })

  it('ouvre la liste et enregistre le choix, une fois les réglages chargés', async () => {
    // L'inverse du comportement d'avant cette PR : la liste s'ouvre, et le
    // choix part au serveur.
    const writes = server()
    await mountScreen()

    await userEvent.click(screen.getByLabelText('Effet d’apparition'))
    expect(await screen.findByRole('listbox')).toBeTruthy()

    await userEvent.click(await screen.findByRole('option', { name: 'Aucune' }))
    await waitFor(() => expect(writes).toEqual([{ hook: { enter: 'none' } }]))
  })
})

describe('la section publication', () => {
  it('choisit un connecteur pour une plateforme, sans toucher aux autres', async () => {
    const writes = server()
    await mountScreen()

    await userEvent.click(screen.getByLabelText('Instagram'))
    await userEvent.click(await screen.findByRole('option', { name: 'Upload Post' }))

    await waitFor(() => expect(writes).toEqual([{ publication: { instagram: 'upload-post' } }]))
  })

  it('revient à Automatique par plateforme, via le bouton dédié', async () => {
    const writes = server({
      read: () =>
        response({ ...DEFAULTS, publication: { ...PUBLICATION_DEFAULTS, facebook: 'meta' } }),
    })
    await mountScreen()

    await userEvent.click(screen.getByLabelText('Revenir à Automatique pour Facebook'))

    await waitFor(() => expect(writes).toEqual([{ publication: { facebook: 'auto' } }]))
  })
})
