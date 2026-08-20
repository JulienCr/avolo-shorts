/**
 * Les constructeurs d'argv ffmpeg — purs, et testés en CI sans ffmpeg.
 *
 * Rien ici ne lance quoi que ce soit : ces fonctions rendent des tableaux de
 * chaînes, `src/server/` les passe à `spawn`. C'est ce qu'OpenShorts a fini par
 * faire en extrayant `general_render_cmd` — « split out so CI can assert on it
 * without ffmpeg » — et c'est la seule façon de vérifier une ligne de commande
 * ffmpeg sans GPU, sans vidéo et sans y passer la journée.
 *
 * **Deux règles mesurées, que les tests verrouillent :**
 *
 * 1. `-hwaccel` est une option d'**entrée** : sa portée s'arrête au `-i` qui
 *    suit. Avec N segments il y a N `-hwaccel cuda`, un devant chaque couple
 *    `-ss`/`-i`. Posée une seule fois en tête, seul le premier segment
 *    décoderait sur le GPU et les suivants retomberaient en logiciel — sans
 *    erreur, juste plus lentement, la manière la plus coûteuse de se tromper.
 * 2. **Jamais `-hwaccel_output_format cuda`.** Combiné à `-pix_fmt yuv420p`, il
 *    fait échouer l'encodage sur « Nothing was written into output file », sans
 *    message utile. Et libass exige de toute façon des images en mémoire
 *    système pour incruster les sous-titres. On décode sur GPU, on filtre sur
 *    CPU, on encode sur GPU.
 */

import type { Ratio, Segment } from '@/core/edl'
import { outputSize, sizeInCanvas } from '@/core/framing'
import {
  LOUDNORM,
  METADATA_SCRUB,
  RESAMPLE,
  videoEncodedArgs,
  type EncoderName,
} from '@/core/ffmpeg/encoder'

/**
 * Options communes à toutes les commandes.
 *
 * `-loglevel warning` plutôt que `error` : `src/server/` remonte les dernières
 * lignes de stderr quand ffmpeg échoue, et une commande qui produit un fichier
 * inutilisable a souvent averti avant. `-stats` garde la ligne `time=` dont la
 * barre de progression se nourrit.
 */
const GLOBAL: readonly string[] = [
  '-hide_banner',
  '-nostdin',
  '-y',
  '-loglevel',
  'warning',
  '-stats',
]

/**
 * La destination, précédée de `--`.
 *
 * Le fichier de sortie est **positionnel** : un chemin commençant par `-` est
 * lu comme une option. Mesuré : `ffmpeg … -sortie.mp4` échoue sur
 * « Unrecognized option 'sortie.mp4' », et `ffmpeg … -- -sortie.mp4` écrit le
 * fichier. Sur un chemin absolu, `--` ne change rien — c'est donc une garde
 * gratuite, et ces fonctions étant pures elles ne peuvent rien supposer des
 * conventions de nommage de l'appelant.
 */
function destination(dst: string): string[] {
  return ['--', dst]
}

/**
 * Un instant en secondes, tel que ffmpeg le lit.
 *
 * `String(n)` suffirait presque, mais rend `1e-7` sur les très petites valeurs
 * et traîne les débris de la virgule flottante : `2856.9 - 2841.2` vaut
 * `15.699999999999818`. On tronque à la microseconde et on retire les zéros de
 * queue — largement en deçà d'une image, même à 60 fps.
 */
function seconds(n: number): string {
  return n.toFixed(6).replace(/\.?0+$/, '')
}

