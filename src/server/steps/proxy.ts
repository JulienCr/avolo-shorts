import { proxyArgs } from '@/core/ffmpeg/args'
import type { EncoderName } from '@/core/ffmpeg/encoder'
import { encoderName, produireArtefact, type Artefact, type Avancement } from '@/server/ffmpeg'
import { proxyPath } from '@/server/paths'

/**
 * Le proxy 960x540 à 30 fps : ce sur quoi l'interface scrube, et ce sur quoi
 * l'itération 1 fera tourner la détection de corps.
 *
 * L'argv vient de `core/ffmpeg/args.ts`, où il est pur et testé. Ici on
 * n'ajoute qu'une chose : le choix de l'encodeur, qui dépend de la machine.
 *
 * **Sur cette machine, l'encodeur par défaut est le processeur, et c'est
 * mesuré** : 13,8x en x264 contre 12,8x en NVENC. Le travail est dominé par le
 * redimensionnement, qui reste sur le processeur dans les deux cas, et la
 * descente des images depuis la mémoire du GPU coûte plus qu'elle ne rapporte.
 * `encoderName()` rend malgré tout ce que `FFMPEG_ENCODER` demande : le proxy est
 * un cas particulier, pas une règle générale, et c'est l'export qui gagne le
 * facteur 2,3.
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
}

export function buildProxy(o: OptionsProxy): Promise<Artefact> {
  const dst = proxyPath(o.projectId)
  const encoder = o.encoder ?? encoderName()
  return produireArtefact({
    dst,
    force: o.force,
    durationSec: o.durationSec,
    onProgress: o.onProgress,
    quoi: `proxy de ${o.projectId}`,
    args: (destination) => proxyArgs({ src: o.input, dst: destination, encoder }),
  })
}
