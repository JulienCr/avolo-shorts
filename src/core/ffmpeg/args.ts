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

import { normalizeSegments, type Segment } from '@/core/edl'
import { outputSize } from '@/core/framing'
import {
  LOUDNORM,
  METADATA_SCRUB,
  RESAMPLE,
  videoEncodeArgs,
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
const GLOBALES: readonly string[] = [
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
function secondes(n: number): string {
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
function échapper(valeur: string): string {
  return valeur
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
function nombre(n: number, quoi: string): string {
  if (!Number.isFinite(n)) {
    // `String` et non `JSON.stringify` : ce dernier rend `null` pour `NaN`
    // comme pour les deux infinis, donc le message désignerait une valeur que
    // l'appelant n'a pas passée. Un diagnostic qui ment coûte plus qu'il ne
    // rapporte.
    throw new Error(`${quoi} doit être un nombre fini, reçu ${String(n)}.`)
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
function option(nom: string, valeur: string): string {
  return `${nom}='${échapper(valeur)}'`
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
    ...GLOBALES,
    ...accélération(o.encoder),
    '-i', o.src,
    // `-map` explicite, et `0:v:0` plutôt que `0:v` : une source peut porter
    // une pochette, que ffmpeg expose comme un second flux vidéo et
    // embarquerait dans le proxy servi au navigateur. Le `?` sur l'audio laisse
    // passer une source muette.
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', 'fps=30,scale=960:540',
    '-g', '30',
    ...videoEncodeArgs(o.encoder, 'fast'),
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
    ...GLOBALES,
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
    ...GLOBALES,
    '-ss', secondes(Math.max(0, o.at)),
    '-i', o.src,
    '-map', '0:v:0',
    '-an',
    '-frames:v', '1',
    '-q:v', '4',
    '-update', '1',
    ...destination(o.dst),
  ]
}

/** `-hwaccel cuda` seul, et seulement quand on encodera sur le GPU. */
function accélération(encoder: EncoderName): string[] {
  return encoder === 'nvenc' ? ['-hwaccel', 'cuda'] : []
}

export type RenderOptions = {
  src: string
  dst: string
  segments: Segment[]
  crop: { w: number; h: number; x: number; y: number }
  out: { w: number; h: number }
  assPath?: string
  fontsDir?: string
  logos?: { path: string; x: number; y: number; w: number; h: number }[]
  encoder: EncoderName
}

/** Une étape linéaire du graphe : une étiquette entre, une étiquette sort. */
type Étape = (entrée: string, sortie: string) => string

/**
 * Écrit une suite d'étapes dans le graphe et rend l'étiquette qui en sort.
 *
 * Les étapes sont **comptées avant d'être écrites**, parce que c'est la
 * dernière — quelle qu'elle soit — qui doit porter l'étiquette terminale.
 * Sans cela il faudrait un filtre de rattrapage, ou un `-map` dont le nom
 * change avec les options.
 *
 * Aucune étape : rien n'est écrit et l'entrée ressort telle quelle. C'est le
 * cas d'un rendu natif sans sous-titres ni marque, où le découpage écrit
 * directement dans l'étiquette terminale.
 */
function enchaîner(
  graphe: string[],
  entrée: string,
  étapes: readonly Étape[],
  terminal: string,
): string {
  let courant = entrée
  étapes.forEach((étape, i) => {
    const sortie = i === étapes.length - 1 ? terminal : `vf${i}`
    graphe.push(étape(courant, sortie))
    courant = sortie
  })
  return courant
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
 * La bonne réponse est en amont : ne jamais mettre de texte dans le fond.
 */
const SIGMA_DU_FOND = 12

/**
 * Le rendu d'un clip, **depuis l'original** et jamais depuis le proxy.
 *
 * La forme, validée sur la machine (36 secondes produites en 10, bornes
 * exactes, pas de décodage depuis le début du fichier) :
 *
 * ```
 * -hwaccel cuda -ss <s0> -t <d0> -i src      un quadruplet par segment
 * -hwaccel cuda -ss <s1> -t <d1> -i src
 * -filter_complex
 *   [0:v]crop=…,scale=…,setsar=1[v0]; [1:v]…[v1];
 *   [v0][0:a][v1][1:a]concat=n=2:v=1:a=1[vc][ac];
 *   [ac]loudnorm=…,aresample=48000[a];
 *   [vc]ass=filename='…':fontsdir='…'[v]
 * -map [v] -map [a] <encodeur> -c:a aac -movflags +faststart -- dst
 * ```
 *
 * **La normalisation de sonie est dans le graphe, pas en `-af`.** Un `-af` sur
 * un flux issu de `-map [a]` fait échouer ffmpeg : « Simple and complex
 * filtering cannot be used together for the same stream ».
 *
 * **Limite assumée :** un `-ss`/`-i` par segment ouvre un décodeur par segment.
 * C'est mesuré bon jusqu'à une dizaine, ce qui couvre l'itération 0. Le
 * nettoyage déterministe des hésitations de l'itération 3 produira des dizaines
 * de coupures : il faudra alors rendre segment par segment puis concaténer en
 * copie de flux. Ne pas le construire maintenant.
 */
export function renderArgs(o: RenderOptions): string[] {
  return construireLeRendu(o, null)
}

/**
 * La variante 9:16 sur fond flouté, pour TikTok et Shorts.
 *
 * **Le contenu est déjà cropé**, donc il se pose **pleine largeur** et centré —
 * et non au ratio 0,42 d'OpenShorts, qui partait de 16:9 brut et rognait les
 * côtés pour gagner en présence. Un 1:1 occupe alors 56 % de la hauteur et un
 * 4:5 en occupe 70 %, contre 32 % pour un 16:9 en letterbox : c'est exactement
 * le bénéfice que la spec §2 reproche à OpenShorts de ne pas prendre.
 *
 * **Elle se rend depuis la source, avec les mêmes arguments que le rendu
 * natif, et c'est le correctif de #22.** Elle partait auparavant du MP4 natif
 * déjà terminé : son fond était donc un agrandissement du clip fini, cartons de
 * sous-titres compris, et le flou ne les effaçait pas — constaté à l'image, le
 * carton restait lisible à la même taille dans la bande du bas, sous le vrai.
 * Monter le sigma ne répare pas ça (voir `SIGMA_DU_FOND`) ; tirer le fond d'un
 * contenu qui n'a jamais porté de texte, si. Le `split` est donc **avant**
 * l'incrustation, et le fond ne peut plus contenir de texte par construction.
 *
 * Ce que ça coûte : le décodage des segments une seconde fois, soit une
 * fraction de l'encodage — mesuré, le décodage seul tourne à 16x contre 4,6x
 * pour l'export. Ce que ça rapporte en plus : l'avant-plan ne traverse plus
 * deux encodages successifs, puisqu'il ne recycle plus un MP4 déjà encodé.
 *
 * Le son est normalisé depuis la source comme celui du natif, et non plus
 * recopié : c'est le même `loudnorm` sur le même PCM d'origine, donc toujours
 * une seule compression.
 */
export function blurredVariantArgs(o: RenderOptions): string[] {
  // La variante est toujours en 9:16 : c'est sa raison d'être.
  return construireLeRendu(o, outputSize('9:16'))
}

/**
 * Le constructeur commun aux deux sorties d'un clip.
 *
 * `canevas` porte toute la différence : `null` rend le format natif, une taille
 * rend la variante posée sur son fond flouté. Le reste — les segments, le
 * rectangle de crop, les sous-titres, les marques, la sonie — est **le même**,
 * et c'est le point : les deux fichiers doivent montrer le même cadre. Deux
 * constructeurs séparés l'ont laissé diverger une fois déjà (#22).
 */
function construireLeRendu(
  o: RenderOptions,
  canevas: { w: number; h: number } | null,
): string[] {
  // Valider les bornes **avant** de normaliser, et c'est l'ordre qui compte :
  // `normalizeSegments` garde un segment si `end > start`, comparaison qui est
  // fausse dès qu'une borne vaut `NaN` — le segment disparaît donc en silence,
  // et un clip de trois segments en rendrait deux sans un mot. Une borne
  // infinie, elle, traverse la normalisation et ressort en `-t Infinity`.
  o.segments.forEach((s, i) => {
    nombre(s.start, `segments[${i}].start`)
    nombre(s.end, `segments[${i}].end`)
  })

  // Normaliser ensuite : deux segments qui se touchent ne valent qu'un
  // décodeur, et un segment vide ou inversé en vaut zéro.
  const segments = normalizeSegments(o.segments)
  if (segments.length === 0) {
    throw new Error(
      "Aucun segment à rendre : un clip est une liste de segments, et une liste vide n'a pas de durée.",
    )
  }

  const logos = o.logos ?? []
  const multi = segments.length > 1

  // Les étapes qui suivent le découpage. Sur la variante, elles ne s'appliquent
  // qu'à l'avant-plan : le fond est tiré du même contenu **avant** elles.
  const étapes: Étape[] = []
  if (o.assPath !== undefined) {
    const options = [option('filename', o.assPath)]
    // `filename=` nommé et non positionnel : un chemin en position portant un
    // `:` serait lu comme le début de l'option suivante.
    if (o.fontsDir !== undefined) options.push(option('fontsdir', o.fontsDir))
    étapes.push((e, s) => `[${e}]ass=${options.join(':')}[${s}]`)
  }
  // Les logos passent **après** l'incrustation des sous-titres : une marque
  // posée dessous serait recouverte par le premier carton qui monte assez haut.
  logos.forEach((logo, i) => {
    const x = nombre(logo.x, `logos[${i}].x`)
    const y = nombre(logo.y, `logos[${i}].y`)
    étapes.push((e, s) => `[${e}][lg${i}]overlay=x=${x}:y=${y}[${s}]`)
  })
  // La mise à la largeur du canevas ferme la chaîne de l'avant-plan. Elle ne
  // change rien à un 1:1 ou à un 4:5, déjà larges de 1080, et ramène un 16:9 de
  // 1920 à 1080.
  if (canevas !== null) {
    étapes.push((e, s) => `[${e}]scale=${canevas.w}:-2[${s}]`)
  }

  // Où finit la chaîne : `[v]` pour le rendu natif, `[fg]` pour l'avant-plan de
  // la variante, que la superposition consomme ensuite.
  const terminal = canevas === null ? 'v' : 'fg'
  // Et où sort le découpage. Sur un rendu natif sans sous-titre ni marque, rien
  // ne suit : c'est le découpage lui-même qui écrit `[v]`.
  const contenu = étapes.length === 0 ? terminal : multi ? 'vc' : 'vd'

  const graphe: string[] = []
  const c = o.crop
  const filtreImage = [
    `crop=${nombre(c.w, 'crop.w')}:${nombre(c.h, 'crop.h')}` +
      `:${nombre(c.x, 'crop.x')}:${nombre(c.y, 'crop.y')}`,
    `scale=${nombre(o.out.w, 'out.w')}:${nombre(o.out.h, 'out.h')}:flags=lanczos`,
    'setsar=1',
  ].join(',')

  segments.forEach((_, i) => {
    graphe.push(`[${i}:v]${filtreImage}[${multi ? `v${i}` : contenu}]`)
  })

  // Pas de `?` sur les entrées audio, et c'est délibéré : une étiquette de
  // graphe ne s'annote pas, et `concat` avec `a=1` exige de toute façon une
  // piste son sur **chaque** entrée. Un replay muet est un replay raté ; mieux
  // vaut que le rendu échoue franchement que de livrer un clip silencieux.
  let audio: string
  if (multi) {
    const entrées = segments.map((_, i) => `[v${i}][${i}:a]`).join('')
    graphe.push(`${entrées}concat=n=${segments.length}:v=1:a=1[${contenu}][ac]`)
    audio = 'ac'
  } else {
    audio = '0:a'
  }
  // `aresample` derrière `loudnorm`, et ce n'est pas décoratif : en passe
  // unique, `loudnorm` travaille à 192 kHz pour mesurer les crêtes et sort à ce
  // taux. ffmpeg insère alors tout seul un rééchantillonnage vers le plus haut
  // taux que l'AAC accepte — mesuré, une source à 44,1 kHz ressortait en
  // **96 kHz**. Personne ne livre du 96 kHz.
  graphe.push(`[${audio}]${LOUDNORM},${RESAMPLE}[a]`)

  // Les logos sont des images fixes : on les met à l'échelle une fois, puis on
  // les superpose. La position donnée est le coin supérieur gauche.
  logos.forEach((logo, i) => {
    const w = nombre(logo.w, `logos[${i}].w`)
    const h = nombre(logo.h, `logos[${i}].h`)
    graphe.push(`[${segments.length + i}:v]scale=${w}:${h}[lg${i}]`)
  })

  if (canevas === null) {
    enchaîner(graphe, contenu, étapes, terminal)
  } else {
    // **Le fond sort du `split`, donc d'avant l'incrustation.** C'est toute la
    // correction de #22 : le fond ne peut pas porter de sous-titre puisqu'il
    // n'en a jamais vu passer. `force_original_aspect_ratio=increase` puis
    // `crop` couvrent le canevas sans déformer.
    graphe.push(`[${contenu}]split=2[bga][fga]`)
    graphe.push(
      `[bga]scale=${canevas.w}:${canevas.h}:force_original_aspect_ratio=increase,` +
        `crop=${canevas.w}:${canevas.h},gblur=sigma=${SIGMA_DU_FOND}[bg]`,
    )
    const avantPlan = enchaîner(graphe, 'fga', étapes, terminal)
    graphe.push(`[bg][${avantPlan}]overlay=x=0:y=(H-h)/2,setsar=1[v]`)
  }

  return [
    ...GLOBALES,
    // Un `-hwaccel` **par entrée**, et non un seul en tête : c'est une option
    // d'entrée, sa portée s'arrête au `-i` qui suit.
    ...segments.flatMap((s) => [
      ...accélération(o.encoder),
      '-ss', secondes(s.start),
      '-t', secondes(s.end - s.start),
      '-i', o.src,
    ]),
    // Les logos n'ont pas de `-hwaccel` : décoder un PNG sur le GPU ne rapporte
    // rien et le ferait remonter en mémoire vidéo pour redescendre aussitôt.
    ...logos.flatMap((logo) => ['-i', logo.path]),
    '-filter_complex', graphe.join(';'),
    '-map', '[v]',
    '-map', '[a]',
    ...videoEncodeArgs(o.encoder, 'quality'),
    '-c:a', 'aac', '-b:a', '192k',
    ...METADATA_SCRUB,
    '-movflags', '+faststart',
    ...destination(o.dst),
  ]
}
