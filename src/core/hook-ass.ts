import {
  BOM,
  escape,
  fontName,
  hundredths,
  styleColor,
  timeAss,
} from '@/core/captions/ass'
import { hookIsBurned, hookLayout, type ResolvedHook } from '@/core/hook'

/**
 * L'émetteur ASS du hook : le texte court incrusté dès la première image d'un
 * clip exporté (`docs/retour-ui-and-next-steps.md` §7).
 *
 * **Second document, second appel à `ass=filename=…` dans le graphe ffmpeg**
 * (`src/core/ffmpeg/args.ts`), posé après les sous-titres et avant les
 * marques. Pas une fusion avec `src/core/captions/ass.ts` : ce document n'a
 * qu'un seul `Dialogue`, pas de karaoké mot à mot, une police et une taille
 * différentes de celles des sous-titres, et sa propre transition d'entrée et
 * de sortie. Les fusionner aurait fait porter à `renderAss` des branches que
 * les sous-titres n'empruntent jamais.
 *
 * **`PlayResX: 384` est déclaré explicitement**, à la différence de
 * `renderAss` qui laisse libass déduire `PlayResX = PlayResY × 4/3` : toute
 * l'arithmétique des marges horizontales de `hookLayout` (`@/core/hook`)
 * suppose ce repère, et une déduction n'est pas un contrat.
 *
 * Les helpers de couleur, d'échappement et de temps viennent de
 * `@/core/captions/ass.ts`, exportés pour cette raison précise : deux
 * implémentations de la même conversion de couleur finiraient par ne plus
 * dire la même chose.
 */

/**
 * La durée du fondu, en millisecondes, pour les deux côtés (`enter`/`exit`).
 *
 * **300 ms, une valeur fixe.** Assez long pour se voir, assez court pour ne
 * pas manger la moitié d'un hook réglé à son plancher de durée (200 ms,
 * `HOOK_BOUNDS.durationMs.min`) — et sans y couper court : `\fad` déborde sur
 * la durée de l'événement sans lever, libass s'y adapte en fondant l'un dans
 * l'autre plutôt qu'en refusant.
 */
const FADE_MS = 300

/**
 * La durée de fondu pour un côté, en millisecondes — 0 pour `none`, ou pour
 * `glitch`/`scanline`, non implémentées dans cette PR.
 *
 * **`glitch` et `scanline` ne sont jamais rendus comme un `fade`.** L'énum
 * persistée les porte déjà (PR précédente), et l'écran Réglages les affiche
 * `disabled` : une valeur de l'un des deux peut donc arriver ici malgré tout,
 * par une base éditée à la main ou une régression amont. La rendre comme un
 * fondu serait le mensonge silencieux que ce dépôt refuse ailleurs (`CLAUDE.md`) —
 * mieux vaut avertir et ne rien montrer que montrer autre chose que ce qui a
 * été demandé.
 */
function fadeMsFor(transition: ResolvedHook['enter'] | ResolvedHook['exit'], side: 'entrée' | 'sortie'): number {
  if (transition === 'fade') return FADE_MS
  if (transition === 'glitch' || transition === 'scanline') {
    console.warn(
      `Transition de ${side} "${transition}" pas encore rendue (hors périmètre de cette PR) : ` +
        'le hook sera incrusté sans transition.',
    )
  }
  return 0
}

/** La balise `\fad(in,out)`, ou une chaîne vide quand les deux côtés sont `none`. */
function fadeTag(enter: ResolvedHook['enter'], exit: ResolvedHook['exit']): string {
  const fadeIn = fadeMsFor(enter, 'entrée')
  const fadeOut = fadeMsFor(exit, 'sortie')
  return fadeIn === 0 && fadeOut === 0 ? '' : `{\\fad(${fadeIn},${fadeOut})}`
}

