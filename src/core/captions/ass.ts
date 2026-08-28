/**
 * L'émetteur ASS karaoké : des cartons en entrée, un fichier de sous-titres en
 * sortie, que ffmpeg incruste par libass.
 *
 * Porté de `openshorts/subtitles.py:321-439` (`generate_ass`) et de ses
 * constantes de style (`:240-254`). Le rendu d'openshorts convient (spec §9) :
 * karaoké mot à mot, Anton blanc en majuscules, mot actif en `#FFE500`, contour
 * noir. Ce qui change ici, c'est que ces valeurs sont **un preset modifiable**
 * et non des constantes en dur.
 *
 * Ce que la version d'origine porte et que celle-ci ne porte pas : les styles
 * `glow` et `box`, le mode « boîte de fond », l'atténuation des mots inactifs et
 * le choix de l'alignement. Aucun n'est retenu par la spec, et chacun ajouterait
 * un champ au preset que rien ne réglerait.
 *
 * **`bound`, `digits`, `HEX_COLOR`, `styleColor`, `colorInLine`, `escape`,
 * `fontName`, `hundredths`, `timeAss` et `BOM` n'étaient exportés que pour
 * `src/core/hook-ass.ts`**, le second émetteur ASS (le hook). Il a disparu le
 * 20 août 2026 : le hook s'incruste désormais par un PNG rasterisé
 * (`src/server/hook-image.ts`), pas par un second document ASS — un fond plein
 * à coins arrondis n'était pas atteignable avec `BorderStyle: 3`. Ces dix
 * symboles redeviennent internes à ce module, `renderAss` restant seul export
 * de rendu.
 *
 * **Exception : `fontName` est réexportée**, pour `src/server/caption-measure.ts`
 * — elle doit nettoyer le même nom que celui écrit dans `Style:` avant de le
 * passer à `ctx.font`, sous peine de mesurer une police que libass ne chargera
 * jamais.
 */

import type { Word } from '@/core/transcript'
import { MAX_CHARS_DEFAULT, MAX_DURATION_DEFAULT } from './cards'
import { wrapCard, type Measure } from './wrap'
export type { Measure } from './wrap'

/**
 * L'apparence des sous-titres. Spec §9 : « ces valeurs deviennent un preset
 * modifiable, pas des constantes en dur ».
 *
 * `maxChars` et `maxDuration` y figurent parce que c'est un seul réglage pour
 * l'utilisateur, mais **`renderAss` ne les lit pas** : ils décrivent le
 * découpage, qui a déjà eu lieu quand le rendu commence. Un appelant qui porte
 * un preset les passe donc lui-même à `splitIntoCards` —
 * `splitIntoCards(mots, style.maxChars, style.maxDuration)`. Les omettre ne
 * marche que tant que le preset vaut `DEFAULT_CAPTION_STYLE`.
 */
export type CaptionStyle = {
  fontName: string
  fontSize: number
  fontColor: string
  highlightColor: string
  borderColor: string
  borderWidth: number
  uppercase: boolean
  maxChars: number
  maxDuration: number
  marginV: number
}

/** La police embarquée dans `fonts/`, et le repli d'un nom vide ou illisible. */
const FONT_BY_DEFAULT = 'Anton'

/**
 * Le BOM UTF-8 qui ouvre le fichier : c'est à lui que les lecteurs de
 * sous-titres reconnaissent de l'Unicode.
 *
 * Nommé, et écrit par son point de code : un U+FEFF littéral au milieu d'une
 * chaîne est **invisible dans la source**, et la première édition de l'en-tête
 * le perdrait sans que personne ne le voie — jusqu'aux accents mangés au rendu.
 */
const BOM = '\uFEFF'

/**
 * La marge basse, en unités de `PlayResY` — soit ~15 % de la hauteur de l'image.
 *
 * **C'est une mesure, pas un goût.** Les 25 (8,7 %) de la version précédente
 * plaçaient les sous-titres sous l'interface de TikTok et de Reels — le bloc
 * légende/pseudo et le bandeau musical — où la plateforme les recouvrait en
 * partie, alors même que le fichier exporté paraissait correct.
 */
const MARGIN_LOW = 43

/**
 * La marge latérale, en unités de `PlayResY` — écrite en dur dans le bloc
 * `[V4+ Styles]` (`MarginL`/`MarginR`), jamais réglée par `CaptionStyle`.
 *
 * Partagée avec `CaptionOverlay`, qui en a besoin pour la même largeur de
 * boîte que le rendu : la confondre avec `MARGIN_LOW` (la marge basse, 43)
 * écrase le carton dans une colonne bien trop étroite.
 */
export const MARGIN_SIDE = 10

