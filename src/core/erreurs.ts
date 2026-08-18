/**
 * Ce qui sort d'une erreur, et ce qui n'en sort pas.
 *
 * Trois producteurs d'erreurs du serveur — `runFfmpeg`, `statAvecDélai` et
 * `lancerWorker` — écrivent **la commande complète** dans leur message, chemins
 * absolus compris. Chacun le documente : « destiné à un journal de serveur, pas
 * à une réponse HTTP ». Rien ne l'appliquait, et un `ffmpeg a échoué` renvoyé
 * tel quel publiait le point de montage du Drive partagé, l'arborescence de la
 * machine et le nom du venv à qui demandait.
 *
 * D'où cette fonction, appelée à la frontière HTTP (`src/server/http.ts`). Le
 * message entier va au journal, sa version épurée part dans la réponse. Elle
 * vit dans `src/core/` parce qu'elle ne fait que du texte : elle n'a besoin ni
 * de connaître les vrais chemins de la machine ni de lire l'environnement, ce
 * qui la rend testable en CI et vraie pour un chemin qu'on n'a pas prévu.
 */

/**
 * Le dernier segment d'un chemin, précédé d'une ellipse.
 *
 * On garde le nom du fichier, et c'est délibéré : `…/proxy.mp4` dit ce qui a
 * échoué, `[chemin]` ne dit rien. Le nom de fichier d'un artefact du projet est
 * su de l'appelant — c'est lui qui a nommé le projet —, l'arborescence non.
 */
function abréger(chemin: string): string {
  const segments = chemin.split(/[\\/]+/).filter((s) => s !== '')
  const nom = segments[segments.length - 1]
  return nom === undefined ? '…' : `…/${nom}`
}

function estAbsolu(valeur: string): boolean {
  return valeur.startsWith('/') || /^[A-Za-z]:[\\/]/.test(valeur)
}

/**
 * Une chaîne entre guillemets. **Traitée en premier**, parce que c'est la seule
 * forme qui peut contenir des espaces : `REPLAY_DIR` pointe sur
 * `/mnt/j/Drive partagés/…` et `statAvecDélai` le rend en `JSON.stringify`.
 * Sans cette passe, la coupure au premier espace laisserait la moitié du chemin.
 */
const ENTRE_GUILLEMETS = /"[^"\n]*"/g

/**
 * Un chemin POSIX nu. Le contexte de gauche exclut ce qui n'est pas un début de
 * chemin : `https://…` (le `:` puis le `/`), un chemin déjà abrégé (`…`), et la
 * suite d'un chemin qu'on vient de couper.
 */
const POSIX_NU = /(?<![\w:.~…/\\-])\/[^\s"'\\]+(?:\/[^\s"'\\]*)*/g

/** `C:\Users\…` et ses variantes à barre oblique. */
const WINDOWS_NU = /(?<![\w:.~…/\\-])[A-Za-z]:[\\/][^\s"']*/g

/**
 * Remplace tout chemin absolu par `…/<nom de fichier>`.
 *
 * **`racines` est ce qui rend l'épuration exacte, et son absence ce qui la rend
 * approximative.** Un chemin nu se coupe au premier espace, faute de savoir où
 * il se termine — et `REPLAY_DIR` vaut littéralement
 * `/mnt/j/Drive partagés/Avolo/…`. Sur un message où `runFfmpeg` a joint son
 * argv par des espaces, la passe générique laissait donc la queue du chemin :
 * l'organisation interne du Drive partagé sortait quand même, un cran plus
 * loin. (relevé par Codex)
 *
 * Une racine connue, elle, se remplace **littéralement**, espaces compris, et
 * ce qui reste derrière est le chemin *relatif* à cette racine — un nom de
 * fichier de replay, ou `<projet>/renders/<clip>.mp4`. C'est-à-dire ce que
 * l'appelant a lui-même nommé, et rien de l'arborescence de la machine.
 *
 * Ce qui n'est pas un chemin absolu passe intact : les messages du projet sont
 * écrits pour être lus, et ce sont eux qui disent quoi faire.
 */
export function épurerChemins(message: string, racines: readonly string[] = []): string {
  let sortie = message
  // Les plus longues d'abord : `STAGE_DIR` peut être sous `PROJECTS_DIR`, et
  // remplacer le parent en premier laisserait l'enfant à moitié épuré.
  for (const racine of [...racines].filter((r) => r !== '').sort((a, b) => b.length - a.length)) {
    // `split`/`join` plutôt qu'une expression régulière : une racine est du
    // texte venu de l'environnement, et l'échapper pour un moteur d'expressions
    // est une occasion d'erreur que ce remplacement littéral n'a pas.
    sortie = sortie.split(racine).join('…')
  }

  return sortie
    .replace(ENTRE_GUILLEMETS, (brut) => {
      const dedans = brut.slice(1, -1)
      return estAbsolu(dedans) ? `"${abréger(dedans)}"` : brut
    })
    .replace(POSIX_NU, abréger)
    .replace(WINDOWS_NU, abréger)
}

/**
 * Le message d'une erreur, épuré. Une valeur qui n'est pas une `Error` est
 * rendue en texte plutôt qu'en `[object Object]`.
 */
export function messageÉpuré(erreur: unknown, racines: readonly string[] = []): string {
  return épurerChemins(erreur instanceof Error ? erreur.message : String(erreur), racines)
}
