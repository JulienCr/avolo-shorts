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

import { framing, shot, splitCells } from '../../fixtures/framing'
import { DUBBING_ANCHORS, dubbingCellsFor } from '@/core/dubbing'
import { defaultPlatformAvailability } from '@/core/publication'
import type { CandidateClip, ClipDetail } from '@/lib/api'
import { useEditor } from '@/store/editor'
import { usePlayback } from '@/components/clip/playback'

// La vue (édition/exports) vit dans l'URL (`clip-view.ts`) : même mock que
// `planning-screen.test.tsx`, une variable de module pour changer la requête
// entre deux rendus.
const replaceMock = vi.fn()
let query = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/clips/c2',
  useSearchParams: () => new URLSearchParams(query),
}))

const { ClipScreen } = await import('@/components/clip/clip-screen')

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
      footer: true,
      title: 'La chute',
      description: 'Une impro',
      status: 'kept',
      pass: 1,
      hookText: '',
      hookBadge: '',
      hookStyle: {},
      framingStyle: {},
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
    outputs: { mp4Url: null, mp4Due: true, variant9x16Url: null, variant9x16Due: true, textsUrl: null },
  }
}

const candidates: CandidateClip[] = (['c1', 'c2', 'c3', 'c4'] as const).map((id, i) => ({
  ...detail(id).clip,
  status: id === 'c3' ? 'discarded' : id === 'c4' ? 'exported' : 'kept',
  preview: '',
  thumbnailUrl: null,
  pass: 1,
  segments: [{ start: i * 100, end: i * 100 + 20 }],
}))

function response(body: unknown): Response {
  return { ok: true, status: 200, statusText: '', json: async () => body } as Response
}

/**
 * `ClipScreen` interroge ces deux routes de publication à chaque montage,
 * indépendamment du clip. `undefined` : l'appelant retombe sur sa propre
 * réponse.
 */
function publicationResponse(url: string): Response | undefined {
  if (url.includes('/publication/availability')) return response(defaultPlatformAvailability())
  if (url.includes('/publications')) return response({ publications: [] })
  return undefined
}

function stubFetch() {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('/candidates')) return response(candidates)
    const publication = publicationResponse(url)
    if (publication !== undefined) return publication
    const id = url.split('/').pop() ?? 'c2'
    return response(detail(id))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function mount(id = 'c2', data?: ClipDetail) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const envelope = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  render(<ClipScreen detail={data ?? detail(id)} />, { wrapper: envelope })
  await screen.findByRole('link', { name: 'La scène du 15 juin' })
}

/**
 * Bascule la bande en mode Mots.
 *
 * **Le transcript n'est plus visible en permanence** : le geste courant de cet
 * écran — vérifier, ajuster deux textes, exporter — se fait sans lui, et
 * l'édition fine passe par le mode Mots. Tout test qui touche aux mots
 * commence donc par ce geste, qui est aussi celui de l'utilisateur.
 */
async function openEditing() {
  fireEvent.click(screen.getByRole('tab', { name: 'Mots' }))
  return screen.findByRole('group', { name: 'Transcript du clip' })
}

/** Une oreille de la bande de temps : la borne d'entrée, ou celle de sortie. */
function handle(edge: 'start' | 'end') {
  return screen.getByRole('slider', {
    name: edge === 'start' ? /borne d’entrée/i : /borne de sortie/i,
  })
}

/**
 * Ouvre « Réglages du rendu ». Les marques et les sous-titres y vivent,
 * repliés par défaut (spec du 23 août, §3.3).
 */
function openRenderSettings() {
  fireEvent.click(screen.getByRole('button', { name: /réglages du rendu/i }))
}

beforeEach(() => {
  stubFetch()
  useEditor.setState({ clipId: null })
  usePlayback.getState().reset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  replaceMock.mockClear()
  query = ''
})