/**
 * Le look appliqué par défaut. Choisi dans openshorts en rendant quatre
 * candidats sur un vrai clip et en les comparant : Anton blanc en majuscules,
 * mot actif en jaune, contour noir épais, léger effet de pop. Le jaune parce
 * que c'est la seule couleur qui n'apparaît presque jamais dans l'image, donc
 * celle qui se lit instantanément sur n'importe quel fond.
 */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontName: FONT_BY_DEFAULT,
  // 22 → 120 px sur 1080×1920, mesuré le 23 août 2026 (44 → 247 px, spec §9).
  fontSize: 22,
  fontColor: '#FFFFFF',
  highlightColor: '#FFE500',
  borderColor: '#000000',
  borderWidth: 2,
  uppercase: true,
  maxChars: MAX_CHARS_DEFAULT,
  maxDuration: MAX_DURATION_DEFAULT,
  marginV: MARGIN_LOW,
}

const HEX_COLOR = /^[0-9A-Fa-f]{6}$/

/** Le nombre coercé et borné, ou `fallback` s'il n'est pas un nombre fini. */
function bound(value: number, min: number, max: number, fallback: number): number {
  const n = Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, n))
}

/** Le repère `PlayResY` de `renderAss`, partagé avec `CaptionOverlay` (spec §9). */
export const PLAYRES_Y = 288

/**
 * Le repère `PlayResX`, désormais déclaré explicitement. Vaut ce que
 * libass dérive déjà de `PlayResY: 288` quand `PlayResX` manque — `288 * 4/3`,
 * le 4:3 par défaut de la spec ASS — vérifié par diff d'image avant ce
 * changement : le rendu ne bouge pas. Le déclarer rend la largeur de retour à
 * la ligne testable, là où elle était jusqu'ici une valeur implicite du
 * moteur de rendu.
 */
export const PLAYRES_X = 384

/**
 * Taille de police, marge basse et épaisseur de contour dans les unités
 * `PlayResY` que `renderAss` écrit telles quelles.
 *
 * @returns `sizeUnits` — `Fontsize` ; `marginUnits` — `MarginV` ; `borderUnits`
 *   — `Outline`. Trois entiers dans le repère `PlayResY: 288`.
 */
export function captionUnits(
  style: Pick<CaptionStyle, 'fontSize' | 'marginV' | 'borderWidth'>,
): { sizeUnits: number; marginUnits: number; borderUnits: number } {
  return {
    // 0,85 : le facteur de la version d'origine, auquel le rendu de référence
    // a été réglé — ne pas le retoucher sans une mesure à l'appui.
    sizeUnits: Math.max(10, Math.floor(bound(style.fontSize, 10, 200, 22) * 0.85)),
    marginUnits: Math.round(bound(style.marginV, 0, 200, MARGIN_LOW)),
    // Un contour à 0 devient illisible sur un fond clair.
    borderUnits: Math.floor(bound(style.borderWidth, 1, 10, 2)),
  }
}

/**
 * Les six chiffres hexadécimaux d'une couleur, `fallback` si l'entrée n'en est pas
 * une.
 *
 * Un repli plutôt qu'une exception : une couleur invalide vient d'un preset
 * édité à la main, et elle ne doit pas faire échouer un export de trois minutes.
 */