/**
 * Échappe une valeur destinée à une option de filtre ffmpeg, écrite entre
 * apostrophes.
 *
 * **Mesuré sur le binaire, pas déduit de la documentation.** Une valeur de
 * filtre traverse `av_get_token` **deux fois** — une fois quand le graphe est
 * découpé en filtres, une fois quand les options du filtre sont séparées — et
 * les règles ne sont pas les mêmes des deux côtés d'une apostrophe :
 *
 * - **entre apostrophes, la contre-oblique n'échappe rien** : tout est littéral
 *   jusqu'à l'apostrophe suivante. Écrire `\'` à l'intérieur ne produit donc pas
 *   une apostrophe, il ferme la chaîne et laisse traîner une contre-oblique.
 *   C'était le défaut de la première version : `filename='/l\'été\:2026/c.ass'`
 *   échoue à l'analyse sur « No option name near '2026' ».
 * - **hors apostrophes, `\X` rend `X`**, quel que soit `X`. Sur-échapper est
 *   donc sans effet, sous-échapper coûte le caractère.
 *
 * D'où les trois règles, dans cet ordre :
 *
 * | dans le chemin | émis | pourquoi |
 * |---|---|---|
 * | `\` | `\\` | le second niveau la lirait comme une échappée |
 * | `:` | `\:` | le second niveau y sépare les options |
 * | `'` | `'\\\''` | fermer, écrire `\'` **doublement échappé**, rouvrir |
 *
 * La dernière ligne est la seule qui ne se devine pas. Hors des apostrophes,
 * pour que le **second** niveau reçoive `\'` — soit une apostrophe littérale —,
 * le **premier** doit lui livrer `\'`, ce qui s'écrit `\\` puis `\'`, soit
 * `\\\'`. Encadré des deux apostrophes de fermeture et de réouverture, cela
 * donne `'\\\''`.
 *
 * Vérifié par aller-retour sur des fichiers réellement posés sur le disque, aux
 * chemins `l'été:2026`, `a'b'c`, `[x],y;z=w`, `dos\slash` et `';exit[v];a='` :
 * libass les charge tous les cinq, et la tentative d'évasion reste dans la
 * valeur au lieu de rouvrir le graphe.
 *
 * L'ordre des trois remplacements compte : `\` d'abord, sinon on doublerait les
 * contre-obliques qu'on vient d'écrire.
 */
function escape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "'\\\\\\''")
}

/**
 * Un nombre destiné au graphe de filtres.
 *
 * TypeScript garantit `number` à la compilation, et rien à l'exécution : une
 * valeur venue d'un JSON de branding ou de la base peut arriver ici à travers
 * un cast. Un `NaN` sortirait en `crop=608:1080:NaN:0`, que ffmpeg refuse avec
 * un message qui ne nomme pas la cause ; une chaîne forcée sortirait telle
 * quelle **dans le graphe**, où elle n'a rien à faire.
 *
 * `Number.isFinite` ferme les deux d'un coup, et c'est la garde que `cropRect`
 * applique déjà à `cropX` : une fonction pure ne peut rien supposer de son
 * appelant.
 */
function number(n: number, what: string): string {
  if (!Number.isFinite(n)) {
    // `String` et non `JSON.stringify` : ce dernier rend `null` pour `NaN`
    // comme pour les deux infinis, donc le message désignerait une valeur que
    // l'appelant n'a pas passée. Un diagnostic qui ment coûte plus qu'il ne
    // rapporte.
    throw new Error(`${what} doit être un nombre fini, reçu ${String(n)}.`)
  }
  return String(n)
}

/**
 * Une option de filtre, valeur entre apostrophes : `filename='/c.ass'`.
 *
 * Les apostrophes ne sont pas décoratives : elles rendent `[`, `]`, `,` et `;`
 * littéraux pour le découpage du graphe, donc un chemin ne peut pas en sortir
 * même si la table d'échappement venait à être rognée.
 */
function option(name: string, value: string): string {
  return `${name}='${escape(value)}'`
}

/**
 * Le proxy : ce sur quoi l'interface scrube, et sur quoi l'itération 1 fera
 * tourner la détection.
 *
 * 960x540 plutôt que 640x360 (spec §6) : un comédien qui occupe 6 % de la
 * largeur ne fait que 38 pixels de large sur un proxy 640, ce qui est mince
 * pour YOLO.
 *
 * `fps=30` **quelle que soit la source**. Les replays ne sont pas tous en 60 —
 * `2025-06-15-cqlp.mp4` est en 30 — et le filtre traite les deux cas.
 *
 * `-g 30` pose une image clé par seconde : c'est ce qui rend le scrub instantané
 * dans le navigateur.
 *
 * **Le palier est `fast`, et l'encodeur se choisit à l'appel.** Mesuré sur cette
 * machine, le proxy ne gagne rien au GPU : 13,8x en x264 contre 12,8x en NVENC,
 * le redimensionnement se faisant sur le processeur dans les deux cas.
 */
export function proxyArgs(o: { src: string; dst: string; encoder: EncoderName }): string[] {
  return [
    ...GLOBAL,
    ...acceleration(o.encoder),
    '-i', o.src,
    // `-map` explicite, et `0:v:0` plutôt que `0:v` : une source peut porter
    // une pochette, que ffmpeg expose comme un second flux vidéo et
    // embarquerait dans le proxy servi au navigateur. Le `?` sur l'audio laisse
    // passer une source muette.
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', 'fps=30,scale=960:540',
    '-g', '30',
    ...videoEncodedArgs(o.encoder, 'fast'),
    // Le son sert au montage : le repérage des coupes se fait à l'oreille.
    '-c:a', 'aac', '-b:a', '128k',
    ...METADATA_SCRUB,
    '-movflags', '+faststart',
    ...destination(o.dst),
  ]
}