describe('la boucle de montage', () => {
  it('dit le rang dans les gardés', async () => {
    // C'est ce rang qui dit qu'on est dans une boucle et pas au bout du monde.
    await mount('c2')
    expect(await screen.findByText(/clip 2 sur 3 gardés/i)).toBeTruthy()
  })

  it('interroge la liste des candidats elle-même', async () => {
    // Arriver ici par une URL partagée, un signet ou un rechargement est un
    // parcours que la conception promet de rendre repreneur : le cache est alors
    // vide, et supposer qu'il ne l'est pas laisserait l'écran sans sortie.
    const fetch = stubFetch()
    await mount('c2')
    await screen.findByText(/clip 2 sur 3 gardés/i)
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/candidates'))).toBe(true)
  })

  it('mène au clip suivant à monter', async () => {
    await mount('c2')
    const link = await screen.findByRole('link', { name: /clip suivant/i })
    expect(link.getAttribute('href')).toBe('/clips/c4')
  })

  it('désactive « clip suivant » sur le dernier', async () => {
    // Sans intérêt à rendre atteignable : `disabled` suffit, la raison ne se
    // discute pas.
    await mount('c4')
    const button = await screen.findByRole('button', { name: /clip suivant/i })
    expect(button.hasAttribute('disabled')).toBe(true)
  })
})

/**
 * L'aperçu de sortie, dans la zone Sortie — jamais la source, qui est un
 * `<figure>` distinct. `role="figure"` n'apporte pas de nom accessible
 * calculé depuis sa légende dans cet environnement de test (`figcaption` non
 * pris en compte par `dom-accessibility-api` ici) : on distingue les deux
 * figures sur leur contenu plutôt que sur un nom de rôle.
 */
function outputFigure(): HTMLElement {
  const found = screen
    .getAllByRole('figure')
    .find((f) => /variante|fichier natif/.test(f.textContent ?? ''))
  if (!found) throw new Error('figure de sortie introuvable')
  return found
}

// Le cadre du plan se lit désormais dans la légende de la sortie 9:16
// (`output-preview.tsx:353-359`), pas dans le `<dl>` disparu avec l'établi —
// même distinction split/doublage/ratio.
describe('le cadre du plan sous la lecture, splitté', () => {
  it('dit « split » plutôt qu’un ratio et un pourcentage qui n’y correspondent plus', async () => {
    const d = detail()
    d.framing = framing({ shots: [shot(0, 200, '16:9', 0.5, 'auto', splitCells())] })
    await mount('c2', d)
    expect(outputFigure().textContent).toContain('cadre split')
  })
})

describe('le cadre du plan sous la lecture, en doublage', () => {
  it('dit « doublage » plutôt qu’un ratio et un pourcentage que la composition ne suit pas', async () => {
    const d = detail()
    const cells = dubbingCellsFor(DUBBING_ANCHORS[0], DUBBING_ANCHORS[0].pip.y0)
    d.framing = framing({ shots: [shot(0, 200, '4:5', 0.5, 'auto', undefined, cells)] })
    await mount('c2', d)
    const text = outputFigure().textContent ?? ''
    expect(text).toContain('cadre doublage')
    expect(text).not.toContain('4:5')
  })
})

describe('le libellé du cadre, quand le natif est déjà 9:16', () => {
  it('ne dit pas « variante », qui n’existe pas dans ce cas', async () => {
    // Le natif prend alors la place de la sortie verticale : aucune variante
    // n'est produite (`src/server/steps/render.ts`). (relevé par Copilot)
    const d = detail()
    d.framing = framing({ ratio: '9:16', shots: [shot(0, 200, '9:16', 0.5)] })
    // `editor.ratio` part de `clip.ratio` (`charger`) : pour que le natif
    // résolu soit bien 9:16, le client doit aussi laisser le cadrage décider.
    d.clip.ratio = 'auto'
    await mount('c2', d)
    const text = outputFigure().textContent ?? ''
    expect(text).toContain('fichier natif 9:16')
    expect(text).not.toContain('variante')
  })
})

