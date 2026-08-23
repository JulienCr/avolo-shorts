// @vitest-environment jsdom

/**
 * La modale de publication — **une primitive, deux appelants**.
 *
 * Ce test vérifie ce que le contrat demande explicitement : la même boîte
 * sert un clip seul ou une sélection ; les quatre plateformes restent
 * visibles et désactivées avec leur raison tant que rien n'est branché ; un
 * clip non exporté est refusé avec son explication plutôt que caché ; la
 * confirmation est un geste obligatoire, jamais implicite ; et les sept
 * états (quatre de publication, trois d'indisponibilité) se rendent.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PublishDialog, type PublishClipTarget } from '@/components/publication/publish-dialog'
import type { Platform, PlatformAvailability } from '@/core/publication'
import { installPointerEventPolyfill } from '../../fixtures/pointer-event'

// **`PointerEvent` n'existe pas sous `jsdom`.** La case à cocher de Base UI
// distingue la souris du tactile en dispatchant elle-même un `PointerEvent`
// synthétique à la validation — `dispatchClickWithModifiers` — et lève sans ce
// constructeur. Le repli est né ici, quand ce fichier était le seul du dépôt à
// cliquer une `Checkbox` ; ils sont trois maintenant, donc il vit dans
// `tests/fixtures/` — mais toujours pas dans une configuration globale, qui le
// ferait payer aux dizaines de fichiers qui n'en ont pas besoin.
installPointerEventPolyfill()

afterEach(cleanup)

function eligible(fields: Partial<PublishClipTarget> = {}): PublishClipTarget {
  return {
    clipId: 'c1',
    title: 'La chute',
    eligibility: { eligible: true },
    ...fields,
  }
}

const allAvailable: Record<Platform, PlatformAvailability> = {
  instagram: { available: true },
  facebook: { available: true },
  tiktok: { available: true },
  youtube: { available: true },
}

describe('PublishDialog — état honnête d’aujourd’hui', () => {
  it('affiche les quatre plateformes, désactivées, avec leur raison', () => {
    render(<PublishDialog open onOpenChange={() => {}} clips={[eligible()]} />)

    for (const label of ['Instagram', 'Facebook', 'TikTok', 'YouTube Shorts']) {
      const checkbox = screen.getByRole('checkbox', { name: label })
      expect(checkbox.getAttribute('data-disabled')).toBe('')
    }
    // Chaque raison se lit sur place, jamais seulement au survol — une par
    // plateforme, en plus du bandeau général.
    expect(screen.getAllByText(/branché pour cette plateforme/).length).toBe(4)
  })

  it('dit que rien n’est branché, en toutes lettres', () => {
    render(<PublishDialog open onOpenChange={() => {}} clips={[eligible()]} />)
    expect(screen.getByText('Aucun connecteur n’est encore branché.')).toBeTruthy()
  })

  it('reste parcourable jusqu’à la confirmation malgré tout', () => {
    render(<PublishDialog open onOpenChange={() => {}} clips={[eligible()]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    expect(screen.getByText('Rien à lancer aujourd’hui.')).toBeTruthy()
    // Pas de bouton de lancement tant qu'il n'y a rien à lancer.
    expect(screen.queryByRole('button', { name: /Confirmer et publier/ })).toBeNull()
  })
})

describe('PublishDialog — un clip non exporté', () => {
  it('est refusé avec son explication, pas caché', () => {
    const ineligible = eligible({
      clipId: 'c2',
      title: 'Pas encore rendu',
      eligibility: { eligible: false, reason: 'Exporter avant de publier.' },
    })
    render(<PublishDialog open onOpenChange={() => {}} clips={[ineligible]} />)
    expect(screen.getByText(/ne peut pas être publié/)).toBeTruthy()
    expect(screen.getAllByText('Pas encore rendu', { exact: false }).length).toBeGreaterThan(0)
    expect(screen.getByText('Exporter avant de publier.')).toBeTruthy()
  })
})

describe('PublishDialog — même logique depuis un clip ou une sélection', () => {
  it('titre différemment selon le nombre de clips, sans dupliquer la logique', () => {
    const { unmount } = render(<PublishDialog open onOpenChange={() => {}} clips={[eligible()]} />)
    expect(screen.getByRole('heading', { name: 'Publier « La chute »' })).toBeTruthy()
    unmount()

    render(
      <PublishDialog
        open
        onOpenChange={() => {}}
        clips={[eligible({ clipId: 'c1' }), eligible({ clipId: 'c2', title: 'Deuxième clip' })]}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Publier 2 clips' })).toBeTruthy()
  })
})

/** Une seule plateforme disponible — les trois autres `not_configured`. */
const onlyInstagram: Record<Platform, PlatformAvailability> = {
  instagram: { available: true },
  facebook: { available: false, reason: 'not_configured' },
  tiktok: { available: false, reason: 'not_configured' },
  youtube: { available: false, reason: 'not_configured' },
}

