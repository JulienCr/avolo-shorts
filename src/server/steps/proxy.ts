import { proxyArgs } from '@/core/ffmpeg/args'
import type { EncoderName } from '@/core/ffmpeg/encoder'
import { choisirEncodeur, produireArtefact, type Artefact, type Avancement } from '@/server/ffmpeg'
import { proxyPath } from '@/server/paths'

/**
 * Le proxy 960x540 à 30 fps : ce sur quoi l'interface scrube, et ce sur quoi
 * l'itération 1 fera tourner la détection de corps.
 *
 * L'argv vient de `core/ffmpeg/args.ts`, où il est pur et testé. Ici on
 * n'ajoute qu'une chose : le choix de l'encodeur, qui dépend de la machine.
 */
export type OptionsProxy = {
  projectId: string
  /** La copie de travail dans `stage/`, pas l'original sur le Drive. */
  input: string
  force?: boolean
  /** La durée de la source, pour rendre une fraction plutôt que des secondes. */
  durationSec?: number | null
  onProgress?: (avancement: Avancement) => void
  /** L'encodeur, si on ne veut pas celui que l'environnement désigne. */
  encoder?: EncoderName
  /** L'arrêt demandé. Voir `OptionsFfmpeg.signal`. */
  signal?: AbortSignal
}

/**
 * L'encodeur du proxy. **`auto` vaut x264, et la sonde NVENC n'est même pas
 * consultée.**
 *
 * Ce n'est pas une entorse à `FFMPEG_ENCODER=auto`, c'est ce que `auto` veut
 * dire ici : *le meilleur pour cette étape*. Or il est mesuré, et il surprend —
 * **NVENC est plus lent que le processeur sur le proxy**, 12,8x contre 13,8x. Le
 * travail y est dominé par le redimensionnement, qui se fait sur le processeur
 * dans les deux cas, et la descente des images depuis la mémoire du GPU coûte
 * plus qu'elle ne rapporte. Une mesure antérieure sur le fichier entier donnait
 * 14,2x contre 15,7x : même conclusion.
 *
 * La spec §6 porte donc `ffmpeg, CPU` pour cette étape. Une valeur explicite,
 * elle, est respectée : `FFMPEG_ENCODER=nvenc` reste un choix qu'on peut faire,
 * il coûte simplement une minute sur douze.
 *
 * L'export, lui, gagne un facteur 2,3 au GPU et passe par `encoderName()`.
 */
export function encodeurProxy(): EncoderName {
  return choisirEncodeur(process.env.FFMPEG_ENCODER, () => false)
}

export function buildProxy(o: OptionsProxy): Promise<Artefact> {
  return produireArtefact({
    dst: proxyPath(o.projectId),
    force: o.force,
    durationSec: o.durationSec,
    onProgress: o.onProgress,
    signal: o.signal,
    quoi: `proxy de ${o.projectId}`,
    // Le choix de l'encodeur est **dans** la fonction paresseuse, et pas
    // au-dessus : `encodeurProxy` lève sur un `FFMPEG_ENCODER` inconnu, et
    // au-dessus il levait donc même quand le proxy était déjà là. Un artefact
    // présent doit revenir tout de suite, quoi que porte l'environnement — la
    // valeur fautive éclate au premier encodage qui en a vraiment besoin.
    // (relevé par Copilot)
    args: (destination) =>
      proxyArgs({ src: o.input, dst: destination, encoder: o.encoder ?? encodeurProxy() }),
  })
}
