// @vitest-environment jsdom

/**
 * Le protocole d'écriture différée, éprouvé sans monter de page.
 *
 * Les trois premiers cas sont les trois défauts trouvés en revue quand ce code
 * vivait dans `src/app/clips/[id]/page.tsx` : ils étaient documentés en tête de
 * fonction, ils sont ici des tests. Les suivants portent la réconciliation d'un
 * `PATCH` refusé pour jeton périmé.
 */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip, Ratio, Segment } from '@/core/edl'
import type { ClipPatch, PatchClipResult } from '@/lib/api'
import { TEMPORISATION_MS, useEnregistrementAuto } from '@/lib/enregistrement'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    projectId: 'p1',
    segments: [{ start: 10, end: 14.8 }],
    ratio: 'auto',
    cropX: 0.5,
    captions: true,
    branding: true,
    title: 'Un titre',
    description: '',
    status: 'candidate',
    pass: 1,
    ...overrides,
  }
}

/** Une réponse de `PATCH`, réduite à ce que le protocole en lit. */
function reponse(gagnant: Clip, applied: boolean): PatchClipResult {
  return {
    applied,
    clip: gagnant,
    outputs: { mp4Url: null, variant9x16Url: null, variant9x16Due: false, textsUrl: null },
    seq: 42,
  }
}

type Props = {
  reference: Clip
  segments: Segment[]
  ratio: Ratio | 'auto'
  cropX: number
}

/** Les appels à `ecrire`, avec leurs rappels, pour délivrer la réponse à la main. */
type Appel = {
  patch: ClipPatch
  onSuccess?: (resultat: PatchClipResult) => void
  onError?: () => void
}

/**
 * Le harnais tient le rôle du store : ce que la réconciliation lui demande
 * d'adopter, il l'adopte et rejoue le rendu. Sans cela, le test « ne renvoie pas
 * l'intention refusée » vérifierait le `rerender` du test plutôt que le code.
 */
function monter(depart: Props) {
  const appels: Appel[] = []
  const reconcilie = vi.fn()
  let props = depart

  const vue = renderHook(
    (rendus: Props) =>
      useEnregistrementAuto({
        pret: true,
        ...rendus,
        ecrire: (variables, options) => {
          appels.push({ patch: variables.patch, ...options })
        },
        reconcilier: (clipId, valeurs) => {
          reconcilie(clipId, valeurs)
          props = { ...props, ...valeurs }
          vue.rerender(props)
        },
      }),
    { initialProps: depart },
  )

  return {
    ...vue,
    appels,
    reconcilie,
    /** Un geste de l'utilisateur, ou une réponse du serveur adoptée par le cache. */
    rejouer(suite: Partial<Props>) {
      props = { ...props, ...suite }
      vue.rerender(props)
    },
  }
}

const auRepos: Props = {
  reference: clip(),
  segments: [{ start: 10, end: 14.8 }],
  ratio: 'auto',
  cropX: 0.5,
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useEnregistrementAuto', () => {
  it('n’écrit rien quand l’état local est celui du serveur', () => {
    const { result, appels } = monter(auRepos)
    act(() => void vi.advanceTimersByTime(5_000))
    expect(appels).toHaveLength(0)
    expect(result.current).toBe('enregistre')
  })

  it('n’envoie qu’une écriture pour une rafale de gestes', () => {
    const { rejouer, appels } = monter(auRepos)
    for (const cropX of [0.6, 0.7, 0.8]) {
      rejouer({ cropX })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS - 100))
    }
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    expect(appels).toHaveLength(1)
    expect(appels[0].patch).toEqual({ cropX: 0.8 })
  })

  // Défaut 1 : quitter dans les 600 ms perdait la modification, et l'écran
  // affichait « enregistré ».
  it('écrit la dernière modification quand on quitte avant la temporisation', () => {
    const { unmount, appels } = monter({ ...auRepos, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS - 100))
    expect(appels).toHaveLength(0)

    unmount()
    expect(appels).toHaveLength(1)
    expect(appels[0].patch).toEqual({ cropX: 0.8 })
  })

  // Défaut 2 : un échec bouclait sans fin, le rollback rendant la comparaison
  // à nouveau inégale toutes les 600 ms.
  it('ne rejoue pas indéfiniment une écriture qui a échoué', () => {
    const { result, appels } = monter({ ...auRepos, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    expect(appels).toHaveLength(1)

    act(() => appels[0].onError?.())
    act(() => void vi.advanceTimersByTime(10_000))

    expect(appels).toHaveLength(1)
    expect(result.current).toBe('echec')
  })

  it('repart au geste suivant, une fois l’échec passé', () => {
    const { rejouer, appels } = monter({ ...auRepos, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    act(() => appels[0].onError?.())

    rejouer({ cropX: 0.9 })
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))

    expect(appels).toHaveLength(2)
    expect(appels[1].patch).toEqual({ cropX: 0.9 })
  })

  // Défaut 3 : « enregistré » mentait pendant la temporisation, `isPending`
  // n'étant vrai qu'une fois le minuteur écoulé.
  it('n’annonce « enregistré » qu’une fois le serveur d’accord', () => {
    const { result, rejouer, appels } = monter({ ...auRepos, cropX: 0.8 })
    expect(result.current).toBe('en-attente')

    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    expect(result.current).toBe('en-attente')

    // La réponse met à jour le cache, donc la référence : c'est elle, et rien
    // d'autre, qui fait retomber la comparaison à zéro.
    const gagnant = clip({ cropX: 0.8 })
    act(() => appels[0].onSuccess?.(reponse(gagnant, true)))
    rejouer({ reference: gagnant })
    expect(result.current).toBe('enregistre')
  })

  describe('quand le serveur refuse pour jeton périmé', () => {
    it('n’affiche pas d’échec de l’enregistrement', () => {
      const { result, appels } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      act(() => appels[0].onSuccess?.(reponse(clip({ cropX: 0.2 }), false)))

      expect(result.current).not.toBe('echec')
    })

    it('remet le montage local d’accord avec le gagnant', () => {
      const { appels, reconcilie } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      act(() => appels[0].onSuccess?.(reponse(clip({ cropX: 0.2 }), false)))

      expect(reconcilie).toHaveBeenCalledWith('c1', { cropX: 0.2 })
    })

    it('ne renvoie pas l’intention refusée une fois réconcilié', () => {
      // Le défaut que la réconciliation ferme : sans elle, l'écart réapparaît à
      // la comparaison suivante et l'intention refusée repart avec un jeton
      // neuf, donc gagnant — l'ordre payé côté serveur ne sert plus à rien.
      const gagnant = clip({ cropX: 0.2 })
      const { rejouer, appels } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      // Le cache adopte le clip rendu ; le store, lui, n'adopte que ce que la
      // réconciliation lui demande — et c'est tout l'objet de ce test.
      act(() => {
        rejouer({ reference: gagnant })
        appels[0].onSuccess?.(reponse(gagnant, false))
      })
      act(() => void vi.advanceTimersByTime(10_000))

      expect(appels).toHaveLength(1)
    })

    it('ne jette pas un geste posé pendant l’aller-retour', () => {
      const { rejouer, appels, reconcilie } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))

      // L'utilisateur continue de cadrer pendant que la réponse voyage.
      rejouer({ cropX: 0.42 })
      act(() => appels[0].onSuccess?.(reponse(clip({ cropX: 0.2 }), false)))

      // Ce champ ne porte plus l'intention refusée : personne n'a refusé 0,42.
      expect(reconcilie).not.toHaveBeenCalled()
    })
  })
})
