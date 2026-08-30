import type { Measure } from '@/core/captions/wrap'
import type { Clip } from '@/core/edl'

/**
 * Le hook : un texte court incrusté dès la première image d'un clip exporté,
 * pour accrocher dans le fil avant que le spectateur comprenne le contexte
 * (`docs/retour-ui-and-next-steps.md` §6.3 et §7 — note de travail de l'auteur
 * du projet, volontairement non versionnée : ce fichier ne se trouve pas dans
 * le dépôt cloné).
 *
 * **Ce module est l'interface dont héritent le rasteriseur PNG du rendu
 * (`src/server/hook-image.ts`) et le calque de preview (écran Clip).**
 * `resolveHook`, `hookIsBurned`, `hookLayout` et `normalizeHookText` sont ce
 * que les deux camps partagent — c'est ce qui permet aux deux de calculer la
 * même géométrie sans se copier l'un l'autre.
 *
 * **Le hook s'incrustait en ASS (`BorderStyle: 3`) jusqu'au 20 août 2026.**
 * `BorderStyle: 3` ne dessine que des angles droits — aucun réglage ASS
 * n'arrondit un coin — et une boîte par ligne, ce qui produit un escalier sur
 * un hook de plusieurs lignes. Le propriétaire du dépôt a regardé les rendus
 * et demandé un fond plein à coins arrondis qui épouse un texte court : ce
 * n'était pas atteignable en ASS, donc le hook s'incruste désormais par une
 * image PNG composée en `overlay`, exactement comme `logo.png` et
 * `twitch.png` (`src/core/ffmpeg/args.ts`). Les sous-titres, eux, restent en
 * ASS : rien dans ce paragraphe ne les concerne.
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
 *
 * **`sizePermille` et `cornerRadiusPermille`, pas `sizeFraction` ni
 * `cornerRadiusFraction`.** Le registre de réglages n'a pas de type décimal
 * (`src/server/db.ts`, doc de `SettingFieldType` : « pas de type flottant, et
 * c'est une décision prise ») — la même raison que `durationMs` porte des
 * millisecondes plutôt que des secondes. Une fraction de la largeur du
 * canevas (0 à 1) exigerait des décimales pour toute granularité utile ; en
 * millièmes, elle reste un entier — `90` veut dire 9,0 % de la largeur.
 */
export const HOOK_BOUNDS = {
  durationMs: { min: 200, max: 10_000 },
  sizePermille: { min: 20, max: 250 },
  cornerRadiusPermille: { min: 0, max: 200 },
  backgroundOpacity: { min: 0, max: 100 },
} as const

/**
 * Les quinze réglages du hook, globaux ou surchargés par un clip.
 *
 * **`durationMs`, pas `durationSec`.** `src/server/db.ts` ne porte pas de type
 * décimal — sa doctrine, écrite dans `parseSetting`, refuse tout ce qui n'est
 * pas `/^\d+$/` pour ne jamais réintroduire la comparaison d'une valeur
 * arrondie à un seuil inclusif (`CLAUDE.md`). L'écran affiche encore
 * « 2 secondes » : la conversion vit dans `hook-section.tsx`, seul endroit qui
 * porte déjà toute la prose de cette section.
 *
 * **`sizePermille`, pas `size`.** Le champ a changé de sens — d'une taille en
 * unités de script ASS à une fraction de la largeur du canevas — et
 * `CLAUDE.md` refuse qu'une clé change de sens sous le même nom (« un
 * correctif compris comme local revient au champ suivant »). Voir
 * `HOOK_BOUNDS` pour pourquoi ce sont des millièmes et pas une fraction
 * décimale.
 *
 * **`cornerRadiusPermille` et `uppercase` sont neufs**, demandés par le
 * propriétaire du dépôt après avoir regardé les rendus : un fond translucide
 * à angles droits ne « pose » pas le bandeau sur l'image, il la recouvre.
 */
export type HookSettings = {
  enabled: boolean
  durationMs: number
  font: (typeof HOOK_FONTS)[number]
  sizePermille: number
  cornerRadiusPermille: number
  uppercase: boolean
  position: (typeof HOOK_POSITIONS)[number]
  alignment: (typeof HOOK_ALIGNMENTS)[number]
  textColor: string
  backgroundColor: string
  backgroundOpacity: number
  enter: (typeof HOOK_TRANSITIONS)[number]
  exit: (typeof HOOK_TRANSITIONS)[number]
  /** La couleur du texte de la pastille. Voir `badgeBackground`. */
  badgeColor: string
  /**
   * La couleur de fond de la pastille — celle qui la détache du carton.
   *
   * **Ce sont les deux SEULS réglages propres au badge, et c'est une
   * décision.** Tout le reste — police, capitales, rayon des coins, position,
   * alignement, durée, transitions — est hérité du hook : une pastille qui
   * pourrait avoir sa propre police et sa propre taille cesserait d'être
   * l'accessoire d'un carton pour devenir un second hook, et l'écran des
   * réglages doublerait de longueur pour un gain que les vignettes de
   * référence ne réclament nulle part. Le texte, lui, n'est pas ici : c'est du
   * contenu, il vit sur `Clip.hookBadge`.
   */
  badgeBackground: string
}