describe('le geste courant', () => {
  beforeEach(async () => {
    await mount('c2')
  })

  it('se fait sans ouvrir le transcript', () => {
    // Le fond du changement : vérifier le clip, ajuster deux textes, exporter.
    // Le transcript occupait la moitié de l'écran pour une édition ponctuelle.
    expect(screen.queryByText(/m0-0/)).toBeNull()
    expect(screen.getByLabelText('Titre')).toBeTruthy()
    expect(screen.getByRole('button', { name: /exporter/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Mots' })).toBeTruthy()
  })

  it('garde toutes les capacités du transcript derrière une action', async () => {
    // **Ne pas retirer des capacités, ne les afficher que lorsqu'on en a
    // besoin.** Chercher, retirer, poser les bornes, annuler, rétablir — ces
    // deux derniers vivent dans la barre d'app, atteignable dans les deux modes.
    await openEditing()
    expect(screen.getByText(/m0-0/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /annuler/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /rétablir/i })).toBeTruthy()
  })

  it('laisse les raccourcis vivre en mode Mots', async () => {
    // Le mode Mots n'est plus un modal à exempter : rien ne fait plus écran
    // entre lui et les raccourcis de la garde. Le clip va de 100 à 120 ; `I`
    // sur le premier mot du contexte le fait commencer au début du transcript.
    await openEditing()
    const word = screen.getByText(/m0-0/)
    fireEvent.pointerDown(word)
    fireEvent.pointerUp(word)
    fireEvent.keyDown(word, { key: 'i' })
    expect(useEditor.getState().history.present[0].start).toBeCloseTo(0, 5)
  })

  it('l’échap referme la recherche, pas le mode Mots', async () => {
    // Sans tiroir modal à refermer, `Échap` n'a plus qu'un niveau à dépiler :
    // la barre de recherche ferme sur sa propre touche (`transcript-surface.tsx`),
    // et le mode reste celui qu'on a choisi.
    await openEditing()
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    await screen.findByLabelText('Chercher dans le transcript')

    fireEvent.keyDown(screen.getByLabelText('Chercher dans le transcript'), { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByLabelText('Chercher dans le transcript')).toBeNull(),
    )
    expect(screen.getByRole('group', { name: 'Transcript du clip' })).toBeTruthy()
  })

  it('donne le focus au champ de recherche sur Ctrl+F', async () => {
    // `SearchBar` se focalise elle-même à son montage
    // (`transcript-surface.tsx`) : rien d'autre ne se dispute le focus une
    // fois qu'il n'y a plus de tiroir modal pour le viser en premier.
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    const field = await screen.findByLabelText('Chercher dans le transcript')
    await waitFor(() => expect(document.activeElement).toBe(field))
  })

  it('ne laisse pas une sélection agissante derrière la porte', async () => {
    // La sélection vit dans le transcript. Le mode Mots quitté, elle n'est
    // visible nulle part — et `Suppr` retirerait pourtant un passage.
    // (relevé par Aristarque, pour l'ancien tiroir modal)
    await openEditing()
    // L'appui suffit à sélectionner : le relâchement sur un mot barré le
    // remonterait, ce qui vide la sélection par un autre chemin.
    fireEvent.pointerDown(screen.getByText(/m0-0/))
    expect(useEditor.getState().selection).not.toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Temps' }))
    await waitFor(() => expect(useEditor.getState().selection).toBeNull())
  })

  it('vide aussi la sélection en quittant Édition par Exports', async () => {
    // Le commutateur Temps/Mots n'est pas le seul chemin de sortie : l'onglet
    // Exports démonte `Timeline` directement, sans passer par lui. (relevé par Copilot)
    await openEditing()
    fireEvent.pointerDown(screen.getByText(/m0-0/))
    expect(useEditor.getState().selection).not.toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Exports' }))
    expect(useEditor.getState().selection).toBeNull()
  })

  it('bascule en mode Mots avec la recherche sur Ctrl+F', async () => {
    // Le transcript n'est plus visible en permanence : une barre de recherche
    // ouverte sur une surface fermée ne chercherait nulle part.
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    await screen.findByRole('group', { name: 'Transcript du clip' })
    expect(screen.getByLabelText('Chercher dans le transcript')).toBeTruthy()
  })
})

describe('la fresco des clips', () => {
  // La bande vit de la liste des candidats, qui arrive après le premier rendu :
  // c'est celle-là qu'on attend, pas le fil d'Ariane.
  const strip = () => screen.findByRole('navigation', { name: /clips gardés/i })

  it('montre les gardés et marque celui qu’on monte', async () => {
    // « J'édite le clip 2 sur les 3 gardés de cette émission », d'un regard.
    await mount('c2')
    const fresco = await strip()
    expect(within(fresco).getAllByRole('listitem')).toHaveLength(3)
    expect(within(fresco).getByText(/clip 2 sur 3/)).toBeTruthy()
    expect(within(fresco).getByText('exporté')).toBeTruthy()
  })

  it('change de clip d’un clic, et ne mène pas à celui qu’on monte', async () => {
    // Un lien vers l'écran où l'on est n'est pas une navigation : le clip
    // courant est marqué, pas cliquable.
    await mount('c2')
    const fresco = await strip()
    const links = within(fresco).getAllByRole('link')
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/clips/c1', '/clips/c4'])
  })
})

describe('les marques', () => {
  it('exposent leur échappatoire dans la zone Image', async () => {
    // Depuis l'issue #37, un clip dont `branding` vaut `true` refuse de se rendre
    // quand aucune marque n'est exploitable, et le message recommande de le
    // passer à `false`. Le contrôle vit avec le ratio et le cadrage : ce qu'il
    // décide est ce que l'image porte. (relevé par Copilot)
    const patches: string[] = []
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') {
        patches.push(String(options.body))
        return response({ applied: true, clip: detail('c2').clip, outputs: detail('c2').outputs, seq: 2 })
      }
      if (String(url).includes('/candidates')) return response(candidates)
      const publication = publicationResponse(String(url))
      if (publication !== undefined) return publication
      return response(detail('c2'))
    })
    vi.stubGlobal('fetch', fetch)
    await mount('c2')

    const zone = screen.getByRole('region', { name: 'Image' })
    fireEvent.click(within(zone).getByRole('button', { name: /réglages du rendu/i }))
    const markers = within(zone).getByRole<HTMLInputElement>('checkbox', { name: /marques/i })
    expect(markers.checked).toBe(true)

    fireEvent.click(markers)
    await waitFor(() => expect(patches.some((body) => body.includes('"branding":false'))).toBe(true))
  })
})

