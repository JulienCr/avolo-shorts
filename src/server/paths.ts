import fs from 'node:fs'
import path from 'node:path'

/**
 * Où vivent les artefacts (spec §5).
 *
 * Une seule règle les sépare : **ce qui est intrinsèque à la vidéo vit à côté
 * d'elle, le reste vit dans le projet.** Le transcript est une propriété du
 * fichier vidéo — il survit à la suppression du projet, se réutilise depuis un
 * autre outil et suit la vidéo si on la déplace. Le proxy, lui, pèse 1,4 Go et
 * n'a rien à faire sur un Drive partagé.
 *
 * Ce fichier est du `src/server/` : il touche au disque, c'est son métier.
 * Aucune décision ne s'y prend — `graph.ts` et `candidates.ts` décident, ici on
 * ne fait que nommer.
 */

/**
 * Les trois racines, lues **à l'appel** et non au chargement du module : un test
 * qui pose `process.env.PROJECTS_DIR` dans un `beforeEach` doit être entendu,
 * et un module déjà importé ne relit rien.
 */
function racine(variable: string, défaut?: string): string {
  const valeur = process.env[variable] ?? défaut
  if (!valeur) {
    throw new Error(
      `${variable} n'est pas définie. Voir .env.example — REPLAY_DIR pointe le dossier des replays.`,
    )
  }
  return path.resolve(valeur)
}

/** Le dossier des replays d'origine. Monté en 9p, lent, et jamais modifié. */
export function replayDir(): string {
  return racine('REPLAY_DIR')
}

/** La copie de travail locale. Transitoire : elle peut être effacée à tout moment. */
export function stageDir(): string {
  return racine('STAGE_DIR', './stage')
}

/** Les projets, un par source. */
export function projectsDir(): string {
  return racine('PROJECTS_DIR', './projects')
}

/**
 * Le chemin de l'original, qu'on l'ait désigné par son nom de fichier (ce que
 * fait `POST /api/projects`) ou par un chemin complet.
 *
 * **Une seule règle, sans exception : la source est un fichier posé directement
 * dans `REPLAY_DIR`.** Ni au-dessus, ni dans un sous-dossier.
 *
 * `source` arrive du réseau, et deux façons de sortir du cadre se ressemblent
 * assez pour être traitées ensemble. `../../etc/passwd` désigne un fichier qui
 * n'est pas un replay ; un chemin absolu vers n'importe où aussi, et le tenir
 * pour « un geste explicite de l'opérateur » suppose une distinction que rien
 * ici ne peut faire — un corps de requête JSON a le même goût qu'une saisie.
 * Traiter un fichier rangé ailleurs se fait en pointant `REPLAY_DIR` dessus.
 *
 * Les sous-dossiers sont refusés pour une raison différente et tout aussi
 * concrète : `projectIdFromSource` et `stagedPath` ne gardent que le nom du
 * fichier, donc `2025/show.mp4` et `2026/show.mp4` se partageraient
 * `projects/show/` et `stage/show.mp4` — deux émissions dans un seul projet,
 * silencieusement. Le dossier de replays est plat et ses noms portent déjà la
 * date ; le jour où il ne le sera plus, c'est l'identifiant qu'il faudra
 * reprendre, pas ce contrôle qu'il faudra retirer.
 */
export function resolveSource(source: string): string {
  const replays = replayDir()
  const résolu = path.resolve(replays, source)
  if (path.dirname(résolu) !== replays) {
    throw new Error(
      `Source hors de REPLAY_DIR : ${JSON.stringify(source)}. Attendu : un fichier posé directement dans ${replays}.`,
    )
  }
  return résolu
}

/**
 * L'identifiant de projet, dérivé du nom de fichier sans son extension —
 * `2026-03-08-caro-mdlm.mp4` donne `2026-03-08-caro-mdlm`.
 *
 * Le nom d'origine est conservé tel quel, accents et espaces compris : le titre
 * du projet en dérive, et un identifiant haché renommerait toute la
 * bibliothèque en charabia (spec §12).
 */
export function projectIdFromSource(source: string): string {
  const nom = path.basename(resolveSource(source))
  return nom.slice(0, nom.length - path.extname(nom).length) || nom
}

/**
 * Un identifiant de projet sert à construire un chemin, et il arrive du réseau
 * (`GET /api/projects/:id`). Sans ce garde-fou, `..%2F..%2Fetc` sortirait de
 * `PROJECTS_DIR` — la traversée de répertoire la plus classique qui soit.
 *
 * Le contrôle est volontairement permissif sur les caractères : les noms de
 * replays portent accents et espaces, et les refuser casserait la bibliothèque
 * existante. Il est strict sur la seule chose qui compte, la traversée.
 */
function vérifierId(projectId: string): string {
  const refusé =
    projectId === '' ||
    projectId === '.' ||
    projectId === '..' ||
    projectId.includes('/') ||
    projectId.includes('\\') ||
    projectId.includes('\0')
  if (refusé) {
    throw new Error(`Identifiant de projet invalide : ${JSON.stringify(projectId)}`)
  }
  return projectId
}

/** `projects/<id>/` — tout ce qui dépend d'un réglage plutôt que de la vidéo. */
export function projectDir(projectId: string): string {
  return path.join(projectsDir(), vérifierId(projectId))
}

/** Le proxy 960x540 à 30 fps, sur lequel tourne tout le travail en aval. */
export function proxyPath(projectId: string): string {
  return path.join(projectDir(projectId), 'proxy.mp4')
}

/** Le WAV 16 kHz mono que WhisperX attend. */
export function audioPath(projectId: string): string {
  return path.join(projectDir(projectId), 'audio.wav')
}

