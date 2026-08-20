import type { Clip } from '@/core/edl'

/**
 * Le hook : un texte court incrusté dès la première image d'un clip exporté,
 * pour accrocher dans le fil avant que le spectateur comprenne le contexte
 * (`docs/retour-ui-and-next-steps.md` §6.3 et §7 — note de travail de l'auteur
 * du projet, volontairement non versionnée : ce fichier ne se trouve pas dans
 * le dépôt cloné).
 *
 * **Ce module est l'interface dont héritent l'émetteur ASS (rendu) et le
 * calque de preview (écran Clip).** Sa signature est celle que l'orchestrateur
 * a figée pour la flotte : `resolveHook`, `hookIsBurned`, `hookLayout` et
 * `normalizeHookText` ne bougent pas d'une PR à l'autre — c'est ce qui permet
 * aux deux camps de calculer la même géométrie sans se copier l'un l'autre.
 *
 * **`HookSettings` et les valeurs qui le bornent vivent ici, pas dans
 * `src/lib/api.ts`, et c'est une contrainte de la frontière de pureté.**
 * `resolveHook` prend `Pick<Clip, 'hookText' | 'hookStyle'>` en argument, donc
 * ce fichier importe le type `Clip` d'`@/core/edl` ; et `Clip.hookStyle` est
 * typé `Partial<HookSettings>`, donc `edl.ts` a besoin de `HookSettings` en
 * retour. Les deux imports sont des imports de **type**, qui s'effacent à la
 * compilation et ne créent donc aucun cycle à l'exécution — mais la règle
 * `no-restricted-imports` de `tests/core/purete.test.ts` refuse tout ce qui ne
 * commence pas par `./`, `@/core/` ou `zod`, y compris en import de type :
 * `src/lib/api.ts` en est donc exclu comme origine. `src/lib/api.ts`
 * **réexporte** `HookSettings` et les constantes ci-dessous depuis ce fichier,
 * exactement comme il le fait déjà pour `ClipFraming`/`ShotFraming`
 * (`@/core/framing`) et `StepName` (`@/core/graph`) — pour la même raison :
 * deux exemplaires d'un même type ne se contraignent pas, et celui qui prend
 * du retard ne fait rien échouer, il affiche seulement quelque chose de faux.
 */

/** Les trois tiers verticaux où poser le hook. */
export const HOOK_POSITIONS = ['top', 'center', 'bottom'] as const

/** L'alignement horizontal du texte. */
export const HOOK_ALIGNMENTS = ['left', 'center', 'right'] as const

/**
 * Les quatre transitions du premier lot (retour d'usage §6.3 : « éviter
 * d'implémenter dix effets avant d'avoir validé visuellement les quatre
 * premiers »). Les quatre sont dans l'énumération **persistée** dès cette PR,
 * même si `glitch` et `scanline` ne sont pas encore rendus : ça évite une
 * migration d'énumération plus tard. L'écran, lui, les affiche `disabled`.
 */
export const HOOK_TRANSITIONS = ['none', 'fade', 'glitch', 'scanline'] as const

/**
 * La seule police embarquée dans `fonts/` — celle que les sous-titres
 * utilisent déjà (`src/core/captions/ass.ts`). En proposer d'autres inviterait
 * à choisir une police que ffmpeg ne trouverait pas au rendu.
 */
export const HOOK_FONTS = ['Anton'] as const

/**
 * Les bornes numériques du hook. Une seule source : le registre de réglages
 * (`src/server/db.ts`, `HOOK_FIELD_SHAPES`), le schéma de surcharge par clip
 * (`hookStyle`, même fichier) et la validation de `PATCH /api/clips/:id` s'y
 * réfèrent tous les trois — une liste de bornes réécrite à la main aurait fini
 * par diverger (`CLAUDE.md`, « un correctif compris comme local »).
 */
export const HOOK_BOUNDS = {
  durationMs: { min: 200, max: 10_000 },
  size: { min: 10, max: 200 },
  backgroundOpacity: { min: 0, max: 100 },
} as const

/**
 * Les onze réglages du hook, globaux ou surchargés par un clip.
 *
 * **`durationMs`, pas `durationSec`.** `src/server/db.ts` ne porte pas de type
 * décimal — sa doctrine, écrite dans `parseSetting`, refuse tout ce qui n'est
 * pas `/^\d+$/` pour ne jamais réintroduire la comparaison d'une valeur
 * arrondie à un seuil inclusif (`CLAUDE.md`). L'écran affiche encore
 * « 2 secondes » : la conversion vit dans `hook-section.tsx`, seul endroit qui
 * porte déjà toute la prose de cette section.
 */
export type HookSettings = {
  enabled: boolean
  durationMs: number
  font: (typeof HOOK_FONTS)[number]
  size: number
  position: (typeof HOOK_POSITIONS)[number]
  alignment: (typeof HOOK_ALIGNMENTS)[number]
  textColor: string
  backgroundColor: string
  backgroundOpacity: number
  enter: (typeof HOOK_TRANSITIONS)[number]
  exit: (typeof HOOK_TRANSITIONS)[number]
}