/**
 * Les quinze défauts globaux du hook — ceux que le registre de réglages
 * enregistre (`src/server/db.ts`, `HOOK_FIELD_SHAPES`) et que l'écran des
 * réglages propose au bouton « Revenir à … » (`hook-section.tsx`).
 *
 * **Une seule source, dans un fichier pur.** Le registre est côté serveur et
 * l'écran de réglages est un composant client : `ai-section.tsx` duplique ses
 * propres défauts à la main pour cette raison (`DEFAULT_PROVIDER`,
 * `DEFAULT_MODEL`), parce qu'ils dépendent du fournisseur choisi. Ceux du hook
 * sont quinze littéraux sans logique — les dupliquer à la main créerait deux
 * listes qui divergeraient au premier réglage changé, exactement le défaut que
 * `CLAUDE.md` documente sous « un correctif compris comme local revient au
 * champ suivant ». Poser la valeur ici et la faire lire des deux côtés
 * l'empêche par construction.
 *
 * **`enter` à `none`, pas `fade` (20 août 2026).** Instagram fabrique la
 * vignette du fil avec la **première image** du fichier. Un fondu d'entrée de
 * 300 ms y laisse le hook à opacité nulle : l'accroche censée arrêter le
 * défilement était donc absente de la seule image qu'on voit avant de cliquer.
 * Le réglage reste — un fondu d'entrée peut se vouloir sur un clip donné —
 * mais ce n'est plus le défaut. `exit` garde le sien : la sortie ne se joue
 * sur aucune vignette.
 *
 * **`backgroundOpacity` à 100, pas 60.** Le retour du propriétaire est net :
 * « un fond plein, à coins arrondis ». Le réglage reste — un fond translucide
 * peut se vouloir — mais ce n'est plus le défaut. `cornerRadiusPermille` à 24
 * (2,4 % de la largeur) donne l'arrondi franc des deux exemples fournis : ni
 * angle droit, ni gélule — vérifié à l'image, voir `tmp/hook-proof/`.
 */
export const HOOK_DEFAULTS: HookSettings = {
  enabled: true,
  durationMs: 2_000,
  font: 'Anton',
  sizePermille: 90,
  cornerRadiusPermille: 24,
  uppercase: true,
  position: 'top',
  alignment: 'center',
  textColor: '#FFFFFF',
  backgroundColor: '#000000',
  backgroundOpacity: 100,
  enter: 'none',
  exit: 'fade',
  badgeColor: '#FFFFFF',
  // Le magenta des vignettes de référence : une pastille ne se détache du
  // carton que si sa couleur ne s'y trouve pas déjà, et le carton est noir ou
  // blanc dans tous les exemples fournis.
  badgeBackground: '#E5007D',
}

/** Les globaux, écrasés par ce que le clip surcharge. */
export type ResolvedHook = HookSettings & { text: string; badge: string }

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
  clip: Pick<Clip, 'hookText' | 'hookBadge' | 'hookStyle'>,
): ResolvedHook {
  return { ...globals, ...clip.hookStyle, text: clip.hookText, badge: clip.hookBadge }
}

/**
 * Vrai quand quelque chose sera incrusté : activé ET un texte non vide.
 *
 * Un hook activé sur un texte vide ne produit aucun carton — c'est l'état
 * initial d'un clip dont le repérage n'a rien proposé, avant qu'une saisie
 * manuelle ou le rattrapage ne pose `hookText`. Un hook désactivé ne produit
 * rien non plus, quel que soit son texte : c'est le geste « désactiver pour
 * ce clip » que §7 demande.
 *
 * **Le badge ne compte pas, et la question a été instruite.** Une pastille
 * seule n'a été validée sur aucune image : les vignettes de référence la
 * montrent toujours posée SUR un carton, et sa géométrie est définie par
 * rapport à lui — le chevauchement, le retrait qui aligne les deux premières
 * lettres. Sans carton, il n'y a pas d'ancre. S'y ajoute que le repérage rend
 * `viral_hook_text` obligatoire et `viral_hook_badge` facultatif : « un badge
 * sans accroche » vient donc surtout d'un modèle qui a rempli le mauvais
 * champ, et l'incruster ferait d'un raté un artefact visible.
 *
 * Ce qui ne veut pas dire s'en taire — c'est le silence qui serait le défaut.
 * `hook-fields.tsx` affiche la phrase qui manque quand un badge est saisi sur
 * une accroche vide, plutôt que de laisser quelqu'un conclure que le champ
 * est cassé.
 */
export function hookIsBurned(resolved: ResolvedHook): boolean {
  return resolved.enabled && resolved.text.trim() !== ''
}

