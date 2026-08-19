// @vitest-environment jsdom

/**
 * Ce qu'un aller-retour vers un clip doit retrouver, et qui n'a rien à faire
 * dans l'URL : la position de défilement et la carte d'où l'on est parti.
 *
 * La vue active, elle, est dans l'URL — un rechargement doit rendre le même
 * écran. Une position de défilement dans une URL est une URL qu'on ne peut plus
 * partager.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { lireSessionTri, écrireSessionTri } from '@/components/tri/session'

afterEach(() => {
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('la session de tri', () => {
  it('rend un état neutre pour un projet jamais visité', () => {
    expect(lireSessionTri('inconnu')).toEqual({
      carte: null,
      defilement: 0,
      vue: null,
      retour: false,
      postedAt: null,
    })
  })

  it('retrouve la carte et le défilement du projet', () => {
    écrireSessionTri('p1', { carte: 'c7', defilement: 940, vue: 'gardes' })
    expect(lireSessionTri('p1')).toEqual({
      carte: 'c7',
      defilement: 940,
      vue: 'gardes',
      retour: false,
      postedAt: null,
    })
  })

  it('ne mélange pas deux projets', () => {
    // Le retour depuis un clip vise **sa** grille : reprendre la carte d'une
    // autre émission ferait sauter dans une liste sans que le geste l'explique.
    écrireSessionTri('p1', { carte: 'c7' })
    écrireSessionTri('p2', { carte: 'c9' })
    expect(lireSessionTri('p1').carte).toBe('c7')
    expect(lireSessionTri('p2').carte).toBe('c9')
  })

  it('écrit un champ sans effacer l’autre', () => {
    écrireSessionTri('p1', { carte: 'c7', defilement: 940 })
    écrireSessionTri('p1', { defilement: 12 })
    expect(lireSessionTri('p1')).toEqual({
      carte: 'c7',
      defilement: 12,
      vue: null,
      retour: false,
      postedAt: null,
    })
  })

  it('survit à un stockage indisponible', () => {
    // Navigation privée, quota, rendu serveur : perdre une position de
    // défilement est ennuyeux, faire tomber l'écran de tri ne l'est pas.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => écrireSessionTri('p1', { carte: 'c1' })).not.toThrow()
  })

  it('survit à un contenu illisible', () => {
    // Une clé écrite par une version précédente, ou bricolée à la main.
    window.sessionStorage.setItem('avolo-shorts:tri:p1', '{pas du json')
    expect(lireSessionTri('p1')).toEqual({
      carte: null,
      defilement: 0,
      vue: null,
      retour: false,
      postedAt: null,
    })
  })

  it('refuse un contenu du bon format mais du mauvais type', () => {
    window.sessionStorage.setItem('avolo-shorts:tri:p1', '{"carte":42,"defilement":"beaucoup"}')
    expect(lireSessionTri('p1')).toEqual({
      carte: null,
      defilement: 0,
      vue: null,
      retour: false,
      postedAt: null,
    })
  })

  it('ne prend pour un retour que la valeur vraie', () => {
    // La marque autorise à déplacer le focus et la vue : une valeur douteuse
    // dans la clé ne doit pas suffire à le déclencher.
    window.sessionStorage.setItem('avolo-shorts:tri:p1', '{"retour":"oui"}')
    expect(lireSessionTri('p1').retour).toBe(false)
  })

  it('refuse une vue que l’écran ne connaît pas', () => {
    // La clé se bricole à la main : une vue inconnue ferait rendre une grille
    // vide, sans que rien n'explique pourquoi.
    window.sessionStorage.setItem('avolo-shorts:tri:p1', '{"vue":"toutes"}')
    expect(lireSessionTri('p1').vue).toBeNull()
  })
})

describe('la marque de retour, et sa durée de vie', () => {
  // Issue #56, point 1 : la marque est posée au clic vers un clip, et rien ne
  // la retire si l'on quitte le clip sans revenir au projet (vers la
  // bibliothèque, ou un Ctrl/Cmd/Shift + clic qui ouvre un onglet sans
  // naviguer — les deux émettent un vrai `click`). Sans horodatage, la visite
  // suivante du projet, ordinaire celle-là, hérite d'une marque orpheline.
  //
  // Le clic du milieu, lui, émet `auxclick` et ne pose jamais la marque : ce
  // n'est pas un cas à couvrir ici, et rien dans ce module ne doit se mettre
  // à l'écouter.

  it('horodate la marque au moment où elle est posée', () => {
    const before = Date.now()
    écrireSessionTri('p1', { retour: true, carte: 'c1' })
    const after = Date.now()

    const { postedAt } = lireSessionTri('p1')
    expect(postedAt).not.toBeNull()
    expect(postedAt as number).toBeGreaterThanOrEqual(before)
    expect(postedAt as number).toBeLessThanOrEqual(after)
  })

  it('honore une marque fraîche', () => {
    écrireSessionTri('p1', { retour: true, carte: 'c1' })
    expect(lireSessionTri('p1').retour).toBe(true)
  })

  it('expire une marque trop vieille, un aller-retour normal ne l’est jamais', () => {
    // Un aller-retour normal — ouvrir le clip, le monter, revenir — se joue en
    // quelques minutes. Une marque de plus de trente minutes ne décrit plus un
    // aller-retour en cours.
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    écrireSessionTri('p1', { retour: true, carte: 'c1' })

    now.mockReturnValue(1_000_000 + 31 * 60 * 1000)
    expect(lireSessionTri('p1').retour).toBe(false)
  })

  it('ne prend pas une marque sans horodatage pour une marque fraîche', () => {
    // Une clé bricolée à la main, ou écrite par une version antérieure du
    // module qui ne connaissait pas encore `postedAt`.
    window.sessionStorage.setItem('avolo-shorts:tri:p1', '{"retour":true,"carte":"c1"}')
    expect(lireSessionTri('p1').retour).toBe(false)
  })

  it('refuse une marque horodatée dans le futur', () => {
    // Une horloge reculée, ou une clé bricolée à la main : sans le contrôle
    // de signe, un âge négatif restait toujours sous la limite et la marque
    // ne périmait jamais. (relevé par Copilot)
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    window.sessionStorage.setItem(
      'avolo-shorts:tri:p1',
      JSON.stringify({ retour: true, carte: 'c1', postedAt: 1_000_000 + 60_000 }),
    )
    expect(lireSessionTri('p1').retour).toBe(false)
  })
})
