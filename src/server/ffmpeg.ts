import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { EncoderName } from '@/core/ffmpeg/encoder'

/**
 * Exécuter ffmpeg, suivre son avancement, et **échouer bruyamment**.
 *
 * `src/core/ffmpeg/args.ts` construit les argv, purs et testés en CI. Ce
 * fichier-ci ne fait que les passer à `spawn` : c'est la seule chose qu'on ne
 * peut pas vérifier sans le binaire.
 *
 * Deux décisions portent tout le reste :
 *
 * 1. **Un code de sortie non nul rejette, avec la fin de stderr.** Un ffmpeg qui
 *    échoue en silence coûte une demi-journée : il laisse un fichier tronqué que
 *    l'étape suivante prend pour un artefact valide, et le graphe par présence
 *    (spec §4) ne fait alors plus que propager l'erreur.
 * 2. **La sonde NVENC tourne une fois par processus.** `FFMPEG_ENCODER=auto`
 *    encode 256x256 depuis `lavfi` : un encodeur peut être compilé dans le
 *    binaire et échouer au premier appel si le pilote ne suit pas — c'est
 *    exactement ce que `setup.sh` vérifie à l'installation, et ce que
 *    `ffmpeg_utils.nvenc_available()` faisait dans OpenShorts.
 */

/** Le binaire installé par `setup.sh`. `ffmpeg` nu en dernier recours. */
export function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || 'ffmpeg'
}

/** Idem pour `ffprobe`, que `src/server/ffprobe.ts` appelle. */
export function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || 'ffprobe'
}

/**
 * Une ligne de statistiques, celles que `-stats` réécrit sur place derrière un
 * `\r`. Le premier mot vaut `frame=` sur une sortie vidéo et `size=` sur une
 * sortie sans image.
 */
const LIGNE_STATS = /^(?:frame|size)=/

/**
 * Toutes les marques `time=` d'un morceau de stderr.
 *
 * ffmpeg réécrit sa ligne de statistiques derrière un `\r`, jamais un `\n` :
 * découper en lignes ne donnerait rien. On lit donc le texte brut et on garde
 * **la dernière** marque, la plus récente.
 *
 * Le nombre d'heures n'est pas borné à deux chiffres — un `-t` très long, ou une
 * source mal étiquetée, en produit davantage.
 */
const MARQUE_TEMPS = /time=\s*(-?)(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)/g

/**
 * La position courante de ffmpeg, en secondes, ou `null` s'il n'en annonce pas.
 *
 * **Une marque négative rend `null`, et ce n'est pas de la coquetterie.** Avant
 * d'avoir écrit sa première image, ffmpeg annonce `time=-577014:32:22.77` — la
 * valeur d'un `INT64_MIN` divisé par un million. Prise pour argent comptant,
 * elle donnerait une progression de -577 014 heures, soit une barre qui commence
 * à moins l'infini.
 *
 * `time=N/A` ne correspond à rien non plus, et tombe par le même chemin.
 */
export function analyserMarqueTemps(morceau: string): number | null {
  let secondes: number | null = null
  // `matchAll` plutôt que `exec` en boucle : la regex porte le drapeau `g`, donc
  // `lastIndex` est un état partagé entre appels — un `exec` sur une constante
  // de module reprendrait là où le morceau précédent s'est arrêté.
  for (const m of morceau.matchAll(MARQUE_TEMPS)) {
    if (m[1] === '-') {
      secondes = null
      continue
    }
    secondes = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
  }
  return secondes
}

/** Ce que `runFfmpeg` remonte à chaque marque de temps. */
export type Avancement = {
  /** La position dans la sortie, en secondes. */
  seconds: number
  /** La fraction faite, entre 0 et 1, ou `null` si la durée attendue est inconnue. */
  fraction: number | null
}

/** Le carnet des dernières lignes de stderr. */
export type Journal = {
  /**
   * Absorbe un morceau de flux, coupé n'importe où, et rend **les
   * enregistrements complets** qu'il vient d'en tirer.
   *
   * Ce retour n'est pas décoratif : `runFfmpeg` y lit la progression. Analyser
   * le morceau brut manquerait une marque `time=00:0` / `0:05.00` coupée en
   * deux par la frontière du morceau — le carnet, lui, reporte déjà la queue.
   * (relevé par Copilot)
   */
  ajouter(morceau: string): string[]
  /** Les lignes retenues, la plus ancienne d'abord. */
  lignes(): string[]
  /** Les mêmes, prêtes pour un message d'erreur. */
  texte(): string
}