/**
 * L'audio pour WhisperX : WAV 16 kHz mono, ce que le modèle attend et ce qu'il
 * rééchantillonnerait lui-même sinon.
 *
 * `-vn` : rien à décoder du côté image, donc rien à accélérer non plus.
 */
export function audioArgs(o: { src: string; dst: string }): string[] {
  return [
    ...GLOBAL,
    '-i', o.src,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    ...destination(o.dst),
  ]
}

/**
 * La vignette d'un candidat : **une image, prise dans le proxy**.
 *
 * Dans le proxy et jamais dans l'original, pour la raison qui a fait construire
 * le proxy : l'original pèse jusqu'à 12,7 Go et vit sur un montage 9p à 40 Mo/s.
 * Une grille de vingt-cinq cartes y demanderait vingt-cinq ouvertures de fichier
 * distantes, là où le proxy est local et déjà décodé pour l'écran de clip.
 *
 * `-ss` **avant** `-i` : ffmpeg saute alors dans le conteneur au lieu de décoder
 * depuis le début, ce qui fait toute la différence sur une image prise à
 * quarante minutes. Le proxy porte un `-g 30`, donc une image-clé toutes les
 * secondes : la seconde d'écart que peut coûter un saut approché est sans
 * conséquence pour une vignette.
 *
 * `-update 1` : sans lui, une sortie `.jpg` est traitée comme une séquence
 * numérotée et ffmpeg avertit à chaque appel.
 */
export function thumbArgs(o: { src: string; dst: string; at: number }): string[] {
  return [
    ...GLOBAL,
    '-ss', seconds(Math.max(0, o.at)),
    '-i', o.src,
    '-map', '0:v:0',
    '-an',
    '-frames:v', '1',
    '-q:v', '4',
    '-update', '1',
    ...destination(o.dst),
  ]
}

/**
 * La vignette d'une **source** : une image prise dans l'original, sur le 9p.
 *
 * C'est l'exact contraire de `thumbArgs` juste au-dessus, et la contradiction
 * n'en est pas une : au moment de choisir un replay dans la bibliothèque, aucun
 * proxy n'existe encore. Il n'y a rien d'autre à ouvrir que le fichier
 * d'origine, 4,5 à 12,7 Go sur un montage 9p (spec §12, issue #41).
 *
 * **`-ss` avant `-i`, et c'est toute la mesure.** ffmpeg cherche alors dans le
 * conteneur au lieu de décoder depuis le début : médiane ~2,7 s par fichier,
 * relevé sur trois émissions le 18 août 2026. Inversés, les deux options
 * feraient décoder plusieurs minutes de vidéo par carte et la grille ne
 * vaudrait plus son coût — l'issue le dit ainsi : « toute implémentation qui
 * inverse les deux invalide ce ticket ». C'est la contrainte la plus facile à
 * casser par inadvertance de tout ce fichier, et `tests/core/ffmpeg-args`
 * verrouille l'ordre des deux.
 *
 * **Réduite à 640 de large.** L'original est en 1920x1080 et la carte réserve
 * environ 170 points ; servir la pleine résolution coûterait quelques centaines
 * de kilooctets par carte pour un emplacement qui en affiche le sixième.
 * Mesuré sur `2025-11-09-realisateur` : 47 ko en 640x360. `min(640, iw)`
 * n'agrandit pas une source déjà plus petite, et la virgule est échappée parce
 * qu'à ce niveau-là de la syntaxe elle sépare deux filtres d'une chaîne.
 * `-2` pour la hauteur : déduite du rapport, arrondie à un nombre pair, que les
 * encodeurs 4:2:0 exigent.
 */
export function sourceThumbArgs(o: { src: string; dst: string; at: number }): string[] {
  return [
    ...GLOBAL,
    '-ss', seconds(Math.max(0, o.at)),
    '-i', o.src,
    '-map', '0:v:0',
    '-an',
    '-frames:v', '1',
    '-vf', 'scale=w=min(640\\,iw):h=-2',
    '-q:v', '4',
    '-update', '1',
    ...destination(o.dst),
  ]
}

/** `-hwaccel cuda` seul, et seulement quand on encodera sur le GPU. */
function acceleration(encoder: EncoderName): string[] {
  return encoder === 'nvenc' ? ['-hwaccel', 'cuda'] : []
}