/** Les propositions, tous lots confondus — c'est ce que `mergeCandidates` produit. */
export function candidatesPath(projectId: string): string {
  return path.join(projectDir(projectId), 'candidates.json')
}

/** Les MP4 produits. Deux par clip non-9:16 : natif et variante à fond flouté. */
export function rendersDir(projectId: string): string {
  return path.join(projectDir(projectId), 'renders')
}

/**
 * La copie de travail, **sous le nom du fichier d'origine**. Le Drive est lent
 * et décroche ; on copie en local avant de traiter (spec §12).
 */
export function stagedPath(source: string): string {
  return path.join(stageDir(), path.basename(resolveSource(source)))
}

/**
 * Le sidecar : `<original sans extension>.avolo/`, **à côté de l'original**.
 *
 * À côté de l'original, pas à côté de la copie dans `stage/` — c'est tout
 * l'intérêt. La copie est transitoire ; y écrire le transcript reviendrait à le
 * jeter avec elle, et à retranscrire deux heures cinquante d'audio à la
 * prochaine ingestion.
 *
 * Un dossier plutôt que des fichiers en vrac, pour ne pas noyer le dossier de
 * replays.
 */
export function sidecarDir(source: string): string {
  const original = resolveSource(source)
  const ext = path.extname(original)
  return `${original.slice(0, original.length - ext.length)}.avolo`
}

/** `transcript.json` du sidecar : mots et segments au format WhisperX. */
export function transcriptPath(source: string): string {
  return path.join(sidecarDir(source), 'transcript.json')
}

/** Où le sidecar a réellement pu se poser. */
export type SidecarPlacement = {
  /** Le dossier retenu. */
  dir: string
  /** `transcript.json` à l'intérieur. */
  transcript: string
  /**
   * Vrai quand le sidecar a dû se rabattre dans le projet. Pas une erreur :
   * seulement moins de réutilisation, et l'interface le signale (spec §5).
   */
  fallback: boolean
}

/**
 * Éprouve un dossier **en y écrivant vraiment**, et le crée au passage.
 *
 * Ne pas lire les bits de permission : `REPLAY_DIR` est un Google Drive monté en
 * 9p qui annonce `drwxrwxrwx` sans que cela prouve quoi que ce soit, et qui
 * décroche de deux façons que `/proc/mounts` ne distingue pas. `access(W_OK)`
 * répondrait oui aux deux. La seule question qui se pose est « est-ce que
 * l'écriture passe », et le seul moyen de la poser est d'écrire.
 *
 * Un montage mort fait échouer l'appel plutôt que de mentir : on se rabat, ce
 * qui est le bon comportement. La *vivacité* du montage, elle, se vérifie en
 * amont, à l'ingestion (tâche 7).
 */
function préparerDossier(dir: string): boolean {
  const existait = fs.existsSync(dir)
  // Nom unique : deux processus peuvent sonder le même dossier en même temps, et
  // l'un ne doit pas effacer la sonde de l'autre.
  const sonde = path.join(dir, `.avolo-sonde-${process.pid}-${Date.now().toString(36)}`)
  let réussi = false
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(sonde, '')
    réussi = true
    return true
  } catch {
    return false
  } finally {
    try {
      fs.rmSync(sonde, { force: true })
    } catch {
      // La sonde peut avoir disparu ; sans conséquence.
    }
    // Un dossier créé puis inutilisable ne doit pas rester derrière nous — mais
    // **seulement s'il est vide**. Un `rm -rf` emporterait le transcript qu'un
    // autre processus vient d'y écrire entre notre `existsSync` et l'échec de
    // notre sonde ; un nom de sonde unique ne protège de rien contre ça, et le
    // fichier détruit serait précisément celui que tout ce module sert à
    // préserver. `rmdirSync` échoue sur un dossier non vide, ce qui est
    // exactement le garde-fou voulu. (relevé par Copilot)
    if (!réussi && !existait) {
      try {
        fs.rmdirSync(dir)
      } catch {
        // Non vide, ou jamais créé. Dans les deux cas, on n'y touche pas.
      }
    }
  }
}

/**
 * Choisit où lire et écrire le sidecar, et crée le dossier retenu.
 *
 * Quatre cas, dans cet ordre, et l'ordre est ce qui garantit qu'aucun transcript
 * déjà calculé n'est perdu de vue :
 *
 * 1. un `transcript.json` existe déjà à côté de l'original → c'est lui, même si
 *    le dossier est devenu illisible en écriture. **Lire n'exige pas d'écrire**,
 *    et se rabattre ici retranscrirait pour rien ce qui est déjà là ;
 * 2. sinon, un transcript posé dans le projet par une passe précédente → lui ;
 * 3. sinon, à côté de l'original si l'écriture y passe ;
 * 4. sinon, dans le projet.
 *
 * Le repli garde le nom `<nom>.avolo/` : le jour où le Drive redevient
 * inscriptible, le dossier se recopie tel quel à côté de la vidéo.
 */
export function placeSidecar(source: string, projectId: string): SidecarPlacement {
  const voulu = sidecarDir(source)
  const repli = path.join(projectDir(projectId), path.basename(voulu))

  const placement = (dir: string, fallback: boolean): SidecarPlacement => ({
    dir,
    transcript: path.join(dir, 'transcript.json'),
    fallback,
  })

  if (fs.existsSync(path.join(voulu, 'transcript.json'))) return placement(voulu, false)
  if (fs.existsSync(path.join(repli, 'transcript.json'))) return placement(repli, true)
  if (préparerDossier(voulu)) return placement(voulu, false)

  fs.mkdirSync(repli, { recursive: true })
  return placement(repli, true)
}