/**
 * La géométrie du hook, en **fractions sans unité de la LARGEUR du
 * canevas** — jamais de sa hauteur, et jamais un pixel ou une unité de script.
 *
 * **C'est un renversement délibéré par rapport aux sous-titres**, et il faut
 * l'écrire ici parce qu'il sera reproposé à l'envers par le premier lecteur
 * qui verra que `src/core/captions/ass.ts` fait autrement. Les sous-titres
 * suivent `PlayResY` — la hauteur du canevas — et c'est **mesuré** sans être
 * un défaut : le même texte y fait deux lignes modérées sur un 1:1
 * (1080×1080) et quatre lignes énormes sur un 9:16 (1080×1920), parce que la
 * hauteur change du tout au tout entre les deux quand la largeur, elle, ne
 * bouge pas (1080 dans les deux cas — seul le 16:9 natif, à 1920, diffère).
 * C'est exactement le reproche que le propriétaire a fait sur les rendus : un
 * bandeau qui change de taille selon le format alors que c'est le MÊME hook.
 * Une géométrie assise sur la largeur rend au contraire le même bandeau sur
 * toutes les sorties dont la largeur coïncide — natif 1:1/4:5/9:16 et
 * variante 9:16, qui partagent tous 1080 — et seul le natif 16:9 (1920) en
 * sort à une échelle différente, ce qui est juste : un cadre deux fois plus
 * large mérite un bandeau proportionnellement plus grand, pas le même nombre
 * de pixels perdu dans le coin.
 *
 * **Une seule fonction, deux consommateurs, aucun calcul parallèle** : le
 * rasteriseur PNG du rendu (`src/server/hook-image.ts`) multiplie ces
 * fractions par la largeur et la hauteur réelles du canevas, le calque de
 * preview (`hook-overlay.tsx`) par `cqw`/`cqh` de la boîte 9:16 d'aperçu.
 * `PlayResX`/`PlayResY` n'existent plus pour le hook : c'était l'échelle
 * imposée par l'ASS, que le passage au PNG existe justement pour lever.
 */
export type HookLayout = {
  /** La taille de police, fraction de la largeur du canevas. */
  fontSizeFraction: number
  /** L'interligne, fraction de la largeur — `fontSizeFraction × HOOK_LINE_HEIGHT_FACTOR`. */
  lineHeightFraction: number
  /** Le rembourrage horizontal interne à la boîte, fraction de la largeur. */
  paddingXFraction: number
  /** Le rembourrage vertical interne, fraction de la largeur (même raison que la taille : une boîte qui garde ses proportions quel que soit le format). */
  paddingYFraction: number
  /** Le rayon des coins, fraction de la largeur. */
  radiusFraction: number
  /** La marge de sécurité gauche/droite, fraction de la largeur. */
  marginXFraction: number
  /**
   * La marge depuis le bord haut ou bas (selon `position`), 0 pour `center`.
   *
   * **Fraction de la largeur pour `top`, fraction de la HAUTEUR pour
   * `bottom`** — la seule fraction de tout `HookLayout` qui ne suit pas la
   * largeur, et volontairement : voir `HOOK_MARGIN_BOTTOM_FRACTION`.
   */
  marginYFraction: number
  /** La largeur maximale de la boîte avant retour à la ligne, fraction de la largeur du canevas. */
  maxBoxWidthFraction: number
  /** La taille de police de la pastille, fraction de la largeur du canevas. */
  badgeFontSizeFraction: number
  /** Le rembourrage horizontal interne à la pastille, fraction de la largeur. */
  badgePaddingXFraction: number
  /** Le rembourrage vertical interne à la pastille, fraction de la largeur. */
  badgePaddingYFraction: number
  /**
   * La hauteur **totale** de la pastille, fraction de la largeur.
   *
   * **Calculée ici et non mesurée**, contrairement à celle du carton : la
   * pastille tient sur une seule ligne par construction — `normalizeHookBadge`
   * la plafonne à trois mots et le rasteriseur ne l'enroule pas —, donc sa
   * hauteur ne dépend d'aucune mesure de texte. C'est ce qui permet au calque
   * de preview de poser exactement la même hauteur que le PNG sans mesurer
   * quoi que ce soit, ce qu'il ne peut pas faire pour le carton.
   */
  badgeHeightFraction: number
  /** Le rayon des coins de la pastille, fraction de la largeur. */
  badgeRadiusFraction: number
  /** De combien la base de la pastille descend sous le bord haut du carton, fraction de la largeur. */
  badgeOverlapFraction: number
  /**
   * Le retrait horizontal de la pastille par rapport au bord du carton, du
   * côté par lequel l'alignement les tient.
   *
   * **Il aligne les deux premières LETTRES, pas les deux bords de boîte** —
   * c'est ce que montrent les vignettes de référence, et ça ne s'obtient pas
   * tout seul : les deux boîtes n'ont pas le même rembourrage, donc des bords
   * alignés donneraient des textes décalés. La valeur est la différence des
   * deux rembourrages, bornée à zéro pour le cas où celui de la pastille
   * dépasse celui du carton (hook à son plancher de taille), qui la ferait
   * sinon sortir du carton du mauvais côté.
   */
  badgeInsetFraction: number
}

/**
 * La marge de sécurité gauche/droite, ~6 % de la largeur — l'équivalent en
 * fraction de largeur de l'ancienne `HOOK_MARGIN_X` (24 unités sur
 * `PlayResX: 384`, soit 6,25 %).
 */
