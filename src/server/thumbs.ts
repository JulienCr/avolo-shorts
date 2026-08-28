import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { Clip } from '@/core/edl'
import { filmstripArgs, posterArgs, thumbArgs } from '@/core/ffmpeg/args'
import { clipBounds } from '@/lib/editing'
import type { PublishedFraming } from '@/lib/api'
import { isAAbsence } from '@/server/bytes'
import { getClip, getDb } from '@/server/db'
import { pathTemporary, runFfmpeg } from '@/server/ffmpeg'
import { projectDir, proxyPath } from '@/server/paths'
import { deliveredVideo } from '@/server/renders'

/**
 * La vignette d'un candidat : une image tirée du proxy, au premier segment du
 * clip, gardée sur disque.
 *
 * **Du proxy, jamais de l'original.** L'original vit sur un Google Drive monté
 * en 9p à 40 Mo/s et pèse jusqu'à 12,7 Go ; une grille de vingt-cinq cartes y
 * ferait vingt-cinq ouvertures distantes. Le proxy est local, fait 960x540, et
 * porte une image-clé par seconde.
 *
 * Le cache n'est pas une optimisation prématurée : l'écran de tri est le premier
 * écran du produit et se recharge à chaque aller-retour vers un clip. Sans lui,
 * chaque visite relancerait vingt-cinq ffmpeg.
 */

/**
 * Un identifiant de clip sert à nommer un fichier, et il arrive du réseau.
 *
 * Le contrôle est le même que celui des identifiants de projet, et pour la même
 * raison : les clips en héritent — `<projet>_<ms>-<ms>` — donc ils portent
 * accents et espaces, qu'on ne peut pas refuser sans casser la bibliothèque.
 * Ce qui est refusé est ce qui permet de sortir du dossier.
 */
function verifyIdClip(clipId: string): string {
  const rejected =
    clipId === '' ||
    clipId === '.' ||
    clipId === '..' ||
    clipId.includes('/') ||
    clipId.includes('\\') ||
    clipId.includes('\0')
  if (rejected) throw new Error(`Identifiant de clip invalide : ${JSON.stringify(clipId)}`)
  return clipId
}

/** `projects/<projet>/thumbs/<clip>.jpg`. */
export function vignettePath(projectId: string, clipId: string): string {
  return path.join(projectDir(projectId), 'thumbs', `${verifyIdClip(clipId)}.jpg`)
}

/** `projects/<projet>/thumbs/<clip>.render.jpg`. */
export function posterPath(projectId: string, clipId: string): string {
  return path.join(projectDir(projectId), 'thumbs', `${verifyIdClip(clipId)}.render.jpg`)
}

/** Le nombre de vues d'une planche. Douze : 43 Ko et 0,44 s, mesurés le 28 août 2026. */
export const FILMSTRIP_COUNT = 12

/** `projects/<projet>/thumbs/<clip>.strip.jpg`. */
export function filmstripPath(projectId: string, clipId: string): string {
  return path.join(projectDir(projectId), 'thumbs', `${verifyIdClip(clipId)}.strip.jpg`)
}

/**
 * L'instant où prendre l'image : le début du premier segment.
 *
 * Un clip vidé de ses segments n'en a pas ; on prend alors la première image
 * plutôt que rien, parce qu'une carte sans vignette dans une grille de vingt-cinq
 * se lit comme un chargement en cours.
 */
export function momentVignette(clip: Clip): number {
  return clip.segments[0]?.start ?? 0
}

/**
 * Produit la vignette si elle manque, et rend son chemin.
 *
 * `null` quand le proxy n'existe pas encore : il n'y a alors rien à extraire, et
 * ce n'est pas une erreur — c'est l'état d'un projet dont l'encodage n'a pas
 * fini.
 *
 * Comme partout ailleurs dans ce dépôt, l'écriture passe par un nom temporaire
 * renommé une fois seulement : un ffmpeg interrompu laisserait sinon un JPEG
 * tronqué que la visite suivante servirait sans le refaire.
 *
 * **Et le clip est relu juste avant le renommage.** L'extraction dure quelques
 * centaines de millisecondes, largement de quoi qu'un `PATCH` déplace la borne
 * de début entre-temps : son éviction ne trouvait alors rien à effacer, et
 * l'image d'avant prenait le nom définitif juste après — périmée pour de bon,
 * puisque plus rien ne viendrait l'invalider. On jette plutôt que de publier.
 * (relevé par Copilot)
 */
