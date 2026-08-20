// @vitest-environment jsdom

/**
 * Le protocole d'écriture différée, éprouvé sans monter de page.
 *
 * Les trois cas marqués « défaut N » sont ceux trouvés en revue quand ce code
 * vivait dans `src/app/clips/[id]/page.tsx` : ils étaient documentés en tête de
 * fonction, ils sont ici des tests. Le groupe suivant porte la réconciliation
 * d'un `PATCH` refusé pour jeton périmé.
 *
 * Le dernier groupe est à part : il branche le protocole sur un **vrai**
 * observateur de TanStack Query, partagé comme il l'est en production. C'est le
 * seul harnais qui puisse voir l'issue #55, dont tout le mécanisme vit dans
 * l'observateur et nulle part dans le code d'ici.
 */

import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip, Ratio, Segment } from '@/core/edl'
import type { ClipPatch, PatchClipResult } from '@/lib/api'
import { DEBOUNCE_MS, useAutosave } from '@/lib/autosave'
import { framing } from '../fixtures/framing'

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
    hookText: '',
    hookBadge: '',
    hookStyle: {},
    ...overrides,
  }
}

/** Une réponse de `PATCH`, réduite à ce que le protocole en lit. */
function response(winner: Clip, applied: boolean): PatchClipResult {
  return {
    applied,
    clip: winner,
    outputs: { mp4Url: null, variant9x16Url: null, variant9x16Due: false, textsUrl: null },
    framing: framing(),
    seq: 42,
  }
}

type Props = {
  reference: Clip
  segments: Segment[]
  ratio: Ratio | 'auto'
  cropX: number
}

/** Ce que le protocole passe à `write`, réduit à ce qu'on en lit ici. */
type Variables = { clipId: string; projectId: string; patch: ClipPatch }

/** Les appels à `write`, avec la main sur le sort de leur promesse. */
type Call = {
  patch: ClipPatch
  resolve: (result: PatchClipResult) => void
  reject: (reason: Error) => void
  /** Quelqu'un a-t-il pris en charge le rejet de cette promesse ? */
  resumed: () => boolean
}

/**
 * Une promesse dont on sait si son rejet a trouvé preneur.
 *
 * `.catch(f)` n'est que `.then(undefined, f)` : instrumenter `then` voit donc
 * passer les deux formes. C'est la seule façon d'écrire ici une **assertion**
 * sur un rejet non géré — un guetteur `unhandledrejection` posé sur la fenêtre
 * de jsdom n'en voit aucun, ces rejets-là remontent au processus, où c'est le
 * lanceur de tests qui les ramasse et fait rougir le fichier entier.
 *
 * `await` ne compte pas : il passe par la fente interne de la promesse et non
 * par la propriété `then`, donc attendre le résultat dans un test ne fait pas
 * croire à une prise en charge.
 */
function promiseWatched<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((ok, ko) => {
    resolve = ok
    reject = ko
  })
  const chain = promise.then.bind(promise)
  let resumed = false
  promise.then = (onSuccess, onFailure) => {
    if (onFailure) resumed = true
    return chain(onSuccess, onFailure)
  }
  return { promise, resolve, reject, resumed: () => resumed }
}

/**
 * Un geste, puis le temps que les promesses se dénouent.
 *
 * Un `act` synchrone ne suffit plus depuis que `write` rend une promesse : la
 * réponse traverse plusieurs micro-tâches avant d'atteindre le protocole. Les
 * minuteurs sont faux, donc c'est `advanceTimersByTimeAsync` — et non un
 * `setTimeout` qui ne s'écoulerait jamais — qui rend la main au moteur.
 */
async function actWrapped(gesture: () => void): Promise<void> {
  await act(async () => {
    gesture()
    await vi.advanceTimersByTimeAsync(0)
  })
}

/**
 * Le harnais tient le rôle du store : ce que la réconciliation lui demande
 * d'adopter, il l'adopte et rejoue le rendu. Sans cela, le test « ne renvoie pas
 * l'intention refusée » vérifierait le `rerender` du test plutôt que le code.
 */