describe('les sous-titres', () => {
  it('décochent et écrivent, symétrique au cas des marques ci-dessus', async () => {
    // Le réglage voisin des marques vérifie déjà l'écriture optimiste/PATCH ;
    // les sous-titres partagent le même mécanisme (`RenderSettings`) et n'en
    // avaient pas le pendant, alors qu'une régression de ce contrôle passerait
    // silencieusement. (relevé par Copilot)
    const patches: string[] = []
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') {
        patches.push(String(options.body))
        return response({ applied: true, clip: detail('c2').clip, outputs: detail('c2').outputs, seq: 2 })
      }
      if (String(url).includes('/candidates')) return response(candidates)
      const publication = publicationResponse(String(url))
      if (publication !== undefined) return publication
      return response(detail('c2'))
    })
    vi.stubGlobal('fetch', fetch)
    await mount('c2')

    const zone = screen.getByRole('region', { name: 'Image' })
    fireEvent.click(within(zone).getByRole('button', { name: /réglages du rendu/i }))
    const captions = within(zone).getByRole<HTMLInputElement>('checkbox', { name: /sous-titres/i })
    expect(captions.checked).toBe(true)

    fireEvent.click(captions)
    await waitFor(() => expect(patches.some((body) => body.includes('"captions":false'))).toBe(true))
  })
})

