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

/** Le préfixe d'une adresse de secret 1Password, `estRéférence` en est la source. */
const PRÉFIXE_DE_RÉFÉRENCE = 'op://'

/**
 * Une référence de secret — `op://<coffre>/<fiche>/<champ>`.
 *
 * **Ce n'est pas un secret** : une adresse n'est pas une valeur, et la lire ne
 * donne accès à rien sans le coffre déverrouillé. Mais elle nomme le coffre, la
 * fiche et le champ, et un message servi par l'API se lit dans un navigateur, un
 * journal partagé ou une capture d'écran : c'est de la structure interne qui n'a
 * aucune raison d'en sortir.
 *
 * **Ce qui reste lisible est le préfixe, et lui seul.** Un chemin garde son nom
 * de fichier parce que l'appelant l'a nommé lui-même ; une référence n'a pas
 * d'équivalent à garder. Ce qui dit quoi réparer est le **nom de la variable** —
 * il vit dans `.env.example`, donc au grand jour, et il accompagne déjà la
 * référence dans les messages qui la citent. Le champ, lui, recopie ce nom quand
 * la convention du `.env` est suivie, et nomme le coffre quand elle ne l'est
 * pas : redondant ou fuitant, jamais utile. Reste `op://`, qui dit ce qu'un
 * `[caviardé]` tairait — que la variable porte une **adresse** et non une valeur
 * littérale, seule question qu'on se pose devant un secret qui n'a pas marché.
 *
 * Le préfixe est celui d'`estRéférence` (`src/server/secrets.ts`), qui définit
 * seul ce que ce projet appelle une référence, et qui n'en accepte aujourd'hui
 * pas d'autre forme. Le module est pur et ne peut pas l'importer : si le projet
 * gagnait une seconde forme, les deux se suivraient à la main.
 *
 * Deux détails de la forme, qui décident de ce que le message vaut encore :
 *
 * - **le dernier caractère n'est jamais une ponctuation** : une référence finit
 *   souvent une phrase, et emporter le point ferait passer le message pour
 *   tronqué ;
 * - **un `op://` nu ne nomme rien**, donc il ressort tel quel — y compris quand
 *   un message cite la forme au lieu d'une référence, comme le fait
 *   `exigerSecret`.
 *
 * Le contexte de gauche ne protège qu'un **mot** — sans lui, un schéma comme
 * `desktop://` sortirait coupé en deux. Il ne protège rien d'autre : tout ce qui
 * n'est pas un mot peut précéder une référence, et une référence qu'on ne
 * caviarde pas coûte plus cher qu'un mot rare qu'on abîme.
 *
 * Hors guillemets, la référence s'arrête au premier espace, comme un chemin nu
 * et pour la même raison : rien ne dit où elle finit. Un nom de coffre espacé y
 * laisserait donc sa queue — d'où la passe entre guillemets ci-dessous.
 */
const RÉFÉRENCE_DE_SECRET = /(?<!\w)op:\/\/[^\s"'\\]*[^\s"'\\.,;:!?)\]]/g

/** Ce qu'il en reste. */
const RÉFÉRENCE_ÉPURÉE = `${PRÉFIXE_DE_RÉFÉRENCE}…`

/**
 * Une clé d'API dans une URL de requête.
 *
 * Vérifié sur `@google/genai@2.17.1` : la clé passe dans l'en-tête
 * `x-goog-api-key`, jamais dans l'URL — le seul `?key=` du paquet sert au
 * WebSocket de génération musicale, que rien ici n'appelle. Le caviardage est
 * donc une ceinture par-dessus des bretelles, et il coûte une ligne : ce dépôt
 * est public, ses journaux se recopient dans des rapports, et la version du SDK
 * bougera.
 *
 * **Il vit ici plutôt que dans le module Gemini** parce que la frontière HTTP en
 * a besoin sans avoir à connaître le fournisseur : le message d'une erreur de
 * repérage traverse `status.json` puis le champ `error` de
 * `GET /api/projects/:id`, et n'était caviardé sur aucun de ces deux chemins.
 * (relevé par Aristarque)
 */
const CLÉ_DANS_URL = /([?&](?:key|api_?key)=)[^&\s"']+/gi

/** Retire une clé d'API d'un message avant de le publier ou de le journaliser. */
export function caviarderClés(message: string): string {
  return message.replace(CLÉ_DANS_URL, '$1[caviardé]')
}

/**
 * Remplace tout chemin absolu par `…/<nom de fichier>`, et caviarde les clés
 * d'API comme les adresses de secret.
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

  return caviarderClés(sortie)
    .replace(ENTRE_GUILLEMETS, (brut) => {
      const dedans = brut.slice(1, -1)
      // Une référence entre guillemets part entière, espaces compris : les noms
      // de coffre et de fiche en portent couramment, et c'est la seule forme qui
      // dise où la référence se termine.
      if (dedans.startsWith(PRÉFIXE_DE_RÉFÉRENCE)) return `"${RÉFÉRENCE_ÉPURÉE}"`
      return estAbsolu(dedans) ? `"${abréger(dedans)}"` : brut
    })
    .replace(RÉFÉRENCE_DE_SECRET, RÉFÉRENCE_ÉPURÉE)
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
