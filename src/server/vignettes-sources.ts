import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { sourceThumbArgs } from '@/core/ffmpeg/args'
import { cheminTemporaire, runFfmpeg } from '@/server/ffmpeg'
import { probeDuration } from '@/server/ffprobe'
import { estUneAbsence } from '@/server/octets'
import { resolveSource, stageDir } from '@/server/paths'
import { statAvecDélai, DÉLAI_STAT_MS } from '@/server/steps/ingest'

/**
 * La vignette d'une **source** : une image tirée de l'original, gardée sur le
 * disque local (spec §12, issue #41).
 *
 * **`src/server/thumbs.ts` ne se réutilise pas**, et ce n'est pas une question
 * de goût : `vignette(clip)` lit `proxyPath(clip.projectId)`, alors qu'une
 * source n'a ni projet, ni proxy, ni dossier où poser quoi que ce soit. Son
 * en-tête dit même l'inverse de ce qu'il faut ici — « du proxy, jamais de
 * l'original ». Il a raison pour un candidat, il ne peut pas l'être pour une
 * source : au moment de choisir un replay, le proxy n'existe pas encore.
 *
 * Quatre choses portent ce fichier, et chacune ferme un mode d'échec.
 *
 * 1. **Le cache vit dans `STAGE_DIR`.** Une vignette de source n'appartient à
 *    aucun projet, et rien ne s'écrit sur le Drive — il est lent, partagé, et
 *    `placeSidecar` documente déjà que l'écriture y échoue parfois. `STAGE_DIR`
 *    est le seul emplacement du dépôt dont la doctrine dise exactement ce
 *    qu'est ce cache : « la copie de travail locale, transitoire : elle peut
 *    être effacée à tout moment » (`paths.ts`). L'effacer ne coûte que de le
 *    recalculer.
 * 2. **La clé porte le nom, la taille et la date de modification** — jamais
 *    l'empreinte de source du graphe (§5), qui ajoute la durée ffprobe et
 *    imposerait un aller distant avant même de savoir s'il y a quelque chose à
 *    calculer. Un fichier remplacé change de taille ou de date, donc invalide
 *    sa vignette tout seul.
 * 3. **Un accès au 9p à la fois, tout le serveur confondu.** C'est la règle que
 *    `sources.ts` énonce en tête et qui a coûté quelque chose : renoncer n'est
 *    pas annuler, un `lstat` abandonné garde son fil du vivier de libuv, et le
 *    vivier en compte quatre. Six vignettes demandées de front sur un montage
 *    mort — la limite de connexions d'un navigateur — figeraient tout ce qui
 *    touche au disque dans le serveur, analyse en cours comprise. Sérialisées,
 *    elles coûtent **un** fil, une fois.
 * 4. **Écriture sous nom temporaire, renommée une fois seulement**, comme
 *    partout ailleurs : un ffmpeg interrompu laisserait sinon un JPEG tronqué
 *    que la visite suivante servirait sans le refaire.
 */

/** `stage/vignettes-sources/` — voir le point 1 en tête de fichier. */
export function dossierVignettesSources(): string {
  return path.join(stageDir(), 'vignettes-sources')
}

/**
 * Un nom de source sert à nommer un fichier de cache, et **il arrive du
 * réseau** : `GET /api/sources/thumb?file=…` est écrit par l'appelant.
 *
 * Le contrôle est celui de `vérifierIdClip`, pour la même raison : les replays
 * portent accents et espaces — `2026-01-11-méchante.mp4` —, qu'on ne peut pas
 * refuser sans vider la bibliothèque. Ce qui est refusé est ce qui permet de
 * sortir du dossier, pas ce qui est exotique.
 *
 * **Et il ne double pas `resolveSource`, il ferme ce qu'elle laisse passer.**
 * `resolveSource('a/../b.mp4')` réussit — le chemin résolu tombe bien dans
 * `REPLAY_DIR` — et c'est correct pour désigner un fichier. Mais la chaîne
 * d'origine, recopiée telle quelle dans un nom de cache, en sortirait. Les deux
 * contrôles regardent donc deux choses différentes : l'un le fichier lu, l'autre
 * le fichier écrit.
 */
