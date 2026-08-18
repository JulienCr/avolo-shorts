import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { cheminTemporaire, créerJournal, ffmpegBin, type Artefact } from '@/server/ffmpeg'
import { probe } from '@/server/ffprobe'
import { analysisPath, proxyPath } from '@/server/paths'

/**
 * L'analyse d'image : où sont les gens, et où sont les coupes.
 *
 * `worker/detect.py` fait le travail — YOLO classe *person* à 2 images par
 * seconde, et le score de scène de ffmpeg pour les frontières de plans, les deux
 * sur le proxy 960x540. Ce fichier-ci ne fait que le lancer et vérifier ce qu'il
 * rend, comme `steps/transcript.ts` le fait pour WhisperX. Il en suit le patron
 * de près, y compris là où ce patron a été payé cher.
 *
 * Trois points portent cette étape.
 *
 * **1. L'étape dépend du proxy, et de rien d'autre.** Pas de l'audio, pas du
 * transcript. Le graphe décrit des dépendances réelles (`src/core/graph.ts`) :
 * viser l'analyse ne doit pas déclencher vingt-cinq minutes de transcription.
 *
 * **2. Le worker doit se terminer, et on l'attend.** La sortie du processus est
 * la seule garantie dure que la VRAM est rendue ; `empty_cache()` n'y suffit
 * pas. YOLO est petit — deux gigaoctets —, mais l'analyse peut tourner à côté
 * d'une transcription qui, elle, en prend une vingtaine.
 *
 * **3. Le résultat est validé avant d'être rangé.** Le fichier temporaire est
 * relu et passé au schéma zod ci-dessous avant le renommage : un worker qui
 * écrirait un JSON incomplet laisserait sinon un artefact que le graphe par
 * présence prendrait pour bon, et le cadrage échouerait trois étapes plus loin.
 */

/**
 * `analysis.json`, tel qu'il est écrit sur le disque.
 *
 * **Les types purs de ces objets vivent dans `src/core/shots.ts`** — `PersonBox`
 * et `Shot`, que le cadrage consomme. Ce schéma les redit, et la redondance est
 * délibérée : le dépôt valide à la frontière d'I/O, et un schéma qui vivrait
 * dans `src/core/` obligerait `core` à connaître la forme d'un fichier. Les six
 * champs se résorberont quand `core/shots.ts` exposera son propre schéma.
 *
 * **Les boîtes sont en fractions de la largeur et de la hauteur, jamais en
 * pixels.** La détection tourne sur le proxy 960x540, le rendu croppe l'original
 * 1920x1080 : des pixels obligeraient chaque consommateur à savoir de quelle
 * image ils viennent, et la première conversion oubliée passerait une boîte à la
 * moitié de sa taille sans que rien ne le signale.
 */
const SCHÉMA_TAILLE = z.object({ w: z.number().int().positive(), h: z.number().int().positive() })

// L'ordre des bornes est vérifié, pas seulement leur domaine : un intervalle
// retourné (`start: 10, end: 5`) a la forme d'un plan et n'en est pas un. Le
// cadrage le trierait sans rien y trouver, et son crop sauterait au plan
// suivant sans que personne ne sache pourquoi.
const SCHÉMA_PLAN = z
  .object({ start: z.number().min(0), end: z.number().min(0) })
  .refine((p) => p.end > p.start, { message: 'end doit être strictement après start' })

const SCHÉMA_BOÎTE = z
  .object({
    /** Instant dans la source, en secondes. Jamais négatif : la source commence à 0. */
    t: z.number().min(0),
    // Bornées à [0, 1] : une fraction hors du cadre ferait sortir le crop de
    // l'image. Le worker les borne déjà ; le schéma le vérifie plutôt que de le
    // supposer, parce que c'est exactement ce qu'un schéma sert à faire.
    x0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
    y0: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
    score: z.number().min(0).max(1),
  })
  // Le domaine ne suffit pas : deux fractions parfaitement valides peuvent
  // décrire une boîte d'aire nulle ou négative. Elle a la forme d'une détection
  // et n'a plus de sujet — et le percentile 90 du cadrage la compterait comme
  // une personne de largeur nulle. `detect.py` ne l'écrit pas ; le schéma
  // s'assure qu'aucune version ultérieure ne s'y remette.
  .refine((b) => b.x1 > b.x0 && b.y1 > b.y0, {
    message: "les bornes d'une boîte doivent croître : x1 > x0 et y1 > y0",
  })