/**
 * Garde les `max` dernières lignes de stderr sans conserver tout le flux.
 *
 * Deux difficultés, et la seconde est celle qui compte :
 *
 * - **les morceaux ne tombent pas sur les fins de ligne.** Un `\n` peut arriver
 *   au début du morceau suivant, donc la queue non terminée est reportée ;
 * - **les statistiques noieraient tout le reste.** Avec `-stats`, ffmpeg réécrit
 *   sa ligne de progression plusieurs fois par seconde derrière un `\r`. Un
 *   carnet naïf de vingt lignes ne contiendrait, après deux heures d'encodage,
 *   que vingt réécritures de la même ligne — et pas un mot des avertissements
 *   qui expliquent l'échec. Deux lignes de statistiques consécutives sont donc
 *   **repliées l'une sur l'autre**, exactement comme le fait un terminal devant
 *   un `\r`. On garde ainsi la dernière position atteinte *et* les
 *   avertissements qui l'entourent.
 */
export function créerJournal(max = 20): Journal {
  const gardées: string[] = []
  let reste = ''

  const pousser = (brute: string): void => {
    const ligne = brute.trimEnd()
    if (ligne === '') return
    const dernière = gardées[gardées.length - 1]
    if (LIGNE_STATS.test(ligne) && dernière !== undefined && LIGNE_STATS.test(dernière)) {
      gardées[gardées.length - 1] = ligne
      return
    }
    gardées.push(ligne)
    if (gardées.length > max) gardées.shift()
  }

  const lignes = (): string[] => {
    // La queue n'est pas terminée par un séparateur, et c'est justement le cas
    // qui compte : quand ffmpeg meurt sur un message, ce message est souvent la
    // dernière chose écrite, sans `\n` derrière.
    const queue = reste.trim()
    return queue === '' ? [...gardées] : [...gardées, queue]
  }

  return {
    ajouter(morceau: string): string[] {
      const texte = reste + morceau
      const parts = texte.split(/\r\n|[\r\n]/)
      reste = parts.pop() ?? ''
      // Une queue sans fin de ligne ne peut pas grandir indéfiniment : un
      // encodage dure des heures, et il suffirait d'un flux sans séparateur pour
      // que ce carnet — dont le but est justement de ne *pas* tout garder —
      // finisse par tout garder. C'est la fin qui intéresse, on coupe le début.
      if (reste.length > TAILLE_QUEUE_MAX) reste = reste.slice(-TAILLE_QUEUE_MAX)
      for (const p of parts) pousser(p)
      // Les enregistrements bruts, avant le filtrage de `pousser` : l'appelant
      // y cherche une marque de temps, pas une ligne à afficher.
      return parts
    },
    lignes,
    texte: () => lignes().join('\n'),
  }
}

/** De quoi tenir la plus longue ligne que ffmpeg écrive, et pas un flux entier. */
const TAILLE_QUEUE_MAX = 8_192

/**
 * L'encodeur demandé, une fois la sonde consultée si besoin.
 *
 * Pure : la sonde est passée en argument, donc la décision se teste sans GPU.
 *
 * **Une valeur inconnue est une erreur, pas un repli.** `FFMPEG_ENCODER=nvidia`
 * qui retomberait en douce sur x264 diviserait la vitesse d'export par 2,3
 * (4,58x contre 1,97x mesurés) sans que rien ne le signale — et personne ne
 * relit une variable d'environnement qui « marche ».
 */
export function choisirEncodeur(demandé: string | undefined, sonde: () => boolean): EncoderName {
  const valeur = (demandé ?? '').trim().toLowerCase()
  if (valeur === 'x264') return 'x264'
  if (valeur === 'nvenc') return 'nvenc'
  if (valeur === '' || valeur === 'auto') return sonde() ? 'nvenc' : 'x264'
  throw new Error(
    `FFMPEG_ENCODER inconnu : ${JSON.stringify(demandé)}. Attendu : auto, nvenc ou x264.`,
  )
}

