/**
 * Les tables de `fonts/Anton-Regular.ttf` qui régissent la conversion entre
 * `Fontsize` ASS et le `font-size` CSS équivalent. **libass traite `Fontsize`
 * comme une hauteur de ligne** (`usWinAscent + usWinDescent`), pas comme le
 * cadratin que CSS utilise — mesuré le 30 août 2026, voir `docs/lessons.md`.
 * `tests/server/font-metrics.test.ts` relit ces trois nombres depuis le
 * fichier de police lui-même, pour attraper un remplacement d'Anton.
 */
export const ANTON_UNITS_PER_EM = 2048
/** `OS/2.usWinAscent` (2876) + `OS/2.usWinDescent` (674). */
export const ANTON_WIN_HEIGHT = 3550
/** `OS/2.sTypoAscender` (2409) + `-OS/2.sTypoDescender` (674). */
export const ANTON_TYPO_HEIGHT = 3083

/** `Fontsize` ASS → `font-size` CSS, dans la même police. */
export const ASS_FONTSIZE_TO_EM = ANTON_UNITS_PER_EM / ANTON_WIN_HEIGHT

/** L'interligne que libass applique : exactement `Fontsize`, en cadratins. */
export const ASS_LINE_HEIGHT_OVER_EM = ANTON_WIN_HEIGHT / ANTON_UNITS_PER_EM

/**
 * Le demi-interligne CSS sous la ligne de base, en cadratins.
 *
 * Ne vaut que parce qu'Anton pose `OS/2.fsSelection` bit 7
 * (`USE_TYPO_METRICS`) : c'est alors `sTypoAscender`/`sTypoDescender`, pas
 * `usWin`, que le navigateur utilise pour construire la boîte de ligne.
 */
export const CSS_HALF_LEADING_OVER_EM = (ANTON_WIN_HEIGHT - ANTON_TYPO_HEIGHT) / (2 * ANTON_UNITS_PER_EM)
