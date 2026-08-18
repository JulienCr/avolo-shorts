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
 * Échappe une valeur destinée à une option de filtre ffmpeg, qu'on écrit
 * toujours entre apostrophes.
 *
 * `\` d'abord — sinon on échapperait les échappements qu'on vient d'écrire.
 * Puis `'`, qui refermerait la chaîne, et `:`, qui sépare les options d'un
 * filtre au niveau au-dessus.
 */
function échapper(valeur: string): string {
  return valeur.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')
}

/** Une option de filtre, valeur entre apostrophes : `filename='/c.ass'`. */
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
    '-vf', 'fps=30,scale=960:540',
    '-g', '30',
    ...videoEncodeArgs(o.encoder, 'fast'),
    // Le son sert au montage : le repérage des coupes se fait à l'oreille.
    '-c:a', 'aac', '-b:a', '128k',
    ...METADATA_SCRUB,
    '-movflags', '+faststart',
    o.dst,
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
    o.dst,
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
 *   [ac]loudnorm=…[a];
 *   [vc]ass=filename='…':fontsdir='…'[v]
 * -map [v] -map [a] <encodeur> -c:a aac -movflags +faststart dst
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
  // Normaliser d'abord : deux segments qui se touchent ne valent qu'un
  // décodeur, et un segment vide ou inversé en vaut zéro.
  const segments = normalizeSegments(o.segments)
  if (segments.length === 0) {
    throw new Error('renderArgs : aucun segment à rendre.')
  }

  const logos = o.logos ?? []
  const multi = segments.length > 1

  // Les étapes vidéo qui suivent le découpage. On les compte **avant** de les
  // écrire, parce que c'est la dernière — quelle qu'elle soit — qui sort en
  // `[v]` : sans cela il faudrait un filtre de rattrapage, ou un `-map` dont le
  // nom change avec les options.
  const suite: ((entrée: string, sortie: string) => string)[] = []
  if (o.assPath !== undefined) {
    const options = [option('filename', o.assPath)]
    // `filename=` nommé et non positionnel : un chemin en position portant un
    // `:` serait lu comme le début de l'option suivante.
    if (o.fontsDir !== undefined) options.push(option('fontsdir', o.fontsDir))
    suite.push((e, s) => `[${e}]ass=${options.join(':')}[${s}]`)
  }
  logos.forEach((logo, i) => {
    suite.push((e, s) => `[${e}][lg${i}]overlay=x=${logo.x}:y=${logo.y}[${s}]`)
  })

  const sortieDécoupage = suite.length === 0 ? 'v' : multi ? 'vc' : 'vd'

  const graphe: string[] = []
  const filtreImage = [
    `crop=${o.crop.w}:${o.crop.h}:${o.crop.x}:${o.crop.y}`,
    `scale=${o.out.w}:${o.out.h}:flags=lanczos`,
    'setsar=1',
  ].join(',')

  segments.forEach((_, i) => {
    graphe.push(`[${i}:v]${filtreImage}[${multi ? `v${i}` : sortieDécoupage}]`)
  })

  let audio: string
  if (multi) {
    const entrées = segments.map((_, i) => `[v${i}][${i}:a]`).join('')
    graphe.push(`${entrées}concat=n=${segments.length}:v=1:a=1[${sortieDécoupage}][ac]`)
    audio = 'ac'
  } else {
    audio = '0:a'
  }
  graphe.push(`[${audio}]${LOUDNORM}[a]`)

  // Les logos sont des images fixes : on les met à l'échelle une fois, puis on
  // les superpose. La position donnée est le coin supérieur gauche.
  logos.forEach((logo, i) => {
    graphe.push(`[${segments.length + i}:v]scale=${logo.w}:${logo.h}[lg${i}]`)
  })

  let vidéo = sortieDécoupage
  suite.forEach((étape, i) => {
    const sortie = i === suite.length - 1 ? 'v' : `vf${i}`
    graphe.push(étape(vidéo, sortie))
    vidéo = sortie
  })

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
    o.dst,
  ]
}

/**
 * La variante 9:16 sur fond flouté, pour TikTok et Shorts, à partir du rendu
 * natif déjà produit.
 *
 * **Le contenu est déjà cropé**, donc il se pose **pleine largeur** et centré —
 * et non au ratio 0,42 d'OpenShorts, qui partait de 16:9 brut et rognait les
 * côtés pour gagner en présence. Un 1:1 occupe alors 56 % de la hauteur et un
 * 4:5 en occupe 70 %, contre 32 % pour un 16:9 en letterbox : c'est exactement
 * le bénéfice que la spec §2 reproche à OpenShorts de ne pas prendre.
 *
 * Le son est **recopié** : le rendu natif l'a déjà passé au `loudnorm`, et le
 * repasser le comprimerait deux fois.
 */
export function blurredVariantArgs(o: {
  src: string
  dst: string
  encoder: EncoderName
}): string[] {
  // La variante est toujours en 9:16 : c'est sa raison d'être.
  const { w, h } = outputSize('9:16')
  const graphe = [
    '[0:v]split=2[bga][fga]',
    `[bga]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=12[bg]`,
    `[fga]scale=${w}:-2[fg]`,
    '[bg][fg]overlay=x=0:y=(H-h)/2,setsar=1[v]',
  ].join(';')

  return [
    ...GLOBALES,
    ...accélération(o.encoder),
    '-i', o.src,
    '-filter_complex', graphe,
    '-map', '[v]',
    // Le `?` compte : une source muette doit quand même se rendre.
    '-map', '0:a:0?',
    '-c:a', 'copy',
    ...videoEncodeArgs(o.encoder, 'quality'),
    ...METADATA_SCRUB,
    '-movflags', '+faststart',
    o.dst,
  ]
}