describe('PublishDialog — quand une plateforme est disponible (injecté pour le test)', () => {
  it('coche par défaut les plateformes disponibles (issue #97)', () => {
    render(
      <PublishDialog open onOpenChange={() => {}} clips={[eligible()]} availability={allAvailable} />,
    )
    for (const label of ['Instagram', 'Facebook', 'TikTok', 'YouTube Shorts']) {
      expect(screen.getByRole('checkbox', { name: label }).getAttribute('aria-checked')).toBe('true')
    }
  })

  it('ne coche jamais une plateforme `not_configured` (issue #97)', () => {
    render(
      <PublishDialog open onOpenChange={() => {}} clips={[eligible()]} availability={onlyInstagram} />,
    )
    expect(screen.getByRole('checkbox', { name: 'Instagram' }).getAttribute('aria-checked')).toBe('true')
    for (const label of ['Facebook', 'TikTok', 'YouTube Shorts']) {
      expect(screen.getByRole('checkbox', { name: label }).getAttribute('aria-checked')).toBe('false')
    }
  })

  it('se confirme, et lance la publication choisie par défaut, avec `force`', () => {
    const onLaunch = vi.fn()
    render(
      <PublishDialog
        open
        onOpenChange={() => {}}
        clips={[eligible()]}
        availability={onlyInstagram}
        onLaunch={onLaunch}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    expect(screen.getByText(/Confirmer déclenche l’envoi/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et publier' }))
    expect(onLaunch).toHaveBeenCalledWith([{ clipId: 'c1', platform: 'instagram' }], false)
  })

  it('n’avance pas tant qu’aucune plateforme disponible n’est cochée', () => {
    render(
      <PublishDialog open onOpenChange={() => {}} clips={[eligible()]} availability={allAvailable} />,
    )
    // Cochées par défaut : il faut les décocher pour retrouver le blocage.
    for (const label of ['Instagram', 'Facebook', 'TikTok', 'YouTube Shorts']) {
      fireEvent.click(screen.getByRole('checkbox', { name: label }))
    }
    expect(screen.getByRole('button', { name: 'Suivant' })).toHaveProperty('disabled', true)
  })

  it('affiche les quatre états d’une publication déjà lancée', () => {
    // **Une plateforme par état**, pas les quatre sur la même — sinon une
    // régression du libellé ou du rendu de `in_progress`, `submitted` ou
    // `failed` resterait invisible derrière le seul `published` qu'exerçait
    // la version précédente de ce test. (relevé par Copilot)
    const target = eligible({
      records: {
        instagram: { status: 'in_progress', remoteUrl: null, publishedFingerprint: null, error: null },
        facebook: { status: 'submitted', remoteUrl: null, publishedFingerprint: null, error: null },
        tiktok: { status: 'published', remoteUrl: 'https://tiktok.test/p/1', publishedFingerprint: null, error: null },
        youtube: { status: 'failed', remoteUrl: null, publishedFingerprint: null, error: null },
      },
    })
    render(
      <PublishDialog open onOpenChange={() => {}} clips={[target]} availability={allAvailable} />,
    )
    // Instagram, Facebook et YouTube sont cochés par défaut (rien n'est
    // `published` chez eux) ; TikTok, déjà `published`, ne l'est pas.
    fireEvent.click(screen.getByRole('checkbox', { name: 'TikTok' }))
    expect(screen.getByText('en cours')).toBeTruthy()
    expect(screen.getByText('déposé')).toBeTruthy()
    expect(screen.getByText('publié')).toBeTruthy()
    expect(screen.getByText('échec')).toBeTruthy()
  })

  it('refuse la republication sans un geste explicite', () => {
    const onLaunch = vi.fn()
    const target = eligible({
      records: {
        instagram: { status: 'published', remoteUrl: null, publishedFingerprint: null, error: null },
      },
    })
    render(
      <PublishDialog
        open
        onOpenChange={() => {}}
        clips={[target]}
        availability={onlyInstagram}
        onLaunch={onLaunch}
      />,
    )
    // Déjà `published` : pas coché par défaut (issue #97).
    expect(screen.getByRole('checkbox', { name: 'Instagram' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Instagram' }))
    fireEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    // Sans avoir coché « republier », il n'y a rien à lancer.
    expect(screen.getByText('Rien à lancer aujourd’hui.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retour' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Republier explicitement/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et publier' }))
    expect(onLaunch).toHaveBeenCalledWith([{ clipId: 'c1', platform: 'instagram' }], true)
  })

  it('signale une publication périmée par une modification locale', () => {
    const target = eligible({
      currentFingerprint: 'empreinte-actuelle',
      records: {
        instagram: { status: 'published', remoteUrl: null, publishedFingerprint: 'empreinte-ancienne', error: null },
      },
    })
    render(
      <PublishDialog open onOpenChange={() => {}} clips={[target]} availability={allAvailable} />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Instagram' }))
    expect(screen.getByText('modifié depuis')).toBeTruthy()
  })
})

describe('PublishDialog — remise à zéro entre deux ouvertures', () => {
  it('revient à la sélection par défaut en se rouvrant, pas à celle laissée avant de fermer', () => {
    // Instagram est coché par défaut (disponible, jamais publié) ; le
    // décocher est le geste qui doit se défaire à la réouverture.
    const { rerender } = render(
      <PublishDialog open onOpenChange={() => {}} clips={[eligible()]} availability={allAvailable} />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Instagram' }))
    expect(screen.getByRole('checkbox', { name: 'Instagram' }).getAttribute('aria-checked')).toBe('false')

    rerender(<PublishDialog open={false} onOpenChange={() => {}} clips={[eligible()]} availability={allAvailable} />)
    rerender(<PublishDialog open onOpenChange={() => {}} clips={[eligible()]} availability={allAvailable} />)

    const checkbox = screen.getByRole('checkbox', { name: 'Instagram' }) as HTMLElement
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
  })
})

describe('PublishDialog — ne s’affiche pas fermée', () => {
  it('ne rend aucune boîte tant qu’elle est fermée', () => {
    render(<PublishDialog open={false} onOpenChange={() => {}} clips={[eligible()]} />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
