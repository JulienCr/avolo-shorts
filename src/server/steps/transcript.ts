import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  StopRequestedError,
  cheminTemporaire,
  créerJournal,
  forwardAbort,
  type Artefact,
} from '@/server/ffmpeg'
import {
  applyWordCorrection,
  wordsToText,
  type CorrectionRefusal,
  type TranscriptLine,
  type WordCorrection,
} from '@/lib/editing'
import type { Project } from '@/server/db'
import { placeSidecar, resolveSource } from '@/server/paths'
import { montageRépond } from '@/server/steps/ingest'
import { lireTranscript, type TranscriptLu } from '@/server/steps/candidates'

/**
 * La transcription : WhisperX en sous-processus, et le résultat dans le sidecar.
 *
 * Trois points portent cette étape, et chacun a un coût si on le rate.
 *
 * **1. Le sidecar se lit et s'écrit par `placeSidecar`, jamais par
 * `transcriptPath` seul.** `transcriptPath` rend le chemin *voulu*, à côté de
 * l'original ; il ignore le repli dans le projet. Un
 * `existsSync(transcriptPath(...))` raterait donc un transcript rangé dans le
 * repli et retranscrirait l'émission entière — vingt-cinq minutes de GPU pour
 * réécrire un fichier déjà là.
 *
 * **2. Le sous-processus doit se terminer, et on l'attend.** La sortie du
 * processus est la seule garantie dure que la VRAM est rendue : `empty_cache()`
 * ne suffit pas avec CTranslate2. L'itération 0 n'enchaîne rien d'autre sur le
 * GPU — la correction du transcript par Ollama, qui ne tiendrait pas à côté de
 * `large-v3` sur 24 Go, est en itération 3 —, mais la structure doit être juste
 * dès maintenant.
 *
 * **3. Deux variables d'environnement, sans lesquelles rien ne démarre.** C'est
 * le correctif que `run-wsl.sh` du diariseur applique, et il n'est pas
 * facultatif.
 */

/** Le venv, déduit du chemin de son interpréteur : `<venv>/bin/python`. */
export function racineVenv(python: string): string {
  return path.dirname(path.dirname(python))
}

/**
 * Où pip range cuDNN dans un venv : `<venv>/lib/pythonX.Y/site-packages/nvidia/cudnn/lib`.
 *
 * **La version de Python n'est pas codée en dur.** `run-wsl.sh` écrit `3.10`
 * parce que c'est celle de sa machine ; ici on lit ce que le venv contient. Un
 * venv reconstruit en 3.11 ferait sinon échouer le chargement du modèle sur une
 * bibliothèque introuvable — un message qui ne nomme ni Python, ni sa version,
 * ni le venv.
 *
 * Pure : le contenu de `<venv>/lib` est passé en argument. Plusieurs entrées si
 * plusieurs versions cohabitent — `LD_LIBRARY_PATH` en accepte autant qu'on veut,
 * et deviner laquelle est la bonne coûterait plus que les toutes lister.
 */
export function cheminsCudnn(venvRoot: string, dossiersLib: readonly string[]): string[] {
  const versions = dossiersLib.filter((d) => /^python\d+\.\d+$/.test(d)).sort()
  // Aucun dossier lisible : on retombe sur ce qu'écrit `run-wsl.sh`. Un chemin
  // qui n'existe pas dans `LD_LIBRARY_PATH` est ignoré par l'éditeur de liens,
  // donc c'est une supposition sans risque — et si elle est bonne, elle sauve.
  const noms = versions.length > 0 ? versions : ['python3.10']
  return noms.map((v) => path.join(venvRoot, 'lib', v, 'site-packages', 'nvidia', 'cudnn', 'lib'))
}

