import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  StopRequestedError,
  pathTemporary,
  createLog,
  ffmpegBin,
  forwardAbort,
  type Artifact,
} from '@/server/ffmpeg'
import { POINT_COUNT } from '@/core/shots'
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
 * **L'ordre des deux lignes est tenu par `tests/server/analysis.test.ts`**, qui
 * regarde ce qui reste sur le disque après un échec — une propriété annoncée ici
 * et vérifiée nulle part serait pire qu'une propriété absente, puisqu'on s'y fie.
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
const SCHEMA_SIZE = z.object({ w: z.number().int().positive(), h: z.number().int().positive() })

// L'ordre des bornes est vérifié, pas seulement leur domaine : un intervalle
// retourné (`start: 10, end: 5`) a la forme d'un plan et n'en est pas un. Le
// cadrage le trierait sans rien y trouver, et son crop sauterait au plan
// suivant sans que personne ne sache pourquoi.
const SCHEMA_SHOT = z
  .object({ start: z.number().min(0), end: z.number().min(0) })
  .refine((p) => p.end > p.start, { message: 'end doit être strictement après start' })


const SCHEMA_BOX = z
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
    /**
     * Les dix-sept points COCO, en fractions, `x, y, confiance` mis bout à bout.
     * Absents d'une analyse produite par un modèle de détection.
     *
     * **Les coordonnées ne sont pas bornées à [0, 1]**, contrairement à celles
     * de la boîte : un point hors cadre est une information — une épaule que le
     * bord de l'image coupe —, alors qu'une boîte hors cadre ne désigne plus
     * rien. Seule la confiance l'est, puisqu'elle sert de seuil.
     *
     * **Et il faut le vérifier au rang, pas au type**, ce que la première
     * version de ce schéma ne faisait pas : le tableau est plat, donc `z.number()`
     * ne distingue pas une abscisse d'une confiance, et `-1` comme `2` passaient.
     * Ni l'un ni l'autre n'échoue bruyamment — ils franchissent `torsoMinScore`
     * dans le mauvais sens et font entrer ou sortir un point du tronc, ce qui
     * déplace un crop sans rien signaler. (relevé par Copilot)
     */
    k: z
      .array(z.number().finite())
      .length(POINT_COUNT * 3)
      .refine((k) => k.every((v, i) => i % 3 !== 2 || (v >= 0 && v <= 1)), {
        message: 'la confiance de chaque point de pose doit tenir dans [0, 1]',
      })
      .optional(),
  })
  // Le domaine ne suffit pas : deux fractions parfaitement valides peuvent
  // décrire une boîte d'aire nulle ou négative. Elle a la forme d'une détection
  // et n'a plus de sujet — et le percentile 90 du cadrage la compterait comme
  // une personne de largeur nulle. `detect.py` ne l'écrit pas ; le schéma
  // s'assure qu'aucune version ultérieure ne s'y remette.
  .refine((b) => b.x1 > b.x0 && b.y1 > b.y0, {
    message: "les bornes d'une boîte doivent croître : x1 > x0 et y1 > y0",
  })

/**
 * La granularité de `detect.py` : il arrondit ses bornes à la milliseconde.
 *
 * Deux arrondis d'un même instant donnent le même nombre, donc la tolérance est
 * inutile pour le producteur d'aujourd'hui — qui calcule les deux bornes depuis
 * la même liste. Elle vaut pour le suivant, qui pourrait les calculer
 * séparément : un écart d'une milliseconde serait alors un artefact d'arrondi,
 * pas un trou. Un vrai trou se compte en secondes.
 */
const TOLERANCE_SHOT = 0.001

/**
 * Les plans partitionnent `[0, durée]` : ils partent de zéro, se suivent bout à
 * bout, et ne se chevauchent pas.
 *
 * **Un invariant de la collection, pas de l'élément**, et c'est ce qui le rend
 * facile à oublier : chaque plan pris isolément peut être irréprochable pendant
 * que la liste ment. Les deux façons de mentir coûtent, et différemment.
 *
 * - **Se chevaucher fait compter deux fois** les boîtes de la zone commune, donc
 *   gonfle le total sur lequel `chooseRatio` cherche son seuil de 90 % : le clip
 *   sort dans un cadre plus large que nécessaire.
 * - **Laisser un trou fait disparaître** les boîtes qui y tombent, puisque
 *   `computeFraming` ignore celles qui n'appartiennent à aucun plan : l'intervalle
 *   est alors cadré par défaut, comme si personne n'y était jamais apparu.
 *
 * Les deux se voient à l'image et aucune ne lève d'erreur. Le test unique —
 * chaque début colle à la fin du précédent, le premier vaut zéro — les attrape
 * toutes les deux, plus le désordre au passage : un plan qui remonte le temps ne
 * colle à rien.
 *
 * Aujourd'hui `detect.py` ne peut pas produire autre chose : il découpe
 * `[0, durée]` à des frontières successives. C'est précisément l'argument —
 * l'itération 1 va itérer sur le détecteur, et cet invariant-là ne casse pas
 * bruyamment. (relevé par Aristarque sur la PR du cadrage, précisé par Copilot)
 */
