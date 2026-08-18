import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Clip, ClipStatus, Ratio, Segment } from '@/core/edl'
import { projectsDir } from '@/server/paths'

/**
 * Le stockage : SQLite par `better-sqlite3`, schéma appliqué à l'ouverture.
 *
 * **Ce que la base ne contient pas est aussi important que ce qu'elle
 * contient.** Les artefacts du pipeline — proxy, WAV, transcript, rendus —
 * restent des fichiers sur disque (spec §5). La base porte ce qui se relit et se
 * modifie à la main : les projets et les clips. Y verser des blobs vidéo
 * rendrait le saut d'étape indémontrable, alors qu'un `existsSync` le tranche.
 *
 * Note d'outillage : `@types/better-sqlite3@9` avec `better-sqlite3@13` est
 * normal. La v13 n'embarque aucun type et 9.6.0 est la dernière version publiée
 * des types.
 */

/**
 * Un projet : une source et son empreinte.
 *
 * **L'empreinte est taille, date de modification et durée ffprobe. Pas de
 * hash** (spec §5) : digérer 12 Go à chaque lancement coûterait plus cher que
 * l'étape qu'on cherche à éviter.
 *
 * En itération 0 elle est seulement *relevée* : le saut d'étape se décide sur la
 * présence du fichier (spec §4), et la comparaison des clés de validité vient en
 * itération 4. `durationSec` sert déjà, lui : `buildWindows` en a besoin pour
 * découper le transcript.
 */
export type Project = {
  id: string
  /** L'original sur `REPLAY_DIR`. Jamais copié en base, jamais modifié. */
  sourcePath: string
  /** La copie de travail dans `stage/`, transitoire — d'où le `null` possible. */
  stagedPath: string | null
  durationSec: number | null
  sizeBytes: number | null
  /**
   * Millisecondes depuis l'époque, comme `fs.Stats.mtimeMs`. Le nom porte
   * l'unité : un `mtime` nu invite à y ranger une `Date` ou une chaîne ISO, et
   * la comparaison avec l'entier stocké échouerait alors sans un mot.
   */
  mtimeMs: number | null
  createdAt: number
}

const SCHÉMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  sourcePath  TEXT NOT NULL,
  stagedPath  TEXT,
  durationSec REAL,
  sizeBytes   INTEGER,
  mtimeMs     INTEGER,
  createdAt   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
  -- Unique pour **toute la base**, et non par projet : la spec §12 expose
  -- \`GET /api/clips/:id\` et \`PATCH /api/clips/:id\`, sans projet dans le
  -- chemin. Une clé composite (projectId, id) rendrait ces routes ambiguës.
  -- La contrepartie est portée par \`vérifierPropriété\` plus bas, qui refuse
  -- qu'un identifiant change de projet, et par le contrat d'identifiants de
  -- \`core/candidates.ts\` : dérivés du projet et des bornes, jamais d'un
  -- compteur reparti de 1.
  id          TEXT PRIMARY KEY,
  projectId   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- La liste de segments, en JSON. Le clip est une liste (spec §5) : une
  -- colonne start et une colonne end feraient réapparaître la fenêtre fixe que
  -- ce projet remplace, et le schéma est l'endroit le plus difficile à corriger
  -- une fois qu'il porte des données.
  segments    TEXT NOT NULL,
  ratio       TEXT NOT NULL,
  cropX       REAL NOT NULL,
  -- SQLite n'a pas de booléen : 0 ou 1, reconvertis à la lecture.
  captions    INTEGER NOT NULL,
  branding    INTEGER NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  status      TEXT NOT NULL,
  pass        INTEGER NOT NULL
);

-- Composite, dans l'ordre exact de \`getClips\` : filtre sur \`projectId\`, tri
-- sur \`pass, id\`. Un index sur la seule colonne \`projectId\` laissait SQLite
-- trier en mémoire. Le volume est négligeable et le restera, mais l'index coûte
-- le même geste à écrire. (relevé par Aristarque)
CREATE INDEX IF NOT EXISTS clips_par_projet ON clips(projectId, pass, id);
`

/** Le fichier par défaut : dans `PROJECTS_DIR`, que `.gitignore` couvre déjà. */
export function defaultDbPath(): string {
  return path.join(projectsDir(), 'avolo.db')
}

/**
 * Ouvre la base et applique le schéma. `CREATE TABLE IF NOT EXISTS` : il n'y a
 * pas de migration en itération 0, et une base absente est le cas courant.
 *
 * Passer `':memory:'` donne une base jetable — c'est ce que font les tests.
 */
