// @vitest-environment jsdom

/**
 * L'écran de clip, monté pour de vrai.
 *
 * Ce que ces tests regardent, c'est le **raccordement** : la sortie du
 * sous-parcours, le rang dans la boucle, et le geste que la spec §7.1 laissait
 * ouvert. Le détail de chaque pièce est testé à côté, dans son propre fichier.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EcranDeClip } from '@/components/clip/ecran-clip'
import { framing, shot } from '../../fixtures/framing'
import type { CandidateClip, ClipDetail } from '@/lib/api'
import { useEditeur } from '@/store/editor'
import { useLecture } from '@/components/clip/lecture'

Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 })
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 })
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 10_000 })
Element.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
  this.scrollTop = typeof options === 'object' ? (options.top ?? this.scrollTop) : this.scrollTop
}
// jsdom n'a pas de canevas : `getContext` y lève « Not implemented » et
// salirait la sortie de la suite. Le rendre nul est ce qu'un navigateur sans
// contexte 2D ferait, et l'aperçu s'en garde déjà.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
// Ni de lecteur multimédia : `play` et `pause` y lèvent aussi.
vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
  () => ({ height: 40, width: 800, top: 0, left: 0, right: 800, bottom: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
)

/** Le transcript servi avec le clip : le clip va de 100 à 120, le contexte de 0 à 200. */
function detail(id = 'c2', segments = [{ start: 100, end: 120 }]): ClipDetail {
  return {
    framing: framing({ shots: [shot(0, 200, '1:1', 0.5)] }),
    clip: {
      id,
      projectId: 'p1',
      segments,
      ratio: '1:1',
      cropX: 0.5,
      captions: true,
      branding: true,
      title: 'La chute',
      description: 'Une impro',
      status: 'kept',
      pass: 1,
    },
    project: { id: 'p1', title: 'La scène du 15 juin', durationSec: 5940, createdAt: '2026-06-15T10:00:00Z' },
    lines: Array.from({ length: 20 }, (_, l) => ({
      id: `l${l}`,
      start: l * 10,
      end: l * 10 + 5,
      words: Array.from({ length: 5 }, (_, m) => ({
        word: `m${l}-${m}`,
        start: l * 10 + m,
        end: l * 10 + m + 0.5,
      })),
    })),
    proxyUrl: '/api/projects/p1/proxy',
    outputs: { mp4Url: null, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
  }
}

const candidats: CandidateClip[] = (['c1', 'c2', 'c3', 'c4'] as const).map((id, i) => ({
  ...detail(id).clip,
  status: id === 'c3' ? 'discarded' : id === 'c4' ? 'exported' : 'kept',
  preview: '',
  thumbnailUrl: null,
  pass: 1,
  segments: [{ start: i * 100, end: i * 100 + 20 }],
}))

function reponse(corps: unknown): Response {
  return { ok: true, status: 200, statusText: '', json: async () => corps } as Response
}

function stubFetch() {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('/candidates')) return reponse(candidats)
    const id = url.split('/').pop() ?? 'c2'
    return reponse(detail(id))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function monter(id = 'c2', donnees?: ClipDetail) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const enveloppe = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  render(<EcranDeClip detail={donnees ?? detail(id)} />, { wrapper: enveloppe })
  await screen.findByRole('link', { name: 'La scène du 15 juin' })
}

/**
 * Ouvre le tiroir de montage.
 *
 * **Le transcript n'est plus visible en permanence** : le geste courant de cet
 * écran — vérifier, ajuster deux textes, exporter — se fait sans lui, et
 * l'édition fine passe par un tiroir. Tout test qui touche aux mots commence
 * donc par ce geste, qui est aussi celui de l'utilisateur.
 */
async function openEditing() {
  fireEvent.click(screen.getByRole('button', { name: /modifier le montage/i }))
  return screen.findByRole('dialog')
}

/** Une oreille de la bande de temps : la borne d'entrée, ou celle de sortie. */
function handle(edge: 'entrée' | 'sortie') {
  return screen.getByRole('slider', {
    name: edge === 'entrée' ? /borne d’entrée/i : /borne de sortie/i,
  })
}