function shotsInPartition(shots: readonly { start: number; end: number }[]): boolean {
  const first = shots[0]
  if (first === undefined || Math.abs(first.start) > TOLERANCE_SHOT) return false
  for (let i = 1; i < shots.length; i += 1) {
    const previous = shots[i - 1]
    const current = shots[i]
    if (previous === undefined || current === undefined) return false
    if (Math.abs(current.start - previous.end) > TOLERANCE_SHOT) return false
  }
  return true
}

/**
 * Les versions d'`analysis.json` que ce dépôt sait lire.
 *
 * - **1** — les boîtes seules, ce que le détecteur écrivait jusqu'au 19 août 2026.
 * - **2** — les boîtes, plus les points de pose quand le modèle en rend, plus le
 *   nom des poids qui ont produit le fichier.
 *
 * **Une version inconnue est refusée, elle n'est pas lue à moitié.** C'est le
 * point que la montée de version existe pour tenir : un fichier de version 3
 * dont on garderait les champs reconnus donnerait un cadrage plausible calculé
 * sur une donnée qu'on ne comprend plus. `lireAnalysis` nomme alors la version
 * trouvée et celles qu'il accepte, parce que « invalid literal » sur un champ
 * `version` n'apprend rien à qui vient de relancer une détection.
 */
export const ANALYSIS_VERSIONS = [1, 2] as const

export const SCHEMA_ANALYSIS = z.object({
  version: z.literal(ANALYSIS_VERSIONS),
  /** Images analysées par seconde — 2, spec §6. */
  fps: z.number().positive(),
  /**
   * Le fichier de poids qui a produit ce résultat, sans son dossier. Absent des
   * fichiers de version 1, et de ceux qu'un autre outil écrirait.
   *
   * Il ne sert à aucun calcul. Il sert à répondre à « d'où vient ce cadrage »
   * sans relancer trois minutes de GPU pour comparer — deux familles de poids
   * écrivent désormais ce fichier, et rien d'autre ne les distingue une fois le
   * JSON sur le disque.
   */
  model: z.string().min(1).optional(),
  /**
   * Le jeu de points que les boîtes portent, quand elles en portent un.
   *
   * **Un champ à part plutôt qu'un parcours des boîtes** : la question « ce
   * fichier porte-t-il des points » se pose avant tout calcul, et y répondre en
   * parcourant trente mille boîtes est à la fois lent et faux — une seule boîte
   * sans points ne dit pas que le fichier n'en a pas.
   */
  keypoints: z.literal('coco17').optional(),
  source: SCHEMA_SIZE,
  proxy: SCHEMA_SIZE,
  shots: z
    .array(SCHEMA_SHOT)
    .min(1)
    .refine(shotsInPartition, {
      message:
        'les plans doivent partitionner [0, durée] : partir de zéro et se suivre bout à bout. ' +
        'Deux plans qui se recouvrent font compter deux fois les boîtes de leur zone commune et ' +
        'élargissent le cadre ; un trou entre deux plans fait disparaître celles qui y tombent, ' +
        'et l’intervalle est cadré par défaut. Ni l’une ni l’autre ne lève d’erreur',
    }),
  boxes: z.array(SCHEMA_BOX),
})

export type Analysis = z.infer<typeof SCHEMA_ANALYSIS>

/**
 * Relit `analysis.json` et le valide.
 *
 * Levée plutôt que `null` sur un fichier invalide : l'appelant a constaté sa
 * présence, donc le trouver illisible est une panne, pas une absence.
 */