export function vérifierNomDeSource(nom: string): string {
  const refusé =
    nom === '' ||
    nom === '.' ||
    nom === '..' ||
    nom.includes('/') ||
    nom.includes('\\') ||
    nom.includes('\0')
  if (refusé) throw new Error(`Nom de source invalide : ${JSON.stringify(nom)}`)
  return nom
}

/**
 * Le chemin du cache pour **cette version** de ce fichier.
 *
 * La date est tronquée à la milliseconde entière : `mtimeMs` est un flottant, et
 * deux relevés du même fichier peuvent en rendre deux écritures décimales
 * différentes — la clé changerait sans que le fichier ait bougé, et chaque
 * visite recalculerait la vignette.
 */
export function vignetteSourcePath(nom: string, sizeBytes: number, mtimeMs: number): string {
  const clé = `${sizeBytes}-${Math.trunc(mtimeMs)}`
  return path.join(dossierVignettesSources(), `${vérifierNomDeSource(nom)}.${clé}.jpg`)
}

/**
 * L'URL que la carte de la bibliothèque met dans son `<img>`.
 *
 * Le nom est encodé : les replays portent accents et espaces, et l'un d'eux
 * porte un `&` un jour ou l'autre.
 */
export function urlVignetteSource(nom: string): string {
  return `/api/sources/thumb?file=${encodeURIComponent(nom)}`
}

/**
 * L'instant où prendre l'image, **jamais zéro**.
 *
 * Les lives ouvrent tous sur le même carton « ON ARRIVE VITE » avec compte à
 * rebours — présent sur les trois émissions mesurées (spec §12) —, et les
 * replays de cette émission commencent tous sur le même plateau. Une image
 * précoce donnerait vingt et une vignettes identiques, c'est-à-dire vingt et une
 * vignettes inutiles là où le nom du fichier porte déjà la date.
 *
 * Un tiers de la durée : bien après le carton d'ouverture, et loin du salut
 * final, qui se ressemble d'une émission à l'autre autant que l'ouverture.
 *
 * **Le repli n'est pas zéro non plus.** Sans durée — ffprobe muet, en-tête
 * illisible — on prend cinq minutes, qui tombent à l'intérieur de n'importe
 * quel replay : ils durent d'une heure et demie à trois heures. Un fichier trop
 * court pour cinq minutes n'est pas un replay, et son extraction échouera, ce
 * qui est la bonne réponse.
 */
export const REPLI_INSTANT_S = 300

export function instantVignetteSource(durationSec: number | null): number {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return REPLI_INSTANT_S
  }
  return durationSec / 3
}

export type OptionsVignetteSource = {
  /** Le délai de garde de chaque accès au montage. */
  timeoutMs?: number
  /** La durée de la source. Injectée par les tests, qui n'ont pas de ffprobe. */
  sonder?: (fichier: string, timeoutMs: number) => Promise<number | null>
  /** L'extraction elle-même. Injectée par les tests, qui n'ont pas de ffmpeg. */
  extraire?: (o: { src: string; dst: string; at: number }, timeoutMs: number) => Promise<void>
}

/**
 * La file d'attente des accès au Drive : **une à la fois**.
 *
 * Voir le point 3 en tête de fichier. Elle est volontairement globale au module
 * plutôt que par fichier : ce qu'on protège n'est pas la cohérence d'une
 * vignette, c'est le vivier de fils de libuv, qui est global au processus.
 *
 * Le `then` à deux branches est ce qui empêche un échec de bloquer la file : la
 * suivante part que la précédente ait abouti ou non.
 */
let file: Promise<unknown> = Promise.resolve()

function enFile<T>(travail: () => Promise<T>): Promise<T> {
  const résultat = file.then(travail, travail)
  file = résultat.then(
    () => {},
    () => {},
  )
  return résultat
}

/**
 * Produit la vignette d'une source si elle manque, et rend son chemin.
 *
 * **`null` veut dire « il n'y a pas d'image à en tirer », jamais « ça a
 * échoué ».** Trois cas y tombent, et l'appelant en fait un 404 : le fichier a
 * disparu entre la liste et le clic, ce n'est pas un fichier ordinaire — un lien
 * symbolique désignerait quelque chose qui n'est pas un replay, et l'ingestion
 * le refuse déjà pour cette raison —, ou il pèse zéro octet, ce qui est l'état
 * d'un enregistrement qui vient de commencer.
 *
 * Tout le reste lève : un nom qui sort du dossier, un montage qui ne répond pas,
 * un ffmpeg en échec. La route les rend épurés de leurs chemins.
 */
