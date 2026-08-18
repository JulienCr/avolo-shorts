import { execFile } from 'node:child_process'
import { ffprobeBin } from '@/server/ffmpeg'

/**
 * Ce que ffprobe sait dire d'un fichier, et rien de plus.
 *
 * La durée est la seule valeur dont l'itération 0 ne peut pas se passer :
 * `buildWindows` en a besoin pour découper le transcript, l'empreinte de source
 * la porte (spec §5), et la barre de progression de ffmpeg s'en sert pour rendre
 * une fraction. Les dimensions et la cadence servent à vérifier un proxy.
 */

/** Le relevé, `null` partout où ffprobe n'a rien su dire. */
export type Sondage = {
  durationSec: number | null
  width: number | null
  height: number | null
  /** Images par seconde, `r_frame_rate` réduit : `30/1` donne 30. */
  fps: number | null
}

const VIDE: Sondage = { durationSec: null, width: null, height: null, fps: null }

/**
 * La forme du JSON de ffprobe, telle qu'on la lit — pas telle qu'elle est.
 *
 * Tout est optionnel et rien n'est de confiance : un MKV sans en-tête de durée
 * rend `"N/A"`, une pochette d'album rend un flux vidéo sans cadence, et un
 * fichier corrompu rend un objet vide. Chaque champ est donc validé plutôt que
 * casté.
 */
type SortieFfprobe = {
  format?: { duration?: unknown }
  streams?: { width?: unknown; height?: unknown; r_frame_rate?: unknown }[]
}

/** Un nombre fini, ou `null`. `"N/A"`, `""` et `undefined` tombent ici. */
function nombreOuNull(brut: unknown): number | null {
  if (typeof brut === 'number') return Number.isFinite(brut) ? brut : null
  if (typeof brut !== 'string' || brut.trim() === '') return null
  const n = Number(brut)
  return Number.isFinite(n) ? n : null
}

/**
 * `r_frame_rate` est une **fraction**, jamais un décimal : `30/1` pour du 30 fps,
 * `60000/1001` pour du 59,94. Un dénominateur nul (`0/0`) signale une cadence
 * inconnue, ce que ffprobe rend sur certaines pochettes.
 */
function cadence(brut: unknown): number | null {
  if (typeof brut !== 'string') return null
  const m = /^(\d+)\/(\d+)$/.exec(brut.trim())
  if (m === null) return nombreOuNull(brut)
  const dénominateur = Number(m[2])
  return dénominateur === 0 ? null : Number(m[1]) / dénominateur
}

/**
 * Le JSON de ffprobe, réduit à ce qui nous intéresse.
 *
 * Pure, et c'est tout l'intérêt : la fragilité d'un sondage tient dans la
 * lecture de sa sortie, pas dans l'appel. Un JSON illisible rend un sondage vide
 * plutôt qu'une exception — un fichier qu'on n'arrive pas à sonder reste un
 * fichier qu'on peut copier et transcrire, et la durée n'est qu'une commodité.
 */
export function analyserSondage(json: string): Sondage {
  let brut: SortieFfprobe
  try {
    brut = JSON.parse(json) as SortieFfprobe
  } catch {
    return { ...VIDE }
  }
  if (brut === null || typeof brut !== 'object') return { ...VIDE }

  const flux = Array.isArray(brut.streams) ? brut.streams[0] : undefined
  return {
    durationSec: nombreOuNull(brut.format?.duration),
    width: nombreOuNull(flux?.width),
    height: nombreOuNull(flux?.height),
    fps: cadence(flux?.r_frame_rate),
  }
}

/**
 * Sonde un fichier. `-select_streams v:0` : le premier flux vidéo, et lui seul —
 * une source peut porter une pochette, que ffprobe expose comme un second flux
 * vidéo aux dimensions d'une vignette.
 *
 * `--` ferme les options : un chemin commençant par `-` serait lu comme une
 * option, exactement comme la sortie de ffmpeg (voir `core/ffmpeg/args.ts`).
 * Vérifié sur le binaire, ffprobe l'accepte.
 *
 * L'échec du binaire n'est pas une erreur pour l'appelant : un fichier que
 * ffprobe refuse rend un sondage vide. C'est `runFfmpeg` qui échoue bruyamment,
 * parce que lui produit un artefact ; ici on ne fait que renseigner.
 */
export function probe(file: string, timeoutMs = 120_000): Promise<Sondage> {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=width,height,r_frame_rate',
    '-of', 'json',
    '--', file,
  ]
  return new Promise<Sondage>((resolve) => {
    execFile(
      ffprobeBin(),
      args,
      // `REPLAY_DIR` est monté en 9p et décroche : sans délai de garde, un
      // sondage sur un montage mort suspend l'ingestion pour toujours.
      { timeout: timeoutMs, maxBuffer: 1 << 20, encoding: 'utf8' },
      (erreur, stdout) => {
        resolve(erreur !== null ? { ...VIDE } : analyserSondage(stdout))
      },
    )
  })
}

/** La durée seule, le seul champ dont le pipeline ne peut pas se passer. */
export async function probeDuration(file: string, timeoutMs?: number): Promise<number | null> {
  return (await probe(file, timeoutMs)).durationSec
}