/** Un rectangle à découper dans l'image source, tel que `cropRect` le rend. */
export type Rectangle = { w: number; h: number; x: number; y: number }

/**
 * Un morceau à décoder, **avec le cadre qui lui appartient**.
 *
 * C'est ce que le cadrage automatique impose au rendu : le ratio et la position
 * du crop sont fixes *à l'intérieur d'un plan* et sautent à ses frontières
 * (spec §10). Un segment qui traverse une frontière se découpe donc en autant
 * d'entrées que de plans traversés, chacune avec son rectangle et son ratio — un
 * `-ss`/`-t`/`-i` par entrée, et une composition par entrée dans le graphe.
 *
 * **Ce n'est pas une caméra qui suit.** Le cadre ne bouge qu'aux endroits où une
 * coupe existe déjà, donc où le saut est invisible ; entre deux frontières il ne
 * bouge pas d'un pixel.
 */
export type FramedSegment = Segment & {
  crop: Rectangle
  /**
   * Le ratio du cadre, qui décide de la place qu'il occupe dans le canevas.
   *
   * Il se déduirait presque de `crop` — presque, et c'est pourquoi il est
   * explicite : `cropRect` arrondit ses composantes au pair, donc un 9:16 sort
   * en 608x1080 et non en 607,5x1080. La hauteur calculée depuis ce rapport
   * tomberait à 1918 au lieu de 1920, et laisserait une bande de fond flouté de
   * un pixel en haut et en bas d'un cadre qui devait remplir.
   */
  ratio: Ratio
}

export type RenderOptions = {
  src: string
  dst: string
  /**
   * Les morceaux à concaténer, dans l'ordre, chacun avec son cadre.
   *
   * **Ils ne sont pas normalisés ici, et c'est le point.** `normalizeSegments`
   * fusionne deux segments qui se touchent — ce qu'il faut sur une liste de
   * montage, et ce qu'il ne faut surtout pas ici : deux entrées adjacentes qui
   * se touchent sont précisément les deux moitiés d'un segment coupé sur une
   * frontière de plan, et les fusionner ferait cadrer la seconde avec le cadre
   * de la première. L'appelant normalise le montage *avant* de le découper par
   * plan ; ce qui arrive ici est déjà canonique et se contrôle.
   */
  segments: FramedSegment[]
  /**
   * Le canevas du **rendu natif** : `outputSize` du ratio le plus large que les
   * plans demandent. La variante 9:16 l'ignore, elle a le sien.
   */
  out: { w: number; h: number }
  assPath?: string
  /**
   * Le PNG du hook (`src/server/hook-image.ts`), s'il y a quelque chose à
   * incruster — un `overlay=x:y`, comme les logos, et non plus un second
   * document `ass=`.
   *
   * **`x`/`y` sont en pixels du canevas de CETTE sortie**, contrairement à
   * l'ancien document ASS qui s'incrustait à l'identique sur les deux
   * canevas via un repère partagé (`PlayResX 384 × PlayResY 288`). Le PNG et
   * son placement sont désormais mesurés en pixels réels, donc **planifiés
   * par canevas** — `renderArgs` et `blurredVariantArgs` reçoivent chacun
   * leur propre `hookImage`, pas le même. C'est la même raison que les
   * marques (`scheduleMarkers`) : deux canevas de largeurs différentes (le
   * natif 16:9 fait 1920, tout le reste fait 1080) rendraient sinon un hook
   * mal placé ou mal dimensionné sur l'un des deux.
   */
  hookImage?: { path: string; x: number; y: number; w: number; h: number }
  fontsDir?: string
  logos?: { path: string; x: number; y: number; w: number; h: number }[]
  encoder: EncoderName
}

/** Une étape linéaire du graphe : une étiquette entre, une étiquette sort. */
type Step = (entry: string, output: string) => string

/**
 * Écrit une suite d'étapes dans le graphe et rend l'étiquette qui en sort.
 *
 * Les étapes sont **comptées avant d'être écrites**, parce que c'est la
 * dernière — quelle qu'elle soit — qui doit porter l'étiquette terminale.
 * Sans cela il faudrait un filtre de rattrapage, ou un `-map` dont le nom
 * change avec les options.
 *
 * Aucune étape : rien n'est écrit et l'entrée ressort telle quelle. L'appelant
 * a alors fait écrire l'étiquette terminale par ce qui précède.
 */