/** `null` tant que la sonde n'a pas tourné. Un seul essai par processus. */
let sondeNvenc: boolean | null = null

/**
 * Encode 256x256 d'image de synthèse en `h264_nvenc`, vers nulle part.
 *
 * `spawnSync` et non `spawn` : la sonde doit rendre un booléen à un appelant
 * synchrone, et elle ne tourne qu'une fois par processus pour un coût de l'ordre
 * de la demi-seconde. La rendre asynchrone obligerait tout ce qui construit un
 * argv à devenir asynchrone avec elle, et n'économiserait rien.
 *
 * L'appel réel n'est pas décoratif : `-encoders` peut annoncer `h264_nvenc` sur
 * un binaire dont le pilote ne suit pas, et l'échec tomberait alors au milieu
 * d'un export d'une heure.
 */
function sonderNvenc(): boolean {
  if (sondeNvenc !== null) return sondeNvenc
  const r = spawnSync(
    ffmpegBin(),
    [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1:r=25',
      '-c:v', 'h264_nvenc', '-frames:v', '3',
      '-f', 'null', '-',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000, encoding: 'utf8' },
  )
  sondeNvenc = r.error === undefined && r.status === 0
  return sondeNvenc
}

/**
 * L'encodeur à utiliser. `FFMPEG_ENCODER` fait foi ; `auto` sonde une fois.
 *
 * C'est l'encodeur **de l'export**, celui qui gagne le facteur 2,3 au GPU (4,58x
 * contre 1,97x). Le proxy a le sien, `encodeurProxy` dans `steps/proxy.ts`, et
 * il rend x264 sur `auto` : le redimensionnement y domine le travail et reste
 * sur le processeur dans les deux cas, si bien que NVENC y est plus lent.
 */
export function encoderName(): EncoderName {
  return choisirEncodeur(process.env.FFMPEG_ENCODER, sonderNvenc)
}

/**
 * L'arrêt demandé par un humain. **Ni une panne, ni un échec.**
 *
 * Elle existe pour que `run.ts` puisse écrire un `status.json` qui ne ressemble
 * pas à un incident : un ffmpeg tué par `SIGTERM` rend « ffmpeg a échoué (tué
 * par SIGTERM) », message parfaitement exact et parfaitement trompeur sur la
 * seule surface qui dise à quelqu'un ce qui s'est passé.
 *
 * Elle vit ici plutôt que dans `run.ts`, qui tient pourtant le contrôleur : les
 * trois lanceurs de sous-processus du dépôt — ffmpeg, WhisperX, le détecteur —
 * l'utilisent, et `run.ts` les importe tous les trois. La poser là-bas ferait un
 * cycle d'imports pour un type de trois lignes.
 */
export class ArrêtDemandéError extends Error {
  constructor(quoi?: string) {
    super(`Arrêt demandé${quoi === undefined ? '' : ` — ${quoi}`}.`)
    this.name = 'ArrêtDemandéError'
  }
}

/**
 * Le délai entre le `SIGTERM` poli et le `SIGKILL` qui ne demande rien.
 *
 * **WhisperX ne rend pas la main tout de suite** : le processus doit libérer le
 * modèle et la VRAM, et CTranslate2 y met plusieurs secondes. Tuer d'emblée
 * marcherait — c'est un sous-processus dont on jette le travail — mais laisserait
 * régulièrement le pilote NVIDIA avec de la mémoire à récupérer, et l'étape
 * suivante démarrerait dans cet état-là. Dix secondes couvrent le cas mesuré et
 * ne coûtent rien quand le processus part tout de suite.
 */
export const DÉLAI_SIGKILL_MS = 10_000

/**
 * Branche un signal d'annulation sur un processus fils : `SIGTERM`, puis
 * `SIGKILL` si le processus n'est pas parti.
 *
 * Rend la fonction qui débranche tout, **à appeler quand le processus se
 * termine** : sans elle, l'écouteur d'`abort` survit au processus qu'il visait et
 * la minuterie de `SIGKILL` tient la boucle d'événements en vie pour rien.
 *
 * Le second `kill` sur un processus déjà mort est sans effet : Node le refuse en
 * silence quand `exitCode` est posé, et un `ESRCH` sur une course serait de
 * toute façon inoffensif. On l'attrape quand même, parce qu'une exception jetée
 * depuis une minuterie n'a personne pour la rattraper et couperait le serveur.
 */