export function lireAnalysis(file: string): Analysis {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  const analysis = SCHEMA_ANALYSIS.safeParse(raw)
  if (!analysis.success) {
    // **La version d'abord, et à part.** Une version inconnue fait échouer le
    // schéma sur un « invalid literal » qui n'apprend rien, au milieu de la
    // demi-douzaine d'autres reproches qu'une forme nouvelle entraîne. Or c'est
    // la seule cause qui se règle en relançant l'analyse, et le message doit le
    // dire au lieu de laisser chercher dans les boîtes.
    const version: unknown =
      typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined
    if (!ANALYSIS_VERSIONS.some((v) => v === version)) {
      throw new Error(
        `${path.basename(file)} est en version ${JSON.stringify(version)}, et ce dépôt lit ` +
          `${ANALYSIS_VERSIONS.join(' et ')}. Une version inconnue n'est pas lue à moitié : les ` +
          'champs reconnus donneraient un cadrage plausible calculé sur une donnée dont le sens a ' +
          "changé. Relancer l'analyse (run --force sur analysis) réécrit le fichier au format du jour.",
      )
    }
    throw new Error(
      `${path.basename(file)} ne suit pas le contrat de l'itération 1 : ${analysis.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(racine)'} — ${i.message}`)
        .join(' ; ')}`,
    )
  }
  return analysis.data
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
function pythonDetection(): string {
  return process.env.DETECT_PYTHON || path.join(process.cwd(), 'worker', 'venv', 'bin', 'python')
}

/**
 * Les poids YOLO, posés par `setup.sh` dans `worker/models/`.
 *
 * **Le modèle de pose, et pas celui de détection.** Il rend dix-sept points par
 * personne en plus de la boîte, dont `src/core/framing.ts` déduit le tronc. Sans
 * eux, le cadrage retombe sur la **boîte rognée** — `personBounds` passe alors
 * par `trimmedBounds`, pas par la boîte entière —, c'est-à-dire sur un cadre qui
 * parie sur la position de la tête au lieu de la connaître (issue #69).
 *
 * **Les deux ne rendent pas la même population de boîtes**, et le dire compte :
 * sur `2025-06-15-cqlp`, `yolo11m.pt` rend 8 325 boîtes courtes collées au bord
 * bas contre 2 429 pour la pose — le modèle de pose ne détecte pas la plupart
 * des têtes de spectateurs de premier rang, faute d'articulations visibles. Le
 * nombre de boîtes gardées, lui, ne bouge presque pas (19 972 contre 20 306).
 * Changer de `DETECT_MODEL` ne change donc pas que les points ; le détail est
 * dans `docs/premier-plan.md`.
 *
 * Le surcoût mesuré est nul : 145 im/s contre 147, trois passes chacun sur le
 * même proxy, soit 1,4 % — sous le seuil de ce qu'une mesure prise ici établit.
 * `DETECT_MODEL` reste là pour repasser sur `yolo11m.pt` et refaire une mesure
 * de comparaison sans toucher au code.
 */
function templateDetection(): string {
  return (
    process.env.DETECT_MODEL || path.join(process.cwd(), 'worker', 'models', 'yolo11m-pose.pt')
  )
}

/** Le script Python. Même convention que `WHISPER_WORKER`. */
function scriptDetection(): string {
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
const FORWARDED: readonly string[] = [
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
export function environmentDetection(
  base: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  // `as NodeJS.ProcessEnv` sur l'accumulateur, comme dans `transcript.ts` : Next
  // déclare `NODE_ENV` obligatoire sur ce type, et un environnement reconstruit
  // ne peut pas le prouver structurellement.
  const forwarded = {} as NodeJS.ProcessEnv
  for (const name of FORWARDED) {
    const value = base[name]
    if (value !== undefined) forwarded[name] = value
  }
  return forwarded
}

/** `960x540`, la forme que `detect.py` attend. */
export function formatSize(width: number, hauteur: number): string {
  return `${width}x${hauteur}`
}

export type OptionsAnalysis = {
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
  onLog?: (line: string) => void
  /** L'arrêt demandé (`POST /api/projects/:id/stop`). Voir `OptionsFfmpeg.signal`. */
  signal?: AbortSignal
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
const THRESHOLD_SCENE = 0.4

/**
 * Analyse le proxy, ou ne fait rien si `analysis.json` est déjà là.
 *
 * Le worker écrit sous un nom temporaire, relu, validé, puis renommé une fois
 * seulement : un processus tué à la quatrième minute laisserait sinon un JSON
 * tronqué sous le nom définitif, que la relance suivante prendrait pour une
 * analyse valide.
 */
export async function runAnalysis(o: OptionsAnalysis): Promise<Artifact> {
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

  const python = pythonDetection()
  const script = scriptDetection()
  const template = o.model ?? templateDetection()
  for (const [what, path, fix] of [
    ["L'interpréteur de détection", python, 'Lancer ./setup.sh, qui monte worker/venv.'],
    ['Le worker de détection', script, 'Lancer depuis la racine du dépôt, ou pointer DETECT_WORKER dessus.'],
    ['Les poids YOLO', template, 'Lancer ./setup.sh, qui les télécharge dans worker/models/.'],
  ] as const) {
    if (!fs.existsSync(path)) {
      throw new Error(`${what} est introuvable : ${JSON.stringify(path)}. ${fix}`)
    }
  }

  // Les deux sondages, et ils ne disent pas la même chose. Celui du proxy est
  // **load-bearing** : `detect.py` lit un flux d'images brutes dont il faut
  // connaître la géométrie à l'octet près, sans quoi chaque image est cisaillée.
  // Celui de la source est un passe-plat, recopié dans `analysis.json` pour que
  // le rendu sache à quoi les fractions se rapportent.
  //
  // **Zéro est refusé comme `null`, et ce n'est pas de la symétrie gratuite.**
  // Une largeur nulle donne `octets = 0` dans `detect.py`, un `read(0)` qui rend
  // toujours zéro octet sans jamais être « plus court que demandé », donc une
  // boucle qui produit indéfiniment des images vides. Le pire des symptômes :
  // pas d'erreur, pas de fin. (relevé par Copilot)
  // Une fonction et non l'expression écrite deux fois : `aborted` change de
  // valeur entre les deux sondages, et TypeScript, qui l'ignore, retenait la
  // restriction du premier contrôle jusqu'au second.
  const isAborted = (): boolean => o.signal?.aborted === true

  const probeProxy = await probe(proxy, undefined, o.signal)
  // **Le contrôle vient avant l'interprétation du sondage.** Un sondage
  // abandonné rend un sondage vide, comme un fichier illisible : sans cette
  // ligne, un arrêt demandé ressortait en « ffprobe n'a rien su dire du
  // proxy — le refaire avec un run --force », qui envoie réencoder six minutes
  // de vidéo parfaitement valide. (relevé par Copilot)
  if (isAborted()) throw new StopRequestedError("l'analyse d'image")
  if (
    probeProxy.width === null ||
    probeProxy.height === null ||
    probeProxy.width <= 0 ||
    probeProxy.height <= 0 ||
    probeProxy.durationSec === null ||
    probeProxy.durationSec <= 0
  ) {
    throw new Error(
      `ffprobe n'a rien su dire du proxy ${JSON.stringify(proxy)} : dimensions ou durée manquantes ou nulles. ` +
        'Le proxy est peut-être tronqué — le refaire avec un run --force sur proxy.',
    )
  }

  // Même contrôle sur la source, pour une autre raison : ses dimensions sont
  // recopiées telles quelles dans `analysis.json`, où `SCHEMA_SIZE` les exige
  // positives. Un zéro qui passerait ici ferait échouer la validation **après**
  // les trois minutes de détection.
  const probeSource = await probe(o.source, undefined, o.signal)
  if (isAborted()) throw new StopRequestedError("l'analyse d'image")
  if (
    probeSource.width === null ||
    probeSource.height === null ||
    probeSource.width <= 0 ||
    probeSource.height <= 0
  ) {
    throw new Error(
      `ffprobe n'a rien su dire des dimensions de ${JSON.stringify(o.source)}. ` +
        "Elles sont recopiées dans analysis.json : sans elles, le rendu ne sait pas à quoi les fractions se rapportent.",
    )
  }

  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const temporary = pathTemporary(destination)

  const args = [
    // `-u` : sans lui, Python tamponne stderr et les étapes du worker
    // arriveraient toutes ensemble, à la fin.
    '-u',
    script,
    '--proxy', proxy,
    '--out', temporary,
    // `ffmpegBin()` et non `process.env.FFMPEG_BIN` relu ici : le binaire de
    // `setup.sh` se désigne d'un seul endroit, sinon un jour l'un des deux
    // apprend un repli que l'autre ignore.
    '--ffmpeg', ffmpegBin(),
    '--model', template,
    '--proxy-size', formatSize(probeProxy.width, probeProxy.height),
    '--source-size', formatSize(probeSource.width, probeSource.height),
    '--duration', String(probeProxy.durationSec),
    '--scene-threshold', String(o.sceneThreshold ?? THRESHOLD_SCENE),
  ]

  try {
    await launchWorker(python, args, environmentDetection(process.env), o.onLog, o.signal)
    // Valider **avant** le renommage : un JSON hors contrat ne doit jamais
    // porter le nom définitif, sans quoi le graphe par présence le sert comme
    // une analyse valide à toutes les relances suivantes.
    lireAnalysis(temporary)
    await fsp.rename(temporary, destination)
  } catch (cause) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw cause
  }

  return { path: destination, skipped: false }
}

