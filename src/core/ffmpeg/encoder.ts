/**
 * Les tables d'arguments d'encodage, et rien d'autre.
 *
 * Elles sont ici, dans `src/core/`, parce que ce sont des **données** : le
 * choix de l'encodeur se fait dans `src/server/` (sonde NVENC, variable
 * `FFMPEG_ENCODER`), mais ce qu'on écrit sur la ligne de commande une fois le
 * choix fait est une constante testable sans GPU.
 *
 * Les réglages sont portés d'OpenShorts (`ffmpeg_utils.py`), où ils ont servi
 * en production. Le `-cq 25` de NVENC n'est pas le `-crf 18` de x264 : mesuré
 * là-bas, `cq ≈ crf + 7` tombe dans le même ordre de taille de fichier.
 */

/** L'encodeur retenu. La résolution de `auto` appartient à `src/server/`. */
export type EncoderName = 'x264' | 'nvenc'

/**
 * Le palier de qualité.
 *
 * - `quality` : ce qu'on livre. Une fois par clip validé.
 * - `fast` : ce qu'on regarde. Le proxy, qui sert à scruber et sera jeté.
 */
export type QualityTier = 'quality' | 'fast'

// `-pix_fmt yuv420p` sur **les deux** encodeurs, pour deux raisons distinctes.
//
// Sur NVENC il est indispensable : sans lui, l'encodeur émet du H.264 en gbrp
// que la moitié des lecteurs refuse.
//
// Sur x264 il est défensif. libx264 conserve le format de la source, et les
// replays d'aujourd'hui sont tous en yuv420p — mais une source en 10 bits ou en
// 4:2:2 produirait un fichier que les plateformes rejettent, sans le moindre
// avertissement en chemin. Deux jetons ferment ce cas.
//
// Ni l'un ni l'autre ne va **jamais** avec `-hwaccel_output_format cuda` —
// voir `args.ts`.
const X264: Record<QualityTier, readonly string[]> = {
  quality: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'],
  fast: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'],
}

const NVENC: Record<QualityTier, readonly string[]> = {
  quality: [
    '-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr',
    '-cq', '25', '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1',
    '-pix_fmt', 'yuv420p',
  ],
  fast: [
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr',
    '-cq', '25', '-b:v', '0', '-spatial-aq', '1', '-pix_fmt', 'yuv420p',
  ],
}

/**
 * Les arguments d'encodage vidéo, en copie : la table est une constante du
 * module, et un appelant qui la modifierait la modifierait pour tous.
 */
export function videoEncodeArgs(encoder: EncoderName, quality: QualityTier): string[] {
  return [...(encoder === 'nvenc' ? NVENC : X264)[quality]]
}

/**
 * Effacer ce que la source traîne. Les replays portent le titre de l'émission,
 * la date d'enregistrement et le logiciel de capture ; rien de tout cela n'a de
 * raison de partir sur un réseau social.
 */
export const METADATA_SCRUB: readonly string[] = [
  '-map_metadata', '-1',
  '-map_chapters', '-1',
  '-map_metadata:s:v', '-1',
  '-map_metadata:s:a', '-1',
]

/**
 * La normalisation de sonie. `-14 LUFS` est la cible des plateformes ; en
 * dessous, le clip paraît timide à côté de celui d'à côté.
 *
 * Mesuré dans OpenShorts, à ne pas reprendre : ni `alimiter` après, ni
 * `loudnorm` en deux passes avec `linear=true` ne corrigent le léger
 * dépassement de crête. Ce réglage-là est celui qui tient.
 */
export const LOUDNORM = 'loudnorm=I=-14:TP=-2.0:LRA=11'

/**
 * Le taux d'échantillonnage de livraison, à poser **derrière `loudnorm`**.
 *
 * En passe unique, `loudnorm` travaille à 192 kHz pour mesurer les crêtes et
 * sort à ce taux. Sans consigne, ffmpeg redescend alors au plus haut taux que
 * l'encodeur accepte : mesuré, une source à 44,1 kHz ressortait en **96 kHz**.
 * C'est un fichier plus lourd, dans un format que personne ne livre, et la
 * variante floutée en héritait par `-c:a copy`.
 *
 * 48 kHz est le taux de la vidéo. On le pose, on ne le négocie pas.
 */
export const RESAMPLE = 'aresample=48000'