/**
 * L'environnement du sous-processus.
 *
 * - `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1` : depuis PyTorch 2.6, `torch.load`
 *   refuse par défaut les points de contrôle qui portent des classes de
 *   bibliothèque, ce que sont ceux de WhisperX.
 * - `LD_LIBRARY_PATH` : CTranslate2 charge cuDNN par le chargeur dynamique, qui
 *   ne connaît rien aux paquets pip. Sans ce chemin, le modèle ne se charge pas.
 *
 * **Le reste de l'environnement est reconstruit depuis une liste blanche** —
 * voir `TRANSMISES` plus bas. Le worker de transcription n'a besoin d'aucun
 * secret.
 *
 * **Le chemin hérité est redécoupé avant d'être filtré**, et ce n'est pas de la
 * propreté : un segment vide dans `LD_LIBRARY_PATH` désigne le **dossier
 * courant**, donc ferait chercher les bibliothèques du processus là où il a été
 * lancé — un dossier que n'importe qui peut garnir. La première version ne
 * regardait que la valeur héritée *entière* : `/usr/lib:` la traversait sans
 * encombre et ressortait telle quelle, avec son segment vide, alors même que ce
 * commentaire annonçait le contraire. (relevé par Copilot)
 *
 * Pure : l'environnement de départ est un argument.
 */
export function environnementWorker(o: {
  cudnn: readonly string[]
  base: Record<string, string | undefined>
}): NodeJS.ProcessEnv {
  const hérité = (o.base.LD_LIBRARY_PATH ?? '').split(':')
  const chemins = [...o.cudnn, ...hérité].filter((c) => c !== '')

  // `as NodeJS.ProcessEnv` sur l'accumulateur, et c'est la seule assertion du
  // fichier : Next déclare `NODE_ENV` **obligatoire** sur ce type, or un
  // environnement reconstruit ne peut pas prouver structurellement qu'il le
  // porte. Il le porte — la liste blanche le nomme — mais cela se voit à
  // l'exécution, pas à la compilation.
  const transmis = {} as NodeJS.ProcessEnv
  for (const nom of TRANSMISES) {
    const valeur = o.base[nom]
    if (valeur === undefined) continue
    transmis[nom] = MANDATAIRES.has(nom) ? épurerMandataire(valeur) : valeur
  }
  transmis.TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD = '1'
  transmis.LD_LIBRARY_PATH = chemins.join(':')
  return transmis
}

/**
 * Les seules variables qui franchissent la frontière de processus. **Une liste
 * blanche, et c'est le point.**
 *
 * Le worker héritait de tout `process.env`, donc de `GEMINI_API_KEY` — une clé
 * qui n'a rien à faire dans un processus de transcription. Le chemin de fuite
 * n'est pas théorique : le stderr du worker est capturé et remonté par `onLog`,
 * que `dev-transcribe` écrit sur la sortie standard et que la tâche 10 exposera
 * à un client HTTP. Il suffit qu'une bibliothèque Python vide son environnement
 * dans une trace pour que la clé parte avec. (relevé par Aristarque)
 *
 * La première version filtrait par motif — `KEY`, `TOKEN`, `SECRET`… — et une
 * liste noire de secrets ne peut pas être complète : `DATABASE_URL` et
 * `REDIS_URL` portent couramment un mot de passe dans leur autorité et ne
 * ressemblent à aucun de ces mots. C'est la même leçon que la frontière de
 * pureté d'ESLint, énoncée à l'envers après cinq passes de review : on nomme ce
 * qui passe, pas ce qui ne passe pas. Le coût est qu'il faut ajouter une ligne
 * ici le jour où le worker a besoin d'autre chose — et c'est très bien, cela
 * doit être une décision. (relevé par Copilot)
 *
 * `HF_TOKEN` n'y est pas, et c'est cohérent : sans diarisation, il n'est jamais
 * demandé.
 */