const HOOK_MARGIN_X_FRACTION = 0.06

/**
 * Depuis le haut, quand `position` vaut `top`. Le tiers supérieur d'un feed
 * vertical est en général le moins recouvert par l'interface de la
 * plateforme — contrairement au bas, voir `HOOK_MARGIN_BOTTOM_FRACTION`.
 */
const HOOK_MARGIN_TOP_FRACTION = 0.05

/**
 * Depuis le bas, quand `position` vaut `bottom`. **Fraction de la HAUTEUR du
 * canevas, pas de sa largeur** — la seule exception à la règle du reste de
 * ce fichier, et délibérée : cette marge protège d'une zone que le bloc
 * légende/pseudo et le bandeau musical de TikTok et de Reels recouvrent, et
 * cette zone est une propriété physique du chrome de la plateforme — elle
 * grandit avec la hauteur de l'image, pas avec sa largeur. La taille du
 * bandeau, elle, reste à dessein assise sur la largeur (voir plus haut) :
 * les deux questions sont indépendantes, et répondent à des contraintes
 * différentes.
 *
 * `0,1493`, soit `43 / 288` arrondi à quatre décimales : la valeur que
 * portait l'ancienne `HOOK_MARGIN_BOTTOM` en unités `PlayResY`, **identique**
 * à `MARGIN_LOW` des sous-titres (`src/core/captions/ass.ts`) — une mesure
 * contre le chrome réel de TikTok et Reels (`CLAUDE.md`, « le point d'arrêt
 * est sur les images »), pas un goût. Le premier passage en fraction de
 * largeur de la PR #117 avait réinterprété ce nombre sans le reconvertir, ce
 * qui donnait ~5 % de la hauteur sur un 9:16 (1080×1920) au lieu des ~15 %
 * mesurés — relevé par Aristarque en review. Dupliquée plutôt qu'importée :
 * les deux systèmes (ASS pour les sous-titres, PNG pour le hook) partagent
 * la même contrainte physique par coïncidence de plateforme, pas par une
 * dépendance qui devrait les lier. Arrondie plutôt que laissée en fraction
 * exacte (`43 / 288`) : au-delà de la troisième décimale la précision ne
 * représente plus rien de mesuré, et un flottant à répétition sérialise
 * différemment en `calc()` selon le moteur qui le formate.
 */
const HOOK_MARGIN_BOTTOM_FRACTION = 0.1493

/** `position: 'center'` n'a pas de marge verticale à tenir : la boîte est déjà centrée. */
const HOOK_MARGIN_CENTER_FRACTION = 0

/**
 * Le rembourrage horizontal, proportionnel à la taille de police — pour
 * qu'un gros hook garde une marge propre plutôt qu'une boîte collée aux
 * lettres, ce qu'une constante fixe aurait donné aux deux extrémités de
 * `HOOK_BOUNDS.sizePermille`. Mesuré à l'image sur les deux exemples fournis
 * (`tmp/hook-proof/`) : c'est ce facteur qui fait que la boîte « épouse » le
 * texte sans le serrer ni nager dedans.
 */
const HOOK_PADDING_X_FACTOR = 0.6

/** Le rembourrage vertical, plus resserré que l'horizontal comme sur les deux exemples fournis. */
const HOOK_PADDING_Y_FACTOR = 0.42

/** L'interligne d'un hook sur plusieurs lignes, en multiple de la taille de police. */
const HOOK_LINE_HEIGHT_FACTOR = 1.2

/**
 * La largeur maximale de la boîte avant retour à la ligne — l'équivalent en
 * fraction de largeur de l'ancienne zone utile de `renderHookAss`
 * (`PlayResX - 2 × HOOK_MARGIN_X = 336/384 = 87,5 %`), resserrée légèrement
 * pour laisser une respiration visible entre la boîte et la marge de
 * sécurité plutôt que de les faire coïncider.
 */
const HOOK_MAX_BOX_WIDTH_FRACTION = 0.84

/**
 * La taille de la pastille, en multiple de celle du hook. Mesuré sur les
 * vignettes de référence : « DÉFI 10 » y fait un peu plus de la moitié de la
 * hauteur de « ENCORE UN PROCÈS ». Assez petit pour se lire comme un
 * accessoire, assez grand pour rester lisible à la taille d'une vignette dans
 * un fil — au-delà, la pastille cesse d'être un sur-titre et devient une
 * seconde ligne de hook.
 */
const HOOK_BADGE_SIZE_FACTOR = 0.55

/**
 * Le rembourrage horizontal de la pastille, en multiple de SA taille de
 * police — **plus généreux que les 0,6 du carton**. Un à trois mots courts ont
 * besoin de plus de marge relative pour se lire comme une pastille et non
 * comme une étiquette serrée ; c'est la proportion des vignettes de référence.
 */
const HOOK_BADGE_PADDING_X_FACTOR = 0.7

/** Nettement plus resserré que les 0,42 du carton : une pastille est large et basse. */
const HOOK_BADGE_PADDING_Y_FACTOR = 0.3