export function openDb(file: string = defaultDbPath()): Database.Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  // WAL : l'analyse tourne 30 à 45 minutes en tâche de fond pendant que
  // l'interface lit la même base. Sans lui, une écriture bloque toute lecture.
  db.pragma('journal_mode = WAL')
  // Désactivées par défaut dans SQLite, et sans elles la cascade déclarée sur
  // `clips.projectId` ne s'applique pas : supprimer un projet laisserait ses
  // clips orphelins. À poser sur **chaque** connexion, c'est un réglage de
  // session et non de fichier.
  db.pragma('foreign_keys = ON')
  db.exec(SCHÉMA)
  return db
}

let partagée: Database.Database | null = null

/**
 * La connexion du processus. `better-sqlite3` est synchrone et réentrant : une
 * seule connexion suffit, et en ouvrir une par requête coûterait le schéma à
 * chaque fois.
 */
export function getDb(): Database.Database {
  partagée ??= openDb()
  return partagée
}

/** Referme la connexion partagée. Pour les tests et l'arrêt du serveur. */
export function closeDb(): void {
  partagée?.close()
  partagée = null
}

export function upsertProject(db: Database.Database, project: Project): void {
  db.prepare(
    `INSERT INTO projects (id, sourcePath, stagedPath, durationSec, sizeBytes, mtimeMs, createdAt)
     VALUES (@id, @sourcePath, @stagedPath, @durationSec, @sizeBytes, @mtimeMs, @createdAt)
     ON CONFLICT(id) DO UPDATE SET
       sourcePath  = excluded.sourcePath,
       stagedPath  = excluded.stagedPath,
       durationSec = excluded.durationSec,
       sizeBytes   = excluded.sizeBytes,
       mtimeMs     = excluded.mtimeMs`,
  ).run(project)
}

export function getProject(db: Database.Database, id: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined
}

export function listProjects(db: Database.Database): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY createdAt DESC').all() as Project[]
}

/** La forme brute d'une ligne de `clips`, avant reconversion. */
type LigneClip = {
  id: string
  projectId: string
  segments: string
  ratio: string
  cropX: number
  captions: number
  branding: number
  title: string
  description: string
  status: ClipStatus
  pass: number
}

// Les valeurs admises, écrites en `Record<union, true>` : TypeScript exige
// **toutes** les clés et n'en accepte aucune de plus. Ajouter un ratio dans
// `core/edl.ts` sans le déclarer ici échoue à la compilation, au lieu de rendre
// silencieusement illisibles les clips qui le portent.
const RATIOS: Record<Ratio | 'auto', true> = {
  '9:16': true,
  '4:5': true,
  '1:1': true,
  '16:9': true,
  auto: true,
}
const STATUTS: Record<ClipStatus, true> = {
  candidate: true,
  kept: true,
  discarded: true,
  exported: true,
}

function valeurAdmise<T extends string>(admises: Record<T, true>, brut: string, champ: string): T {
  if (!Object.hasOwn(admises, brut)) {
    throw new Error(`Valeur inattendue en base pour ${champ} : ${JSON.stringify(brut)}`)
  }
  return brut as T
}

function analyserSegments(json: string, clipId: string): Segment[] {
  const brut: unknown = JSON.parse(json)
  if (!Array.isArray(brut)) throw new Error(`segments n'est pas une liste (clip ${clipId})`)
  return brut.map((s) => {
    const seg = s as Partial<Segment>
    if (typeof seg?.start !== 'number' || typeof seg?.end !== 'number') {
      throw new Error(`segment illisible (clip ${clipId}) : ${JSON.stringify(s)}`)
    }
    return { start: seg.start, end: seg.end }
  })
}

function clipDepuisLigne(ligne: LigneClip): Clip {
  return {
    id: ligne.id,
    projectId: ligne.projectId,
    segments: analyserSegments(ligne.segments, ligne.id),
    ratio: valeurAdmise(RATIOS, ligne.ratio, 'ratio'),
    cropX: ligne.cropX,
    // `Boolean(0)` et `Boolean(1)`, mais surtout pas la ligne brute : renvoyer
    // un `0` là où le reste du code attend un booléen marche partout sauf dans
    // un `JSON.stringify`, qui l'expose tel quel à l'interface.
    captions: ligne.captions !== 0,
    branding: ligne.branding !== 0,
    title: ligne.title,
    description: ligne.description,
    status: valeurAdmise(STATUTS, ligne.status, 'status'),
    pass: ligne.pass,
  }
}

