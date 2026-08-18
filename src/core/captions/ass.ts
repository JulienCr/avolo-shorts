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
 */

import type { Word } from '@/core/transcript'
import { MAX_CHARS_DEFAUT, MAX_DURATION_DEFAUT } from './cards'

/**
 * L'apparence des sous-titres. Spec §9 : « ces valeurs deviennent un preset
 * modifiable, pas des constantes en dur ».
 *
 * `maxChars` et `maxDuration` décrivent le découpage plutôt que le rendu, mais
 * ils voyagent avec le reste : c'est un seul réglage pour l'utilisateur, et les
 * séparer obligerait l'appelant à en transporter deux.
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
const POLICE_PAR_DEFAUT = 'Anton'

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
const MARGE_BASSE = 43

/**
 * Le look appliqué par défaut. Choisi dans openshorts en rendant quatre
 * candidats sur un vrai clip et en les comparant : Anton blanc en majuscules,
 * mot actif en jaune, contour noir épais, léger effet de pop. Le jaune parce
 * que c'est la seule couleur qui n'apparaît presque jamais dans l'image, donc
 * celle qui se lit instantanément sur n'importe quel fond.
 */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontName: POLICE_PAR_DEFAUT,
  fontSize: 44,
  fontColor: '#FFFFFF',
  highlightColor: '#FFE500',
  borderColor: '#000000',
  borderWidth: 4,
  uppercase: true,
  maxChars: MAX_CHARS_DEFAUT,
  maxDuration: MAX_DURATION_DEFAUT,
  marginV: MARGE_BASSE,
}

const HEX_COULEUR = /^[0-9A-Fa-f]{6}$/

/** Le nombre coercé et borné, ou `repli` s'il n'est pas un nombre fini. */
function borner(valeur: number, min: number, max: number, repli: number): number {
  const n = Number.isFinite(valeur) ? valeur : repli
  return Math.max(min, Math.min(max, n))
}

/**
 * Les six chiffres hexadécimaux d'une couleur, `repli` si l'entrée n'en est pas
 * une.
 *
 * Un repli plutôt qu'une exception : une couleur invalide vient d'un preset
 * édité à la main, et elle ne doit pas faire échouer un export de trois minutes.
 */