/**
 * Les onze défauts globaux du hook — ceux que le registre de réglages
 * enregistre (`src/server/db.ts`, `HOOK_FIELD_SHAPES`) et que l'écran des
 * réglages propose au bouton « Revenir à … » (`hook-section.tsx`).
 *
 * **Une seule source, dans un fichier pur.** Le registre est côté serveur et
 * l'écran de réglages est un composant client : `ai-section.tsx` duplique ses
 * propres défauts à la main pour cette raison (`DEFAULT_PROVIDER`,
 * `DEFAULT_MODEL`), parce qu'ils dépendent du fournisseur choisi. Ceux du hook
 * sont onze littéraux sans logique — les dupliquer à la main créerait deux
 * listes qui divergeraient au premier réglage changé, exactement le défaut que
 * `CLAUDE.md` documente sous « un correctif compris comme local revient au
 * champ suivant ». Poser la valeur ici et la faire lire des deux côtés
 * l'empêche par construction.
 */
export const HOOK_DEFAULTS: HookSettings = {
  enabled: true,
  durationMs: 2_000,
  font: 'Anton',
  size: 56,
  position: 'top',
  alignment: 'center',
  textColor: '#FFFFFF',
  backgroundColor: '#000000',
  backgroundOpacity: 60,
  enter: 'fade',
  exit: 'fade',
}

/** Les globaux, écrasés par ce que le clip surcharge. */
export type ResolvedHook = HookSettings & { text: string }

/**
 * Les globaux, avec la surcharge du clip par-dessus.
 *
 * `hookStyle` est un objet **creux** : seules les clés que le clip surcharge y
 * figurent, et l'étalement `{ ...globals, ...clip.hookStyle }` s'en sert tel
 * quel — une clé absente laisse le global en place, une clé présente le
 * remplace, même quand la valeur surchargée est identique au global (§7 : les
 * deux doivent rester distincts, et c'est `hookStyle` en base qui porte cette
 * distinction, pas ce merge).
 */
export function resolveHook(
  globals: HookSettings,
  clip: Pick<Clip, 'hookText' | 'hookStyle'>,
): ResolvedHook {
  return { ...globals, ...clip.hookStyle, text: clip.hookText }
}

/**
 * Vrai quand quelque chose sera incrusté : activé ET un texte non vide.
 *
 * Un hook activé sur un texte vide ne produit aucun carton — c'est l'état
 * initial de tout clip nouvellement gardé, avant que le repérage ou une saisie
 * manuelle ne pose `hookText`. Un hook désactivé ne produit rien non plus,
 * quel que soit son texte : c'est le geste « désactiver pour ce clip » que
 * §7 demande.
 */
export function hookIsBurned(resolved: ResolvedHook): boolean {
  return resolved.enabled && resolved.text.trim() !== ''
}

/**
 * La géométrie du hook, en unités du script ASS `PlayResX 384 × PlayResY 288`
 * — le même repère que `src/core/captions/ass.ts`, pour que le hook et les
 * sous-titres se positionnent l'un par rapport à l'autre sans conversion.
 */
export type HookLayout = {
  /** L'alignement ASS, 1 à 9, dérivé de position × alignment. */
  assAlignment: number
  marginL: number
  marginR: number
  marginV: number
  /** La taille en unités de script : floor(size * 0.85), comme les sous-titres. */
  sizeUnits: number
}

/**
 * La marge horizontale de sécurité, des deux côtés — ~6,25 % de `PlayResX`
 * (384). Posée symétriquement quel que soit l'alignement : c'est ce que
 * « respecter une safe-area adaptée au format vertical » (§7) veut dire pour
 * un texte qui peut revenir sur plusieurs lignes, pas seulement une marge côté
 * texte.
 */
const HOOK_MARGIN_X = 24

/**
 * Depuis le haut, quand `position` vaut `top`. Le tiers supérieur d'un feed
 * vertical est en général le moins recouvert par l'interface de la
 * plateforme — contrairement au bas, voir `HOOK_MARGIN_BOTTOM`.
 */
const HOOK_MARGIN_TOP = 24

/**
 * Depuis le bas, quand `position` vaut `bottom`. **La même mesure que les
 * sous-titres** (`MARGIN_LOW`, `src/core/captions/ass.ts`, ~15 % de
 * `PlayResY`) : c'est la zone que le bloc légende/pseudo et le bandeau musical
 * de TikTok et de Reels recouvrent, mesurée pour les sous-titres et valable
 * pour tout texte posé en bas de cadre.
 */
const HOOK_MARGIN_BOTTOM = 43

/** `position: 'center'` n'a pas de marge verticale à tenir : ASS centre déjà. */
const HOOK_MARGIN_CENTER = 0