export function propagerArrêt(
  proc: ChildProcess,
  signal: AbortSignal | undefined,
  délaiMs: number = DÉLAI_SIGKILL_MS,
): () => void {
  if (signal === undefined) return () => {}

  let couperet: NodeJS.Timeout | undefined
  const tuer = (sig: NodeJS.Signals): void => {
    try {
      proc.kill(sig)
    } catch {
      // Le processus est déjà parti : c'est le résultat qu'on visait.
    }
  }

  const arrêter = (): void => {
    tuer('SIGTERM')
    couperet = setTimeout(() => tuer('SIGKILL'), délaiMs)
  }

  // **Le signal peut déjà avoir été levé.** Un arrêt demandé pendant qu'une
  // étape démarrait laisserait sinon tourner le processus qu'elle vient de
  // lancer, seul, jusqu'au bout de ses six minutes.
  if (signal.aborted) arrêter()
  else signal.addEventListener('abort', arrêter, { once: true })

  return () => {
    clearTimeout(couperet)
    signal.removeEventListener('abort', arrêter)
  }
}

export type OptionsFfmpeg = {
  /** La durée attendue de la sortie, pour convertir `time=` en fraction. */
  durationSec?: number | null
  /** Appelé à chaque marque de temps. */
  onProgress?: (avancement: Avancement) => void
  /** Ce qu'on est en train de faire, pour le message d'échec. */
  quoi?: string
  /** Le binaire, si ce n'est pas `ffmpegBin()`. */
  bin?: string
  /**
   * Le délai au bout duquel le processus est **tué**, ou `undefined` pour ne
   * jamais renoncer — ce qui reste le défaut, et le bon défaut : un proxy prend
   * six minutes, un export jusqu'à une minute, et une borne arbitraire les
   * ferait échouer le jour où la machine est chargée.
   *
   * Il existe pour le seul appelant qui lise **l'original sur le montage 9p**,
   * la vignette d'une source. Le Drive décroche de deux façons que
   * `/proc/mounts` ne distingue pas, et un ffmpeg qui pend dessus ne rend
   * jamais la main : ni le processus, ni la requête HTTP qui l'attend.
   *
   * **Renoncer ne suffit pas ici, il faut tuer.** Ailleurs dans ce dépôt on se
   * contente de cesser d'attendre — un appel système n'est pas annulable. Un
   * processus, lui, l'est : le laisser derrière soi accumulerait un ffmpeg par
   * vignette demandée pendant que le partage est tombé.
   */
  timeoutMs?: number
  /**
   * L'arrêt demandé par un humain (`POST /api/projects/:id/stop`).
   *
   * **Distinct de `timeoutMs`, et pour une raison de fond** : celui-ci décide
   * qu'un ffmpeg qui pend sur un montage mort ne reviendra pas, celui-là dit que
   * quelqu'un ne veut plus du résultat. Le second se propage depuis le lanceur à
   * travers toute la chaîne ; le premier est une garde locale. Ils tuent le même
   * processus et ne veulent pas dire la même chose — l'un est une panne, l'autre
   * un choix, et `status.json` ne doit pas les confondre.
   */
  signal?: AbortSignal
}

/**
 * Lance ffmpeg et attend sa fin.
 *
 * Le processus n'a pas d'entrée standard (`-nostdin` est déjà dans les argv, et
 * `stdio[0]` vaut `ignore` par-dessus) : un ffmpeg qui poserait une question
 * bloquerait un serveur sans que personne ne voie la question.
 *
 * **Le message d'erreur porte la commande et la fin de stderr.** Il est destiné
 * à un journal de serveur, pas à une réponse HTTP : une route qui le renverrait
 * tel quel exposerait l'arborescence de la machine.
 */