export const SCHÉMA_ANALYSE = z.object({
  version: z.literal(1),
  /** Images analysées par seconde — 2, spec §6. */
  fps: z.number().positive(),
  source: SCHÉMA_TAILLE,
  proxy: SCHÉMA_TAILLE,
  shots: z.array(SCHÉMA_PLAN).min(1),
  boxes: z.array(SCHÉMA_BOÎTE),
})

export type Analyse = z.infer<typeof SCHÉMA_ANALYSE>

/**
 * Relit `analysis.json` et le valide.
 *
 * Levée plutôt que `null` sur un fichier invalide : l'appelant a constaté sa
 * présence, donc le trouver illisible est une panne, pas une absence.
 */
export function lireAnalyse(fichier: string): Analyse {
  const brut: unknown = JSON.parse(fs.readFileSync(fichier, 'utf8'))
  const analysé = SCHÉMA_ANALYSE.safeParse(brut)
  if (!analysé.success) {
    throw new Error(
      `${path.basename(fichier)} ne suit pas le contrat de l'itération 1 : ${analysé.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(racine)'} — ${i.message}`)
        .join(' ; ')}`,
    )
  }
  return analysé.data
}

/**
 * L'interpréteur du venv de détection.
 *
 * Le défaut vise l'emplacement que `setup.sh` remplit, résolu depuis le dossier
 * de travail du processus — la racine du dépôt sous Next comme sous `tsx`, la
 * même convention que `worker/transcribe.py` et que `fonts/`. `DETECT_PYTHON`
 * sert aux autres cas.
 *
 * **Ce n'est surtout pas `WHISPER_PYTHON`.** Celui-là pointe le venv du
 * diariseur de `~/dev/rythmo-impro`, qui appartient à un autre dépôt et n'a ni
 * ultralytics ni de raison d'en avoir.
 *
 * `||` et non `??`, comme partout ailleurs : une variable posée mais vide — ce
 * qu'un `.env` produit facilement — désactiverait le défaut et ferait échouer
 * l'étape sur un chemin vide.
 */
function pythonDétection(): string {
  return process.env.DETECT_PYTHON || path.join(process.cwd(), 'worker', 'venv', 'bin', 'python')
}

/** Les poids YOLO, posés par `setup.sh` dans `worker/models/`. */
function modèleDétection(): string {
  return process.env.DETECT_MODEL || path.join(process.cwd(), 'worker', 'models', 'yolo11m.pt')
}

/** Le script Python. Même convention que `WHISPER_WORKER`. */
function scriptDétection(): string {
  return process.env.DETECT_WORKER || path.join(process.cwd(), 'worker', 'detect.py')
}

/**
 * Les seules variables qui franchissent la frontière de processus.
 *
 * **Une liste blanche, et volontairement plus courte que celle de
 * `steps/transcript.ts`.** Les deux workers n'ont pas les mêmes besoins et ne
 * doivent pas dériver ensemble : celui-ci ne télécharge rien — les poids sont
 * sur le disque, posés par `setup.sh` — donc ni les caches de Hugging Face ni
 * les variables de mandataire n'ont de raison de passer. Or ce sont précisément
 * les mandataires qui portent un mot de passe dans leur autorité, et le stderr
 * du worker est capturé puis remonté par `onLog`.
 *
 * On nomme ce qui passe, jamais ce qui ne passe pas : une liste noire de secrets
 * ne peut pas être complète.
 */
const TRANSMISES: readonly string[] = [
  // Le strict nécessaire pour qu'un processus tourne.
  'PATH',
  // `HOME` n'est pas décoratif : ultralytics écrit ses réglages dans
  // `~/.config/Ultralytics` au premier lancement, et sans `HOME` il les pose
  // dans le dossier de travail — donc à la racine du dépôt.
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  // Le GPU.
  'CUDA_VISIBLE_DEVICES',
  'CUDA_HOME',
  'NVIDIA_VISIBLE_DEVICES',
]

/**
 * L'environnement du sous-processus, reconstruit depuis la liste blanche.
 *
 * Pure : l'environnement de départ est un argument, donc la liste se teste sans
 * toucher à `process.env`.
 */
export function environnementDétection(
  base: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  // `as NodeJS.ProcessEnv` sur l'accumulateur, comme dans `transcript.ts` : Next
  // déclare `NODE_ENV` obligatoire sur ce type, et un environnement reconstruit
  // ne peut pas le prouver structurellement.
  const transmis = {} as NodeJS.ProcessEnv
  for (const nom of TRANSMISES) {
    const valeur = base[nom]
    if (valeur !== undefined) transmis[nom] = valeur
  }
  return transmis
}

/** `960x540`, la forme que `detect.py` attend. */
export function formatTaille(largeur: number, hauteur: number): string {
  return `${largeur}x${hauteur}`
}

export type OptionsAnalyse = {
  projectId: string
  /**
   * La vidéo dont on relève les dimensions pour le champ `source`. La copie de
   * travail fait l'affaire : elle est identique à l'original, et la sonder ne
   * touche pas au Drive.
   */
  source: string
  force?: boolean
  /** Le modèle, si on ne veut pas celui que l'environnement désigne. */
  model?: string
  /** Le seuil de score de scène. Voir la constante plus bas. */
  sceneThreshold?: number
  /** Les lignes que le worker écrit sur stderr, au fil de l'eau. */
  onLog?: (ligne: string) => void
}

/**
 * Le score de scène au-delà duquel on déclare une coupe.
 *
 * **Mesuré, et il contredit ce que la spec §2 laissait attendre.** Cette
 * section-là, bâtie sur une mosaïque de vingt minutes d'une seule scène,
 * annonçait des plans de plusieurs minutes sans changement d'axe. Sur
 * `2025-06-15-cqlp` en entier, la vérification image par image des candidates
 * montre au contraire une émission **multicaméra**, qui coupe à peu près une
 * fois par minute — et les coupes sont réelles : le cadrage, l'axe et souvent
 * le décor changent d'une image à la suivante.
 *
 * Le confondant n'est pas le mouvement des comédiens, c'est **la lumière**. Le
 * plateau est éclairé par des barres de LED de couleur qui basculent entre les
 * jeux ; un passage du noir au bleu donne un score de 0,61 sans qu'aucune caméra
 * n'ait bougé. Un seuil trop bas attrape ces basculements, et une frontière
 * fantôme laisse le crop sauter au milieu d'un plan continu — exactement le
 * tangage que la spec §10 interdit.
 *
 * 0,4 est le point où l'échantillon vérifié à l'image ne contient plus que des
 * coupes et des basculements d'éclairage francs. En dessous de 0,3, ce sont des
 * mouvements de comédien.
 */
const SEUIL_SCÈNE = 0.4

/**
 * Analyse le proxy, ou ne fait rien si `analysis.json` est déjà là.
 *
 * Le worker écrit sous un nom temporaire, relu, validé, puis renommé une fois
 * seulement : un processus tué à la quatrième minute laisserait sinon un JSON
 * tronqué sous le nom définitif, que la relance suivante prendrait pour une
 * analyse valide.
 */
export async function runAnalysis(o: OptionsAnalyse): Promise<Artefact> {
  const destination = analysisPath(o.projectId)
  if (o.force !== true && fs.existsSync(destination)) {
    return { path: destination, skipped: true }
  }

  const proxy = proxyPath(o.projectId)
  if (!fs.existsSync(proxy)) {
    throw new Error(
      `Le proxy ${JSON.stringify(proxy)} n'existe pas. L'analyse vient après l'étape proxy.`,
    )
  }

  const python = pythonDétection()
  const script = scriptDétection()
  const modèle = o.model ?? modèleDétection()
  for (const [quoi, chemin, remède] of [
    ["L'interpréteur de détection", python, 'Lancer ./setup.sh, qui monte worker/venv.'],
    ['Le worker de détection', script, 'Lancer depuis la racine du dépôt, ou pointer DETECT_WORKER dessus.'],
    ['Les poids YOLO', modèle, 'Lancer ./setup.sh, qui les télécharge dans worker/models/.'],
  ] as const) {
    if (!fs.existsSync(chemin)) {
      throw new Error(`${quoi} est introuvable : ${JSON.stringify(chemin)}. ${remède}`)
    }
  }

  // Les deux sondages, et ils ne disent pas la même chose. Celui du proxy est
  // **load-bearing** : `detect.py` lit un flux d'images brutes dont il faut
  // connaître la géométrie à l'octet près, sans quoi chaque image est cisaillée.
  // Celui de la source est un passe-plat, recopié dans `analysis.json` pour que
  // le rendu sache à quoi les fractions se rapportent.
  const sondageProxy = await probe(proxy)
  if (
    sondageProxy.width === null ||
    sondageProxy.height === null ||
    sondageProxy.durationSec === null ||
    sondageProxy.durationSec <= 0
  ) {
    throw new Error(
      `ffprobe n'a rien su dire du proxy ${JSON.stringify(proxy)} : dimensions ou durée manquantes. ` +
        'Le proxy est peut-être tronqué — le refaire avec un run --force sur proxy.',
    )
  }

  const sondageSource = await probe(o.source)
  if (sondageSource.width === null || sondageSource.height === null) {
    throw new Error(
      `ffprobe n'a rien su dire des dimensions de ${JSON.stringify(o.source)}. ` +
        "Elles sont recopiées dans analysis.json : sans elles, le rendu ne sait pas à quoi les fractions se rapportent.",
    )
  }

  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const temporaire = cheminTemporaire(destination)

  const args = [
    // `-u` : sans lui, Python tamponne stderr et les quatre étapes du worker
    // arriveraient toutes ensemble, à la fin.
    '-u',
    script,
    '--proxy', proxy,
    '--out', temporaire,
    // `ffmpegBin()` et non `process.env.FFMPEG_BIN` relu ici : le binaire de
    // `setup.sh` se désigne d'un seul endroit, sinon un jour l'un des deux
    // apprend un repli que l'autre ignore.
    '--ffmpeg', ffmpegBin(),
    '--model', modèle,
    '--proxy-size', formatTaille(sondageProxy.width, sondageProxy.height),
    '--source-size', formatTaille(sondageSource.width, sondageSource.height),
    '--duration', String(sondageProxy.durationSec),
    '--scene-threshold', String(o.sceneThreshold ?? SEUIL_SCÈNE),
  ]

  try {
    await lancerWorker(python, args, environnementDétection(process.env), o.onLog)
    // Valider **avant** le renommage : un JSON hors contrat ne doit jamais
    // porter le nom définitif, sans quoi le graphe par présence le sert comme
    // une analyse valide à toutes les relances suivantes.
    lireAnalyse(temporaire)
    await fsp.rename(temporaire, destination)
  } catch (cause) {
    await fsp.rm(temporaire, { force: true }).catch(() => {})
    throw cause
  }

  return { path: destination, skipped: false }
}

