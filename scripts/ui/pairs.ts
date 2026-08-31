/**
 * Les paires de recouvrement à surveiller, par écran — `ui-shot.ts` les
 * énumère toutes et échoue si l'une des deux moitiés d'une paire ne
 * résout à aucun élément (voir la garantie 1 du contrat `ui-shot`).
 *
 * Repris de `docs/superpowers/plans/2026-08-30-hierarchie-ecran-clip.md`
 * (lignes 219-250 et 678-706), avec les sélecteurs corrigés sur le DOM
 * réel de cette branche : `[role="tab"]`/`aria-pressed` n'existent nulle
 * part sur `clip-screen.tsx`, `[role="region"][aria-label="Transcript du
 * clip"]` est en fait un `role="group"`, et l'enchaînement
 * `nextElementSibling` des deux snippets se réécrit en sélecteur CSS
 * (`+`) pour tenir dans le type `OverlapPair`.
 */

export type OverlapPair = { readonly name: string; readonly a: string; readonly b: string }

/**
 * L'écran de clip (`src/components/clip/clip-screen.tsx`).
 *
 * La paire « figure vs onglet Temps » du premier snippet est absente :
 * le commutateur Temps/Mots qu'elle visait n'a jamais été (re)construit
 * depuis #289 — aucun `role="tab"` ni `aria-pressed` n'existe sur cet
 * écran aujourd'hui. À réintroduire quand ce commutateur reviendra.
 */
export const CLIP_SCREEN_PAIRS: readonly OverlapPair[] = [
  {
    name: 'figure vs transport',
    a: '[data-slot="source-row"] figure',
    b: '[data-slot="source-row"] + div',
  },
  {
    name: 'figure vs bande',
    a: '[data-slot="source-row"] figure',
    b: '[role="group"][aria-label="Bande de temps du clip"]',
  },
  {
    name: 'figure vs ruban',
    a: '[data-slot="source-row"] figure',
    b: '[data-testid="filmstrip"]',
  },
  {
    name: 'panneau transcript vs bande',
    a: '[role="group"][aria-label="Transcript du clip"]',
    b: '[role="group"][aria-label="Bande de temps du clip"]',
  },
  {
    name: 'panneau transcript vs ligne d’outils',
    a: '[role="group"][aria-label="Transcript du clip"]',
    b: '[role="region"][aria-label="Outils de cadrage"]',
  },
  {
    name: 'carte Montage vs ligne d’outils',
    a: '[role="group"][aria-label="Montage"]',
    b: '[role="region"][aria-label="Outils de cadrage"]',
  },
]

export const SCREEN_PAIRS: Readonly<Record<string, readonly OverlapPair[]>> = {
  clip: CLIP_SCREEN_PAIRS,
}

/** L'overlap vertical de deux rectangles `DOMRect`-like — jamais négatif. */
export function verticalOverlap(a: { top: number; bottom: number }, b: { top: number; bottom: number }): number {
  return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
}