export function runFfmpeg(args: string[], options: OptionsFfmpeg = {}): Promise<void> {
  const bin = options.bin ?? ffmpegBin()
  const durée = options.durationSec ?? null
  const journal = créerJournal()

  return new Promise<void>((resolve, reject) => {
    // **Le refus vient avant le `spawn`.** Un arrêt demandé pendant qu'une étape
    // se prépare — le `mkdir` de `produireArtefact`, par exemple — laisserait
    // sinon partir un encodage de six minutes que plus personne n'attend.
    if (options.signal?.aborted === true) {
      reject(new ArrêtDemandéError(options.quoi))
      return
    }

    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const débrancher = propagerArrêt(proc, options.signal)

    // **On rejette *et* on tue, dans cet ordre.** Sur un montage 9p mort, le
    // processus part en sommeil non interruptible : `SIGKILL` est enregistré
    // mais `close` peut n'arriver que bien plus tard, voire jamais. Attendre la
    // fin du processus pour rendre la main reproduirait exactement le blocage
    // qu'on ferme. Un `reject` après règlement est sans effet, donc le `close`
    // qui finira peut-être par venir ne dit rien de plus.
    const renoncer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            proc.kill('SIGKILL')
            reject(
              new Error(
                `ffmpeg n'a pas répondu en ${options.timeoutMs} ms` +
                  `${options.quoi === undefined ? '' : ` — ${options.quoi}`}, il a été tué. ` +
                  'Sur un chemin du montage 9p, cela veut dire que le partage a perdu son ' +
                  "transport : /proc/mounts ne le distingue pas d'un partage sain.",
              ),
            )
          }, options.timeoutMs)
    const finir = () => {
      clearTimeout(renoncer)
      débrancher()
    }

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (morceau: string) => {
      // On analyse ce que le carnet vient de **terminer**, pas le morceau brut :
      // stderr est un flux, et une marque `time=00:0` / `0:05.00` coupée en deux
      // par la frontière d'un morceau serait perdue des deux côtés. Le carnet
      // reporte déjà la queue, il n'y a rien à rebâtir ici. (relevé par Copilot)
      const complètes = journal.ajouter(morceau)
      if (options.onProgress === undefined) return
      const secondes = analyserMarqueTemps(complètes.join('\n'))
      if (secondes === null) return
      options.onProgress({
        seconds: secondes,
        // `durée <= 0` viendrait d'un ffprobe qui n'a rien su dire : mieux vaut
        // pas de fraction du tout qu'une division par zéro rendue en `Infinity`.
        fraction: durée !== null && durée > 0 ? Math.min(1, secondes / durée) : null,
      })
    })

    // `error` couvre le binaire introuvable (`ENOENT`), le cas le plus fréquent
    // sur une machine où `setup.sh` n'a pas tourné. Sans ce gestionnaire, la
    // promesse ne se réglerait jamais.
    proc.on('error', (cause) => {
      finir()
      reject(
        new Error(
          `ffmpeg n'a pas pu démarrer (${bin}) : ${cause.message}. ` +
            'Voir FFMPEG_BIN dans .env, et setup.sh.',
          { cause },
        ),
      )
    })

    proc.on('close', (code, signal) => {
      finir()
      if (code === 0) {
        resolve()
        return
      }
      // **Un arrêt demandé n'est pas un échec de ffmpeg.** Le processus est bien
      // mort d'un `SIGTERM`, et le message que ce bloc écrirait — « ffmpeg a
      // échoué (tué par SIGTERM) » — est exact et trompeur : il finirait dans
      // `status.json`, puis dans le champ `error` de `GET /api/projects/:id`,
      // c'est-à-dire sur la seule surface qui dise à quelqu'un ce qui s'est
      // passé. Le contrôle est sur le signal d'annulation et non sur le nom du
      // signal Unix reçu : un `SIGTERM` venu d'ailleurs reste un incident.
      if (options.signal?.aborted === true) {
        reject(new ArrêtDemandéError(options.quoi))
        return
      }
      // Un signal donne `code === null` : le dire, sinon le message annonce
      // « code null » et laisse croire à un bug du lanceur.
      const cause = signal !== null ? `tué par ${signal}` : `code de sortie ${code}`
      reject(
        new Error(
          [
            `ffmpeg a échoué (${cause})${options.quoi ? ` — ${options.quoi}` : ''}.`,
            `Commande : ${bin} ${args.join(' ')}`,
            'Dernières lignes de stderr :',
            journal.texte() || '(stderr vide)',
          ].join('\n'),
        ),
      )
    })
  })
}

