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
import { TEMPORISATION_MS, useEnregistrementAuto } from '@/lib/enregistrement'
import { cadrage } from '../fixtures/cadrage'

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
    framing: cadrage(),
    seq: 42,
  }
}

type Props = {
  reference: Clip
  segments: Segment[]
  ratio: Ratio | 'auto'
  cropX: number
}

/** Ce que le protocole passe à `ecrire`, réduit à ce qu'on en lit ici. */
type Variables = { clipId: string; projectId: string; patch: ClipPatch }

/** Les appels à `ecrire`, avec la main sur le sort de leur promesse. */
type Appel = {
  patch: ClipPatch
  resoudre: (resultat: PatchClipResult) => void
  rejeter: (raison: Error) => void
  /** Quelqu'un a-t-il pris en charge le rejet de cette promesse ? */
  repris: () => boolean
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
function promesseSurveillee<T>() {
  let resoudre!: (valeur: T) => void
  let rejeter!: (raison: Error) => void
  const promesse = new Promise<T>((ok, ko) => {
    resoudre = ok
    rejeter = ko
  })
  const enchainer = promesse.then.bind(promesse)
  let repris = false
  promesse.then = (surSucces, surEchec) => {
    if (surEchec) repris = true
    return enchainer(surSucces, surEchec)
  }
  return { promesse, resoudre, rejeter, repris: () => repris }
}

/**
 * Un geste, puis le temps que les promesses se dénouent.
 *
 * Un `act` synchrone ne suffit plus depuis que `ecrire` rend une promesse : la
 * réponse traverse plusieurs micro-tâches avant d'atteindre le protocole. Les
 * minuteurs sont faux, donc c'est `advanceTimersByTimeAsync` — et non un
 * `setTimeout` qui ne s'écoulerait jamais — qui rend la main au moteur.
 */
async function agir(geste: () => void): Promise<void> {
  await act(async () => {
    geste()
    await vi.advanceTimersByTimeAsync(0)
  })
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
  // Une réponse peut arriver après le démontage — c'est tout l'objet du dernier
  // cas. Le store, lui, survit ; ce harnais tient son rôle, donc il enregistre
  // l'appel sans rejouer un rendu qui n'a plus de conteneur.
  let monte = true

  const vue = renderHook(
    (rendus: Props) =>
      useEnregistrementAuto({
        pret: true,
        ...rendus,
        ecrire: (variables) => {
          const { promesse, resoudre, rejeter, repris } = promesseSurveillee<PatchClipResult>()
          appels.push({ patch: variables.patch, resoudre, rejeter, repris })
          return promesse
        },
        reconcilier: (clipId, valeurs) => {
          reconcilie(clipId, valeurs)
          props = { ...props, ...valeurs }
          if (monte) vue.rerender(props)
        },
      }),
    { initialProps: depart },
  )

  return {
    ...vue,
    appels,
    reconcilie,
    unmount: () => {
      monte = false
      vue.unmount()
    },
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

  // Le vidage du départ **n'attend pas de réponse**, et c'est voulu — le
  // commentaire au point d'appel dit pourquoi. Mais ne pas attendre n'est pas
  // ne pas reprendre : une promesse rejetée que personne ne reprend devient un
  // rejet non géré, qui fait rougir un fichier de test entier et salit la
  // console en production.
  it('ne laisse pas un rejet non géré derrière le vidage du départ', async () => {
    const { unmount, appels } = monter({ ...auRepos, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS - 100))
    unmount()
    expect(appels).toHaveLength(1)

    expect(appels[0].repris()).toBe(true)
    // Et on rejette pour de vrai : si la reprise n'était qu'apparente, le
    // lanceur de tests le dirait ici.
    await agir(() => appels[0].rejeter(new Error('réseau coupé')))
  })

  // Défaut 2 : un échec bouclait sans fin, le rollback rendant la comparaison
  // à nouveau inégale toutes les 600 ms.
  it('ne rejoue pas indéfiniment une écriture qui a échoué', async () => {
    const { result, appels } = monter({ ...auRepos, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    expect(appels).toHaveLength(1)

    await agir(() => appels[0].rejeter(new Error('réseau coupé')))
    act(() => void vi.advanceTimersByTime(10_000))

    expect(appels).toHaveLength(1)
    expect(result.current).toBe('echec')
  })

  it('repart au geste suivant, une fois l’échec passé', async () => {
    const { rejouer, appels } = monter({ ...auRepos, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    await agir(() => appels[0].rejeter(new Error('réseau coupé')))

    rejouer({ cropX: 0.9 })
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))

    expect(appels).toHaveLength(2)
    expect(appels[1].patch).toEqual({ cropX: 0.9 })
  })

  // Défaut 3 : « enregistré » mentait pendant la temporisation, `isPending`
  // n'étant vrai qu'une fois le minuteur écoulé.
  it('n’annonce « enregistré » qu’une fois le serveur d’accord', async () => {
    const { result, rejouer, appels } = monter({ ...auRepos, cropX: 0.8 })
    expect(result.current).toBe('en-attente')

    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    expect(result.current).toBe('en-attente')

    // La réponse met à jour le cache, donc la référence : c'est elle, et rien
    // d'autre, qui fait retomber la comparaison à zéro.
    const gagnant = clip({ cropX: 0.8 })
    await agir(() => appels[0].resoudre(reponse(gagnant, true)))
    rejouer({ reference: gagnant })
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
      const { result, rejouer, appels } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      rejouer({ cropX: 0.9 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      expect(appels.map((a) => a.patch)).toEqual([{ cropX: 0.8 }, { cropX: 0.9 }])

      // Le plus récent échoue : c'est lui qui doit tenir le blocage.
      await agir(() => appels[1].rejeter(new Error('réseau coupé')))
      expect(result.current).toBe('echec')

      // Puis le dépassé aboutit, en retard. Son `setEchec(null)` rouvrirait la
      // porte, et l'écriture ratée repartirait toute seule 600 ms plus tard :
      // le garde-fou anti-boucle contourné par le chemin qu'il surveille.
      await agir(() => appels[0].resoudre(reponse(clip({ cropX: 0.8 }), true)))
      act(() => void vi.advanceTimersByTime(10_000))

      expect(result.current).toBe('echec')
      expect(appels).toHaveLength(2)
    })

    it('ne réconcilie pas sur un refus dépassé, même si la valeur est revenue', async () => {
      // Le cas que la première garde laissait ouvert : « ce champ porte encore
      // l'intention refusée » ne sait pas distinguer « personne n'y a touché »
      // de « l'utilisateur est repassé par là ». Sur une réponse dépassée, la
      // seconde lecture est la bonne, et adopter le gagnant écraserait le geste
      // le plus récent de tous. (relevé par Codex)
      const { rejouer, appels, reconcilie } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      rejouer({ cropX: 0.9 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      expect(appels.map((a) => a.patch)).toEqual([{ cropX: 0.8 }, { cropX: 0.9 }])

      // L'utilisateur ramène le cadrage là où il était, avant que la première
      // réponse ne revienne.
      rejouer({ cropX: 0.8 })
      await agir(() => appels[0].resoudre(reponse(clip({ cropX: 0.9 }), false)))

      expect(reconcilie).not.toHaveBeenCalled()

      // Et le geste survit : c'est lui qui part.
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      expect(appels).toHaveLength(3)
      expect(appels[2].patch).toEqual({ cropX: 0.8 })
    })

    it('ne retient pas la signature d’un échec tardif déjà dépassé', async () => {
      const gagnant = clip({ cropX: 0.9 })
      const { result, rejouer, appels } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      rejouer({ cropX: 0.9 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))

      // Le plus récent passe, et le cache adopte le clip rendu.
      await agir(() => appels[1].resoudre(reponse(gagnant, true)))
      rejouer({ reference: gagnant })
      expect(result.current).toBe('enregistre')

      // Le dépassé échoue après coup. Retenir sa signature poserait une mine :
      // le serveur va très bien, mais le jour où l'utilisateur ramène le cadrage
      // à cette valeur-là, l'écriture serait refusée par l'écran lui-même.
      await agir(() => appels[0].rejeter(new Error('réseau coupé')))

      rejouer({ cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))

      expect(result.current).not.toBe('echec')
      expect(appels).toHaveLength(3)
      expect(appels[2].patch).toEqual({ cropX: 0.8 })
    })
  })

  // **Le compteur de tentatives appartient à une instance du hook**, et la
  // promesse lui survit. Rouvrir le même clip donne un compteur neuf, incapable
  // de dépasser une écriture partie sous l'écran précédent — pendant que le
  // store, lui, est global et que sa garde ne regarde que l'identifiant du clip,
  // le même dans les deux sessions. (relevé par Codex)
  it('n’adopte plus rien pour une écriture encore en vol au démontage', async () => {
    const { unmount, appels, reconcilie } = monter({ ...auRepos, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    expect(appels).toHaveLength(1)

    unmount()
    await agir(() => appels[0].resoudre(reponse(clip({ cropX: 0.2 }), false)))

    expect(reconcilie).not.toHaveBeenCalled()
  })

  // **Un vidage sur `pagehide` est une écriture comme une autre**, même s'il
  // n'attend rien : il porte une intention plus récente que ce qui vole encore.
  // Sans lui faire prendre un rang, l'ancienne se croit toujours la dernière —
  // et une page restaurée depuis le bfcache lui laisse tout le temps de le
  // croire. (relevé par Copilot)
  it('périme les tentatives en vol quand le départ vide une modification', async () => {
    const { rejouer, appels, reconcilie } = monter({ ...auRepos, cropX: 0.8 })
    act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    expect(appels).toHaveLength(1)

    // Un geste de plus, promis mais pas encore parti, que la fermeture emporte.
    rejouer({ cropX: 0.9 })
    act(() => void window.dispatchEvent(new Event('pagehide')))
    expect(appels.map((a) => a.patch)).toEqual([{ cropX: 0.8 }, { cropX: 0.9 }])

    // La page revient du bfcache et l'utilisateur ramène le cadrage à 0,8 —
    // valeur qui redonne à la vieille réponse l'apparence d'être d'actualité.
    rejouer({ cropX: 0.8 })
    await agir(() => appels[0].resoudre(reponse(clip({ cropX: 0.2 }), false)))

    expect(reconcilie).not.toHaveBeenCalled()
  })

  describe('quand le serveur refuse pour jeton périmé', () => {
    it('n’affiche pas d’échec de l’enregistrement', async () => {
      const { result, appels } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      await agir(() => appels[0].resoudre(reponse(clip({ cropX: 0.2 }), false)))

      expect(result.current).not.toBe('echec')
    })

    it('remet le montage local d’accord avec le gagnant', async () => {
      const { appels, reconcilie } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      await agir(() => appels[0].resoudre(reponse(clip({ cropX: 0.2 }), false)))

      expect(reconcilie).toHaveBeenCalledWith('c1', { cropX: 0.2 })
    })

    it('ne renvoie pas l’intention refusée une fois réconcilié', async () => {
      // Le défaut que la réconciliation ferme : sans elle, l'écart réapparaît à
      // la comparaison suivante et l'intention refusée repart avec un jeton
      // neuf, donc gagnant — l'ordre payé côté serveur ne sert plus à rien.
      const gagnant = clip({ cropX: 0.2 })
      const { rejouer, appels } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      // Le cache adopte le clip rendu ; le store, lui, n'adopte que ce que la
      // réconciliation lui demande — et c'est tout l'objet de ce test.
      await agir(() => {
        rejouer({ reference: gagnant })
        appels[0].resoudre(reponse(gagnant, false))
      })
      act(() => void vi.advanceTimersByTime(10_000))

      expect(appels).toHaveLength(1)
    })

    it('réessaie quand le refus vient du plancher de jeton, pas d’un croisement', async () => {
      // Une horloge de navigateur remise en arrière produit des jetons
      // inférieurs à ce que la base a déjà appliqué : le serveur refuse une
      // modification pourtant fraîche et rend la valeur d'avant — celle qu'on a
      // déjà en référence. `usePatchClip` se recale sur le plancher annoncé, et
      // la tentative suivante passe. Réconcilier ici tuerait ce rétablissement
      // et perdrait la modification.
      const { rejouer, appels, reconcilie } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      await agir(() => appels[0].resoudre(reponse(auRepos.reference, false)))

      expect(reconcilie).not.toHaveBeenCalled()

      // Un geste de plus, et l'écriture repart — avec un jeton au-dessus du
      // plancher, donc gagnante.
      rejouer({ cropX: 0.81 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
      expect(appels).toHaveLength(2)
      expect(appels[1].patch).toEqual({ cropX: 0.81 })
    })

    it('ne jette pas un geste posé pendant l’aller-retour', async () => {
      const { rejouer, appels, reconcilie } = monter({ ...auRepos, cropX: 0.8 })
      act(() => void vi.advanceTimersByTime(TEMPORISATION_MS))

      // L'utilisateur continue de cadrer pendant que la réponse voyage.
      rejouer({ cropX: 0.42 })
      await agir(() => appels[0].resoudre(reponse(clip({ cropX: 0.2 }), false)))

      // Ce champ ne porte plus l'intention refusée : personne n'a refusé 0,42.
      expect(reconcilie).not.toHaveBeenCalled()
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
 * précédente, donc le second appel emporte le sort du premier. Un faux `ecrire`
 * qui se contente d'enregistrer ses rappels ne peut pas le voir.
 */
function monterSurObservateurPartage(depart: Props) {
  const envois: Appel[] = []
  const reconcilie = vi.fn()
  const client = new QueryClient()
  // Une case, et non une variable : TypeScript ne sait pas que le corps du hook
  // s'exécute, et refuserait de la considérer comme affectée.
  const direct: { ecrire: (variables: Variables) => void } = { ecrire: () => {} }

  const vue = renderHook(
    (rendus: Props) => {
      const patch = useMutation<PatchClipResult, Error, Variables>({
        mutationFn: (variables) => {
          const { promesse, resoudre, rejeter, repris } = promesseSurveillee<PatchClipResult>()
          envois.push({ patch: variables.patch, resoudre, rejeter, repris })
          return promesse
        },
      })
      direct.ecrire = patch.mutate
      return useEnregistrementAuto({
        pret: true,
        ...rendus,
        ecrire: patch.mutateAsync,
        reconcilier: (clipId, valeurs) => reconcilie(clipId, valeurs),
      })
    },
    {
      initialProps: depart,
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )

  return {
    ...vue,
    envois,
    reconcilie,
    /** Le geste ordinaire : taper un titre pendant que le montage s'enregistre. */
    ecrireUnTitre: (titre: string) =>
      direct.ecrire({ clipId: 'c1', projectId: 'p1', patch: { title: titre } }),
  }
}

describe('useEnregistrementAuto sur l’observateur partagé de l’écran', () => {
  it('réconcilie un refus alors qu’une écriture de titre est partie entre-temps', async () => {
    const { envois, reconcilie, ecrireUnTitre } = monterSurObservateurPartage({
      ...auRepos,
      cropX: 0.8,
    })
    await agir(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    expect(envois).toHaveLength(1)
    expect(envois[0].patch).toEqual({ cropX: 0.8 })

    // Entre l'écriture du montage et sa réponse : les deux surfaces sont côte à
    // côte sur le même écran, le croisement n'est pas un cas limite.
    await agir(() => ecrireUnTitre('Un autre titre'))
    expect(envois).toHaveLength(2)

    // Le serveur écarte le montage pour jeton périmé et rend le gagnant.
    await agir(() => envois[0].resoudre(reponse(clip({ cropX: 0.2 }), false)))

    expect(reconcilie).toHaveBeenCalledWith('c1', { cropX: 0.2 })
  })

  it('pose l’échec du montage alors qu’une autre mutation est partie depuis', async () => {
    const { result, envois, ecrireUnTitre } = monterSurObservateurPartage({
      ...auRepos,
      cropX: 0.8,
    })
    await agir(() => void vi.advanceTimersByTime(TEMPORISATION_MS))
    expect(envois).toHaveLength(1)

    await agir(() => ecrireUnTitre('Un autre titre'))
    await agir(() => envois[0].rejeter(new Error('réseau coupé')))

    expect(result.current).toBe('echec')

    // Et la signature ratée reste retenue : rien ne repart tout seul.
    await agir(() => void vi.advanceTimersByTime(10_000))
    expect(envois).toHaveLength(2)
  })
})