function mount(start: Props) {
  const calls: Call[] = []
  const reconciled = vi.fn()
  let props = start
  // Une réponse peut arriver après le démontage — c'est tout l'objet du dernier
  // cas. Le store, lui, survit ; ce harnais tient son rôle, donc il enregistre
  // l'appel sans rejouer un rendu qui n'a plus de conteneur.
  let mount = true

  const view = renderHook(
    (renders: Props) =>
      useAutosave({
        ready: true,
        ...renders,
        write: (variables) => {
          const { promise, resolve, reject, resumed } = promiseWatched<PatchClipResult>()
          calls.push({ patch: variables.patch, resolve, reject, resumed })
          return promise
        },
        reconcile: (clipId, values) => {
          reconciled(clipId, values)
          props = { ...props, ...values }
          if (mount) view.rerender(props)
        },
      }),
    { initialProps: start },
  )

  return {
    ...view,
    calls,
    reconciled,
    unmount: () => {
      mount = false
      view.unmount()
    },
    /** Un geste de l'utilisateur, ou une réponse du serveur adoptée par le cache. */
    replay(next: Partial<Props>) {
      props = { ...props, ...next }
      view.rerender(props)
    },
  }
}

const rest: Props = {
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

describe('useAutosave', () => {
  it('n’écrit rien quand l’état local est celui du serveur', () => {
    const { result, calls } = mount(rest)
    act(() => void vi.advanceTimersByTime(5_000))
    expect(calls).toHaveLength(0)
    expect(result.current).toBe('enregistre')
  })

  it('n’envoie qu’une écriture pour une rafale de gestes', () => {
    const { replay, calls } = mount(rest)
    for (const cropX of [0.6, 0.7, 0.8]) {
      replay({ cropX })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS - 100))
    }
    act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
    expect(calls).toHaveLength(1)
    expect(calls[0].patch).toEqual({ cropX: 0.8 })
  })

  // Défaut 1 : quitter dans les 600 ms perdait la modification, et l'écran
  // affichait « enregistré ».
  it('écrit la dernière modification quand on quitte avant la temporisation', () => {
    const { unmount, calls } = mount({ ...rest, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(DEBOUNCE_MS - 100))
    expect(calls).toHaveLength(0)

    unmount()
    expect(calls).toHaveLength(1)
    expect(calls[0].patch).toEqual({ cropX: 0.8 })
  })

  // Le vidage du départ **n'attend pas de réponse**, et c'est voulu — le
  // commentaire au point d'appel dit pourquoi. Mais ne pas attendre n'est pas
  // ne pas reprendre : une promesse rejetée que personne ne reprend devient un
  // rejet non géré, qui fait rougir un fichier de test entier et salit la
  // console en production.
  it('ne laisse pas un rejet non géré derrière le vidage du départ', async () => {
    const { unmount, calls } = mount({ ...rest, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(DEBOUNCE_MS - 100))
    unmount()
    expect(calls).toHaveLength(1)

    expect(calls[0].resumed()).toBe(true)
    // Et on rejette pour de vrai : si la reprise n'était qu'apparente, le
    // lanceur de tests le dirait ici.
    await actWrapped(() => calls[0].reject(new Error('réseau coupé')))
  })

  // Défaut 2 : un échec bouclait sans fin, le rollback rendant la comparaison
  // à nouveau inégale toutes les 600 ms.
  it('ne rejoue pas indéfiniment une écriture qui a échoué', async () => {
    const { result, calls } = mount({ ...rest, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
    expect(calls).toHaveLength(1)

    await actWrapped(() => calls[0].reject(new Error('réseau coupé')))
    act(() => void vi.advanceTimersByTime(10_000))

    expect(calls).toHaveLength(1)
    expect(result.current).toBe('echec')
  })

  it('repart au geste suivant, une fois l’échec passé', async () => {
    const { replay, calls } = mount({ ...rest, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
    await actWrapped(() => calls[0].reject(new Error('réseau coupé')))

    replay({ cropX: 0.9 })
    act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))

    expect(calls).toHaveLength(2)
    expect(calls[1].patch).toEqual({ cropX: 0.9 })
  })

  // Défaut 3 : « enregistré » mentait pendant la temporisation, `isPending`
  // n'étant vrai qu'une fois le minuteur écoulé.
  it('n’annonce « enregistré » qu’une fois le serveur d’accord', async () => {
    const { result, replay, calls } = mount({ ...rest, cropX: 0.8 })
    expect(result.current).toBe('en-attente')

    act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
    expect(result.current).toBe('en-attente')

    // La réponse met à jour le cache, donc la référence : c'est elle, et rien
    // d'autre, qui fait retomber la comparaison à zéro.
    const winner = clip({ cropX: 0.8 })
    await actWrapped(() => calls[0].resolve(response(winner, true)))
    replay({ reference: winner })
    expect(result.current).toBe('enregistre')
  })

  // **Deux enregistrements du montage peuvent se chevaucher.** La temporisation
  // est de 600 ms, un aller-retour peut être plus long, et un geste de plus fait
  // repartir une écriture pendant que la précédente vole encore. Tant que les
  // rappels vivaient sur l'observateur, la mutation dépassée était détachée et
  // sa réponse ne disait plus rien ; depuis `mutateAsync`, elle parle — et si
  // personne ne l'en empêche, elle parle **après** la plus récente.
  // (relevé par Copilot et par Codex)
  describe('quand deux enregistrements du montage se chevauchent', () => {
    it('ne laisse pas le succès tardif du dépassé effacer l’échec du récent', async () => {
      const { result, replay, calls } = mount({ ...rest, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      replay({ cropX: 0.9 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      expect(calls.map((a) => a.patch)).toEqual([{ cropX: 0.8 }, { cropX: 0.9 }])

      // Le plus récent échoue : c'est lui qui doit tenir le blocage.
      await actWrapped(() => calls[1].reject(new Error('réseau coupé')))
      expect(result.current).toBe('echec')

      // Puis le dépassé aboutit, en retard. Son `setFailure(null)` rouvrirait la
      // porte, et l'écriture ratée repartirait toute seule 600 ms plus tard :
      // le garde-fou anti-boucle contourné par le chemin qu'il surveille.
      await actWrapped(() => calls[0].resolve(response(clip({ cropX: 0.8 }), true)))
      act(() => void vi.advanceTimersByTime(10_000))

      expect(result.current).toBe('echec')
      expect(calls).toHaveLength(2)
    })

    it('ne réconcilie pas sur un refus dépassé, même si la valeur est revenue', async () => {
      // Le cas que la première garde laissait ouvert : « ce champ porte encore
      // l'intention refusée » ne sait pas distinguer « personne n'y a touché »
      // de « l'utilisateur est repassé par là ». Sur une réponse dépassée, la
      // seconde lecture est la bonne, et adopter le gagnant écraserait le geste
      // le plus récent de tous. (relevé par Codex)
      const { replay, calls, reconciled } = mount({ ...rest, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      replay({ cropX: 0.9 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      expect(calls.map((a) => a.patch)).toEqual([{ cropX: 0.8 }, { cropX: 0.9 }])

      // L'utilisateur ramène le cadrage là où il était, avant que la première
      // réponse ne revienne.
      replay({ cropX: 0.8 })
      await actWrapped(() => calls[0].resolve(response(clip({ cropX: 0.9 }), false)))

      expect(reconciled).not.toHaveBeenCalled()

      // Et le geste survit : c'est lui qui part.
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      expect(calls).toHaveLength(3)
      expect(calls[2].patch).toEqual({ cropX: 0.8 })
    })

    it('ne retient pas la signature d’un échec tardif déjà dépassé', async () => {
      const winner = clip({ cropX: 0.9 })
      const { result, replay, calls } = mount({ ...rest, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      replay({ cropX: 0.9 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))

      // Le plus récent passe, et le cache adopte le clip rendu.
      await actWrapped(() => calls[1].resolve(response(winner, true)))
      replay({ reference: winner })
      expect(result.current).toBe('enregistre')

      // Le dépassé échoue après coup. Retenir sa signature poserait une mine :
      // le serveur va très bien, mais le jour où l'utilisateur ramène le cadrage
      // à cette valeur-là, l'écriture serait refusée par l'écran lui-même.
      await actWrapped(() => calls[0].reject(new Error('réseau coupé')))

      replay({ cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))

      expect(result.current).not.toBe('echec')
      expect(calls).toHaveLength(3)
      expect(calls[2].patch).toEqual({ cropX: 0.8 })
    })
  })

  // **Le compteur de tentatives appartient à une instance du hook**, et la
  // promesse lui survit. Rouvrir le même clip donne un compteur neuf, incapable
  // de dépasser une écriture partie sous l'écran précédent — pendant que le
  // store, lui, est global et que sa garde ne regarde que l'identifiant du clip,
  // le même dans les deux sessions. (relevé par Codex)
  it('n’adopte plus rien pour une écriture encore en vol au démontage', async () => {
    const { unmount, calls, reconciled } = mount({ ...rest, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
    expect(calls).toHaveLength(1)

    unmount()
    await actWrapped(() => calls[0].resolve(response(clip({ cropX: 0.2 }), false)))

    expect(reconciled).not.toHaveBeenCalled()
  })

  // **Un vidage sur `pagehide` est une écriture comme une autre**, même s'il
  // n'attend rien : il porte une intention plus récente que ce qui vole encore.
  // Sans lui faire prendre un rang, l'ancienne se croit toujours la dernière —
  // et une page restaurée depuis le bfcache lui laisse tout le temps de le
  // croire. (relevé par Copilot)
  it('périme les tentatives en vol quand le départ vide une modification', async () => {
    const { replay, calls, reconciled } = mount({ ...rest, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
    expect(calls).toHaveLength(1)

    // Un geste de plus, promis mais pas encore parti, que la fermeture emporte.
    replay({ cropX: 0.9 })
    act(() => void window.dispatchEvent(new Event('pagehide')))
    expect(calls.map((a) => a.patch)).toEqual([{ cropX: 0.8 }, { cropX: 0.9 }])

    // La page revient du bfcache et l'utilisateur ramène le cadrage à 0,8 —
    // valeur qui redonne à la vieille réponse l'apparence d'être d'actualité.
    replay({ cropX: 0.8 })
    await actWrapped(() => calls[0].resolve(response(clip({ cropX: 0.2 }), false)))

    expect(reconciled).not.toHaveBeenCalled()
  })

  describe('quand le serveur refuse pour jeton périmé', () => {
    it('n’affiche pas d’échec de l’enregistrement', async () => {
      const { result, calls } = mount({ ...rest, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      await actWrapped(() => calls[0].resolve(response(clip({ cropX: 0.2 }), false)))

      expect(result.current).not.toBe('echec')
    })

    it('remet le montage local d’accord avec le gagnant', async () => {
      const { calls, reconciled } = mount({ ...rest, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      await actWrapped(() => calls[0].resolve(response(clip({ cropX: 0.2 }), false)))

      expect(reconciled).toHaveBeenCalledWith('c1', { cropX: 0.2 })
    })

    it('ne renvoie pas l’intention refusée une fois réconcilié', async () => {
      // Le défaut que la réconciliation ferme : sans elle, l'écart réapparaît à
      // la comparaison suivante et l'intention refusée repart avec un jeton
      // neuf, donc gagnant — l'ordre payé côté serveur ne sert plus à rien.
      const winner = clip({ cropX: 0.2 })
      const { replay, calls } = mount({ ...rest, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      // Le cache adopte le clip rendu ; le store, lui, n'adopte que ce que la
      // réconciliation lui demande — et c'est tout l'objet de ce test.
      await actWrapped(() => {
        replay({ reference: winner })
        calls[0].resolve(response(winner, false))
      })
      act(() => void vi.advanceTimersByTime(10_000))

      expect(calls).toHaveLength(1)
    })

    it('réessaie quand le refus vient du plancher de jeton, pas d’un croisement', async () => {
      // Une horloge de navigateur remise en arrière produit des jetons
      // inférieurs à ce que la base a déjà appliqué : le serveur refuse une
      // modification pourtant fraîche et rend la valeur d'avant — celle qu'on a
      // déjà en référence. `usePatchClip` se recale sur le plancher annoncé, et
      // la tentative suivante passe. Réconcilier ici tuerait ce rétablissement
      // et perdrait la modification.
      const { replay, calls, reconciled } = mount({ ...rest, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      await actWrapped(() => calls[0].resolve(response(rest.reference, false)))

      expect(reconciled).not.toHaveBeenCalled()

      // Un geste de plus, et l'écriture repart — avec un jeton au-dessus du
      // plancher, donc gagnante.
      replay({ cropX: 0.81 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
      expect(calls).toHaveLength(2)
      expect(calls[1].patch).toEqual({ cropX: 0.81 })
    })

    it('ne jette pas un geste posé pendant l’aller-retour', async () => {
      const { replay, calls, reconciled } = mount({ ...rest, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(DEBOUNCE_MS))

      // L'utilisateur continue de cadrer pendant que la réponse voyage.
      replay({ cropX: 0.42 })
      await actWrapped(() => calls[0].resolve(response(clip({ cropX: 0.2 }), false)))

      // Ce champ ne porte plus l'intention refusée : personne n'a refusé 0,42.
      expect(reconciled).not.toHaveBeenCalled()
    })
  })
})

/**
 * Le harnais de l'observateur partagé.
 *
 * Il ne simule rien : c'est un vrai `useMutation`, dont l'écran de clip n'a
 * qu'un exemplaire pour l'enregistrement du montage **et** pour les écritures
 * directes de titre, de description et de marques. Le seul point de contrôle
 * est la promesse de `mutationFn`, qu'on dénoue à la main.
 *
 * C'est ce partage qui fait l'issue #55 : `MutationObserver.mutate` garde les
 * rappels qu'on lui passe dans un champ unique et détache la mutation
 * précédente, donc le second appel emporte le sort du premier. Un faux `write`
 * qui se contente d'enregistrer ses rappels ne peut pas le voir.
 */
function mountOnObserverShared(start: Props) {
  const send: Call[] = []
  const reconciled = vi.fn()
  const client = new QueryClient()
  // Une case, et non une variable : TypeScript ne sait pas que le corps du hook
  // s'exécute, et refuserait de la considérer comme affectée.
  const direct: { write: (variables: Variables) => void } = { write: () => {} }

  const view = renderHook(
    (renders: Props) => {
      const patch = useMutation<PatchClipResult, Error, Variables>({
        mutationFn: (variables) => {
          const { promise, resolve, reject, resumed } = promiseWatched<PatchClipResult>()
          send.push({ patch: variables.patch, resolve, reject, resumed })
          return promise
        },
      })
      direct.write = patch.mutate
      return useAutosave({
        ready: true,
        ...renders,
        write: patch.mutateAsync,
        reconcile: (clipId, values) => reconciled(clipId, values),
      })
    },
    {
      initialProps: start,
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )

  return {
    ...view,
    send,
    reconciled,
    /** Le geste ordinaire : taper un titre pendant que le montage s'enregistre. */
    writeATitle: (title: string) =>
      direct.write({ clipId: 'c1', projectId: 'p1', patch: { title: title } }),
  }
}

describe('useAutosave sur l’observateur partagé de l’écran', () => {
  it('réconcilie un refus alors qu’une écriture de titre est partie entre-temps', async () => {
    const { send, reconciled, writeATitle } = mountOnObserverShared({
      ...rest,
      cropX: 0.8,
    })
    await actWrapped(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
    expect(send).toHaveLength(1)
    expect(send[0].patch).toEqual({ cropX: 0.8 })

    // Entre l'écriture du montage et sa réponse : les deux surfaces sont côte à
    // côte sur le même écran, le croisement n'est pas un cas limite.
    await actWrapped(() => writeATitle('Un autre titre'))
    expect(send).toHaveLength(2)

    // Le serveur écarte le montage pour jeton périmé et rend le gagnant.
    await actWrapped(() => send[0].resolve(response(clip({ cropX: 0.2 }), false)))

    expect(reconciled).toHaveBeenCalledWith('c1', { cropX: 0.2 })
  })

  it('pose l’échec du montage alors qu’une autre mutation est partie depuis', async () => {
    const { result, send, writeATitle } = mountOnObserverShared({
      ...rest,
      cropX: 0.8,
    })
    await actWrapped(() => void vi.advanceTimersByTime(DEBOUNCE_MS))
    expect(send).toHaveLength(1)

    await actWrapped(() => writeATitle('Un autre titre'))
    await actWrapped(() => send[0].reject(new Error('réseau coupé')))

    expect(result.current).toBe('echec')

    // Et la signature ratée reste retenue : rien ne repart tout seul.
    await actWrapped(() => void vi.advanceTimersByTime(10_000))
    expect(send).toHaveLength(2)
  })
})