function chain(
  graph: string[],
  entry: string,
  steps: readonly Step[],
  terminal: string,
): string {
  let current = entry
  steps.forEach((step, i) => {
    const output = i === steps.length - 1 ? terminal : `vf${i}`
    graph.push(step(current, output))
    current = output
  })
  return current
}

/**
 * L'écart-type du flou de fond, **et il ne monte pas**.
 *
 * C'était la première piste de #22, et elle est mauvaise : monter le sigma
 * floute toute l'image davantage — le fond n'a pas à être une purée — sans
 * garantir d'effacer quoi que ce soit. Mesuré à l'image sur un 1:1 : à 12, un
 * carton de 40 px cerclé d'un contour de 8, agrandi 1,78x par la mise à
 * l'échelle du fond, reste **pleinement lisible**, le jaune du mot actif
 * compris. Un flou gaussien étale un trait à fort contraste, il ne le détruit
 * pas ; il faudrait un sigma tel que le fond cesserait d'être une image.
 *
 * La bonne réponse est en amont : ne jamais mettre de texte dans le fond. C'est
 * ce que garantit le `split`, qui prend sa branche **avant** toute incrustation.
 */
const BACKGROUND_SIGMA = 12

/**
 * Le rendu **natif** d'un clip, celui du feed d'Instagram et de Facebook, depuis
 * l'original et jamais depuis le proxy.
 *
 * **Un seul ratio pour tout le clip** — `o.out` —, et les entrées le portent
 * toutes : une vidéo de feed dont les bandes latérales apparaîtraient et
 * disparaîtraient au fil des plans serait exactement le défaut que le fond
 * flouté existe pour éviter. Ce qui varie ici est la seule **position** du crop,
 * qui saute aux frontières de plans.
 *
 * La forme, pour deux entrées :
 *
 * ```
 * -hwaccel cuda -ss <s0> -t <d0> -i src      un quadruplet par entrée
 * -hwaccel cuda -ss <s1> -t <d1> -i src
 * -filter_complex
 *   [0:v]crop=…,scale=…,setsar=1[v0]; [1:v]…[v1];   un crop par entrée
 *   [v0][0:a][v1][1:a]concat=n=2:v=1:a=1[vc][ac];
 *   [ac]loudnorm=…,aresample=48000[a];
 *   [vc]ass=filename='…':fontsdir='…'[v]
 * -map [v] -map [a] <encodeur> -c:a aac -movflags +faststart -- dst
 * ```
 *
 * **Les sous-titres et les marques s'incrustent APRÈS la composition**, une
 * seule fois, à l'échelle du canevas. Sur le natif ça ne change rien — le cadre
 * remplit son canevas —, mais c'est la même fonction qui rend la variante, où le
 * point décide de tout : l'ordre précédent réduisait le texte avec l'image, et
 * un 16:9 posé dans un 9:16 s'y retrouvait à 31,6 % de sa taille, illisible.
 *
 * **La normalisation de sonie est dans le graphe, pas en `-af`.** Un `-af` sur
 * un flux issu de `-map [a]` fait échouer ffmpeg : « Simple and complex
 * filtering cannot be used together for the same stream ».
 *
 * **Limite assumée :** un `-ss`/`-i` par entrée ouvre un décodeur par entrée.
 * C'est mesuré bon jusqu'à une dizaine. Le cadrage automatique en ajoute : un
 * segment qui traverse cinq plans compte pour cinq entrées, et la médiane des
 * plans est de 5,3 s sur `2026-03-08-caro-mdlm`. `renderClip` compte et le dit
 * au journal au-delà du seuil. Le nettoyage déterministe des hésitations de
 * l'itération 3 produira des dizaines de coupures : il faudra alors rendre
 * morceau par morceau puis concaténer en copie de flux. Ne pas le construire
 * maintenant.
 */
export function renderArgs(o: RenderOptions): string[] {
  return buildRender(o, o.out)
}