const TRANSMISES: readonly string[] = [
  // Le strict nécessaire pour qu'un processus tourne.
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  // Où Hugging Face, Torch et XDG rangent leurs poids. Les omettre ferait
  // retélécharger huit gigaoctets de modèles dans un dossier par défaut.
  'HF_HOME',
  'HF_HUB_CACHE',
  'HUGGINGFACE_HUB_CACHE',
  'TRANSFORMERS_CACHE',
  'TORCH_HOME',
  'XDG_CACHE_HOME',
  // Le GPU.
  'CUDA_VISIBLE_DEVICES',
  'CUDA_HOME',
  'NVIDIA_VISIBLE_DEVICES',
  // Le réseau, si le premier lancement doit aller chercher un modèle. Les URLs
  // de mandataire passent par `épurerMandataire` — voir juste en dessous.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]

/** Celles de `TRANSMISES` dont la valeur est une URL, donc peut porter un secret. */
const MANDATAIRES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'])

/**
 * Retire les identifiants d'une URL de mandataire.
 *
 * La liste blanche ferme la porte à `GEMINI_API_KEY` et à `DATABASE_URL`, mais
 * `HTTP_PROXY` la contournait : `http://utilisateur:motdepasse@mandataire:3128`
 * est une forme courante, et le mot de passe partait dans l'environnement d'un
 * processus dont les deux sorties sont capturées puis remontées par `onLog`.
 * Nommer une variable dans une liste blanche dit qu'on veut *ce réglage*, pas
 * qu'on veut le secret qui voyage avec. (relevé par Aristarque)
 *
 * `NO_PROXY` n'y passe pas : c'est une liste d'hôtes, pas une URL, et elle ne
 * porte pas d'autorité.
 */
export function épurerMandataire(valeur: string): string {
  try {
    const url = new URL(valeur)
    if (url.username !== '' || url.password !== '') {
      url.username = ''
      url.password = ''
      return url.toString()
    }
    // Une autorité analysée et sans identifiants : rien à retirer, et on rend la
    // valeur telle quelle plutôt que la forme normalisée par `URL`.
    //
    // **Le contrôle sur `host` n'est pas décoratif.** `new URL` ne lève pas sur
    // `utilisateur:motdepasse@hôte:3128` : il y lit `utilisateur:` comme un
    // schéma et le reste comme un chemin opaque, si bien que `username` et
    // `password` sont vides et que les identifiants passeraient intacts. Un
    // `host` vide signale exactement ce cas, et renvoie au découpage brut.
    if (url.host !== '') return valeur
  } catch {
    // Pas une URL du tout — `NO_PROXY` et ses listes d'hôtes tombent ici.
  }
  // La forme sans schéma porte le même secret. Tout ce qui précède l'arobase
  // tombe ; en son absence il n'y a rien à retirer.
  const arobase = valeur.lastIndexOf('@')
  return arobase === -1 ? valeur : valeur.slice(arobase + 1)
}

/** Le contenu de `<venv>/lib`, ou rien si le dossier n'existe pas. */
function dossiersLib(venvRoot: string): string[] {
  try {
    return fs.readdirSync(path.join(venvRoot, 'lib'))
  } catch {
    return []
  }
}

/**
 * L'interpréteur du venv. **Obligatoire, et sans repli.**
 *
 * Un `python3` de système ferait retélécharger huit gigaoctets de modèles pour
 * les ranger ailleurs, ou échouerait sur un `ModuleNotFoundError` trois minutes
 * plus tard. La variable est dans `.env.example` ; l'absence se signale tout de
 * suite.
 */
function pythonWorker(): string {
  const python = process.env.WHISPER_PYTHON
  if (!python) {
    throw new Error(
      "WHISPER_PYTHON n'est pas définie. Voir .env.example — elle pointe l'interpréteur du venv " +
        'de ~/dev/rythmo-impro/diarizer, réutilisé tel quel (worker/requirements.txt explique ' +
        "comment en monter un si ce venv n'existe pas).",
    )
  }
  return python
}

/**
 * Le script Python. `process.cwd()` par défaut — la racine du dépôt sous Next
 * comme sous `tsx` —, et `WHISPER_WORKER` pour tout le reste.
 */
function scriptWorker(): string {
  // `||` et non `??`, comme pour `WHISPER_MODEL` : une variable posée mais vide
  // — ce qu'un `.env` produit facilement — désactiverait le défaut, et
  // l'`existsSync('')` qui suit ferait échouer l'étape alors que le worker est
  // là où il a toujours été. (relevé par Copilot)
  return process.env.WHISPER_WORKER || path.join(process.cwd(), 'worker', 'transcribe.py')
}

export type OptionsTranscript = {
  /**
   * L'original sur `REPLAY_DIR`. C'est **lui** qui décide où va le sidecar, pas
   * la copie de travail : le transcript est une propriété de la vidéo et doit
   * lui survivre.
   */
  source: string
  projectId: string
  /** Le WAV 16 kHz mono produit par l'étape audio. */
  audio: string
  force?: boolean
  model?: string
  language?: string
  /** Les lignes que le worker écrit sur stderr, au fil de l'eau. */
  onLog?: (ligne: string) => void
  /**
   * L'arrêt demandé (`POST /api/projects/:id/stop`).
   *
   * **C'est l'étape où il compte le plus, et celle où il coûte le plus cher à
   * rater.** WhisperX tient le GPU, et un processus laissé derrière soi garde la
   * VRAM : la reprise démarrerait à côté de lui. `forwardAbort` lui laisse dix
   * secondes après le `SIGTERM` — CTranslate2 ne rend pas la main tout de suite.
   */
  signal?: AbortSignal
}

export type Transcription = Artefact & {
  /**
   * Vrai quand le sidecar a dû se rabattre dans le projet, le Drive n'étant pas
   * inscriptible. Pas une erreur : seulement moins de réutilisation (spec §5).
   */
  fallback: boolean
}

/**
 * Transcrit, ou ne fait rien si le transcript est déjà là.
 *
 * Le worker écrit sous un nom temporaire, renommé une fois seulement : un
 * processus tué à la vingtième minute laisserait sinon un JSON tronqué sous le
 * nom définitif, que la relance suivante prendrait pour un transcript valide.
 */
export async function transcribe(o: OptionsTranscript): Promise<Transcription> {
  // **Avant de laisser `placeSidecar` toucher le Drive.** Il y fait plusieurs
  // appels *synchrones* — `existsSync`, `mkdirSync`, `writeFileSync` — et sur un
  // montage 9p au transport mort, un appel synchrone ne bloque pas un fil du
  // vivier comme le ferait `fsp.stat` : il gèle la boucle d'événements entière,
  // donc tout le serveur, et jamais il ne se rabat.
  //
  // On échoue plutôt que de se rabattre, et c'est le seul choix honnête :
  // « le Drive ne répond pas » n'est pas « le Drive est en lecture seule ». Le
  // repli existe pour le second cas, où le montage répond — un `EACCES` est une
  // réponse, et `placeSidecar` le traite très bien. (relevé par Copilot et
  // Aristarque)
  //
  // Le sondage porte sur **le fichier source**, pas sur son dossier : le mode de
  // panne visé laisse justement le dossier répondre — son entrée est en cache —
  // pendant que l'accès au contenu se bloque. Sonder le dossier rendrait `true`
  // et la garde ne servirait à rien. C'est le chemin que sonde l'ingestion.
  // (relevé par Copilot)
  if (!(await montageRépond(resolveSource(o.source)))) {
    throw new Error(
      'Le dossier des replays ne répond pas : impossible de décider où va le sidecar. ' +
        'REPLAY_DIR est monté en 9p et peut être monté avec son transport mort dessous — ' +
        '/proc/mounts ne le distingue pas. Rouvrir le lecteur côté Windows, ou remonter le partage.',
    )
  }

  const placement = placeSidecar(o.source, o.projectId)

  if (o.force !== true && fs.existsSync(placement.transcript)) {
    return { path: placement.transcript, skipped: true, fallback: placement.fallback }
  }

  if (!fs.existsSync(o.audio)) {
    throw new Error(
      `L'audio ${JSON.stringify(o.audio)} n'existe pas. La transcription vient après l'étape audio.`,
    )
  }

  const python = pythonWorker()
  const script = scriptWorker()
  if (!fs.existsSync(script)) {
    throw new Error(
      `Le worker ${JSON.stringify(script)} est introuvable. Lancer depuis la racine du dépôt, ` +
        'ou pointer WHISPER_WORKER dessus.',
    )
  }

  const venv = racineVenv(python)
  const env = environnementWorker({ cudnn: cheminsCudnn(venv, dossiersLib(venv)), base: process.env })
  const temporaire = cheminTemporaire(placement.transcript)

  const args = [
    // `-u` : sans lui, Python tamponne stderr et les quatre étapes du worker
    // arriveraient toutes ensemble, à la fin.
    '-u',
    script,
    '--audio', o.audio,
    '--out', temporaire,
    // `||` et non `??` : une variable posée mais vide — ce qu'un `.env` produit
    // facilement — donnerait `--model ''`, que WhisperX chercherait sur le Hub.
    '--model', o.model ?? (process.env.WHISPER_MODEL || 'large-v3'),
    '--language', o.language ?? 'fr',
  ]

  try {
    await lancerWorker(python, args, env, o.onLog, o.signal)
    await fsp.rename(temporaire, placement.transcript)
  } catch (cause) {
    await fsp.rm(temporaire, { force: true }).catch(() => {})
    throw cause
  }

  return { path: placement.transcript, skipped: false, fallback: placement.fallback }
}

/**
 * Lance le worker et **attend sa sortie**.
 *
 * `close` et non `exit` : `exit` part dès que le processus meurt, `close` attend
 * que ses flux soient vidés. Sur un échec, la différence est précisément les
 * dernières lignes de la trace Python — celles qui disent pourquoi.
 *
 * **Le message d'échec porte la commande complète**, donc les chemins du venv et
 * de l'audio. Comme ceux de `runFfmpeg` et de `statAvecDélai`, il est destiné à
 * un journal de serveur, pas à une réponse HTTP. (relevé par Aristarque)
 *
 * **Les deux sorties sont capturées, aucune n'est héritée.** Le worker écrit son
 * avancement sur stderr, mais ses dépendances — WhisperX, Lightning, pyannote —
 * écrivent sur stdout par le module `logging`, sans rien demander à personne.
 * Hérité, tout cela irait se mêler à la sortie du serveur quand la tâche 10
 * branchera cette étape derrière l'API. Capturé, tout passe par `onLog`, qui
 * décide. (relevé par Aristarque)
 */
function lancerWorker(
  python: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onLog?: (ligne: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const journal = créerJournal(40)

  return new Promise<void>((resolve, reject) => {
    // L'arrêt peut être arrivé pendant le sondage du montage, qui attend
    // jusqu'à vingt secondes juste au-dessus.
    if (signal?.aborted === true) {
      reject(new StopRequestedError('la transcription'))
      return
    }
    const proc = spawn(python, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const detach = forwardAbort(proc, signal)

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
        // Découpage sur **CR comme LF** : les barres d'avancement de `tqdm` et
        // consorts se réécrivent derrière un `\r`, sans jamais de saut de ligne.
        // Avec un découpage sur `\n` seul, elles s'accumulaient dans `reste`
        // pendant tout le traitement sans qu'une ligne ne sorte. (relevé par
        // Copilot)
        const lignes = (reste + morceau).split(/\r\n|[\r\n]/)
        reste = lignes.pop() ?? ''
        for (const ligne of lignes) émettre(ligne)
      })
      // La dernière ligne d'un flux qui se ferme sans séparateur — souvent le
      // message qui explique l'échec.
      flux.on('end', () => {
        émettre(reste)
        reste = ''
      })
    }

    // Seul stderr nourrit le carnet d'erreur : c'est là que Python écrit sa
    // trace, et stdout n'y ajouterait que du bruit de bibliothèque.
    relayer(proc.stderr, true)
    relayer(proc.stdout, false)

    proc.on('error', (cause) => {
      detach()
      reject(
        new Error(
          `Le worker de transcription n'a pas pu démarrer (${python}) : ${cause.message}. ` +
            'Voir WHISPER_PYTHON dans .env.',
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
      // Un arrêt demandé n'est pas un échec de la transcription. Voir `runFfmpeg`.
      if (signal?.aborted === true) {
        reject(new StopRequestedError('la transcription'))
        return
      }
      const cause = exitSignal !== null ? `tué par ${exitSignal}` : `code de sortie ${code}`
      reject(
        new Error(
          [
            `La transcription a échoué (${cause}).`,
            `Commande : ${python} ${args.join(' ')}`,
            'Dernières lignes :',
            journal.texte() || '(stderr vide)',
          ].join('\n'),
        ),
      )
    })
  })
}

// ---------------------------------------------------------------------------
// La correction manuelle
// ---------------------------------------------------------------------------

/** Pourquoi une correction n'a pas été écrite. */
export type TranscriptCorrectionRefusal = 'no-transcript' | 'unknown-line' | CorrectionRefusal

export type TranscriptCorrectionOutcome =
  | { ok: true; line: TranscriptLine }
  | { ok: false; reason: TranscriptCorrectionRefusal }

/**
 * L'index de segment qu'un `lineId` porte, ou `null` s'il n'a pas cette forme.
 *
 * **`lignesDuTranscript` (`src/server/vues.ts`) écrit `l${i}`, `i` étant
 * l'index dans `transcript.segments`** — y compris pour les segments qu'elle
 * filtre ensuite parce qu'ils n'ont aucun mot aligné. C'est ce qui rend
 * l'identifiant stable : il désigne une position dans le fichier, pas une
 * position dans la liste affichée.
 */
function lineIndex(lineId: string): number | null {
  const trouvé = /^l(\d+)$/.exec(lineId)
  return trouvé === null ? null : Number(trouvé[1])
}

/**
 * Corrige une phrase du transcript, sur le disque.
 *
 * **Bornée à un segment, jamais à tout le transcript.** L'appelant nomme la
 * phrase (`lineId`) et l'empan à l'intérieur (`from`/`to` dans
 * `WordCorrection`) ; cette fonction ne réécrit que les mots de ce segment,
 * jamais les autres, et ne touche jamais à `start`/`end` du segment lui-même —
 * l'empan que le remplacement occupe est toujours un sous-ensemble de l'empan
 * qu'occupaient les mots retirés, donc l'enveloppe temporelle de la phrase ne
 * bouge pas. C'est ce qui garde intactes les timings de tout ce qui n'est pas
 * corrigé : les phrases voisines, et les bornes des clips qui recouvrent
 * celle-ci.
 *
 * **Le fichier entier est réécrit**, comme `candidates.json` ou l'empreinte de
 * rendu le sont déjà ailleurs dans ce dépôt : il n'y a pas de format qui
 * permette une écriture partielle d'un JSON, et une correction ne porte de
 * toute façon que sur quelques mots — le coût est le même pour l'un ou pour
 * cent.
 *
 * **Elle se relit après écriture, elle ne déduit rien du succès du
 * renommage.** `CLAUDE.md` documente le piège : un remplacement qui ne trouve
 * pas son motif réussit en silence. Le renommage peut réussir sur un disque
 * dont l'écriture précédente a été tronquée par un incident du montage ; se
 * relire est la seule façon de le savoir plutôt que de le supposer.
 */
export async function correctTranscript(
  project: Project,
  lineId: string,
  correction: WordCorrection,
): Promise<TranscriptCorrectionOutcome> {
  // Même garde que `transcribe()`, et pour la même raison : `placeSidecar`
  // fait des appels *synchrones* sur le Drive, qui gèlent la boucle
  // d'événements entière — donc tout le serveur — si son transport est mort.
  if (!(await montageRépond(resolveSource(project.sourcePath)))) {
    throw new Error(
      'Le dossier des replays ne répond pas : impossible de lire ni écrire le sidecar. ' +
        'REPLAY_DIR est monté en 9p et peut être monté avec son transport mort dessous — ' +
        '/proc/mounts ne le distingue pas. Rouvrir le lecteur côté Windows, ou remonter le partage.',
    )
  }

  const placement = placeSidecar(project.sourcePath, project.id)
  if (!fs.existsSync(placement.transcript)) return { ok: false, reason: 'no-transcript' }

  const transcript = lireTranscript(placement.transcript)
  const index = lineIndex(lineId)
  if (index === null || index < 0 || index >= transcript.segments.length) {
    return { ok: false, reason: 'unknown-line' }
  }

  const segment = transcript.segments[index]
  const outcome = applyWordCorrection(segment.words, correction)
  if (!outcome.ok) return outcome

  const nextSegment = { ...segment, words: outcome.words, text: wordsToText(outcome.words) }
  const nextTranscript: TranscriptLu = {
    language: transcript.language,
    segments: transcript.segments.map((s, i) => (i === index ? nextSegment : s)),
  }

  const temporaire = cheminTemporaire(placement.transcript)
  await fsp.writeFile(temporaire, `${JSON.stringify(nextTranscript, null, 2)}\n`, 'utf8')
  await fsp.rename(temporaire, placement.transcript)

  const relu = lireTranscript(placement.transcript)
  const relûSegment = relu.segments[index]
  const relectureIdentique =
    relûSegment !== undefined &&
    relûSegment.words.length === nextSegment.words.length &&
    relûSegment.words.every(
      (w, i) =>
        w.word === nextSegment.words[i].word &&
        w.start === nextSegment.words[i].start &&
        w.end === nextSegment.words[i].end,
    )
  if (!relectureIdentique) {
    throw new Error(
      `La correction écrite dans ${JSON.stringify(path.basename(placement.transcript))} ne se relit pas ` +
        'telle quelle : rien ne certifie que le sidecar porte le texte corrigé.',
    )
  }

  return {
    ok: true,
    line: { id: lineId, start: nextSegment.start, end: nextSegment.end, words: nextSegment.words },
  }
}
