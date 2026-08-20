// @vitest-environment jsdom

/**
 * La fresque des clips gardés.
 *
 * Ce qu'elle doit rendre visible tient en une phrase : « j'édite le clip 4 sur
 * les 12 de cette émission ». Les deux boutons « précédent / suivant » faisaient
 * avancer sans jamais le dire.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ClipStrip } from '@/components/clip/clip-strip'
import type { CandidateClip } from '@/lib/api'

afterEach(cleanup)

function candidate(id: string, overrides: Partial<CandidateClip> = {}): CandidateClip {
  return {
    id,
    projectId: 'p1',
    segments: [{ start: 0, end: 20 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: `Le clip ${id}`,
    description: '',
    status: 'kept',
    pass: 1,
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    preview: '',
    thumbnailUrl: null,
    ...overrides,
  }
}

describe('ClipStrip', () => {
  it('mène à chaque autre clip gardé', () => {
    render(<ClipStrip clips={[candidate('a'), candidate('b'), candidate('c')]} currentId="b" />)
    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/clips/a', '/clips/c'])
  })

  it('marque le clip courant, et n’en fait pas un lien vers lui-même', () => {
    // Un lien vers l'écran où l'on est n'est pas une navigation et volerait un
    // arrêt de tabulation — la règle que le fil d'Ariane applique déjà.
    render(<ClipStrip clips={[candidate('a'), candidate('b')]} currentId="b" />)
    expect(screen.queryByRole('link', { name: /Le clip b/ })).toBeNull()
    const current = screen.getByText('Le clip b').closest('[aria-current]')
    expect(current?.getAttribute('aria-current')).toBe('page')
  })

  it('dit le rang au complet à la voix, abrégé à l’œil', () => {
    // « 4 » seul ne dit pas de quoi c'est le quatrième ; « sur 12 » répété douze
    // fois ne tient pas dans la bande.
    render(<ClipStrip clips={[candidate('a'), candidate('b'), candidate('c')]} currentId="a" />)
    expect(screen.getByText(/clip 3 sur 3/)).toBeTruthy()
  })

  it('porte l’état de chaque clip', () => {
    // Un clip déjà exporté se distingue d'un clip qui attend son montage : c'est
    // ce qui évite de rouvrir celui qui est fait.
    render(<ClipStrip clips={[candidate('a'), candidate('b', { status: 'exported' })]} currentId="a" />)
    expect(screen.getByText('exporté')).toBeTruthy()
    expect(screen.getByText('gardé')).toBeTruthy()
  })

  it('ne rend rien plutôt qu’une bande vide', () => {
    const { container } = render(<ClipStrip clips={[]} currentId="a" />)
    expect(container.firstChild).toBeNull()
  })

  it('se passe d’une vignette quand le proxy n’est pas encodé', () => {
    // `thumbnailUrl: null` est un état normal d'un projet récent, pas une
    // anomalie : le repli est prévu, comme sur les cartes de tri.
    const { container } = render(<ClipStrip clips={[candidate('a')]} currentId="a" />)
    expect(container.querySelector('img')).toBeNull()
  })
})