/** Ce que rend une étape adossée à un artefact : le chemin, et si on l'a refait. */
export type Artefact = {
  path: string
  /** Vrai si l'artefact était déjà là et que `force` ne le visait pas. */
  skipped: boolean
}

export type OptionsArtefact = {
  /** Le chemin définitif de l'artefact. Sa présence vaut « étape faite ». */
  dst: string
  /** Refaire même si l'artefact est là. */
  force?: boolean
  /** L'argv, construit autour de la destination **temporaire** qu'on lui passe. */
  args: (destination: string) => string[]
  durationSec?: number | null
  onProgress?: (avancement: Avancement) => void
  quoi?: string
  /** L'arrêt demandé. Voir `OptionsFfmpeg.signal`. */
  signal?: AbortSignal
}

/**
 * Produit un artefact avec ffmpeg — ou ne fait rien s'il est déjà là.
 *
 * Deux règles, et les deux sont des décisions du projet plutôt que des détails :
 *
 * 1. **La présence du fichier vaut « étape faite »** (spec §4). Pas encore de clé
 *    de validité — c'est l'itération 4 —, et `force` court-circuite.
 * 2. **ffmpeg écrit sous un nom temporaire, renommé une fois seulement.** Sans
 *    cela, un encodage interrompu au bout de dix minutes laisserait un MP4
 *    tronqué sous le nom définitif, et la règle 1 le prendrait pour un artefact
 *    valide à la relance suivante. Le fichier serait lisible, plus court, et
 *    personne ne verrait rien.
 *
 * Le temporaire **garde l'extension d'origine** : ffmpeg choisit son muxeur
 * dessus, et un `proxy.mp4.partiel` sortirait sur « Unable to find a suitable
 * output format ».
 *
 * **C'est la règle 2 qui rend l'arrêt d'une analyse sûr**, et elle vaut d'être
 * lue dans ce sens-là aussi : un ffmpeg tué en plein encodage ne laisse rien qui
 * porte le nom définitif, donc `relevéPrésence` ne verra pas l'étape comme
 * faite et la reprise la refera. Le fichier temporaire est effacé au passage, et
 * `rendusPrésents` ignore de toute façon les `*.partiel-*`. Le même invariant
 * tient pour les deux workers Python, qui écrivent par `cheminTemporaire` et ne
 * renomment qu'après validation.
 */
export async function produireArtefact(o: OptionsArtefact): Promise<Artefact> {
  if (o.force !== true && fs.existsSync(o.dst)) return { path: o.dst, skipped: true }

  await fsp.mkdir(path.dirname(o.dst), { recursive: true })
  const temporaire = cheminTemporaire(o.dst)

  try {
    await runFfmpeg(o.args(temporaire), {
      durationSec: o.durationSec,
      onProgress: o.onProgress,
      quoi: o.quoi,
      signal: o.signal,
    })
    await fsp.rename(temporaire, o.dst)
  } catch (cause) {
    await fsp.rm(temporaire, { force: true }).catch(() => {})
    throw cause
  }

  return { path: o.dst, skipped: false }
}

/** Distingue deux écritures simultanées **dans le même processus**. */
let numéroÉcriture = 0

/**
 * Le nom sous lequel on écrit avant de renommer.
 *
 * **L'extension est conservée**, et ce n'est pas cosmétique : ffmpeg choisit son
 * muxeur sur elle, et un `proxy.mp4.partiel-42` échouerait sur « Unable to find a
 * suitable output format ».
 *
 * Le jeton distingue deux écritures concurrentes vers la même destination. Le
 * numéro de processus ne suffit pas : rien n'interdit un
 * `Promise.all([buildProxy(x), buildProxy(x)])`, où les deux ffmpeg
 * écriraient dans le même fichier temporaire et produiraient un MP4 entrelacé
 * que le renommage rendrait définitif. Un compteur de module ferme ce cas, le
 * `pid` ferme celui de deux processus.
 *
 * Le renommage final, lui, est atomique : le dernier arrivé gagne, et les deux
 * candidats sont corrects.
 */
export function cheminTemporaire(dst: string, jeton?: string | number): string {
  const marque = jeton ?? `${process.pid}-${++numéroÉcriture}`
  const ext = path.extname(dst)
  return path.join(path.dirname(dst), `${path.basename(dst, ext)}.partiel-${marque}${ext}`)
}