/**
 * Le champ `Outline` de la ligne `Style`, en unités de script — **la seule
 * chose qui donne à la boîte de `BorderStyle: 3` un peu d'air autour du
 * texte.**
 *
 * **Mesuré sur le binaire, pas déduit de la doctrine ASS.** À `0`, libass ne
 * dessine aucune boîte du tout — pas même une boîte ajustée au plus près des
 * lettres, rien : le premier rendu de cette fonction sortait un texte blanc
 * nu sur fond flouté, `BorderStyle: 3` et `OutlineColour` posés pour rien.
 * `Outline` en est la cause : pour cette valeur de bordure, c'est elle qui
 * dimensionne le rembourrage de la boîte, contrairement à `renderAss` où elle
 * ne fait qu'épaissir un contour de trait (`BorderStyle: 1`).
 *
 * Proportionnel à `sizeUnits`, pour qu'un gros hook garde une marge propre
 * plutôt qu'une boîte collée aux lettres, ce qu'une constante fixe aurait
 * donné aux deux extrémités de `HOOK_BOUNDS.size`. Le plancher de 4 est ce qui
 * reste visible sur le plus petit hook possible (`sizeUnits` peut descendre à
 * son propre plancher de 10).
 */
function boxPadding(sizeUnits: number): number {
  return Math.max(4, Math.round(sizeUnits * 0.13))
}

/**
 * Le document ASS du hook, ou `null` quand il n'y a rien à incruster —
 * exactement quand `hookIsBurned(resolved)` est faux : hook désactivé, ou
 * texte vide.
 *
 * Un `Style` unique en boîte opaque (`BorderStyle: 3`) : `PrimaryColour` est
 * la couleur du texte, `OutlineColour` celle du fond — c'est là que le fond et
 * son opacité vivent. Un seul `Dialogue`, de `0:00:00.00` à la durée du hook.
 */
export function renderHookAss(resolved: ResolvedHook): string | null {
  if (!hookIsBurned(resolved)) return null

  const layout = hookLayout(resolved)
  const font = fontName(resolved.font)
  // Toujours opaque : contrairement au fond, le texte du hook n'a pas de
  // réglage de transparence qui lui soit propre — `1`, pas `bound(...)`
  // d'une valeur en pourcentage qui n'existe pas pour ce champ.
  const primary = styleColor(resolved.textColor, 1)
  // **`backgroundOpacity` est un pourcentage (0-100, `HOOK_BOUNDS`)**, et
  // `styleColor` attend une fraction (0-1, `bound(opacity, 0, 1, 1)`) : sans
  // cette division, toute valeur de 1 à 100 se bornerait à 1 (opaque), et le
  // réglage n'aurait plus d'effet qu'à ses deux extrémités (0 et [1, 100]).
  const outline = styleColor(resolved.backgroundColor, resolved.backgroundOpacity / 100)
  // Transparent, et sans conséquence : `Shadow: 0` plus bas ne dessine rien
  // avec cette couleur, comme dans `renderAss`.
  const shadow = styleColor('#000000', 0)

  const header =
    BOM +
    '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    'PlayResX: 384\n' +
    'PlayResY: 288\n' +
    'WrapStyle: 0\n' +
    'ScaledBorderAndShadow: yes\n' +
    '\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, ' +
    'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ' +
    'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
    'Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    `Style: Default,${font},${layout.sizeUnits},${primary},${primary},` +
    `${outline},${shadow},1,0,0,0,100,100,0,0,3,${boxPadding(layout.sizeUnits)},0,` +
    `${layout.assAlignment},${layout.marginL},${layout.marginR},${layout.marginV},1\n` +
    '\n' +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'

  const text = `${fadeTag(resolved.enter, resolved.exit)}${escape(resolved.text)}`
  const end = timeAss(hundredths(resolved.durationMs / 1000))
  const dialogue = `Dialogue: 0,0:00:00.00,${end},Default,,0,0,0,,${text}`

  return `${header}${dialogue}\n`
}
