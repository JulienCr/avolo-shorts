import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { sourceThumbArgs } from '@/core/ffmpeg/args'
import { cheminTemporaire, runFfmpeg } from '@/server/ffmpeg'
import { probeDuration } from '@/server/ffprobe'
import { estUneAbsence } from '@/server/octets'
import { resolveSource, stageDir } from '@/server/paths'
import { attendreOuRenoncer, DÉLAI_STAT_MS } from '@/server/steps/ingest'

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
 * 3. **Un accès au 9p à la fois pour les vignettes, et un disjoncteur
 *    derrière.** C'est la règle que `sources.ts` énonce en tête et qui a coûté
 *    quelque chose : renoncer
 *    n'est pas annuler, un `lstat` abandonné garde son fil du vivier de libuv,
 *    et le vivier en compte quatre. Six vignettes demandées de front sur un
 *    montage mort — la limite de connexions d'un navigateur — figeraient tout
 *    ce qui touche au disque dans le serveur, analyse en cours comprise.
 *
 *    **Mais sérialiser ne suffit pas**, et c'est le piège : la file borne les
 *    départs simultanés, pas l'accumulation. Le premier accès renonce au bout
 *    du délai, la file avance, le suivant part sur le même montage mort et se
 *    bloque à son tour — quatre requêtes suffisent, il leur faut seulement un
 *    peu plus de temps. D'où le disjoncteur, plus bas : le premier
 *    renoncement condamne les suivants sans qu'ils touchent au disque.
 *    (relevé par Codex)
 * 4. **Écriture sous nom temporaire, renommée une fois seulement**, comme
 *    partout ailleurs : un ffmpeg interrompu laisserait sinon un JPEG tronqué
 *    que la visite suivante servirait sans le refaire.
 */

/** `stage/vignettes-sources/` — voir le point 1 en tête de fichier. */
export function dossierVignettesSources(): string {
  return path.join(stageDir(), 'vignettes-sources')
}

/**
 * Un nom que l'appelant a mal formé — **400, jamais 500**.
 *
 * C'est la règle de `src/server/http.ts` : « la seule catégorie d'erreur dont
 * l'appelant est responsable, et lui répondre 500 lui ferait chercher la panne
 * en face ». Sans ce type, `?file=../../etc/passwd` était bel et bien refusé,
 * mais sous un code qui accuse le serveur — et qui inscrit une trace complète
 * au journal à chaque tentative.
 *
 * Le message est sûr à publier : `vérifierNomDeSource` cite le nom que
 * l'appelant a écrit, et `resolveSource` nomme la variable `REPLAY_DIR`, pas sa
 * valeur.
 */
export class SourceInvalideError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SourceInvalideError'
  }
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
  if (refusé) throw new SourceInvalideError(`Nom de source invalide : ${JSON.stringify(nom)}`)
  return nom
}

/**
 * Ce qu'on garde du nom dans le nom de cache : de quoi le reconnaître d'un
 * `ls`, pas de quoi dépasser `NAME_MAX`.
 *
 * **Un nom de source peut faire 255 octets** — c'est la limite d'un nom de
 * fichier sous Linux, et un replay qui l'atteint est parfaitement lisible. Le
 * recopier tel quel, puis y ajouter la taille, la date, l'extension et, le temps
 * de l'écriture, le suffixe de `cheminTemporaire`, dépassait la limite : la
 * vignette échouait en `ENAMETOOLONG` sur une source que rien n'empêchait de
 * lire. (relevé par Copilot)
 *
 * D'où le partage : un préfixe lisible **borné**, et une empreinte de longueur
 * fixe qui porte l'identité. Deux noms tronqués au même préfixe ne se
 * confondent pas — c'est l'empreinte qui les sépare, pas ce qu'on en montre.
 */
const NOM_LISIBLE_OCTETS = 96
const EMPREINTE_HEX = 12

function nomDeCache(nom: string, clé: string): string {
  // Coupé sur les octets, parce que c'est `NAME_MAX` qui les compte. La coupe
  // peut tomber au milieu d'un caractère accentué — les replays en portent — et
  // laisser un caractère de remplacement, qu'on retire : il ne sert à rien, et
  // l'empreinte porte déjà l'identité.
  const lisible = Buffer.from(nom, 'utf8')
    .subarray(0, NOM_LISIBLE_OCTETS)
    .toString('utf8')
    .replace(/\uFFFD+$/, '')
  const empreinte = createHash('sha256').update(nom, 'utf8').digest('hex').slice(0, EMPREINTE_HEX)
  return `${lisible}.${empreinte}.${clé}.jpg`
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
  vérifierNomDeSource(nom)
  return path.join(
    dossierVignettesSources(),
    nomDeCache(nom, `${sizeBytes}-${Math.trunc(mtimeMs)}`),
  )
}