beforeEach(() => {
  stubFetch()
  useEditeur.setState({ clipId: null })
  useLecture.getState().reinitialiser()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('la boucle de montage', () => {
  it('dit le rang dans les gardés', async () => {
    // C'est ce rang qui dit qu'on est dans une boucle et pas au bout du monde.
    await monter('c2')
    expect(await screen.findByText(/clip 2 sur 3 gardés/i)).toBeTruthy()
  })

  it('interroge la liste des candidats elle-même', async () => {
    // Arriver ici par une URL partagée, un signet ou un rechargement est un
    // parcours que la conception promet de rendre repreneur : le cache est alors
    // vide, et supposer qu'il ne l'est pas laisserait l'écran sans sortie.
    const fetch = stubFetch()
    await monter('c2')
    await screen.findByText(/clip 2 sur 3 gardés/i)
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/candidates'))).toBe(true)
  })

  it('mène au clip suivant à monter', async () => {
    await monter('c2')
    const lien = await screen.findByRole('link', { name: /clip suivant/i })
    expect(lien.getAttribute('href')).toBe('/clips/c4')
  })

  it('désactive « clip suivant » sur le dernier', async () => {
    // Sans intérêt à rendre atteignable : `disabled` suffit, la raison ne se
    // discute pas.
    await monter('c4')
    const bouton = await screen.findByRole('button', { name: /clip suivant/i })
    expect(bouton.hasAttribute('disabled')).toBe(true)
  })
})

describe('le geste courant', () => {
  beforeEach(async () => {
    await monter('c2')
  })

  it('se fait sans ouvrir le transcript', () => {
    // Le fond du changement : vérifier le clip, ajuster deux textes, exporter.
    // Le transcript occupait la moitié de l'écran pour une édition ponctuelle.
    expect(screen.queryByText(/m0-0/)).toBeNull()
    expect(screen.getByLabelText('Titre')).toBeTruthy()
    expect(screen.getByRole('button', { name: /exporter/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /modifier le montage/i })).toBeTruthy()
  })

  it('garde toutes les capacités du transcript derrière une action', async () => {
    // **Ne pas retirer des capacités, ne les afficher que lorsqu'on en a
    // besoin.** Chercher, retirer, poser les bornes, annuler, rétablir.
    await openEditing()
    expect(screen.getByText(/m0-0/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /annuler/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /rétablir/i })).toBeTruthy()
  })

  it('rend le focus au bouton qui a ouvert le tiroir', async () => {
    // §4.4 : une boîte de dialogue piège le focus et le rend à son déclencheur.
    // C'est `SheetTrigger` qui le garantit — un bouton qui basculerait un booléen
    // à côté laisserait le focus au corps du document à la fermeture.
    const bouton = screen.getByRole('button', { name: /modifier le montage/i })
    await openEditing()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(bouton)
  })

  it('laisse les raccourcis vivre dans le tiroir', async () => {
    // **La garde des raccourcis écarte tout modal — sauf celui-ci, qui le
    // déclare.** Sans l'exception, `I`, `O`, `Suppr` et `Ctrl+Z` meurent au
    // moment précis où on les presse : le focus est dans le tiroir, et plus rien
    // ne répond. Le clip va de 100 à 120 ; `I` sur le premier mot du contexte le
    // fait commencer au début du transcript.
    await openEditing()
    const mot = screen.getByText(/m0-0/)
    fireEvent.pointerDown(mot)
    fireEvent.pointerUp(mot)
    fireEvent.keyDown(mot, { key: 'i' })
    expect(useEditeur.getState().historique.present[0].start).toBeCloseTo(0, 5)
  })

  it('dépile Échap : la recherche d’abord, le tiroir ensuite', async () => {
    // **Ce que Base UI fait de `Échap` décide du sort du montage en cours.** Sa
    // boîte de dialogue referme sur cette touche ; si elle referme *avant* que
    // la barre de recherche ait pu se fermer, un geste destiné à quitter la
    // recherche emporte le tiroir. Le refus se pose donc dans `onOpenChange`, sur
    // le motif de l'événement — et ce test est la seule chose qui le tienne, la
    // question ne se tranchant pas à la lecture du source de la primitive.
    // (à vérifier, relevé par Aristarque)
    await openEditing()
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    await screen.findByLabelText('Chercher dans le transcript')

    fireEvent.keyDown(screen.getByLabelText('Chercher dans le transcript'), { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByLabelText('Chercher dans le transcript')).toBeNull(),
    )
    expect(screen.queryByRole('dialog')).not.toBeNull()

    // La recherche fermée, le second Échap ferme le tiroir.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('donne le focus au champ de recherche, pas à la surface', async () => {
    // `initialFocus` du tiroir vise la surface du transcript ; la barre de
    // recherche se focalise à son montage. Sur `Ctrl+F` les deux partent au même
    // instant, et l'ordre décide de qui garde le focus — donc de savoir si la
    // frappe suivante cherche ou déplace le curseur. (à vérifier, relevé par
    // Aristarque)
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    const champ = await screen.findByLabelText('Chercher dans le transcript')
    await waitFor(() => expect(document.activeElement).toBe(champ))
  })

  it('ouvre le tiroir avec la recherche sur Ctrl+F', async () => {
    // Le transcript n'est plus visible en permanence : une barre de recherche
    // ouverte sur une surface fermée ne chercherait nulle part.
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    await screen.findByRole('dialog')
    expect(screen.getByLabelText('Chercher dans le transcript')).toBeTruthy()
  })
})

describe('la fresco des clips', () => {
  // La bande vit de la liste des candidats, qui arrive après le premier rendu :
  // c'est celle-là qu'on attend, pas le fil d'Ariane.
  const strip = () => screen.findByRole('navigation', { name: /clips gardés/i })

  it('montre les gardés et marque celui qu’on monte', async () => {
    // « J'édite le clip 2 sur les 3 gardés de cette émission », d'un regard.
    await monter('c2')
    const fresco = await strip()
    expect(within(fresco).getAllByRole('listitem')).toHaveLength(3)
    expect(within(fresco).getByText(/clip 2 sur 3/)).toBeTruthy()
    expect(within(fresco).getByText('exporté')).toBeTruthy()
  })

  it('change de clip d’un clic, et ne mène pas à celui qu’on monte', async () => {
    // Un lien vers l'écran où l'on est n'est pas une navigation : le clip
    // courant est marqué, pas cliquable.
    await monter('c2')
    const fresco = await strip()
    const liens = within(fresco).getAllByRole('link')
    expect(liens.map((l) => l.getAttribute('href'))).toEqual(['/clips/c1', '/clips/c4'])
  })
})

describe('le mot barré cliqué loin devant', () => {
  it('déplace la borne plutôt que d’ajouter une île', async () => {
    // Spec §7.1 : un mot barré à l'extérieur de l'étendue est une borne, pas un
    // trou. Le remonter veut dire « le clip commence là », pas « ajoute trois
    // dixièmes de seconde à quatre-vingt-dix secondes d'ici ».
    await monter('c2')
    await openEditing()
    const mot = screen.getByText(/m1-0/)
    fireEvent.pointerDown(mot)
    fireEvent.pointerUp(mot)

    const montage = useEditeur.getState().historique.present
    expect(montage.length).toBe(1)
    expect(montage[0].start).toBeCloseTo(10, 5)
    expect(montage[0].end).toBe(120)
  })
})

describe('les raccourcis', () => {
  it('affiche la liste sur `?`', async () => {
    await monter('c2')
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})

describe('les valeurs limites', () => {
  it('désactive « clip précédent » sur le premier', async () => {
    await monter('c1')
    const bouton = await screen.findByRole('button', { name: /clip précédent/i })
    expect(bouton.hasAttribute('disabled')).toBe(true)
  })

  it('dit par où sortir d’un clip dont tous les mots ont été retirés', async () => {
    // Le cas est prévu côté serveur — `étendueOrigine` retombe sur
    // `candidates.json` — et n'avait pas de rendu propre : durée nulle,
    // transcript entièrement barré, et rien qui dise que le transcript reste la
    // façon d'en sortir.
    await monter('c2', detail('c2', []))
    expect(screen.getByText(/il ne reste rien du clip/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /exporter/i }).getAttribute('aria-disabled')).toBe(
      'true',
    )
  })
})

describe('l’enregistrement en échec', () => {
  it('offre de réessayer, plutôt que d’attendre un nouveau geste', async () => {
    // L'écriture différée retient la signature de la tentative ratée et ne la
    // rejoue pas telle quelle — sans quoi elle boucle. Sans ce bouton, il faut
    // deviner qu'un autre geste débloquera la situation.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === 'PATCH') throw new Error('réseau coupé')
        if (String(url).includes('/candidates')) return reponse(candidats)
        return reponse(detail('c2'))
      })
      vi.stubGlobal('fetch', fetch)
      await monter('c2')

      // Un geste : une image de plus à l'entrée, prise sur la bande de temps.
      // Elle passe par le même montage et la même écriture différée que le
      // transcript — c'est ce qui garantit qu'aucun second chemin d'écriture n'a
      // été ouvert.
      fireEvent.keyDown(handle('entrée'), { key: 'ArrowLeft' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(screen.getByText(/échec de l’enregistrement/i)).toBeTruthy()
      const patchsAvant = fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').length
      fireEvent.click(screen.getByRole('button', { name: /réessayer/i }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').length).toBe(
        patchsAvant + 1,
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('le surlignage, dès l’ouverture', () => {
  it('connaît les mots même quand le store porte déjà ce clip', async () => {
    // L'écran remet la lecture à zéro au changement de clip **et** publie les
    // mots du transcript. Dans le mauvais ordre, la remise à zéro efface les
    // mots aussitôt publiés, et plus rien ne se surligne jusqu'à la première
    // coupe — sur l'écran dont c'est une des deux nouveautés.
    // Rouvert : `charger` n'a rien à faire, donc l'écran ne rend qu'une fois et
    // l'ordre des deux effets décide seul de ce qui reste publié.
    await monter('c2')
    await openEditing()
    cleanup()
    await monter('c2')
    await openEditing()
    act(() => useLecture.getState().definirPosition(3.2))
    expect(screen.getByText(/m0-3/).getAttribute('aria-current')).toBe('location')
  })
})

describe('le curseur du clavier et les bornes', () => {
  it('pose la borne sur le mot atteint à la flèche, pas sur le dernier cliqué', async () => {
    // Les flèches déplaçaient le curseur dans la surface sans toucher à la
    // sélection : `I` posait donc la borne sur un mot cliqué trois gestes plus
    // tôt, sans que rien ne le dise. (relevé par Copilot)
    await monter('c2')
    await openEditing()
    const mot = screen.getByText(/m0-0/)
    fireEvent.pointerDown(mot)
    fireEvent.pointerUp(mot)
    mot.focus()
    fireEvent.keyDown(mot, { key: 'ArrowRight' })
    fireEvent.keyDown(document.body, { key: 'i' })

    const montage = useEditeur.getState().historique.present
    expect(montage[0].start).toBeCloseTo(1, 5)
  })
})

describe('l’échec d’une écriture directe', () => {
  it('le dit dans la barre et le renvoie', async () => {
    // Le titre, la description et les marques ne passent pas par
    // `useEnregistrementAuto` : sans ce raccord, la barre affiche « enregistré »
    // sur une écriture que le serveur a refusée. (relevé par Copilot)
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') throw new Error('réseau coupé')
      if (String(url).includes('/candidates')) return reponse(candidats)
      return reponse(detail('c2'))
    })
    vi.stubGlobal('fetch', fetch)
    await monter('c2')

    fireEvent.click(screen.getByRole('checkbox', { name: /marques/i }))
    await screen.findByText(/échec de l’enregistrement/i)

    const avant = fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').length
    fireEvent.click(screen.getByRole('button', { name: /réessayer/i }))
    await waitFor(() =>
      expect(fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').length).toBe(avant + 1),
    )
  })
})

describe('l’export et les écritures qui se chevauchent', () => {
  it('reste bloqué tant qu’une écriture est en vol, même si une plus récente est passée', async () => {
    // `isPending` ne décrit que le dernier appel de l'observateur, que tous les
    // champs partagent : une écriture plus récente qui aboutit le remet à faux
    // alors que la première est encore en vol, et l'export part contre un état
    // que le serveur n'a pas encore. (relevé par Copilot)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let patchs = 0
      const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === 'PATCH') {
          patchs += 1
          // La première n'aboutit jamais ; la seconde, si.
          if (patchs === 1) return new Promise<Response>(() => {})
          return reponse({
            applied: true,
            clip: detail('c2').clip,
            outputs: detail('c2').outputs,
            seq: 2,
          })
        }
        if (String(url).includes('/candidates')) return reponse(candidats)
        return reponse(detail('c2'))
      })
      vi.stubGlobal('fetch', fetch)
      await monter('c2')

      fireEvent.click(screen.getByRole('checkbox', { name: /marques/i }))
      fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Un autre titre' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(patchs).toBe(2)
      expect(
        screen.getByRole('button', { name: /exporter/i }).getAttribute('aria-disabled'),
      ).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('un texte resté non enregistré', () => {
  it('bloque l’export même après une écriture plus récente qui aboutit', async () => {
    // Une écriture de marques qui passe remet `patch.isError` à faux, alors que
    // le titre, lui, n'est toujours pas écrit : l'export produirait un `.txt`
    // portant le texte d'avant pendant que l'écran affiche le nouveau.
    // (relevé par Codex et par Copilot)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let patchs = 0
      const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === 'PATCH') {
          patchs += 1
          if (patchs === 1) throw new Error('réseau coupé')
          return reponse({
            applied: true,
            clip: detail('c2').clip,
            outputs: detail('c2').outputs,
            seq: 2,
          })
        }
        if (String(url).includes('/candidates')) return reponse(candidats)
        return reponse(detail('c2'))
      })
      vi.stubGlobal('fetch', fetch)
      await monter('c2')

      fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Un autre titre' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      fireEvent.click(screen.getByRole('checkbox', { name: /marques/i }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(patchs).toBe(2)
      expect(
        screen.getByRole('button', { name: /exporter/i }).getAttribute('aria-disabled'),
      ).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })
})
