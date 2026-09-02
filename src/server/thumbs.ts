import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { Clip } from '@/core/edl'
import { filmstripArgs, posterArgs, thumbArgs } from '@/core/ffmpeg/args'
import { clipBounds } from '@/lib/editing'
import { FILMSTRIP_COUNT_DEFAULT, FILMSTRIP_COUNT_MAX, FILMSTRIP_COUNT_MIN } from '@/lib/filmstrip'
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

/**
 * `projects/<projet>/thumbs/<clip>.strip.<count>.jpg`. Le compte fait partie
 * du nom : chaque largeur de bande demande un tuilage différent, et deux
 * comptes ne peuvent pas partager un fichier sans que l'un écrase l'autre.
 */
export function filmstripPath(projectId: string, clipId: string, count: number): string {
  return path.join(projectDir(projectId), 'thumbs', `${verifyIdClip(clipId)}.strip.${count}.jpg`)
}

/** `projects/<projet>/thumbs/<clip>.strip.jpg` — le nom d'avant #292, sans
 * compte, laissé orphelin sur tout clip ouvert avant ce déploiement (#295). */
export function filmstripLegacyPath(projectId: string, clipId: string): string {
  return path.join(projectDir(projectId), 'thumbs', `${verifyIdClip(clipId)}.strip.jpg`)
}

/** Tous les comptes qu'une planche a pu prendre — pour l'effacer au complet
 * quand les bornes bougent, sans lister le dossier. */
export function filmstripCounts(): number[] {
  const counts: number[] = []
  for (let count = FILMSTRIP_COUNT_MIN; count <= FILMSTRIP_COUNT_MAX; count++) counts.push(count)
  return counts
}

/**
 * L'instant où prendre l'image : le début du premier segment.
 *
 * Un clip vidé de ses segments n'en a pas ; on prend alors la première image
 * plutôt que rien, parce qu'une carte sans vignette dans une grille de vingt-cinq
 * se lit comme un chargement en cours.
 */
export function momentVignette(clip: Clip): number {
  return clipBounds(clip.segments)?.start ?? 0
}

/**
 * Produit la vignette si elle manque, et rend son chemin. `null` sans proxy :
 * l'encodage n'a pas fini, pas une erreur.
 *
 * Écriture par temporaire renommé une fois (pas de JPEG tronqué). Renommage
 * **synchrone** (#274) : `fsp.rename` cédait la main au threadpool libuv
 * entre la garde et la publication, un `PATCH` concurrent pouvait évincer
 * dans le vide puis voir publier une image périmée. Un clip disparu
 * entre-temps ne publie rien, comme `filmstrip`.
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
    if (toDay === undefined || momentVignette(toDay) !== moment) {
      await fsp.rm(temporary, { force: true }).catch(() => {})
      return null
    }
    fs.renameSync(temporary, destination)
  } catch (cause) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw cause
  }
  return destination
}

/**
 * La planche d'un clip : `count` vues tuilées sur toute sa durée, gardée sur
 * disque comme `vignette` — même garde, même renommage synchrone (#274).
 *
 * `null` sans proxy, ou quand `clipBounds` n'a rien à couvrir : un clip vidé
 * de ses segments n'a pas de durée à tuiler. `count` vient du client
 * (largeur de bande) et doit déjà être validé : voir `parseFilmstripCount`.
 */
/**
 * Efface l'héritage d'avant #292 (`<clip>.strip.jpg`, sans compte) s'il
 * traîne encore. Appelé sur les deux chemins de `filmstrip` : un clip qui
 * n'est plus jamais `PATCH`é et dont la planche du jour est déjà en cache
 * ne passerait sinon plus jamais par un nettoyage (#295 corrigé une
 * première fois trop tôt : seul le chemin froid était couvert).
 *
 * `existsSync` d'abord : sur le chemin chaud (`GET` en boucle), ça évite un
 * `unlink` — donc un syscall d'écriture — à chaque appel une fois l'héritage
 * déjà effacé.
 */
function purgeFilmstripLegacy(projectId: string, clipId: string): void {
  const legacy = filmstripLegacyPath(projectId, clipId)
  if (!fs.existsSync(legacy)) return
  try {
    fs.rmSync(legacy, { force: true })
  } catch (cause) {
    console.warn(`Planche héritée non effacée pour ${clipId} :`, cause)
  }
}

export async function filmstrip(clip: Clip, count: number = FILMSTRIP_COUNT_DEFAULT): Promise<string | null> {
  const proxy = proxyPath(clip.projectId)
  if (!fs.existsSync(proxy)) return null

  const bounds = clipBounds(clip.segments)
  if (bounds === null) return null

  const destination = filmstripPath(clip.projectId, clip.id, count)
  if (fs.existsSync(destination)) {
    purgeFilmstripLegacy(clip.projectId, clip.id)
    return destination
  }

  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const temporary = pathTemporary(destination)
  try {
    await runFfmpeg(
      filmstripArgs({
        src: proxy,
        dst: temporary,
        at: bounds.start,
        duration: bounds.end - bounds.start,
        count,
      }),
      { what: `planche de ${clip.id}` },
    )
    const toDay = getClip(getDb(), clip.id)
    const boundsToDay = toDay === undefined ? null : clipBounds(toDay.segments)
    if (boundsToDay === null || boundsToDay.start !== bounds.start || boundsToDay.end !== bounds.end) {
      await fsp.rm(temporary, { force: true }).catch(() => {})
      return null
    }
    fs.renameSync(temporary, destination)
    purgeFilmstripLegacy(clip.projectId, clip.id)
  } catch (cause) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw cause
  }
  return destination
}

/**
 * L'affiche d'un clip du vivier : le premier repère du **rendu livré**,
 * jamais du proxy. `null` sans livraison à jour ou sans fichier vidéo.
 *
 * **Fraîcheur sans point d'éviction** : refaite si elle manque ou si le rendu
 * est plus récent, rien d'autre n'a besoin de l'invalider.
 *
 * Livraison relue après ffmpeg, avant le renommage synchrone (#274) : un
 * réexport pendant l'extraction ne doit pas publier une affiche périmée.
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
  // Tolérance d'1 ms : `Math.floor` plus bas ne met jamais l'estampille dans
  // le futur, mais peut la faire retomber tout juste sous `videoMtime`
  // (mesuré : jusqu'à ~0,99 ms). Sans cette marge, l'affiche qu'on vient de
  // produire se dirait déjà périmée et se régénérerait à chaque appel.
  if (posterMtime !== null && posterMtime + 1 >= videoMtime) return destination

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
    // Course #288 : le temporaire porte la mtime de la vidéo validée, pas
    // l'instant du renommage. `utimesSync`, jamais `fsp.utimes` (#274).
    // `Math.floor`, jamais `ceil` : une estampille dans le futur romprait la
    // règle du dépôt sur les seuils inclusifs. La perte sous-milliseconde
    // que ça laisse est absorbée par la tolérance de la garde ci-dessus.
    const secondsVideo = Math.floor(videoMtime) / 1000
    fs.utimesSync(temporary, secondsVideo, secondsVideo)
    fs.renameSync(temporary, destination)
  } catch (cause) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw cause
  }
  return destination
}