function ligneDepuisClip(clip: Clip): LigneClip {
  return {
    id: clip.id,
    projectId: clip.projectId,
    segments: JSON.stringify(clip.segments),
    ratio: clip.ratio,
    cropX: clip.cropX,
    captions: clip.captions ? 1 : 0,
    branding: clip.branding ? 1 : 0,
    title: clip.title,
    description: clip.description,
    status: clip.status,
    pass: clip.pass,
  }
}

const INSÉRER_CLIP = `
  INSERT INTO clips (id, projectId, segments, ratio, cropX, captions, branding,
                     title, description, status, pass)
  VALUES (@id, @projectId, @segments, @ratio, @cropX, @captions, @branding,
          @title, @description, @status, @pass)
  ON CONFLICT(id) DO UPDATE SET
    segments    = excluded.segments,
    ratio       = excluded.ratio,
    cropX       = excluded.cropX,
    captions    = excluded.captions,
    branding    = excluded.branding,
    title       = excluded.title,
    description = excluded.description,
    status      = excluded.status,
    pass        = excluded.pass`

/**
 * Refuse qu'un identifiant de clip change de projet.
 *
 * `clips.id` est unique pour toute la base, et l'`ON CONFLICT(id)` ci-dessus
 * rattrapait la collision en écrivant par-dessus le clip existant. Deux projets
 * qui produisaient un `clip_07` — ce que fait n'importe quel compteur reparti de
 * 1 — se volaient donc silencieusement leurs clips : l'écriture du second
 * effaçait le premier, et un `replaceClips` sur l'un emportait le travail de
 * l'autre. Une collision est désormais une erreur, jamais un déménagement.
 * (relevé par Codex, Copilot et Aristarque)
 */
function vérifierPropriété(db: Database.Database, ligne: LigneClip): void {
  const existant = db.prepare('SELECT projectId FROM clips WHERE id = ?').get(ligne.id) as
    | { projectId: string }
    | undefined
  if (existant && existant.projectId !== ligne.projectId) {
    throw new Error(
      `Le clip ${ligne.id} appartient au projet ${existant.projectId} : un identifiant de clip est unique pour toute la base, il ne change pas de projet.`,
    )
  }
}

/** Écrit un clip. C'est ce que fait `PATCH /api/clips/:id` après relecture. */
export function putClip(db: Database.Database, clip: Clip): void {
  const ligne = ligneDepuisClip(clip)
  vérifierPropriété(db, ligne)
  db.prepare(INSÉRER_CLIP).run(ligne)
}

/**
 * Remplace **tout** le jeu de clips d'un projet, en une transaction.
 *
 * C'est la forme qu'appelle la sortie de `mergeCandidates`, qui rend la liste
 * complète et fait autorité : les survivants humains y sont déjà, les
 * propositions périmées n'y sont plus. Écrire l'un sans effacer l'autre
 * ressusciterait précisément ce que la fusion venait d'écarter.
 */
export function replaceClips(db: Database.Database, projectId: string, clips: Clip[]): void {
  const vus = new Set<string>()
  for (const clip of clips) {
    if (clip.projectId && clip.projectId !== projectId) {
      throw new Error(
        `Le clip ${clip.id} appartient au projet ${clip.projectId}, pas à ${projectId}.`,
      )
    }
    // Deux clips du même `id` dans un seul lot : l'`ON CONFLICT` écraserait le
    // premier par le second, et l'appelant croirait avoir écrit deux clips.
    // `mergeCandidates` dédoublonne en amont, mais un appelant direct n'a pas à
    // perdre un clip en silence pour autant. (relevé par Aristarque)
    if (vus.has(clip.id)) {
      throw new Error(`Le clip ${clip.id} apparaît deux fois dans le même lot.`)
    }
    vus.add(clip.id)
  }

  const lignes = clips.map((clip) => ligneDepuisClip({ ...clip, projectId }))
  const écrire = db.transaction(() => {
    db.prepare('DELETE FROM clips WHERE projectId = ?').run(projectId)
    const insérer = db.prepare(INSÉRER_CLIP)
    for (const ligne of lignes) {
      // Après le DELETE : ce qui reste sous cet identifiant appartient
      // forcément à un autre projet. La transaction annule tout le lot.
      vérifierPropriété(db, ligne)
      insérer.run(ligne)
    }
  })
  écrire()
}

export function getClips(db: Database.Database, projectId: string): Clip[] {
  const lignes = db
    .prepare('SELECT * FROM clips WHERE projectId = ? ORDER BY pass, id')
    .all(projectId) as LigneClip[]
  return lignes.map(clipDepuisLigne)
}

export function getClip(db: Database.Database, id: string): Clip | undefined {
  const ligne = db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as LigneClip | undefined
  return ligne && clipDepuisLigne(ligne)
}
