import path from 'node:path'

import { messageÉpuré } from '@/core/erreurs'
import { projectsDir, replayDir, stageDir } from '@/server/paths'
import { corpsDeRéférence } from '@/server/secrets'

/**
 * L'épuration des messages, avec les racines de **cette** machine sous les yeux.
 *
 * `épurerChemins` vit dans `src/core/` et ne peut donc pas lire l'environnement
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
function racines(): string[] {
  const trouvées: string[] = []
  for (const lire of [replayDir, stageDir, projectsDir]) {
    try {
      trouvées.push(lire())
    } catch {
      // Variable absente : rien à retirer sous ce nom-là.
    }
  }

  // Les binaires nommés par l'environnement vivent ailleurs — un ffmpeg
  // compilé à la main, le venv du diariseur, celui de la détection — et
  // `runFfmpeg` comme `lancerWorker` les écrivent en tête de la commande qu'ils
  // citent. On retient leur **dossier**, pas le binaire : c'est ce qui sort
  // l'arborescence du message tout en gardant lisible le nom de l'outil qui a
  // échoué.
  //
  // Les trois `DETECT_*` sont là depuis l'itération 1. Les passes génériques
  // d'`épurerChemins` les attrapent déjà quand leur chemin n'a pas d'espace, ce
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
    const valeur = process.env[variable]
    // **Absolu, et pas la racine.** Un `FFMPEG_BIN=ffmpeg` donnerait `.` et un
    // `/ffmpeg` donnerait `/` : remplacer l'un ou l'autre partout dans un
    // message le rendrait illisible, pour ne rien protéger du tout.
    if (valeur === undefined || !path.isAbsolute(valeur)) continue
    const dossier = path.dirname(valeur)
    if (dossier !== '/' && dossier !== '.') trouvées.push(dossier)
  }

  // **Une référence de secret est une racine littérale comme une autre.**
  // `épurerChemins` sait caviarder `op://coffre/fiche/champ` par sa seule forme,
  // mais hors citation elle s'arrête au premier espace : la grammaire qui les
  // traversait avalait la prose derrière une référence incomplète — diagnostic
  // et remède compris — et elle a été retirée pour ça. Un coffre au nom espacé y
  // laissait donc sa queue.
  //
  // Ici, on ne devine pas où la référence finit : on la tient en entier. Son
  // **corps** part en racine, son préfixe reste lisible, et le résultat est la
  // forme que le caviardage produit partout ailleurs. (issue #49)
  //
  // Deux propriétés à ne pas perdre de vue :
  //
  // - **aucune valeur de secret n'entre là-dedans.** Seule une valeur qui *est*
  //   une référence est retenue, et une référence n'est pas une valeur — elle
  //   nomme le coffre, la fiche et le champ ;
  // - **le cas utile est celui de l'échec.** `résoudreSecrets` réécrit
  //   l'environnement une fois toutes ses lectures abouties : il lève donc en
  //   laissant les adresses en place, et c'est exactement là que les messages
  //   qui les citent sont produits.
  for (const valeur of Object.values(process.env)) {
    const corps = corpsDeRéférence(valeur)
    // **Un corps sans barre oblique ne fait pas une racine.** `op read` ne lit
    // que `<coffre>/<fiche>/<champ>` : un corps d'un seul segment ne nomme
    // qu'un coffre, il n'est lisible par personne, et c'est un mot que ce
    // remplacement littéral retirerait de **partout** dans le message — la
    // panne la plus bruyante qu'un caviardage puisse avoir, pour une référence
    // que la passe nue attrape déjà, faute d'espace où buter. Le préfixe seul
    // tombe sous la même condition : sa racine serait vide, et une racine vide
    // découpe le message entre chacun de ses caractères.
    if (corps === undefined || !corps.includes('/')) continue
    trouvées.push(corps)
  }

  return trouvées
}

/** Le message d'une erreur, sans un chemin de la machine dedans. */
export function messageSûr(erreur: unknown): string {
  return messageÉpuré(erreur, racines())
}