function digits(color: string, fallback: string): string {
  const digits = String(color ?? '').replace(/^#/, '')
  return HEX_COLOR.test(digits) ? digits.toUpperCase() : fallback
}

function twoDigits(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * `#RRGGBB` → `&HAABBGGRR`, la forme des couleurs du **bloc `[V4+ Styles]`**.
 *
 * `opacity` vaut 1 pour opaque et 0 pour transparent — l'inverse de l'alpha ASS,
 * où 255 est transparent.
 */
function styleColor(color: string, opacity: number, fallback = 'FFFFFF'): string {
  const d = digits(color, fallback)
  const alpha = Math.round((1 - bound(opacity, 0, 1, 1)) * 255)
  return `&H${twoDigits(alpha)}${d.slice(4, 6)}${d.slice(2, 4)}${d.slice(0, 2)}`
}

/**
 * `#RRGGBB` → `&HBBGGRR&`, la forme des surcharges `\c` **en ligne**.
 *
 * Deux formats de couleur dans le même fichier, et les confondre ne produit
 * aucune erreur : juste des couleurs inversées. `#FFE500` s'écrit `&H00E5FF&`
 * ici et `&H0000E5FF` là-haut.
 */
function colorInLine(color: string, fallback = 'FFD700'): string {
  const d = digits(color, fallback)
  return `&H${d.slice(4, 6)}${d.slice(2, 4)}${d.slice(0, 2)}&`
}

/**
 * L'instant en centièmes de seconde entiers — **la seule unité que le fichier
 * connaisse**.
 *
 * Arrondir ici, une fois, et raisonner ensuite sur des entiers, est ce qui rend
 * les bornes d'un événement comparables dans l'unité où elles seront écrites.
 * La version d'origine gardait les secondes flottantes jusqu'au formatage, ce
 * qui laissait passer un événement de quatre millisecondes — écrit avec un début
 * et une fin identiques.
 */
function hundredths(seconds: number): number {
  return Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 100)
}

/**
 * `H:MM:SS.cc` — l'horodatage ASS, formé d'un compte de centièmes.
 *
 * La décomposition part du total et non de la seconde : c'est ce qui propage la
 * retenue. La version d'origine arrondissait la partie fractionnaire à part puis
 * écrêtait à 99 pour éviter un `0:00:59.100` — ce qui écrit `59,999` en
 * `0:00:59.99` et perd jusqu'à dix millisecondes au passage de chaque seconde.
 */
function timeAss(hundredths: number): string {
  const hours = Math.floor(hundredths / 360000)
  const minutes = Math.floor((hundredths % 360000) / 6000)
  const s = Math.floor((hundredths % 6000) / 100)
  const c = hundredths % 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

/**
 * Neutralise les métacaractères d'ASS dans du texte à afficher.
 *
 * `{` ouvre un bloc de balises, `}` le referme, `\` introduit une balise ou un
 * saut de ligne (`\N`). Le texte vient d'un transcript, donc de la parole : rien
 * n'y garantit l'absence de ces trois caractères, et un `{` non refermé fait
 * disparaître la fin du carton sans que libass ne signale rien.
 *
 * Un saut de ligne **littéral** est le quatrième, et le plus destructeur : un
 * événement tient sur une ligne, donc un U+000A dans un mot coupe la ligne
 * `Dialogue:` en deux et rend le fichier illisible à partir de là.
 * `splitIntoCards` normalise déjà les blancs, mais `renderAss` est exporté et
 * doit tenir seul.
 *
 * **Substitution et non échappement** : ASS n'a pas d'échappement d'accolade sur
 * lequel les lecteurs s'accordent. On remplace donc par un caractère voisin —
 * c'est ce que fait la version d'origine, éprouvée en production.
 */
function escape(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
}

/**
 * Ne garde du nom de police que `[A-Za-z0-9 _-]`.
 *
 * Une virgule y ajouterait des champs à la ligne `Style:`, donc réécrirait la
 * taille, les couleurs et la marge qui la suivent ; une accolade ou un antislash
 * y ouvriraient des balises.
 */
export function fontName(name: string): string {
  const clean = String(name ?? '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
  return clean === '' ? FONT_BY_DEFAULT : clean
}

/**
 * Le fichier ASS complet : en-tête, style, et **un événement `Dialogue` par
 * mot**.
 *
 * Chaque événement réémet le carton entier et n'enveloppe que le mot actif. Il
 * n'y a donc pas de « sous-titre qui s'affiche puis se colore » : il y a autant
 * de sous-titres identiques que de mots, dont un seul diffère à chaque fois.
 * C'est ce qui fait avancer le surlignage sans un seul clignotement.
 *
 * Les bornes de chaque événement : il commence au mot actif — donc, pour le
 * premier, au début du carton — et se termine au début du mot suivant, le
 * dernier tenant jusqu'à la fin du carton. Aucun trou entre deux mots, donc rien
 * qui disparaisse pendant un silence. Un événement dont la fin ne dépasse pas le
 * début est sauté : libass le rejetterait de toute façon, et deux mots qui
 * démarrent au même instant en produisent un.
 *
 * La chaîne rendue commence par un **BOM UTF-8**. C'est une propriété du
 * fichier, pas de l'écriture : les lecteurs de sous-titres s'en servent pour
 * reconnaître de l'Unicode, et l'appelant n'a donc qu'à écrire cette chaîne
 * telle quelle en UTF-8.
 *
 * Sans carton, le document rendu est valide et ne porte aucun événement. C'est à
 * l'appelant de décider s'il vaut la peine d'incruster un fichier vide.
 */
export function renderAss(cards: Word[][], style: CaptionStyle, measure: Measure): string {
  // Partagé avec `CaptionOverlay` — voir `captionUnits`.
  const { sizeUnits: size, marginUnits: margin, borderUnits: thickness } = captionUnits(style)
  const font = fontName(style.fontName)

  const main = styleColor(style.fontColor, 1)
  const outline = styleColor(style.borderColor, 1, '000000')
  // Le `BackColour` sert l'ombre portée, qui est à zéro : entièrement
  // transparent, il ne peut rien assombrir.
  const background = styleColor('#000000', 0)
  const highlight = colorInLine(style.highlightColor)

  // L'effet `pop` : le mot actif change de couleur et grossit en 110 ms. La
  // plage 90 → 108 est douce à dessein — le 75 → 112 d'une version antérieure
  // partait de si bas qu'une image saisie en pleine animation se lisait comme un
  // défaut de dimensionnement plutôt que comme un temps fort.
  //
  // `ACTIVE_WORD_PEAK_SCALE` porte le même 108 que la balise `\fscx`/`\fscy` :
  // une seule source, pour que la garantie anti-débordement de `measureAtPeak`
  // ne se décale jamais en silence si l'animation est retouchée.
  const ACTIVE_WORD_PEAK_SCALE = 1.08
  const peakPercent = Math.round(ACTIVE_WORD_PEAK_SCALE * 100)
  const wordActive = `{\\c${highlight}\\fscx90\\fscy90\\t(0,110,\\fscx${peakPercent}\\fscy${peakPercent})}`

  // `PlayResX` est désormais déclaré — voir sa doc — et `WrapStyle: 2` interdit
  // à libass tout retour à la ligne automatique : les seules coupures sont les
  // `\N` explicites posés plus bas par `wrapCard`.
  //
  // `Alignment: 2` — bas centré. C'est ce que `marginV` mesure : une marge
  // depuis le bas.
  const header =
    BOM + '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    `PlayResX: ${PLAYRES_X}\n` +
    `PlayResY: ${PLAYRES_Y}\n` +
    'WrapStyle: 2\n' +
    'ScaledBorderAndShadow: yes\n' +
    '\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, ' +
    'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ' +
    'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
    'Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    `Style: Default,${font},${size},${main},${main},` +
    `${outline},${background},1,0,0,0,100,100,0,0,1,${thickness},0,2,${MARGIN_SIDE},${MARGIN_SIDE},${margin},1\n` +
    '\n' +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'

  // `PLAYRES_X - 2 * MARGIN_SIDE` : la largeur disponible entre les marges
  // latérales du bloc `[V4+ Styles]`, dans le même repère que `PlayResX`.
  const maxWidth = PLAYRES_X - 2 * MARGIN_SIDE

  // Le mot actif grossit jusqu'à `ACTIVE_WORD_PEAK_SCALE` pendant l'animation
  // (`wordActive`), mais `wrapCard` ne voit que des mots mesurés à 100 % : une
  // ligne calée pile sous `maxWidth` déborderait donc pendant le pic, sans que
  // `WrapStyle: 2` ne laisse plus libass corriger. On mesure ici la largeur
  // pire cas — le mot le plus large de la ligne porté à son pic — plutôt que
  // celle, plus optimiste, où tous les mots restent à 100 %.
  const measureAtPeak: typeof measure = (text) => {
    const words = text.split(' ')
    const widest = Math.max(...words.map(measure))
    return measure(text) + widest * (ACTIVE_WORD_PEAK_SCALE - 1)
  }

  const events: string[] = []
  for (const card of cards) {
    if (card.length === 0) continue

    // Le texte affiché de chaque mot, calculé une seule fois pour tout le
    // carton : c'est lui que `measure` doit mesurer, puisque c'est lui que
    // libass trace — pas le mot brut du transcript.
    const displayWords = card.map((w) => (style.uppercase ? escape(w.word).toUpperCase() : escape(w.word)))
    const breakAfter = wrapCard(displayWords, measureAtPeak, maxWidth)

    for (let i = 0; i < card.length; i++) {
      // L'événement commence au mot actif — ce qui, pour le premier, revient au
      // début du carton — et se termine au début du mot suivant.
      //
      // Les deux bornes sont converties en centièmes **avant** d'être comparées :
      // c'est l'unité du fichier, et c'est donc la seule où « la fin dépasse le
      // début » veut dire quelque chose. Comparées en secondes, deux bornes
      // distantes de quatre millisecondes passaient la garde et s'écrivaient
      // identiques.
      const start = hundredths(card[i].start)
      const fin = hundredths(i < card.length - 1 ? card[i + 1].start : card[i].end)
      if (fin <= start) continue

      // La même coupure `breakAfter` pour tous les événements du carton, quel
      // que soit le mot actif : c'est ce qui rend la mise en lignes stable.
      const parts = displayWords.map((text, j) => (j === i ? `${wordActive}${text}{\\r}` : text))
      const lines: string[] = []
      let line: string[] = []
      parts.forEach((part, j) => {
        line.push(part)
        if (breakAfter[j]) {
          lines.push(line.join(' '))
          line = []
        }
      })
      if (line.length > 0) lines.push(line.join(' '))

      events.push(
        `Dialogue: 0,${timeAss(start)},${timeAss(fin)},Default,,0,0,0,,${lines.join('\\N')}`,
      )
    }
  }

  return events.length === 0 ? header : `${header}${events.join('\n')}\n`
}