export async function vignetteSource(
  nom: string,
  options: OptionsVignetteSource = {},
): Promise<string | null> {
  // Avant la file d'attente : refuser un nom ne coûte rien et n'attend personne.
  const source = resolveSource(vérifierNomDeSource(nom))
  const timeoutMs = options.timeoutMs ?? DÉLAI_STAT_MS

  return enFile(async () => {
    const info = await relever(source, timeoutMs)
    if (info === null || !info.isFile() || info.size === 0) return null

    // Pas de table des extractions en vol, contrairement à la sonde de
    // `sources.ts` : la file d'attente en tient déjà lieu. Deux onglets qui
    // demandent la même vignette passent l'un après l'autre, et le second
    // trouve le fichier écrit par le premier.
    return produire(source, vignetteSourcePath(nom, info.size, info.mtimeMs), timeoutMs, options)
  })
}

/**
 * `lstat` sous délai de garde, ou `null` si le fichier n'est pas là.
 *
 * `lstat` et non `stat`, comme `statAvecDélai` le fait déjà pour l'ingestion :
 * un lien de `REPLAY_DIR` pointant sur `/etc/shadow` passerait le contrôle de
 * dossier parent de `resolveSource`, que `path.resolve` fait sans suivre les
 * liens. `stat` le déclarerait fichier et ffmpeg irait le lire.
 */
async function relever(source: string, timeoutMs: number): Promise<fs.Stats | null> {
  try {
    return await statAvecDélai(source, timeoutMs)
  } catch (cause) {
    if (estUneAbsence(cause)) return null
    throw cause
  }
}

/** Sonde la durée, extrait l'image, et ne publie que ce qui est complet. */
async function produire(
  source: string,
  destination: string,
  timeoutMs: number,
  options: OptionsVignetteSource,
): Promise<string> {
  if (fs.existsSync(destination)) return destination

  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const temporaire = cheminTemporaire(destination)
  const sonder = options.sonder ?? probeDuration
  const extraire = options.extraire ?? extraireAvecFfmpeg
  const at = instantVignetteSource(await sonder(source, timeoutMs))

  try {
    await extraire({ src: source, dst: temporaire, at }, timeoutMs)
    // **Un code de sortie nul ne prouve pas qu'un fichier est sorti.** Un `-ss`
    // au-delà de la fin du conteneur fait sortir ffmpeg proprement sans avoir
    // rien écrit ; le `rename` échouerait alors sur un `ENOENT` venu de nulle
    // part, et le journal accuserait le renommage. Un fichier vide vient du même
    // endroit et se sert encore plus mal : le navigateur affiche une image
    // cassée, et le cache la garde.
    const écrit = await fsp.stat(temporaire).catch(() => null)
    if (écrit === null || écrit.size === 0) {
      throw new Error(
        `ffmpeg n'a écrit aucune image pour ${JSON.stringify(path.basename(source))} ` +
          `(demandée à ${at.toFixed(1)} s).`,
      )
    }
    await fsp.rename(temporaire, destination)
  } catch (cause) {
    await fsp.rm(temporaire, { force: true }).catch(() => {})
    throw cause
  }
  return destination
}

function extraireAvecFfmpeg(
  o: { src: string; dst: string; at: number },
  timeoutMs: number,
): Promise<void> {
  return runFfmpeg(sourceThumbArgs(o), {
    quoi: `vignette de source ${path.basename(o.src)}`,
    // **Le délai est le mode d'échec qu'on ferme ici.** `statAvecDélai` a prouvé
    // juste avant que le montage répondait, mais il peut mourir entre les deux —
    // et un ffmpeg qui pend sur un 9p mort ne rend jamais la main. Le facteur
    // trois sur le délai de garde des `stat` laisse la place à une extraction
    // lente sans laisser la place à une extraction qui n'aboutira jamais :
    // médiane ~2,7 s, pire cas mesuré 6,6 s.
    timeoutMs: timeoutMs * 3,
  })
}