/**
 * La variante 9:16 sur fond flouté, pour TikTok et Shorts.
 *
 * **C'est ici que le ratio varie par plan.** Chaque entrée est posée sur le
 * canevas vertical au cadre le plus serré qui tienne sur son plan, le fond
 * flouté prenant le reste : un 9:16 remplit, un 4:5 occupe 70,3 % de la hauteur,
 * un 1:1 56,3 %, un 16:9 31,6 %. Le saut de taille tombe sur une coupe, donc il
 * ne se voit pas — c'est le même argument qui justifie déjà le crop qui saute
 * aux frontières. C'est aussi exactement le bénéfice que la spec §2 reproche à
 * OpenShorts de ne pas prendre : un 16:9 en letterbox n'occupe que 31,6 % de
 * l'écran, un 4:5 en occupe 70 %.
 *
 * **Elle se rend depuis la source, et c'est le correctif de #22.** Elle partait
 * auparavant du MP4 natif déjà terminé : son fond était donc un agrandissement
 * du clip fini, cartons de sous-titres compris, et le flou ne les effaçait pas —
 * constaté à l'image, le carton restait lisible à la même taille dans la bande
 * du bas, sous le vrai. Monter le sigma ne répare pas ça (voir `SIGMA_DU_FOND`) ;
 * tirer le fond d'un contenu qui n'a jamais porté de texte, si. Le `split` est
 * donc **avant** l'incrustation, et le fond ne peut plus contenir de texte par
 * construction.
 *
 * C'est aussi ce qui rend le ratio par plan gratuit : les deux sorties étant
 * deux rendus indépendants, un plan serré n'est jamais rétréci deux fois.
 *
 * Ce que ça coûte : le décodage des segments une seconde fois, soit une fraction
 * de l'encodage — mesuré, le décodage seul tourne à 16x contre 4,6x pour
 * l'export. Le son est normalisé depuis la source comme celui du natif, et non
 * recopié : c'est le même `loudnorm` sur le même PCM d'origine, donc toujours
 * une seule compression.
 */
export function blurredVariantArgs(o: RenderOptions): string[] {
  return buildRender(o, outputSize('9:16'))
}

/**
 * Le constructeur commun aux deux sorties d'un clip.
 *
 * `canvas` porte toute la différence, et le reste est **le même** : les mêmes
 * morceaux, les mêmes sous-titres, la même sonie. Deux constructeurs séparés
 * l'ont laissé diverger une fois déjà (#22).
 *
 * **Chaque entrée est composée sur le canevas avant la concaténation**, parce
 * que `concat` exige des flux de même taille : une entrée dont le cadre ne
 * remplit pas le canevas sort son fond de son propre `split`, le floute, et se
 * pose dessus. Le natif n'y passe jamais — son cadre a le ratio du canevas — et
 * le graphe s'y réduit à `crop,scale,setsar`.
 */
