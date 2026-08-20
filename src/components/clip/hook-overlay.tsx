import { hookIsBurned, hookLayout, type ResolvedHook } from '@/core/hook'
import { hookFont } from '@/components/clip/hook-font'

/**
 * Le calque de preview du hook, dans l'aperçu 9:16 (`output-preview.tsx`).
 *
 * **Un calque DOM, frère du `<canvas>`, jamais peint dedans.** Le `<canvas>`
 * ne porte que l'image vidéo cadrée — il occupe `part * 100 %` de la boîte,
 * la part que le ratio choisi laisse au contenu — alors que le hook s'incruste
 * sur le 9:16 **complet**, bandes floutées comprises. Peindre le hook dans le
 * canvas l'enfermerait dans la bande centrale et le ferait sauter de place à
 * chaque changement de ratio, ce que ce calque évite en couvrant toute la
 * boîte, indépendamment du canvas qu'il recouvre.
 *
 * **Les unités sont `cqh`/`cqw`, jamais des pixels.** Le repère du rendu est
 * `PlayResX 384 × PlayResY 288` (`src/core/hook.ts`) ; la boîte qui porte ce
 * calque n'a pas de taille fixe — sa hauteur vient d'une classe Tailwind que
 * l'appelant choisit (`PREVIEW_HEIGHT`, `clip-screen.tsx`). `containerType:
 * 'size'` est posé par `output-preview.tsx` sur la boîte elle-même, pas ici :
 * c'est elle qui définit le contexte de requête de conteneur que ces unités
 * lisent.
 *
 * **Toutes les valeurs viennent de `hookLayout(hook)`** — la même fonction
 * que l'émetteur ASS de la PR de rendu consomme pour poser le hook dans le
 * fichier réellement encodé. C'est la garantie de cette preview : pas une
 * géométrie parallèle qui lui ressemblerait, la même.
 *
 * **Ce que ce calque ne peut pas promettre.** Il est exact sur la position, la
 * boîte, les couleurs et la taille : ce sont des nombres, traduits sans
 * approximation. Il est **approché d'un mot sur la coupure de ligne** : libass
 * (le moteur qui incruste le rendu final) et le navigateur ne calculent pas
 * l'interlignage et le passage à la ligne selon la même formule. Un hook
 * d'une ligne ne bouge pas d'un pixel entre les deux ; un hook qui revient à
 * la ligne peut la couper à un mot différent. Ce n'est pas un défaut de ce
 * calque, c'est une limite qu'il faut connaître avant de traiter le moindre
 * écart d'un mot comme un bug.
 */

/**
 * Le bord vertical que désigne l'alignement ASS 1-9, dérivé de sa *rangée*
 * — `7 8 9` en haut, `4 5 6` au centre, `1 2 3` en bas, la convention que
 * `assAlignmentFor` (`@/core/hook`) pose. Une dérivation pure de la valeur
 * numérique que `hookLayout` rend déjà, pas un second calcul de position.
 */
function verticalEdge(assAlignment: number): 'top' | 'center' | 'bottom' {
  if (assAlignment >= 7) return 'top'
  if (assAlignment >= 4) return 'center'
  return 'bottom'
}

/** La colonne, même principe : `1 4 7` à gauche, `2 5 8` au centre, `3 6 9` à droite. */
function horizontalAlign(assAlignment: number): 'left' | 'center' | 'right' {
  const column = ((assAlignment - 1) % 3) + 1
  if (column === 1) return 'left'
  if (column === 2) return 'center'
  return 'right'
}

/**
 * `u` unités du script ASS, en pourcentage de la largeur du conteneur
 * (`PlayResX = 384`).
 *
 * **Enveloppé dans `calc(…)`, même à un seul terme.** jsdom (`tests/`) refuse
 * une longueur en `cqw`/`cqh` nue — l'unité n'existe pas encore dans son
 * analyseur CSS — mais accepte et évalue un `calc()` qui la contient. Un
 * navigateur réel traite les deux formes de façon identique : `calc(x)` vaut
 * `x`. C'est donc l'écriture qui fonctionne des deux côtés, pas un
 * contournement propre au test.
 */
function cqw(units: number): string {
  return `calc(${(units / 384) * 100}cqw)`
}

/** Idem en hauteur (`PlayResY = 288`). */
function cqh(units: number): string {
  return `calc(${(units / 288) * 100}cqh)`
}

/** `#RRGGBB` + une opacité 0-100 → `rgba()`. Pure, exportée pour le test. */
export function rgbaFrom(hex: string, opacityPercent: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacityPercent / 100})`
}

export function HookOverlay({ hook }: { hook: ResolvedHook }) {
  // Rien à incruster : le hook est désactivé, ou son texte est vide — l'état
  // initial de tout clip nouvellement gardé, avant que le repérage ou une
  // saisie manuelle ne pose `hookText`.
  if (!hookIsBurned(hook)) return null

  const layout = hookLayout(hook)
  const edge = verticalEdge(layout.assAlignment)
  const align = horizontalAlign(layout.assAlignment)

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex flex-col"
      style={{
        justifyContent: edge === 'top' ? 'flex-start' : edge === 'bottom' ? 'flex-end' : 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          textAlign: align,
          paddingLeft: cqw(layout.marginL),
          paddingRight: cqw(layout.marginR),
          paddingTop: edge === 'top' ? cqh(layout.marginV) : undefined,
          paddingBottom: edge === 'bottom' ? cqh(layout.marginV) : undefined,
        }}
      >
        <span
          className={hookFont.className}
          style={{
            display: 'inline-block',
            fontSize: `calc(${layout.sizeUnits} / 288 * 100 * 1cqh)`,
            lineHeight: 1.15,
            color: hook.textColor,
            backgroundColor: rgbaFrom(hook.backgroundColor, hook.backgroundOpacity),
            padding: '0.15em 0.35em',
            whiteSpace: 'pre-wrap',
          }}
        >
          {hook.text}
        </span>
      </div>
    </div>
  )
}