/**
 * La commande, citée là où il le faut.
 *
 * **Un argument qui contient une espace se met entre guillemets**, et ce n'est
 * pas de la cosmétique de journal : c'est ce qui permet à `cleanPaths` de le
 * traiter d'un seul tenant. Sa passe sur les chemins nus s'arrête à la première
 * espace, faute de savoir où le chemin finit — donc un dépôt cloné sous
 * `/home/jean/Mon dossier` verrait la queue de son arborescence partir dans
 * `status.json`, puis dans la réponse de `GET /api/projects/:id`. Entre
 * guillemets, la passe `BETWEEN_QUOTES` prend le tout.
 *
 * Seuls les arguments à espace sont cités : une ligne de commande où chaque
 * jeton porte des guillemets ne se relit pas. (relevé par Copilot)
 */
export function commandReadable(python: string, args: readonly string[]): string {
  return [python, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')
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
 * Comme ceux de `runFfmpeg` et de `launchWorker` côté transcription, il est
 * destiné à un journal de serveur, pas à une réponse HTTP — `messageSafe` épure
 * ce qui part dans `status.json`.
 */
function launchWorker(
  python: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onLog?: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const log = createLog(40)

  return new Promise<void>((resolve, reject) => {
    // L'arrêt peut être arrivé pendant les deux `ffprobe` qui précèdent.
    if (signal?.aborted === true) {
      reject(new StopRequestedError("l'analyse d'image"))
      return
    }
    const proc = spawn(python, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const detach = forwardAbort(proc, signal)

    // Un découpage en lignes par flux : les deux arrivent par morceaux coupés
    // n'importe où, et un tampon partagé recollerait la fin de l'un au début de
    // l'autre.
    const relayer = (stream: NodeJS.ReadableStream, shouldLog: boolean): void => {
      stream.setEncoding('utf8')
      let remaining = ''
      const emit = (line: string): void => {
        if (onLog !== undefined && line.trim() !== '') onLog(line)
      }
      stream.on('data', (piece: string) => {
        if (shouldLog) log.add(piece)
        if (onLog === undefined) return
        // Découpage sur **CR comme LF** : les barres d'avancement d'ultralytics
        // se réécrivent derrière un `\r`, sans jamais de saut de ligne.
        const lines = (remaining + piece).split(/\r\n|[\r\n]/)
        remaining = lines.pop() ?? ''
        for (const line of lines) emit(line)
      })
      stream.on('end', () => {
        emit(remaining)
        remaining = ''
      })
    }

    relayer(proc.stderr, true)
    relayer(proc.stdout, false)

    proc.on('error', (cause) => {
      detach()
      // **Le code d'erreur, pas `cause.message`.** Node y écrit
      // `spawn <chemin> ENOENT`, avec le chemin **nu** : rien ne peut le citer
      // après coup, et l'épuration d'un chemin nu s'arrête à la première espace.
      // Un dépôt cloné sous `/home/jean/Mon dossier` publierait donc la queue de
      // son arborescence dans `status.json`. Le chemin est déjà là, cité, juste
      // avant — et `ENOENT` ou `EACCES` est tout ce que le message ajoutait.
      // L'erreur d'origine reste attachée en `cause` pour le journal du serveur.
      // (relevé par Copilot)
      const code = (cause as NodeJS.ErrnoException).code ?? 'échec au démarrage'
      reject(
        new Error(
          `Le worker de détection n'a pas pu démarrer (${JSON.stringify(python)}) : ${code}. ` +
            'Voir DETECT_PYTHON dans .env, et setup.sh.',
          { cause },
        ),
      )
    })

    proc.on('close', (code, exitSignal) => {
      detach()
      if (code === 0) {
        resolve()
        return
      }
      // Un arrêt demandé n'est pas un échec de l'analyse. Voir `runFfmpeg`.
      if (signal?.aborted === true) {
        reject(new StopRequestedError("l'analyse d'image"))
        return
      }
      const cause = exitSignal !== null ? `tué par ${exitSignal}` : `code de sortie ${code}`
      reject(
        new Error(
          [
            `L'analyse a échoué (${cause}).`,
            `Commande : ${commandReadable(python, args)}`,
            'Dernières lignes :',
            log.text() || '(stderr vide)',
          ].join('\n'),
        ),
      )
    })
  })
}