function chiffres(couleur: string, repli: string): string {
  const digits = String(couleur ?? '').replace(/^#/, '')
  return HEX_COULEUR.test(digits) ? digits.toUpperCase() : repli
}

function deuxChiffres(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * `#RRGGBB` → `&HAABBGGRR`, la forme des couleurs du **bloc `[V4+ Styles]`**.
 *
 * `opacite` vaut 1 pour opaque et 0 pour transparent — l'inverse de l'alpha ASS,
 * où 255 est transparent.
 */
function couleurDeStyle(couleur: string, opacite: number, repli = 'FFFFFF'): string {
  const d = chiffres(couleur, repli)
  const alpha = Math.round((1 - borner(opacite, 0, 1, 1)) * 255)
  return `&H${deuxChiffres(alpha)}${d.slice(4, 6)}${d.slice(2, 4)}${d.slice(0, 2)}`
}

/**
 * `#RRGGBB` → `&HBBGGRR&`, la forme des surcharges `\c` **en ligne**.
 *
 * Deux formats de couleur dans le même fichier, et les confondre ne produit
 * aucune erreur : juste des couleurs inversées. `#FFE500` s'écrit `&H00E5FF&`
 * ici et `&H0000E5FF` là-haut.
 */
function couleurEnLigne(couleur: string, repli = 'FFD700'): string {
  const d = chiffres(couleur, repli)
  return `&H${d.slice(4, 6)}${d.slice(2, 4)}${d.slice(0, 2)}&`
}

/** `H:MM:SS.cc` — l'horodatage ASS, au centième. */
function tempsAss(secondes: number): string {
  const t = Math.max(0, Number.isFinite(secondes) ? secondes : 0)
  const heures = Math.floor(t / 3600)
  const minutes = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  // Le plafond à 99 rattrape l'arrondi qui ferait déborder d'une seconde
  // (`59,999` → `60`), ce qui donnerait un horodatage qu'aucun lecteur n'accepte.
  const centiemes = Math.min(99, Math.round((t - Math.floor(t)) * 100))
  return `${heures}:${String(minutes).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(centiemes).padStart(2, '0')}`
}

/**
 * Neutralise les métacaractères d'ASS dans du texte à afficher.
 *
 * `{` ouvre un bloc de balises, `}` le referme, `\` introduit une balise ou un
 * saut de ligne (`\N`). Le texte vient d'un transcript, donc de la parole : rien
 * n'y garantit l'absence de ces trois caractères, et un `{` non refermé fait
 * disparaître la fin du carton sans que libass ne signale rien.
 *
 * **Substitution et non échappement** : ASS n'a pas d'échappement d'accolade sur
 * lequel les lecteurs s'accordent. On remplace donc par un caractère voisin —
 * c'est ce que fait la version d'origine, éprouvée en production.
 */
function echapper(texte: string): string {
  return texte.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')')
}

/**
 * Ne garde du nom de police que `[A-Za-z0-9 _-]`.
 *
 * Une virgule y ajouterait des champs à la ligne `Style:`, donc réécrirait la
 * taille, les couleurs et la marge qui la suivent ; une accolade ou un antislash
 * y ouvriraient des balises.
 */
function nomDePolice(nom: string): string {
  const propre = String(nom ?? '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
  return propre === '' ? POLICE_PAR_DEFAUT : propre
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
export function renderAss(cards: Word[][], style: CaptionStyle): string {
  // La taille est exprimée dans le repère `PlayResY: 288`, pas en pixels de
  // l'image : le facteur 0,85 est celui de la version d'origine, à laquelle le
  // rendu de référence a été réglé. 44 devient donc 37.
  const taille = Math.max(10, Math.floor(borner(style.fontSize, 10, 200, 44) * 0.85))
  const police = nomDePolice(style.fontName)
  const epaisseur = Math.max(1, Math.floor(borner(style.borderWidth, 0, 10, 4)))
  const marge = Math.round(borner(style.marginV, 0, 200, MARGE_BASSE))

  const principale = couleurDeStyle(style.fontColor, 1)
  const contour = couleurDeStyle(style.borderColor, 1, '000000')
  // Le `BackColour` sert l'ombre portée, qui est à zéro : entièrement
  // transparent, il ne peut rien assombrir.
  const fond = couleurDeStyle('#000000', 0)
  const surlignage = couleurEnLigne(style.highlightColor)

  // L'effet `pop` : le mot actif change de couleur et grossit en 110 ms. La
  // plage 90 → 108 est douce à dessein — le 75 → 112 d'une version antérieure
  // partait de si bas qu'une image saisie en pleine animation se lisait comme un
  // défaut de dimensionnement plutôt que comme un temps fort.
  const motActif = `{\\c${surlignage}\\fscx90\\fscy90\\t(0,110,\\fscx108\\fscy108)}`

  // `PlayResX` n'est volontairement pas déclaré, comme dans la version d'origine
  // dont le rendu fait référence. En ajouter un changerait l'échelle du texte
  // par rapport à cette référence : à ne toucher qu'avec une mesure à l'appui.
  //
  // `Alignment: 2` — bas centré. C'est ce que `marginV` mesure : une marge
  // depuis le bas.
  const entete =
    BOM + '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    'PlayResY: 288\n' +
    'WrapStyle: 0\n' +
    'ScaledBorderAndShadow: yes\n' +
    '\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, ' +
    'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ' +
    'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
    'Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    `Style: Default,${police},${taille},${principale},${principale},` +
    `${contour},${fond},1,0,0,0,100,100,0,0,1,${epaisseur},0,2,10,10,${marge},1\n` +
    '\n' +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'

  const events: string[] = []
  for (const card of cards) {
    if (card.length === 0) continue
    for (let i = 0; i < card.length; i++) {
      // L'événement commence au mot actif — ce qui, pour le premier, revient au
      // début du carton — et se termine au début du mot suivant.
      const debut = card[i].start
      const fin = i < card.length - 1 ? card[i + 1].start : card[card.length - 1].end
      if (fin <= debut) continue

      const parts = card.map((autre, j) => {
        const texte = style.uppercase ? echapper(autre.word).toUpperCase() : echapper(autre.word)
        return j === i ? `${motActif}${texte}{\\r}` : texte
      })

      events.push(
        `Dialogue: 0,${tempsAss(debut)},${tempsAss(fin)},Default,,0,0,0,,${parts.join(' ')}`,
      )
    }
  }

  return events.length === 0 ? entete : `${entete}${events.join('\n')}\n`
}