describe('le mot barré cliqué loin devant', () => {
  it('déplace la borne plutôt que d’ajouter une île', async () => {
    // Spec §7.1 : un mot barré à l'extérieur de l'étendue est une borne, pas un
    // trou. Le remonter veut dire « le clip commence là », pas « ajoute trois
    // dixièmes de seconde à quatre-vingt-dix secondes d'ici ».
    await mount('c2')
    await openEditing()
    const word = screen.getByText(/m1-0/)
    fireEvent.pointerDown(word)
    fireEvent.pointerUp(word)

    const editing = useEditor.getState().history.present
    expect(editing.length).toBe(1)
    expect(editing[0].start).toBeCloseTo(10, 5)
    expect(editing[0].end).toBe(120)
  })
})

describe('les raccourcis', () => {
  it('affiche la liste sur `?`', async () => {
    await mount('c2')
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})

describe('la barre d’app, depuis la refonte du 28 août', () => {
  it('pose les onglets et le primaire dans la barre, plus de rail en pied', async () => {
    await mount('c2')

    const bar = screen.getByRole('banner')
    expect(within(bar).getByRole('tab', { name: 'Édition' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(within(bar).getByRole('tab', { name: 'Exports' })).toBeTruthy()
    expect(within(bar).getByRole('button', { name: 'Exporter' })).toBeTruthy()

    expect(screen.queryByRole('button', { name: 'Détail' })).toBeNull()
  })

  it('n’offre qu’un seul geste terminal', async () => {
    await mount('c2')

    const primaries = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-slot') === 'button' && b.className.includes('bg-primary'))
    expect(primaries).toHaveLength(1)
  })

  it('demande la vue Exports dans l’URL au clic sur l’onglet', async () => {
    await mount('c2')
    fireEvent.click(screen.getByRole('tab', { name: 'Exports' }))
    expect(replaceMock).toHaveBeenCalledWith('/clips/c2?vue=exports', { scroll: false })
  })

  it('rend la vue Exports quand l’URL la demande déjà', async () => {
    query = 'vue=exports'
    await mount('c2')
    expect(await screen.findByRole('heading', { name: 'Livraison courante' })).toBeTruthy()
  })
})

describe('la fiche éditoriale, à côté de la source', () => {
  it('range Titre, Description et Hook dans la région Image', async () => {
    await mount('c2')

    const image = screen.getByRole('region', { name: 'Image' })
    expect(within(image).getByLabelText('Titre')).toBeTruthy()
    expect(within(image).getByLabelText('Description')).toBeTruthy()
    expect(within(image).getByLabelText('Hook')).toBeTruthy()
  })

  it('ne partage plus une classe entre la source et la sortie', async () => {
    await mount('c2')

    const source = screen
      .getAllByRole('figure')
      .find((f) => /la source/i.test(f.textContent ?? ''))
    if (!source) throw new Error('figure de la source introuvable')
    const sortie = outputFigure()
    expect(source.className).not.toBe(sortie.className)
  })
})

describe('les valeurs limites', () => {
  it('désactive « clip précédent » sur le premier', async () => {
    await mount('c1')
    const button = await screen.findByRole('button', { name: /clip précédent/i })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('dit par où sortir d’un clip dont tous les mots ont été retirés', async () => {
    // Le cas est prévu côté serveur — `extentOrigin` retombe sur
    // `candidates.json` — et n'avait pas de rendu propre : durée nulle,
    // transcript entièrement barré, et rien qui dise que le transcript reste la
    // façon d'en sortir.
    await mount('c2', detail('c2', []))
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
        if (String(url).includes('/candidates')) return response(candidates)
        const publication = publicationResponse(String(url))
        if (publication !== undefined) return publication
        return response(detail('c2'))
      })
      vi.stubGlobal('fetch', fetch)
      await mount('c2')

      // Un geste : une image de plus à l'entrée, prise sur la bande de temps.
      // Elle passe par le même montage et la même écriture différée que le
      // transcript — c'est ce qui garantit qu'aucun second chemin d'écriture n'a
      // été ouvert.
      fireEvent.keyDown(handle('start'), { key: 'ArrowLeft' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(screen.getByText(/échec de l’enregistrement/i)).toBeTruthy()
      const patchesBefore = fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').length
      fireEvent.click(screen.getByRole('button', { name: /réessayer/i }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').length).toBe(
        patchesBefore + 1,
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
    await mount('c2')
    await openEditing()
    cleanup()
    await mount('c2')
    await openEditing()
    act(() => usePlayback.getState().definePosition(3.2))
    expect(screen.getByText(/m0-3/).getAttribute('aria-current')).toBe('location')
  })
})

describe('le curseur du clavier et les bornes', () => {
  it('pose la borne sur le mot atteint à la flèche, pas sur le dernier cliqué', async () => {
    // Les flèches déplaçaient le curseur dans la surface sans toucher à la
    // sélection : `I` posait donc la borne sur un mot cliqué trois gestes plus
    // tôt, sans que rien ne le dise. (relevé par Copilot)
    await mount('c2')
    await openEditing()
    const word = screen.getByText(/m0-0/)
    fireEvent.pointerDown(word)
    fireEvent.pointerUp(word)
    word.focus()
    fireEvent.keyDown(word, { key: 'ArrowRight' })
    fireEvent.keyDown(document.body, { key: 'i' })

    const editing = useEditor.getState().history.present
    expect(editing[0].start).toBeCloseTo(1, 5)
  })
})

describe('l’échec d’une écriture directe', () => {
  it('le dit dans la barre et le renvoie', async () => {
    // Le titre, la description et les marques ne passent pas par
    // `useAutosave` : sans ce raccord, la barre affiche « enregistré »
    // sur une écriture que le serveur a refusée. (relevé par Copilot)
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') throw new Error('réseau coupé')
      if (String(url).includes('/candidates')) return response(candidates)
      const publication = publicationResponse(String(url))
      if (publication !== undefined) return publication
      return response(detail('c2'))
    })
    vi.stubGlobal('fetch', fetch)
    await mount('c2')

    openRenderSettings()
    fireEvent.click(screen.getByRole('checkbox', { name: /marques/i }))
    await screen.findByText(/échec de l’enregistrement/i)

    const before = fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').length
    fireEvent.click(screen.getByRole('button', { name: /réessayer/i }))
    await waitFor(() =>
      expect(fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').length).toBe(before + 1),
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
      let patches = 0
      const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === 'PATCH') {
          patches += 1
          // La première n'aboutit jamais ; la seconde, si.
          if (patches === 1) return new Promise<Response>(() => {})
          return response({
            applied: true,
            clip: detail('c2').clip,
            outputs: detail('c2').outputs,
            seq: 2,
          })
        }
        if (String(url).includes('/candidates')) return response(candidates)
        const publication = publicationResponse(String(url))
        if (publication !== undefined) return publication
        return response(detail('c2'))
      })
      vi.stubGlobal('fetch', fetch)
      await mount('c2')

      openRenderSettings()
      fireEvent.click(screen.getByRole('checkbox', { name: /marques/i }))
      fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Un autre titre' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(patches).toBe(2)
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
      let patches = 0
      const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === 'PATCH') {
          patches += 1
          if (patches === 1) throw new Error('réseau coupé')
          return response({
            applied: true,
            clip: detail('c2').clip,
            outputs: detail('c2').outputs,
            seq: 2,
          })
        }
        if (String(url).includes('/candidates')) return response(candidates)
        const publication = publicationResponse(String(url))
        if (publication !== undefined) return publication
        return response(detail('c2'))
      })
      vi.stubGlobal('fetch', fetch)
      await mount('c2')

      fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Un autre titre' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      openRenderSettings()
      fireEvent.click(screen.getByRole('checkbox', { name: /marques/i }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(patches).toBe(2)
      expect(
        screen.getByRole('button', { name: /exporter/i }).getAttribute('aria-disabled'),
      ).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('la confirmation d’écrasement, depuis Exports', () => {
  it('nomme les fichiers qu’elle va écraser, puis envoie force:true', async () => {
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST' && String(url).includes('/export')) {
        return response({ mp4: null, variant9x16: 'c2-9x16.mp4', texts: 'c2.txt', skipped: false })
      }
      if (String(url).includes('/candidates')) return response(candidates)
      const publication = publicationResponse(String(url))
      if (publication !== undefined) return publication
      return response(detail('c2'))
    })
    vi.stubGlobal('fetch', fetch)
    const d = detail('c2')
    d.outputs = {
      mp4Url: null,
      mp4Due: false,
      variant9x16Url: '/api/clips/c2/renders/c2-9x16.mp4',
      variant9x16Due: true,
      textsUrl: '/api/clips/c2/renders/c2.txt',
    }
    query = 'vue=exports'
    await mount('c2', d)

    const forcer = await screen.findByRole('button', { name: /forcer un nouvel export/i })
    fireEvent.click(forcer)

    const box = await screen.findByRole('alertdialog')
    // Le natif est désactivé sur ce ratio (1:1, le défaut de `detail()`) :
    // `c2.mp4` n'est jamais un fichier à écraser.
    expect(box.textContent).not.toContain('c2.mp4')
    expect(box.textContent).toContain('c2-9x16.mp4')
    expect(box.textContent).toContain('c2.txt')
    expect(fetch.mock.calls.some(([, o]) => (o as RequestInit | undefined)?.method === 'POST')).toBe(
      false,
    )

    fireEvent.click(screen.getByRole('button', { name: /écraser/i }))
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, o]) => String(url).includes('/export') && (o as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    )
  })
})

describe('le dialogue de publication, depuis le primaire', () => {
  it('s’ouvre une fois le clip livré', async () => {
    const d = detail('c2')
    d.outputs = {
      mp4Url: null,
      mp4Due: false,
      variant9x16Url: '/api/clips/c2/renders/c2-9x16.mp4',
      variant9x16Due: true,
      textsUrl: '/api/clips/c2/renders/c2.txt',
    }
    await mount('c2', d)

    fireEvent.click(screen.getByRole('button', { name: /^publier$/i }))
    expect(await screen.findByRole('heading', { name: 'Publier « La chute »' })).toBeTruthy()
  })
})

describe('la publication, sans vidéo rendue', () => {
  function outputsTextsOnly() {
    return {
      mp4Url: null,
      mp4Due: true,
      variant9x16Url: null,
      variant9x16Due: true,
      textsUrl: '/api/clips/c2/renders/c2.txt',
    }
  }

  it('n’offre pas « Publier » quand seul le texte existe', async () => {
    const d = detail('c2')
    d.outputs = outputsTextsOnly()
    await mount('c2', d)

    expect(screen.queryByRole('button', { name: /^publier$/i })).toBeNull()
  })

  it('en dit la raison dans Exports', async () => {
    const d = detail('c2')
    d.outputs = outputsTextsOnly()
    query = 'vue=exports'
    await mount('c2', d)

    expect(await screen.findByText(/exporter avant de publier/i)).toBeTruthy()
  })
})

describe('l’état périmé', () => {
  it('confirme toujours l’écrasement, même seul en primaire', async () => {
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      void options
      if (String(url).includes('/candidates')) return response(candidates)
      const publication = publicationResponse(String(url))
      if (publication !== undefined) return publication
      return response(detail('c2'))
    })
    vi.stubGlobal('fetch', fetch)
    const d = detail('c2')
    d.clip.status = 'exported'
    await mount('c2', d)

    fireEvent.click(screen.getByRole('button', { name: /ré-exporter/i }))
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(fetch.mock.calls.some(([, o]) => (o as RequestInit | undefined)?.method === 'POST')).toBe(
      false,
    )
  })

  it('ramène le viseur en Aperçu quand un nouveau `detail` périme le fichier affiché', async () => {
    // `outputs` vient du prop `detail`, que la page (`useClip`) renouvelle
    // après chaque écriture. Sans ce recours, un nouveau `detail` périmé
    // laisse le viseur tenter un `<video>` sans `src`. (relevé par Copilot)
    const delivered = detail('c2')
    delivered.outputs = {
      mp4Url: null,
      mp4Due: false,
      variant9x16Url: '/api/clips/c2/renders/c2-9x16.mp4',
      variant9x16Due: true,
      textsUrl: '/api/clips/c2/renders/c2.txt',
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const envelope = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const view = render(<ClipScreen detail={delivered} />, { wrapper: envelope })
    await screen.findByRole('link', { name: 'La scène du 15 juin' })

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(await screen.findByText('fichier livré')).toBeTruthy()

    const stale = detail('c2')
    view.rerender(<ClipScreen detail={stale} />)

    await waitFor(() => expect(screen.queryByText('fichier livré')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull()
  })
})

describe('la raison d’un primaire désactivé', () => {
  it('se lit dans la barre, et le bouton s’y lie par aria-describedby', async () => {
    await mount('c2', detail('c2', []))

    const button = screen.getByRole('button', { name: /exporter/i })
    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    const reason = document.getElementById(describedBy as string)
    expect(reason?.textContent).toMatch(/rien à rendre/i)
  })
})

describe('l’indicateur d’un export en cours', () => {
  it('marque le primaire aria-busy pendant que le rendu tourne', async () => {
    let release: (r: Response) => void = () => {}
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST' && String(url).includes('/export')) {
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      }
      if (String(url).includes('/candidates')) return response(candidates)
      const publication = publicationResponse(String(url))
      if (publication !== undefined) return publication
      return response(detail('c2'))
    })
    vi.stubGlobal('fetch', fetch)
    await mount('c2')

    fireEvent.click(screen.getByRole('button', { name: /exporter/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /exporter/i }).getAttribute('aria-busy')).toBe(
        'true',
      ),
    )
    expect(screen.getByText(/rendu en cours/i)).toBeTruthy()

    release(response({ mp4: null, variant9x16: 'c2-9x16.mp4', texts: 'c2.txt', skipped: false }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /exporter/i }).getAttribute('aria-busy'),
      ).toBeNull(),
    )
  })
})

describe('l’annonce de réussite', () => {
  function exportFetch(skipped: boolean) {
    return vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST' && String(url).includes('/export')) {
        return response({ mp4: null, variant9x16: 'c2-9x16.mp4', texts: 'c2.txt', skipped })
      }
      if (String(url).includes('/candidates')) return response(candidates)
      const publication = publicationResponse(String(url))
      if (publication !== undefined) return publication
      return response(detail('c2'))
    })
  }

  it('dit qu’un rendu sauté est une réussite, pas un échec', async () => {
    vi.stubGlobal('fetch', exportFetch(true))
    await mount('c2')

    fireEvent.click(screen.getByRole('button', { name: /exporter/i }))
    expect(await screen.findByText(/rien n’a été refait/i)).toBeTruthy()
    expect(screen.queryByText(/^rendu terminé\.$/i)).toBeNull()
  })

  it('distingue un rendu qui a vraiment eu lieu', async () => {
    vi.stubGlobal('fetch', exportFetch(false))
    await mount('c2')

    fireEvent.click(screen.getByRole('button', { name: /exporter/i }))
    expect(await screen.findByText(/^rendu terminé\.$/i)).toBeTruthy()
    expect(screen.queryByText(/rien n’a été refait/i)).toBeNull()
  })
})
