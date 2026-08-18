import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { cheminTemporaire, créerJournal, type Artefact } from '@/server/ffmpeg'
import { placeSidecar } from '@/server/paths'

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
 * Les segments vides sont écartés, et ce n'est pas de la propreté : un
 * `LD_LIBRARY_PATH` qui se termine par `:` désigne le **dossier courant**, et
 * ferait chercher les bibliothèques du processus là où il a été lancé.
 *
 * Pure : l'environnement de départ est un argument.
 */
export function environnementWorker<T extends Record<string, string | undefined>>(o: {
  cudnn: readonly string[]
  base: T
}): T & { TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD: string; LD_LIBRARY_PATH: string } {
  const chemins = [...o.cudnn, o.base.LD_LIBRARY_PATH].filter(
    (c): c is string => typeof c === 'string' && c !== '',
  )
  // `Object.assign` et non un littéral en `...` : l'étalement d'un générique
  // perd l'intersection, et `process.env` porte des propriétés obligatoires
  // (Next y déclare `NODE_ENV`) que le type de retour doit conserver.
  return Object.assign({}, o.base, {
    TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD: '1',
    LD_LIBRARY_PATH: chemins.join(':'),
  })
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
  return process.env.WHISPER_WORKER ?? path.join(process.cwd(), 'worker', 'transcribe.py')
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
    await lancerWorker(python, args, env, o.onLog)
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
 */
function lancerWorker(
  python: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onLog?: (ligne: string) => void,
): Promise<void> {
  const journal = créerJournal(40)

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(python, args, { env, stdio: ['ignore', 'inherit', 'pipe'] })

    proc.stderr.setEncoding('utf8')
    let reste = ''
    proc.stderr.on('data', (morceau: string) => {
      journal.ajouter(morceau)
      if (onLog === undefined) return
      const lignes = (reste + morceau).split('\n')
      reste = lignes.pop() ?? ''
      for (const ligne of lignes) if (ligne.trim() !== '') onLog(ligne)
    })

    proc.on('error', (cause) => {
      reject(
        new Error(
          `Le worker de transcription n'a pas pu démarrer (${python}) : ${cause.message}. ` +
            'Voir WHISPER_PYTHON dans .env.',
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