/**
 * Lance le worker et **attend sa sortie**.
 *
 * `close` et non `exit` : `exit` part dès que le processus meurt, `close` attend
 * que ses flux soient vidés. Sur un échec, la différence est précisément les
 * dernières lignes de la trace Python — celles qui disent pourquoi.
 *
 * **Les deux sorties sont capturées, aucune n'est héritée.** Le worker écrit son
 * avancement sur stderr, mais ultralytics et torch écrivent sur stdout par le
 * module `logging` sans rien demander à personne. Hérité, tout cela irait se
 * mêler à la sortie du serveur.
 *
 * **Le message d'échec porte la commande complète**, donc des chemins absolus.
 * Comme ceux de `runFfmpeg` et de `lancerWorker` côté transcription, il est
 * destiné à un journal de serveur, pas à une réponse HTTP — `messageSûr` épure
 * ce qui part dans `status.json`.
 */
function lancerWorker(
  python: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onLog?: (ligne: string) => void,
): Promise<void> {
  const journal = créerJournal(40)

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(python, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })

    // Un découpage en lignes par flux : les deux arrivent par morceaux coupés
    // n'importe où, et un tampon partagé recollerait la fin de l'un au début de
    // l'autre.
    const relayer = (flux: NodeJS.ReadableStream, journaliser: boolean): void => {
      flux.setEncoding('utf8')
      let reste = ''
      const émettre = (ligne: string): void => {
        if (onLog !== undefined && ligne.trim() !== '') onLog(ligne)
      }
      flux.on('data', (morceau: string) => {
        if (journaliser) journal.ajouter(morceau)
        if (onLog === undefined) return
        // Découpage sur **CR comme LF** : les barres d'avancement d'ultralytics
        // se réécrivent derrière un `\r`, sans jamais de saut de ligne.
        const lignes = (reste + morceau).split(/\r\n|[\r\n]/)
        reste = lignes.pop() ?? ''
        for (const ligne of lignes) émettre(ligne)
      })
      flux.on('end', () => {
        émettre(reste)
        reste = ''
      })
    }

    relayer(proc.stderr, true)
    relayer(proc.stdout, false)

    proc.on('error', (cause) => {
      reject(
        new Error(
          `Le worker de détection n'a pas pu démarrer (${python}) : ${cause.message}. ` +
            'Voir DETECT_PYTHON dans .env, et setup.sh.',
          { cause },
        ),
      )
    })

    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      const cause = signal !== null ? `tué par ${signal}` : `code de sortie ${code}`
      reject(
        new Error(
          [
            `L'analyse a échoué (${cause}).`,
            `Commande : ${python} ${args.join(' ')}`,
            'Dernières lignes :',
            journal.texte() || '(stderr vide)',
          ].join('\n'),
        ),
      )
    })
  })
}