/**
 * De combien la pastille mord sur le carton, en fraction de sa propre hauteur.
 *
 * **Un chevauchement, pas un écart**, et c'est ce que montrent les vignettes
 * de référence : deux boîtes qui se touchent se lisent comme un seul objet
 * posé sur l'image, là où deux boîtes séparées par du vide se lisent comme
 * deux incrustations sans rapport. À 0 elles se touchent sans se lier ; à 0,5
 * la pastille s'enfonce jusqu'à son axe et le carton la coupe en deux. La
 * valeur se règle à l'image, pas au raisonnement — voir la vérification du
 * plan.
 */
const HOOK_BADGE_OVERLAP_FACTOR = 0.25

function marginYFractionFor(position: HookSettings['position']): number {
  if (position === 'top') return HOOK_MARGIN_TOP_FRACTION
  if (position === 'bottom') return HOOK_MARGIN_BOTTOM_FRACTION
  return HOOK_MARGIN_CENTER_FRACTION
}

export function hookLayout(resolved: ResolvedHook): HookLayout {
  const fontSizeFraction = resolved.sizePermille / 1000
  const paddingXFraction = fontSizeFraction * HOOK_PADDING_X_FACTOR
  const badgeFontSizeFraction = fontSizeFraction * HOOK_BADGE_SIZE_FACTOR
  const badgePaddingXFraction = badgeFontSizeFraction * HOOK_BADGE_PADDING_X_FACTOR
  const badgePaddingYFraction = badgeFontSizeFraction * HOOK_BADGE_PADDING_Y_FACTOR
  const badgeHeightFraction =
    badgeFontSizeFraction * HOOK_LINE_HEIGHT_FACTOR + 2 * badgePaddingYFraction
  return {
    fontSizeFraction,
    lineHeightFraction: fontSizeFraction * HOOK_LINE_HEIGHT_FACTOR,
    paddingXFraction,
    paddingYFraction: fontSizeFraction * HOOK_PADDING_Y_FACTOR,
    radiusFraction: resolved.cornerRadiusPermille / 1000,
    marginXFraction: HOOK_MARGIN_X_FRACTION,
    marginYFraction: marginYFractionFor(resolved.position),
    maxBoxWidthFraction: HOOK_MAX_BOX_WIDTH_FRACTION,
    badgeFontSizeFraction,
    badgePaddingXFraction,
    badgePaddingYFraction,
    badgeHeightFraction,
    // **Le rayon suit la taille de la pastille, pas celle du carton.** Un
    // rayon absolu identique sur les deux boîtes donnerait une pastille en
    // gélule à côté d'un carton à peine arrondi, alors que le réglage de
    // l'humain porte sur une seule idée : « à quel point c'est arrondi ».
    // Et ce n'est pas non plus une gélule d'office — les pastilles de
    // référence sont des rectangles franchement arrondis, pas des capsules.
    badgeRadiusFraction: (resolved.cornerRadiusPermille / 1000) * HOOK_BADGE_SIZE_FACTOR,
    badgeOverlapFraction: badgeHeightFraction * HOOK_BADGE_OVERLAP_FACTOR,
    badgeInsetFraction: Math.max(0, paddingXFraction - badgePaddingXFraction),
  }
}