/**
 * L'alignement ASS façon pavé numérique, 1 à 9 : `7 8 9` en haut, `4 5 6` au
 * centre, `1 2 3` en bas — colonne gauche/centre/droite dans cet ordre à
 * chaque ligne. C'est la convention que lit `src/core/captions/ass.ts`
 * (`Alignment: 2`, bas centré).
 */
function assAlignmentFor(
  position: HookSettings['position'],
  alignment: HookSettings['alignment'],
): number {
  const row = position === 'top' ? 6 : position === 'center' ? 3 : 0
  const column = alignment === 'left' ? 1 : alignment === 'center' ? 2 : 3
  return row + column
}

function marginVFor(position: HookSettings['position']): number {
  if (position === 'top') return HOOK_MARGIN_TOP
  if (position === 'bottom') return HOOK_MARGIN_BOTTOM
  return HOOK_MARGIN_CENTER
}

export function hookLayout(resolved: ResolvedHook): HookLayout {
  return {
    assAlignment: assAlignmentFor(resolved.position, resolved.alignment),
    marginL: HOOK_MARGIN_X,
    marginR: HOOK_MARGIN_X,
    marginV: marginVFor(resolved.position),
    // Le facteur 0,85 est repris tel quel de `src/core/captions/ass.ts`, pour
    // qu'un hook à 44 et un sous-titre à 44 donnent la même hauteur de glyphe
    // — une propriété produit, pas un détail d'implémentation. Le plancher de
    // 10 aussi : sans lui, la taille minimale du registre (`HOOK_BOUNDS.size.min`)
    // rendrait 8, plus petit que ce que les sous-titres s'autorisent jamais.
    sizeUnits: Math.max(10, Math.floor(resolved.size * 0.85)),
  }
}

/** Les guillemets encadrants que `normalizeHookText` retire, par paire. */
const SURROUNDING_QUOTES: readonly [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['«', '»'],
  ['“', '”'], // “ ”
]

function stripSurroundingQuotes(text: string): string {
  for (const [open, close] of SURROUNDING_QUOTES) {
    // `>=`, pas `>` : `'""'` est un texte vide correctement encadré, et doit
    // se réduire à `''`. Un unique caractère qui joue les deux rôles à la
    // fois — `'"'` seul, `open === close` pour les guillemets droits — reste
    // en revanche inchangé : `text.length` vaut alors 1, la somme des deux
    // délimiteurs 2, et la garde ne s'applique pas.
    if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim()
    }
  }
  return text
}

const HOOK_TEXT_MAX_WORDS = 10
const HOOK_TEXT_MAX_CHARS = 120

/**
 * Le texte d'un hook, ramené à une forme affichable : trim, blancs effondrés,
 * guillemets encadrants retirés, plafonné à 10 mots puis à 120 caractères.
 *
 * Gemini rend `viral_hook_text` entouré de guillemets plus souvent qu'autrement
 * — un tic de rédaction, pas une intention — et le prompt le plafonne à 10
 * mots sans garantir que le modèle s'y tienne. Les deux plafonds sont
 * indépendants et appliqués dans cet ordre : les mots d'abord, pour ne pas
 * couper un mot au milieu, les caractères ensuite, en filet de sécurité pour
 * une saisie manuelle sans espaces. Le filet lui-même ne coupe pas un mot :
 * quand la coupe dure tombe au milieu d'un mot, on recule au dernier espace
 * du fragment ; une saisie sans aucun espace n'a nulle part où reculer, et
 * garde la coupe dure. **On ne recule que si la coupe tombe vraiment au
 * milieu d'un mot** — si le caractère suivant est l'espace séparateur (ou
 * s'il n'y en a pas, le texte s'arrêtant pile là), la coupe dure est déjà une
 * frontière de mot et reculer supprimerait un mot entier qui tenait dans la
 * limite. **Le plafond compte des points de code, pas des unités UTF-16** :
 * `.length`/`.slice` comptent des unités, et un emoji hors du plan de base en
 * occupe deux (une paire de substituts) — couper au milieu en rendrait un
 * seul, une chaîne Unicode invalide.
 */
export function normalizeHookText(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ')
  const unquoted = stripSurroundingQuotes(collapsed)
  const words = unquoted.split(' ').filter((word) => word !== '')
  const limitedByWords = words.slice(0, HOOK_TEXT_MAX_WORDS).join(' ')
  const codePoints = Array.from(limitedByWords)
  if (codePoints.length <= HOOK_TEXT_MAX_CHARS) return limitedByWords
  const hardCut = codePoints.slice(0, HOOK_TEXT_MAX_CHARS).join('')
  const cutsMidWord = codePoints[HOOK_TEXT_MAX_CHARS] !== ' '
  const lastSpace = hardCut.lastIndexOf(' ')
  return (cutsMidWord && lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut).trimEnd()
}