function buildRender(
  o: RenderOptions,
  requestedCanvas: { w: number; h: number },
): string[] {
  // **Le canevas se contrôle avant d'entrer dans le graphe.** TypeScript garantit
  // `number` à la compilation et rien à l'exécution : `out` vient de la base par
  // l'intermédiaire d'un ratio, et un `Infinity` sortirait en `scale=Infinity:1920`
  // sans que rien ne le nomme. Il ne sert plus à composer la chaîne d'échelle,
  // qui passe désormais par `sizeInCanvas` — d'où la garde explicite, que
  // ce détour avait fait disparaître.
  // Appelées pour leur refus et non pour leur valeur : elles lèvent sur un
  // nombre non fini, et c'est tout ce qu'on leur demande ici.
  number(requestedCanvas.w, 'out.w')
  number(requestedCanvas.h, 'out.h')
  const canvas = requestedCanvas
  // **Contrôlées, pas normalisées.** Une borne `NaN` traverserait
  // `normalizeSegments` sans bruit — `end > start` est faux, donc le segment
  // disparaîtrait et un clip de trois entrées en rendrait deux sans un mot —, et
  // une borne infinie ressortirait en `-t Infinity`. Mais fusionner n'est plus
  // permis ici : deux entrées qui se touchent sont les deux moitiés d'un segment
  // coupé sur une frontière de plan, et chacune porte son propre cadre.
  const segments = o.segments
  if (segments.length === 0) {
    throw new Error(
      "Aucun segment à rendre : un clip est une liste de segments, et une liste vide n'a pas de durée.",
    )
  }
  segments.forEach((s, i) => {
    number(s.start, `segments[${i}].start`)
    number(s.end, `segments[${i}].end`)
    if (s.end <= s.start) {
      throw new Error(
        `segments[${i}] ne dure pas : ${seconds(s.start)} → ${seconds(s.end)}. ` +
          "Un morceau vide ouvre un décodeur qui ne rend aucune image, et décale d'autant les " +
          'sous-titres, qui sont calés sur la somme des durées demandées.',
      )
    }
    // **Strictement croissantes et sans recouvrement.** Le recalage des
    // sous-titres additionne les durées des entrées dans leur ordre : deux
    // entrées qui se chevauchent feraient afficher les bons mots au mauvais
    // moment sur tout ce qui suit, et aucun test de durée ne le verrait.
    const previous = i === 0 ? null : segments[i - 1]
    if (previous !== null && s.start < previous.end) {
      throw new Error(
        `segments[${i}] commence avant la fin de segments[${i - 1}] ` +
          `(${seconds(s.start)} < ${seconds(previous.end)}). Les entrées se concatènent dans ` +
          "l'ordre où elles arrivent, et les sous-titres sont recalés sur cette somme.",
      )
    }
  })

  const logos = o.logos ?? []
  const multi = segments.length > 1

  // **Le PNG du hook prend une entrée à lui seul**, juste après les segments
  // et avant les logos — voir la doc de `hookImage` sur `RenderOptions` pour
  // pourquoi il est planifié par canevas et non partagé entre les deux
  // sorties comme l'était l'ancien document ASS.
  const hookInputIndex = o.hookImage !== undefined ? segments.length : null
  const logoInputOffset = segments.length + (hookInputIndex !== null ? 1 : 0)

  // Ce qui s'incruste **sur le canevas composé**, une seule fois, à sa taille.
  //
  // **L'ordre est sous-titres → hook → marques.** Le hook après les
  // sous-titres et avant les marques, pour la même raison que les marques
  // passent après les sous-titres deux lignes plus bas : une marque posée
  // dessous serait recouverte par le premier carton qui monte assez haut, et
  // ça vaut *a fortiori* pour un bandeau de hook, généralement plus haut
  // encore. `chain()` compte les étapes après coup — ajouter une étape
  // conditionnelle de plus continue de fonctionner dans les quatre
  // combinaisons (avec/sans sous-titres × avec/sans hook), y compris le hook
  // seul : la seule chose qui compte est que la DERNIÈRE étape écrite porte
  // l'étiquette terminale, et `chain()` s'en charge sans savoir laquelle des
  // deux ce sera.
  const steps: Step[] = []
  if (o.assPath !== undefined) {
    const options = [option('filename', o.assPath)]
    // `filename=` nommé et non positionnel : un chemin en position portant un
    // `:` serait lu comme le début de l'option suivante.
    if (o.fontsDir !== undefined) options.push(option('fontsdir', o.fontsDir))
    steps.push((e, s) => `[${e}]ass=${options.join(':')}[${s}]`)
  }
  // **Un `overlay`, comme les logos — plus un `ass=`.** Le PNG est déjà à sa
  // taille finale (`src/server/hook-image.ts` le rasterise pour ce canevas
  // précis), donc pas de `scale=` préalable comme en ont besoin les logos, qui
  // partent de leur taille native.
  if (o.hookImage !== undefined && hookInputIndex !== null) {
    const x = number(o.hookImage.x, 'hookImage.x')
    const y = number(o.hookImage.y, 'hookImage.y')
    steps.push((e, s) => `[${e}][${hookInputIndex}:v]overlay=x=${x}:y=${y}[${s}]`)
  }
  // Les logos passent **après** l'incrustation des sous-titres et du hook :
  // une marque posée dessous serait recouverte par le premier carton (ou le
  // bandeau de hook) qui monte assez haut.
  logos.forEach((logo, i) => {
    const x = number(logo.x, `logos[${i}].x`)
    const y = number(logo.y, `logos[${i}].y`)
    steps.push((e, s) => `[${e}][lg${i}]overlay=x=${x}:y=${y}[${s}]`)
  })

  // Où finit tout le graphe. Quand rien ne s'incruste, c'est la composition —
  // ou la concaténation — qui écrit directement cette étiquette : un graphe ne
  // porte pas de filtre de rattrapage, et un `-map` dont le nom changerait avec
  // les options se paierait un jour.
  const terminal = 'v'
  const concatLabel = steps.length === 0 ? terminal : 'vc'
  const entryLabel = (i: number): string =>
    multi ? `v${i}` : steps.length === 0 ? terminal : 'v0'

  const graph: string[] = []
  segments.forEach((s, i) => {
    const c = s.crop
    const crop =
      `crop=${number(c.w, `segments[${i}].crop.w`)}:${number(c.h, `segments[${i}].crop.h`)}` +
      `:${number(c.x, `segments[${i}].crop.x`)}:${number(c.y, `segments[${i}].crop.y`)}`
    const inCanvas = sizeInCanvas(s.ratio, canvas)
    const output = entryLabel(i)

    if (inCanvas.h >= canvas.h) {
      // Le cadre remplit le canevas : pas de fond à fabriquer, et le composer
      // quand même ferait payer un `gblur` sur une image que rien ne montre.
      graph.push(
        `[${i}:v]${crop},scale=${canvas.w}:${canvas.h}:flags=lanczos,setsar=1[${output}]`,
      )
      return
    }

    // **Le `split` d'abord, l'incrustation nulle part ici.** Le fond est tiré du
    // contenu *avant* que quoi que ce soit ne s'y pose — c'est le correctif de
    // #22, et il est structurel : le fond ne peut pas porter de texte puisqu'il
    // n'en a jamais vu passer. `force_original_aspect_ratio=increase` puis
    // `crop` couvrent le canevas sans déformer.
    graph.push(`[${i}:v]${crop},setsar=1[c${i}]`)
    graph.push(`[c${i}]split=2[bga${i}][fga${i}]`)
    graph.push(
      `[bga${i}]scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=increase,` +
        `crop=${canvas.w}:${canvas.h},gblur=sigma=${BACKGROUND_SIGMA}[bg${i}]`,
    )
    graph.push(`[fga${i}]scale=${inCanvas.w}:${inCanvas.h}:flags=lanczos[fg${i}]`)
    graph.push(`[bg${i}][fg${i}]overlay=x=0:y=(H-h)/2,setsar=1[${output}]`)
  })

  // Pas de `?` sur les entrées audio, et c'est délibéré : une étiquette de
  // graphe ne s'annote pas, et `concat` avec `a=1` exige de toute façon une
  // piste son sur **chaque** entrée. Un replay muet est un replay raté ; mieux
  // vaut que le rendu échoue franchement que de livrer un clip silencieux.
  let audio: string
  let content: string
  if (multi) {
    const entries = segments.map((_, i) => `[v${i}][${i}:a]`).join('')
    graph.push(`${entries}concat=n=${segments.length}:v=1:a=1[${concatLabel}][ac]`)
    audio = 'ac'
    content = concatLabel
  } else {
    audio = '0:a'
    content = entryLabel(0)
  }
  // `aresample` derrière `loudnorm`, et ce n'est pas décoratif : en passe
  // unique, `loudnorm` travaille à 192 kHz pour mesurer les crêtes et sort à ce
  // taux. ffmpeg insère alors tout seul un rééchantillonnage vers le plus haut
  // taux que l'AAC accepte — mesuré, une source à 44,1 kHz ressortait en
  // **96 kHz**. Personne ne livre du 96 kHz.
  graph.push(`[${audio}]${LOUDNORM},${RESAMPLE}[a]`)

  // Les logos sont des images fixes : on les met à l'échelle une fois, puis on
  // les superpose. La position donnée est le coin supérieur gauche.
  //
  // **`logoInputOffset`, pas `segments.length`** : le PNG du hook, s'il y en
  // a un, s'est glissé une entrée avant les logos (voir sa définition plus
  // haut) — sans ce décalage, chaque logo pointerait vers l'entrée qui le
  // précède, et le dernier logo n'aurait pas d'entrée du tout.
  logos.forEach((logo, i) => {
    const w = number(logo.w, `logos[${i}].w`)
    const h = number(logo.h, `logos[${i}].h`)
    graph.push(`[${logoInputOffset + i}:v]scale=${w}:${h}[lg${i}]`)
  })

  chain(graph, content, steps, terminal)

  return [
    ...GLOBAL,
    // Un `-hwaccel` **par entrée**, et non un seul en tête : c'est une option
    // d'entrée, sa portée s'arrête au `-i` qui suit.
    ...segments.flatMap((s) => [
      ...acceleration(o.encoder),
      '-ss', seconds(s.start),
      '-t', seconds(s.end - s.start),
      '-i', o.src,
    ]),
    // Le PNG du hook, s'il y en a un, juste après les segments — voir
    // `hookInputIndex`. Pas de `-hwaccel` non plus : même raison que les logos.
    ...(o.hookImage !== undefined ? ['-i', o.hookImage.path] : []),
    // Les logos n'ont pas de `-hwaccel` : décoder un PNG sur le GPU ne rapporte
    // rien et le ferait remonter en mémoire vidéo pour redescendre aussitôt.
    ...logos.flatMap((logo) => ['-i', logo.path]),
    '-filter_complex', graph.join(';'),
    '-map', '[v]',
    '-map', '[a]',
    ...videoEncodedArgs(o.encoder, 'quality'),
    '-c:a', 'aac', '-b:a', '192k',
    ...METADATA_SCRUB,
    '-movflags', '+faststart',
    ...destination(o.dst),
  ]
}
