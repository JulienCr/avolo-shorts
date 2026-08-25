import path from 'node:path'

import { messageCleaned } from '@/core/errors'
import { projectsDir, replayDir, stageDir } from '@/server/paths'
import { referenceBody } from '@/server/secrets'

/**
 * L'épuration des messages, avec les racines de **cette** machine sous les yeux.
 *
 * `cleanPaths` vit dans `src/core/` et ne peut donc pas lire l'environnement
 * — c'est ce qui la rend testable. Or elle a besoin des racines de la machine pour
 * être exacte : un chemin nu se coupe au premier espace, et `REPLAY_DIR` vaut
 * littéralement `/mnt/j/Drive partagés/…`. Ce fichier-ci est le seul endroit qui
 * connaisse les deux — le calcul pur et la configuration.
 *
 * **Une racine non définie n'est pas une erreur ici.** `replayDir()` lève quand
 * `REPLAY_DIR` manque, et cette fonction est appelée précisément sur le chemin
 * d'échec : y relever une seconde erreur remplacerait le message qu'on essaie de
 * rendre lisible par un autre, moins utile.
 */
function roots(): string[] {
  const found: string[] = []
  for (const lire of [replayDir, stageDir, projectsDir]) {
    try {
      found.push(lire())
    } catch {
      // Variable absente : rien à retirer sous ce nom-là.
    }
  }

  // Les binaires nommés par l'environnement vivent ailleurs — un ffmpeg
  // compilé à la main, le venv du diariseur, celui de la détection — et
  // `runFfmpeg` comme `launchWorker` les écrivent en tête de la commande qu'ils
  // citent. On retient leur **dossier**, pas le binaire : c'est ce qui sort
  // l'arborescence du message tout en gardant lisible le nom de l'outil qui a
  // échoué.
  //
  // Les trois `DETECT_*` sont là depuis l'itération 1. Les passes génériques
  // d'`cleanPaths` les attrapent déjà quand leur chemin n'a pas d'espace, ce
  // qui est le cas courant ; mais le message d'un `spawn` en échec recopie le
  // chemin tel que **Node** l'écrit, sans guillemets, et cette forme-là se
  // couperait au premier espace. (relevé par Aristarque et Copilot)
  for (const variable of [
    'FFMPEG_BIN',
    'FFPROBE_BIN',
    'WHISPER_PYTHON',
    'WHISPER_WORKER',
    'DETECT_PYTHON',
    'DETECT_WORKER',
    'DETECT_MODEL',
  ]) {
    const value = process.env[variable]
    // **Absolu, et pas la racine.** Un `FFMPEG_BIN=ffmpeg` donnerait `.` et un
    // `/ffmpeg` donnerait `/` : remplacer l'un ou l'autre partout dans un
    // message le rendrait illisible, pour ne rien protéger du tout.
    if (value === undefined || !path.isAbsolute(value)) continue
    const folder = path.dirname(value)
    if (folder !== '/' && folder !== '.') found.push(folder)
  }

  return found
}

/**
 * Les références de secret que porte l'environnement, avec leur préfixe séparé,
 * de la plus longue à la plus courte.
 *
 * **L'ordre compte** : deux variables peuvent nommer le même coffre, l'une
 * s'arrêtant à la fiche et l'autre nommant le champ. Retirer la plus courte
 * d'abord laisserait la queue de la plus longue.
 *
 * **Le préfixe nu est écarté.** Il ne nomme ni coffre, ni fiche, ni champ : il
 * n'y a rien à en retirer, et un message qui le cite en toutes lettres —
 * `requireSecret` le fait — doit ressortir intact.
 */
function referencesKnown(): { reference: string; prefix: string }[] {
  const found: { reference: string; prefix: string }[] = []
  for (const value of Object.values(process.env)) {
    const body = referenceBody(value)
    if (value === undefined || body === undefined || body === '') continue
    found.push({ reference: value, prefix: value.slice(0, value.length - body.length) })
  }
  return found.sort((a, b) => b.reference.length - a.reference.length)
}

/**
 * Les références de secret de l'environnement, retirées d'un message **par leur
 * forme complète**.
 *
 * `cleanPaths` sait déjà caviarder `op://coffre/fiche/champ` par sa seule
 * forme, mais hors citation elle s'arrête au premier espace : la grammaire qui
 * les traversait avalait la prose derrière une référence incomplète —
 * diagnostic et remède compris — et elle a été retirée pour ça. Un coffre au
 * nom espacé y laissait donc sa queue.
 *
 * Ici, on ne devine pas où la référence finit : on la tient en entier. D'où le
 * remplacement littéral, et d'où sa place **avant** `cleanPaths`, dont la
 * grammaire couperait la référence avant qu'on ait pu la reconnaître.
 *
 * **C'est la forme complète qui est retirée, préfixe compris, et le préfixe est
 * remis derrière.** Le corps seul ne ferait pas une clé de recherche : un
 * `op://team/project/status` transformerait tout message contenant
 * `team/project/status` — un chemin relatif, une phrase — en `…`, et détruirait
 * le diagnostic pour rien. Le préfixe remis est ce que le caviardage laisse
 * partout ailleurs : il dit que la variable portait une **adresse** et non une
 * valeur littérale, seule question qu'on se pose devant un secret qui n'a pas
 * marché. (relevé par Codex, issue #49)
 *
 * **Aucune valeur de secret n'entre là-dedans** : seule une valeur qui *est*
 * une référence est retenue, et une référence n'est pas une valeur — elle nomme
 * le coffre, la fiche et le champ. Le cas utile est d'ailleurs celui de
 * l'échec : `resolveSecrets` ne réécrit l'environnement qu'une fois toutes ses
 * lectures abouties, donc il lève en laissant les adresses en place, et c'est
 * exactement là que les messages qui les citent sont produits.
 */
function redactReferencesKnown(message: string): string {
  let output = message
  for (const { reference, prefix } of referencesKnown()) {
    output = output.split(reference).join(`${prefix}…`)
  }
  return output
}

/** Le message d'une erreur, sans un chemin de la machine dedans. */
export function messageSafe(error: unknown): string {
  // Le texte est pris ici plutôt que laissé à `messageCleaned` parce que les
  // références doivent partir **avant** la grammaire d'`cleanPaths`, qui les
  // couperait au premier espace. `messageCleaned` repasse ensuite une chaîne, ce
  // qui ne lui coûte rien.
  const raw = error instanceof Error ? error.message : String(error)
  return messageCleaned(redactReferencesKnown(raw), roots())
}