export async function vignette(clip: Clip): Promise<string | null> {
  const proxy = proxyPath(clip.projectId)
  if (!fs.existsSync(proxy)) return null

  const destination = vignettePath(clip.projectId, clip.id)
  if (fs.existsSync(destination)) return destination

  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const temporary = pathTemporary(destination)
  const moment = momentVignette(clip)
  try {
    await runFfmpeg(thumbArgs({ src: proxy, dst: temporary, at: moment }), {
      what: `vignette de ${clip.id}`,
    })
    const toDay = getClip(getDb(), clip.id)
    if (toDay !== undefined && momentVignette(toDay) !== moment) {
      await fsp.rm(temporary, { force: true }).catch(() => {})
      return null
    }
    await fsp.rename(temporary, destination)
  } catch (cause) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw cause
  }
  return destination
}

/**
 * La planche d'un clip : douze vues tuilées sur toute sa durée, gardée sur
 * disque comme `vignette` ci-dessus — même garde-fou, même relecture avant
 * renommage (relevé par Copilot).
 *
 * `null` sans proxy, ou quand `clipBounds` n'a rien à couvrir : un clip vidé de
 * ses segments n'a pas de durée à tuiler.
 */
export async function filmstrip(clip: Clip): Promise<string | null> {
  const proxy = proxyPath(clip.projectId)
  if (!fs.existsSync(proxy)) return null

  const bounds = clipBounds(clip.segments)
  if (bounds === null) return null

  const destination = filmstripPath(clip.projectId, clip.id)
  if (fs.existsSync(destination)) return destination

  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const temporary = pathTemporary(destination)
  try {
    await runFfmpeg(
      filmstripArgs({
        src: proxy,
        dst: temporary,
        at: bounds.start,
        duration: bounds.end - bounds.start,
        count: FILMSTRIP_COUNT,
      }),
      { what: `planche de ${clip.id}` },
    )
    const toDay = getClip(getDb(), clip.id)
    const boundsToDay = toDay === undefined ? null : clipBounds(toDay.segments)
    if (boundsToDay === null || boundsToDay.start !== bounds.start || boundsToDay.end !== bounds.end) {
      await fsp.rm(temporary, { force: true }).catch(() => {})
      return null
    }
    await fsp.rename(temporary, destination)
  } catch (cause) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw cause
  }
  return destination
}

/**
 * L'affiche d'un clip du vivier : le premier repère du **rendu livré**,
 * jamais du proxy — voir `posterArgs`. `null` sans livraison à jour ou sans
 * fichier vidéo sur le disque.
 *
 * **Fraîcheur sans point d'éviction.** Refaite quand elle manque, ou quand
 * elle est plus vieille que le rendu dont elle est extraite : `deliveredVideo`
 * n'a donc rien à savoir invalider ailleurs, ni `discardRenderStale`, ni le
 * `PATCH` d'édition.
 *
 * **La livraison est relue après ffmpeg, avant le renommage.** Un réexport
 * pendant l'extraction changerait `deliveredVideo` sans que rien ne le
 * signale : la mtime posée par le renommage suivrait alors le nouveau rendu
 * dans le temps, sans en porter le contenu — fraîche pour de bon, comme
 * `vignette` ci-dessus (relevé par Copilot).
 */
/**
 * La mtime d'un fichier, ou `null` s'il n'est pas là.
 *
 * **Seule une absence vaut `null`** — un refus de droits ou un montage mort
 * traverse, comme dans `renders.ts` et `bytes.ts`. Elle remplace le couple
 * `existsSync` puis `statSync`, dont l'intervalle était lui-même une course.
 */
function mtimeOrNull(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs
  } catch (error) {
    if (isAAbsence(error)) return null
    throw error
  }
}

export async function renderPoster(clip: Clip, framing?: PublishedFraming): Promise<string | null> {
  const video = deliveredVideo(clip, framing)
  if (video === null) return null

  const destination = posterPath(clip.projectId, clip.id)
  const videoMtime = mtimeOrNull(video.path)
  // Le fichier a disparu entre `deliveredVideo` et ici. C'est une absence, donc
  // un `null` que la route rattrape sur le proxy — pas une panne à remonter.
  if (videoMtime === null) return null
  const posterMtime = mtimeOrNull(destination)
  if (posterMtime !== null && posterMtime >= videoMtime) return destination

  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const temporary = pathTemporary(destination)
  try {
    await runFfmpeg(posterArgs({ src: video.path, dst: temporary }), {
      what: `affiche de ${clip.id}`,
    })
    const toDay = getClip(getDb(), clip.id)
    const videoToDay = toDay === undefined ? null : deliveredVideo(toDay, framing)
    const changed =
      videoToDay === null ||
      videoToDay.path !== video.path ||
      mtimeOrNull(videoToDay.path) !== videoMtime
    if (changed) {
      await fsp.rm(temporary, { force: true }).catch(() => {})
      return null
    }
    await fsp.rename(temporary, destination)
  } catch (cause) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw cause
  }
  return destination
}
