import { audioArgs } from '@/core/ffmpeg/args'
import { produceArtifact, type Artifact, type Progress } from '@/server/ffmpeg'
import { audioPath } from '@/server/paths'

/**
 * Le WAV que WhisperX attend : **16 kHz, mono, PCM 16 bits**.
 *
 * C'est le format d'entrée du modèle. Lui donner autre chose marche — il
 * rééchantillonne tout seul — mais il le fait alors à chaque exécution, sur
 * deux heures cinquante d'audio, pendant que le GPU attend.
 *
 * Aucun encodeur ici : `audioArgs` pose `-vn`, il n'y a pas une image à décoder,
 * donc rien à accélérer. C'est aussi pourquoi cette étape ne dépend pas du
 * proxy — et pourquoi `graph.ts` fait dépendre le transcript de l'audio et non
 * de la vidéo : viser le transcript ne doit pas déclencher douze minutes de
 * proxy pour rien.
 */
export type OptionsAudio = {
  projectId: string
  /** La copie de travail dans `stage/`. */
  input: string
  force?: boolean
  durationSec?: number | null
  onProgress?: (progress: Progress) => void
  /** L'arrêt demandé. Voir `OptionsFfmpeg.signal`. */
  signal?: AbortSignal
}

export function extractAudio(o: OptionsAudio): Promise<Artifact> {
  return produceArtifact({
    dst: audioPath(o.projectId),
    force: o.force,
    durationSec: o.durationSec,
    onProgress: o.onProgress,
    signal: o.signal,
    what: `audio de ${o.projectId}`,
    args: (destination) => audioArgs({ src: o.input, dst: destination }),
  })
}