/** Rond au pair le plus proche, jamais sous 2 — même contrainte que `scheduleMarkers` (chrominance sous-échantillonnée en yuv420p). */
function pairEven(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/**
 * Comme `pairEven`, mais **vers le bas** — pour un plafond qu'on ne veut
 * jamais dépasser, jamais atteindre par excès d'un demi-pixel.
 */
function pairEvenFloor(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
}

/**
 * Découpe `text` en lignes qui tiennent chacune sous `maxWidthPx`, glouton et
 * **sans jamais couper un mot** — la même règle que `WrapStyle: 0` de l'ASS
 * tient pour les sous-titres, et que `normalizeHookText` tient pour ses
 * propres plafonds. Un mot seul plus large que `maxWidthPx` reste sur sa
 * ligne : mieux vaut une boîte qui déborde légèrement qu'un mot tranché en deux.
 */
function wrapLines(text: string, maxWidthPx: number, measure: Measure): string[] {
  const words = text.split(' ').filter((w) => w !== '')
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = words[0]
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`
    if (measure(candidate) <= maxWidthPx) {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }
  lines.push(current)
  return lines
}

/**
 * La géométrie en pixels du composite carton + pastille sur un canevas donné.
 *
 * Toutes les dimensions dérivées d'un texte réellement mesuré (largeur du
 * carton, de la pastille) plutôt qu'estimées : la boîte épouse le mot, comme
 * `renderHookImage` (`src/server/hook-image.ts`) le faisait déjà en ligne.
 */
export type HookGeometry = {
  /** Les lignes du carton, déjà retournées à la ligne — capitales et trim déjà appliqués. */
  lines: string[]
  /** Le texte de la pastille, vide si aucune. */
  badgeText: string
  hasBadge: boolean
  fontSizePx: number
  lineHeightPx: number
  paddingXPx: number
  paddingYPx: number
  badgeFontSizePx: number
  badgePaddingXPx: number
  cardWidth: number
  cardHeight: number
  /** La hauteur réellement dessinée du carton — rognée quand le composite plafonne à `canvas.h`. */
  cardHeightDrawn: number
  /** L'ordonnée du haut du carton, sous la pastille qui mord dessus. */
  cardTop: number
  cardX: number
  badgeWidth: number
  badgeHeight: number
  badgeX: number
  overlapPx: number
  insetPx: number
  compositeWidth: number
  compositeHeight: number
}

/**
 * Un `Measure` pour une taille de police donnée, en pixels.
 *
 * **Le carton et la pastille ne partagent pas la même taille de police**
 * (`badgeFontSizeFraction = fontSizeFraction × HOOK_BADGE_SIZE_FACTOR`) :
 * un seul `Measure` fixe ne peut donc pas mesurer les deux, d'où cette
 * fabrique plutôt qu'un `Measure` unique.
 */
export type HookMeasure = (fontSizePx: number) => Measure

/**
 * La géométrie en pixels du composite hook + pastille — extraite de
 * `renderHookImage` (`src/server/hook-image.ts`) pour que le calque de
 * preview (`hook-overlay.tsx`) pose la même boîte sans la recalculer à sa
 * façon. Une seule fonction, deux consommateurs, aucun calcul parallèle —
 * même motif que `captionLines` (`@/core/captions/ass`).
 *
 * **Précondition : `hookIsBurned(resolved)`.** Non vérifiée ici, comme
 * `hookLayout` — c'est à l'appelant de l'avoir déjà écartée.
 *
 * `measure` est injecté : le rasteriseur PNG mesure avec `@napi-rs/canvas`,
 * l'aperçu avec un `<canvas>` du navigateur, et ni l'un ni l'autre ne peut
 * vivre dans `src/core` (frontière de pureté, `tests/core/purete.test.ts`).
 */
export function hookGeometry(
  resolved: ResolvedHook,
  canvas: { w: number; h: number },
  measure: HookMeasure,
): HookGeometry {
  const layout = hookLayout(resolved)
  const fontSizePx = Math.max(1, Math.round(canvas.w * layout.fontSizeFraction))
  const lineHeightPx = Math.max(1, Math.round(canvas.w * layout.lineHeightFraction))
  const paddingXPx = Math.round(canvas.w * layout.paddingXFraction)
  const paddingYPx = Math.round(canvas.w * layout.paddingYFraction)
  const maxTextWidthPx = Math.max(1, Math.round(canvas.w * layout.maxBoxWidthFraction) - 2 * paddingXPx)

  const text = resolved.uppercase ? resolved.text.toUpperCase() : resolved.text
  const badgeText = resolved.uppercase ? resolved.badge.trim().toUpperCase() : resolved.badge.trim()
  const hasBadge = badgeText !== ''

  const cardMeasure = measure(fontSizePx)
  const lines = wrapLines(text, maxTextWidthPx, cardMeasure)
  const textWidthPx = Math.max(...lines.map(cardMeasure))

  // Borné à `canvas.w` : `wrapLines` refuse de couper un mot, donc une ligne
  // seule peut mesurer plus que `maxTextWidthPx` — voir sa doc.
  const cardWidth = Math.min(pairEven(Math.ceil(textWidthPx) + 2 * paddingXPx), pairEvenFloor(canvas.w))
  const cardHeight = pairEven(Math.ceil(lines.length * lineHeightPx) + 2 * paddingYPx)

  const badgeFontSizePx = Math.max(1, Math.round(canvas.w * layout.badgeFontSizeFraction))
  const badgePaddingXPx = Math.round(canvas.w * layout.badgePaddingXFraction)
  let badgeWidth = 0
  let badgeHeight = 0
  if (hasBadge) {
    const badgeMeasure = measure(badgeFontSizePx)
    badgeWidth = Math.min(
      pairEven(Math.ceil(badgeMeasure(badgeText)) + 2 * badgePaddingXPx),
      pairEvenFloor(canvas.w),
    )
    // Dérivée du layout, pas de la mesure — voir `badgeHeightFraction`.
    badgeHeight = pairEven(Math.round(canvas.w * layout.badgeHeightFraction))
  }

  const overlapPx = hasBadge
    ? Math.min(
        Math.round(canvas.w * layout.badgeOverlapFraction),
        badgeHeight,
        Math.max(0, cardHeight - 2),
      )
    : 0
  const insetPx = resolved.alignment === 'center' ? 0 : Math.round(canvas.w * layout.badgeInsetFraction)

  const compositeWidth = Math.min(
    pairEven(Math.max(cardWidth, badgeWidth + insetPx)),
    pairEvenFloor(canvas.w),
  )
  const compositeHeight = Math.min(
    pairEven(cardHeight + badgeHeight - overlapPx),
    pairEvenFloor(canvas.h),
  )

  const cardTop = badgeHeight - overlapPx
  // Quand le plafond a mordu, c'est le CARTON qui rétrécit, jamais la
  // pastille — elle est la plus courte et la plus lisible des deux.
  const cardHeightDrawn = Math.max(2, compositeHeight - cardTop)

  const cardX =
    resolved.alignment === 'left'
      ? 0
      : resolved.alignment === 'right'
        ? compositeWidth - cardWidth
        : Math.round((compositeWidth - cardWidth) / 2)
  const badgeX =
    resolved.alignment === 'left'
      ? insetPx
      : resolved.alignment === 'right'
        ? compositeWidth - insetPx - badgeWidth
        : Math.round((compositeWidth - badgeWidth) / 2)

  return {
    lines,
    badgeText,
    hasBadge,
    fontSizePx,
    lineHeightPx,
    paddingXPx,
    paddingYPx,
    badgeFontSizePx,
    badgePaddingXPx,
    cardWidth,
    cardHeight,
    cardHeightDrawn,
    cardTop,
    cardX,
    badgeWidth,
    badgeHeight,
    badgeX,
    overlapPx,
    insetPx,
    compositeWidth,
    compositeHeight,
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

/**
 * **6, pas 10.** Les deux exemples fournis par le propriétaire du dépôt font
 * un à cinq mots (« CURIOSITY », « ÇA TOURNE ! », « LES ALÉAS DU BTP », « JE
 * VOUS AI BIEN EUS ») : un hook « court et frappant » n'a jamais besoin de
 * dix. `HOOK_PATTERNS` (`src/core/gemini/prompts.ts`) et
 * `HOOK_PROMPT_MAX_WORDS` (`src/server/steps/hook.ts`) demandent la même
 * limite au modèle — resserrer l'une sans l'autre laisserait
 * `normalizeHookText` couper au milieu d'une phrase que le modèle croyait
 * complète.
 */
const HOOK_TEXT_MAX_WORDS = 6
const HOOK_TEXT_MAX_CHARS = 120

/**
 * Le texte d'un hook, ramené à une forme affichable : trim, blancs effondrés,
 * guillemets encadrants retirés, plafonné à 6 mots puis à 120 caractères.
 *
 * Gemini rend `viral_hook_text` entouré de guillemets plus souvent qu'autrement
 * — un tic de rédaction, pas une intention — et le prompt le plafonne à 6
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
function normalizeShortText(raw: string, maxWords: number, maxChars: number): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ')
  const unquoted = stripSurroundingQuotes(collapsed)
  const words = unquoted.split(' ').filter((word) => word !== '')
  const limitedByWords = words.slice(0, maxWords).join(' ')
  const codePoints = Array.from(limitedByWords)
  if (codePoints.length <= maxChars) return limitedByWords
  const hardCut = codePoints.slice(0, maxChars).join('')
  const cutsMidWord = codePoints[maxChars] !== ' '
  const lastSpace = hardCut.lastIndexOf(' ')
  return (cutsMidWord && lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut).trimEnd()
}

export function normalizeHookText(raw: string): string {
  return normalizeShortText(raw, HOOK_TEXT_MAX_WORDS, HOOK_TEXT_MAX_CHARS)
}

/**
 * **3 mots et 24 caractères, nettement sous le hook.** Les pastilles des
 * vignettes de référence font deux mots (« DÉFI 10 », « DÉFI 08 ») ; une
 * pastille de six mots n'est plus une pastille, c'est un second hook posé
 * au-dessus du premier — et le rasteriseur ne la fait pas revenir à la ligne,
 * donc une pastille bavarde sortirait du cadre plutôt que de s'y replier.
 * `HOOK_BADGE_PROMPT_MAX_WORDS` (`src/server/steps/hook.ts`) demande la même
 * limite au modèle, pour la raison écrite sur `HOOK_TEXT_MAX_WORDS`.
 */
const HOOK_BADGE_MAX_WORDS = 3
const HOOK_BADGE_MAX_CHARS = 24

/**
 * Le texte d'une pastille, ramené à une forme affichable — les mêmes gestes
 * que `normalizeHookText`, à des plafonds plus serrés.
 *
 * **La mécanique est partagée, pas recopiée.** Le recul au dernier espace, le
 * comptage en points de code et le retrait des guillemets encadrants ont
 * chacun été corrigés une fois, en review ; les réécrire ici les exposerait à
 * l'être une seconde — c'est exactement ce que `CLAUDE.md` décrit sous « un
 * correctif compris comme local revient au champ suivant ».
 */
export function normalizeHookBadge(raw: string): string {
  return normalizeShortText(raw, HOOK_BADGE_MAX_WORDS, HOOK_BADGE_MAX_CHARS)
}

/**
 * `#RRGGBB` + une opacité 0-100 → `rgba(r, g, b, a)`, la forme que le CSS et
 * le canevas 2D comprennent tous les deux.
 *
 * **Une seule fonction, deux consommateurs** — le calque de preview
 * (`hook-overlay.tsx`, en CSS) et le rasteriseur PNG (`src/server/hook-image.ts`,
 * `ctx.fillStyle`) — pour que le fond du hook ait exactement la même couleur
 * dans le navigateur et dans le fichier. Pure : aucune dépendance au DOM ni au
 * canevas, seulement de l'arithmétique sur une chaîne.
 */
export function hookRgba(hex: string, opacityPercent: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacityPercent / 100})`
}

/**
 * Où poser la boîte du hook sur son canevas, en pixels — le coin
 * supérieur gauche de l'image déjà rasterisée.
 *
 * **Prend l'image en entrée plutôt que de la mesurer elle-même** : sa largeur
 * et sa hauteur dépendent du texte réel (mesuré au pixel par le rasteriseur,
 * `src/server/hook-image.ts`), que cette fonction n'a aucun moyen de connaître
 * sans un contexte de canevas — ce qui la sortirait de `src/core`. Elle reste
 * donc pure : de l'arithmétique sur des tailles déjà connues, comme
 * `scheduleMarkers` (`src/server/steps/render.ts`) le fait pour les marques.
 *
 * Bornée aux **deux** extrémités de chaque axe : `Math.max(0, …)` empêche une
 * coordonnée négative que ffmpeg refuserait, `Math.min(…, canvas − image)`
 * empêche le débordement par la droite ou par le bas qu'un bornage à une
 * seule extrémité laisse passer — un mot insécable en alignement `left` peut
 * plafonner l'image à `canvas.w` (voir `renderHookImage`) sans que `x` en
 * tienne compte, donc `x + image.w` dépasse quand même le bord droit. Relevé
 * par Copilot sur la PR #117, passe 3 — même famille que les deux bornages à
 * une seule extrémité déjà corrigés sur cette PR (`boxWidth`, `boxHeight`).
 */
export function hookPlacement(
  image: { w: number; h: number },
  canvas: { w: number; h: number },
  resolved: Pick<ResolvedHook, 'position' | 'alignment'>,
  layout: HookLayout,
): { x: number; y: number } {
  const marginX = Math.round(canvas.w * layout.marginXFraction)
  // `bottom` protège une zone dont la hauteur du canevas fixe l'étendue (le
  // chrome de TikTok/Reels), `top` reste une marge de respiration assise sur
  // la largeur comme le reste de la géométrie — voir la doc de
  // `HOOK_MARGIN_BOTTOM_FRACTION`.
  const marginY = Math.round(
    (resolved.position === 'bottom' ? canvas.h : canvas.w) * layout.marginYFraction,
  )
  const x =
    resolved.alignment === 'left'
      ? marginX
      : resolved.alignment === 'right'
        ? canvas.w - marginX - image.w
        : Math.round((canvas.w - image.w) / 2)
  const y =
    resolved.position === 'top'
      ? marginY
      : resolved.position === 'bottom'
        ? canvas.h - marginY - image.h
        : Math.round((canvas.h - image.h) / 2)
  return {
    x: Math.min(Math.max(0, x), Math.max(0, canvas.w - image.w)),
    y: Math.min(Math.max(0, y), Math.max(0, canvas.h - image.h)),
  }
}

/**
 * La durée du fondu, en millisecondes, pour un côté (`enter`/`exit`).
 *
 * **300 ms, une valeur fixe.** Reprend la constante de l'ancien émetteur ASS
 * (`src/core/hook-ass.ts`, supprimé le 20 août 2026) : assez long pour se
 * voir, assez court pour ne pas manger la moitié d'un hook réglé à son
 * plancher de durée (200 ms, `HOOK_BOUNDS.durationMs.min`).
 */
export const HOOK_FADE_MS = 300

/**
 * La durée de fondu pour un côté, en millisecondes — 0 pour `none`, ou pour
 * `glitch`/`scanline`, non implémentées dans cette PR. Bornée à la moitié de
 * `durationMs` : au plancher de durée, deux fondus de 300 ms se
 * chevaucheraient sur toute la durée et le hook n'atteindrait jamais son
 * opacité normale (même correctif que portait déjà `hook-ass.ts`).
 *
 * **`glitch` et `scanline` ne sont jamais rendus comme un fondu.** L'énum
 * persistée les porte déjà (PR précédente) et l'écran les affiche
 * `disabled`, mais une valeur de l'un des deux peut arriver ici malgré tout —
 * une base éditée à la main, une régression amont. Les rendre comme un fondu
 * serait le mensonge silencieux que ce dépôt refuse ailleurs (`CLAUDE.md`) :
 * mieux vaut avertir et ne poser aucun fondu que d'en poser un que personne
 * n'a demandé.
 *
 * Appelée depuis `src/core/ffmpeg/args.ts`, à la construction du graphe —
 * donc uniquement à l'export, jamais à un `GET` de lecture, qui ne construit
 * aucun graphe ffmpeg.
 */
export function hookFadeMsFor(
  transition: HookSettings['enter'] | HookSettings['exit'],
  side: 'enter' | 'exit',
  durationMs: number,
): number {
  if (transition === 'fade') return Math.min(HOOK_FADE_MS, Math.floor(durationMs / 2))
  if (transition === 'glitch' || transition === 'scanline') {
    const label = side === 'enter' ? 'entrée' : 'sortie'
    console.warn(
      `Transition de ${label} "${transition}" pas encore rendue (hors périmètre de cette PR) : ` +
        'le hook sera incrusté sans transition.',
    )
  }
  return 0
}