/**
 * L'URL que la carte de la bibliothèque met dans son `<img>`.
 *
 * Le nom est encodé : les replays portent accents et espaces, et l'un d'eux
 * porte un `&` un jour ou l'autre.
 *
 * **`v` porte la version, et le serveur ne le lit pas.** La spec §12 décrit
 * `?file=<nom>` seul, et c'est bien `file` qui désigne le fichier ; `v` ne sert
 * qu'à faire **changer l'URL quand le fichier change**. Sans lui, l'URL d'une
 * source est éternelle : le navigateur garde son image, et surtout la carte,
 * qui retient l'URL dont l'image a échoué, ne redemanderait jamais celle d'un
 * replay réenregistré depuis. (relevé par Copilot)
 *
 * Le serveur reconstruit la clé de cache depuis son propre relevé, jamais depuis
 * ce paramètre : un `v` faux ou absent ne fait donc rien de plus que rendre
 * l'image d'aujourd'hui.
 */
export function urlVignetteSource(nom: string, sizeBytes: number, mtimeMs: number): string {
  const version = `${sizeBytes}-${Math.trunc(mtimeMs)}`
  return `/api/sources/thumb?file=${encodeURIComponent(nom)}&v=${version}`
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

/**
 * De combien la garde extérieure d'une sonde dépasse le délai de la sonde
 * elle-même. Voir le point d'appel, dans `produire`.
 */
const MARGE_FERMETURE = 2

export type OptionsVignetteSource = {
  /** Le délai de garde de chaque accès au montage. */
  timeoutMs?: number
  /** La durée de la source. Injectée par les tests, qui n'ont pas de ffprobe. */
  sonder?: (fichier: string, timeoutMs: number) => Promise<number | null>
  /** L'extraction elle-même. Injectée par les tests, qui n'ont pas de ffmpeg. */
  extraire?: (o: { src: string; dst: string; at: number }, timeoutMs: number) => Promise<void>
}

/**
 * Le message que le délai de garde donne à son rejet — même motif que dans
 * `sources.ts`, et pour la même raison : `attendreOuRenoncer` construit son
 * `Error` lui-même, et c'est la seule chose qui distingue « personne n'a
 * répondu » d'un code d'erreur du système de fichiers. Il ne s'affiche nulle
 * part.
 */
const RENONCEMENT = 'vignettes:délai-dépassé'

/** Ce que l'appelant voit quand le montage n'a pas répondu. */
export class MontageMuetError extends Error {
  constructor() {
    super(
      'Le dossier des replays ne répond pas. REPLAY_DIR est monté en 9p : il peut avoir perdu ' +
        "son transport sans que /proc/mounts le dise. Rouvrir l'explorateur Windows sur le " +
        'lecteur, ou remonter le partage.',
    )
    this.name = 'MontageMuetError'
  }
}

/**
 * L'accès qu'on a cessé d'attendre et qui n'est **toujours pas revenu**.
 *
 * C'est le disjoncteur, et sa condition n'est pas une durée. Une durée fixe ne
 * fait que retarder l'accumulation qu'elle prétend fermer : à chaque expiration,
 * la requête suivante repart sur le montage mort et y laisse un fil de plus,
 * si bien qu'au bout de quatre intervalles le vivier de libuv est épuisé comme
 * si le disjoncteur n'existait pas. C'était le défaut de la version d'avant, et
 * son commentaire l'assumait au lieu de le corriger. (relevé par Codex)
 *
 * La bonne condition est **l'appel lui-même** : tant qu'il n'a rien rendu, on
 * n'en lance pas un second. On ne peut pas l'annuler — c'est le prix d'un appel
 * système non interruptible —, mais on peut refuser de l'accompagner. Le coût
 * d'un montage mort est donc **un fil, une fois**, quel que soit le nombre de
 * requêtes et le temps que ça dure. C'est ce que l'en-tête de ce fichier promet
 * depuis le début.
 *
 * **La contrepartie, assumée** : sur un montage dont l'appel ne revient jamais,
 * les vignettes restent indisponibles jusqu'au redémarrage du serveur. C'est le
 * bon côté du choix — une case grise sur une carte, contre un serveur dont plus
 * rien ne touche au disque. `réarmerLeDisjoncteur` est la sortie explicite ; il
 * n'a pas d'appelant en production, et lui en donner un demanderait de savoir de
 * l'extérieur que le montage répond, ce qui est le régulateur partagé décrit
 * plus haut.
 */
let enSouffrance: Promise<unknown> | null = null

/** Retient l'accès abandonné jusqu'à ce qu'il se règle enfin. */
function retenir(brut: Promise<unknown>): void {
  enSouffrance = brut
  // **Le `catch` est sur la chaîne, pas à côté d'elle** — même piège que la
  // sonde de `sources.ts` : `finally` propage le rejet, et un `catch` posé en
  // parallèle laisserait la promesse dérivée sans gestionnaire.
  //
  // Le contrôle d'identité évite qu'un règlement tardif ne rouvre le passage
  // par-dessus un renoncement plus récent.
  void brut
    .finally(() => {
      if (enSouffrance === brut) enSouffrance = null
    })
    .catch(() => {})
}

/** Rouvre le passage. La sortie explicite, et ce dont les tests se servent. */
export function réarmerLeDisjoncteur(): void {
  enSouffrance = null
}

/**
 * Un accès au montage, sous délai de garde et derrière le disjoncteur.
 *
 * Les deux accès du parcours y passent — le `lstat` et la sonde de durée. Le
 * second n'est pas décoratif : `probe` s'appuie sur le `timeout` d'`execFile`,
 * qui envoie un signal puis **attend la sortie du processus** pour rendre la
 * main. Un ffprobe en sommeil non interruptible sur un 9p mort ne sort jamais,
 * donc ce délai-là ne se déclenche jamais non plus, et la file entière restait
 * bloquée pour de bon. (relevé par Codex)
 */
async function sousGarde<T>(travail: () => Promise<T>, timeoutMs: number): Promise<T> {
  // **Un thunk, pas une promesse.** Une promesse passée en argument est
  // construite au point d'appel, donc l'appel système part **avant** que le
  // disjoncteur ait pu dire non — et le disjoncteur ne protège plus rien. La
  // première version faisait exactement ça, et un test qui compte les départs
  // l'a montré : trois requêtes, trois `lstat` partis.
  if (enSouffrance !== null) throw new MontageMuetError()
  const brut = travail()
  try {
    return await attendreOuRenoncer(brut, timeoutMs, RENONCEMENT)
  } catch (cause) {
    if (cause instanceof Error && cause.message === RENONCEMENT) {
      retenir(brut)
      throw new MontageMuetError()
    }
    throw cause
  }
}

/**
 * La file d'attente des accès au Drive : **une à la fois**.
 *
 * Voir le point 3 en tête de fichier. Elle est globale au module plutôt que par
 * fichier : ce qu'on protège n'est pas la cohérence d'une vignette, c'est le
 * vivier de fils de libuv, qui est global au processus.
 *
 * **Elle n'est pas globale au serveur pour autant**, et il ne faut pas le lui
 * faire dire : `listerSources` a sa propre sonde, l'ingestion la sienne, et rien
 * ne les coordonne. Un montage mort peut donc encore coûter un fil à chacune —
 * trois au pire, sur les quatre du vivier. Les mettre sous une même autorité
 * demanderait un régulateur d'accès au montage partagé par les trois modules :
 * un autre dispositif, qui appartient à `sources.ts` autant qu'ici, et qui ne
 * tient pas dans une PR de vignettes. (relevé par Copilot)
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
  const source = résoudre(nom)
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
 * Le fichier désigné, ou un refus que la route rendra en 400.
 *
 * Les deux contrôles ne font pas le même travail — l'un décide du fichier qu'on
 * **lit**, l'autre du fichier qu'on **écrit** — mais ils se trompent de la même
 * façon, du fait de l'appelant. Ils sortent donc sous le même type.
 */
function résoudre(nom: string): string {
  try {
    return resolveSource(vérifierNomDeSource(nom))
  } catch (cause) {
    if (cause instanceof SourceInvalideError) throw cause
    // `resolveSource` ne lève que des `Error`, mais le lire depuis un `as`
    // rendrait `undefined` le jour où ce ne serait plus vrai — et un 400 au
    // message vide est un cul-de-sac.
    throw new SourceInvalideError(cause instanceof Error ? cause.message : String(cause), {
      cause,
    })
  }
}

/**
 * `lstat` sous garde, ou `null` si le fichier n'est pas là.
 *
 * `lstat` et non `stat`, comme `statAvecDélai` le fait pour l'ingestion : un
 * lien de `REPLAY_DIR` pointant sur `/etc/shadow` passerait le contrôle de
 * dossier parent de `resolveSource`, que `path.resolve` fait sans suivre les
 * liens. `stat` le déclarerait fichier et ffmpeg irait le lire.
 *
 * L'appel passe par `sousGarde` plutôt que par `statAvecDélai` pour une seule
 * raison : le disjoncteur a besoin de **reconnaître** le renoncement, et
 * `statAvecDélai` rend un `Error` que rien ne distingue d'une panne du système
 * de fichiers.
 */
async function relever(source: string, timeoutMs: number): Promise<fs.Stats | null> {
  try {
    return await sousGarde(() => fsp.lstat(source), timeoutMs)
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
  // **Le double, et c'est ce qui laisse ffprobe finir proprement.** `probe`
  // s'arrête sur son propre `timeout`, mais `execFile` envoie d'abord un signal
  // et ne rend la main qu'à la fermeture du processus : entre les deux il y a un
  // intervalle, court et parfaitement normal. Une garde extérieure calée sur la
  // même échéance le gagnait systématiquement — elle ouvrait le disjoncteur et
  // faisait tomber les vignettes voisines, là où la sonde allait rendre `null` et
  // laisser jouer l'instant de repli. Elle attend donc deux fois plus longtemps
  // que celle qu'elle surveille, et ne se déclenche que sur un ffprobe qui ne
  // ferme jamais. (relevé par Codex)
  const at = instantVignetteSource(
    await sousGarde(() => sonder(source, timeoutMs), timeoutMs * MARGE_FERMETURE),
  )

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
