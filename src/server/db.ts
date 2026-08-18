import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Clip, ClipStatus, Ratio, Segment } from '@/core/edl'
import { DIMENSIONS_PAR_DÉFAUT, type DimensionsRepérage } from '@/core/transcript'
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
  pass        INTEGER NOT NULL,
  -- Le numéro d'ordre du dernier geste appliqué, **par champ**, en JSON.
  --
  -- L'interface envoie délibérément des écritures qui se chevauchent, et l'ordre
  -- de traitement est celui de l'arrivée : sans ce repère, deux clics rapides
  -- peuvent laisser la valeur la plus ancienne en base (issue #21).
  --
  -- **Par champ et non par ligne**, parce que les patches sont partiels. Un
  -- repère unique par ligne ferait écarter une écriture entière au motif qu'une
  -- plus récente l'a doublée sur un *autre* champ : un changement de ratio et un
  -- déplacement de segment qui se croisent perdraient l'un des deux, alors
  -- qu'aucun des deux gestes ne contredit l'autre. Voir \`putClipOrdonné\`.
  -- (relevé par Codex)
  --
  -- Un objet vide par défaut : tout jeton dépasse un champ absent, donc une
  -- ligne écrite avant cette colonne ne bloque personne.
  seqs        TEXT NOT NULL DEFAULT '{}'
);

-- Composite, dans l'ordre exact de \`getClips\` : filtre sur \`projectId\`, tri
-- sur \`pass, id\`. Un index sur la seule colonne \`projectId\` laissait SQLite
-- trier en mémoire. Le volume est négligeable et le restera, mais l'index coûte
-- le même geste à écrire. (relevé par Aristarque)
CREATE INDEX IF NOT EXISTS clips_par_projet ON clips(projectId, pass, id);

-- Les réglages, en clé/valeur et en portée unique : voir \`getRéglages\`.
CREATE TABLE IF NOT EXISTS settings (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);
`

/** Le fichier par défaut : dans `PROJECTS_DIR`, que `.gitignore` couvre déjà. */
export function defaultDbPath(): string {
  return path.join(projectsDir(), 'avolo.db')
}

/**
 * Ce que `CREATE TABLE IF NOT EXISTS` ne sait pas faire : ajouter une colonne à
 * une table déjà là.
 *
 * Les bases ouvertes avant l'arrivée de `seq` existent — il y en a une sur cette
 * machine, avec les clips d'une émission entière dedans — et le schéma ci-dessus
 * les laisserait telles quelles : chaque écriture ordonnée échouerait alors sur
 * une colonne inconnue.
 *
 * Le contrôle porte sur la présence de la colonne, pas sur un numéro de version :
 * il n'y a pas de table de migrations à tenir, et `PRAGMA table_info` dit la
 * vérité même sur une base à l'historique inconnu. Le jour où les migrations se
 * comptent, ce sera le moment d'en tenir la liste — pas avant.
 */
function migrer(db: Database.Database): void {
  const colonnes = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
    (colonne) => colonne.name,
  )
  if (!colonnes.includes('seqs')) {
    db.exec(`ALTER TABLE clips ADD COLUMN seqs TEXT NOT NULL DEFAULT '{}'`)
  }
  // `seq`, son prédécesseur par ligne, n'a jamais quitté cette branche : le
  // laisser derrière nous ferait une colonne morte au nom presque identique à
  // celle qui compte, ce qui est le pire des deux mondes.
  if (colonnes.includes('seq')) {
    db.exec('ALTER TABLE clips DROP COLUMN seq')
  }
}

/**
 * Ouvre la base et applique le schéma. `CREATE TABLE IF NOT EXISTS` couvre le
 * cas courant — une base absente —, `migrer` celles qui existaient déjà.
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
  migrer(db)
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

/**
 * Ce qui dimensionne le repérage, tenu en base plutôt qu'en constantes.
 *
 * **La base ne déplace pas la frontière de pureté, elle la respecte.**
 * `src/core/transcript.ts` documente pourquoi les surcharges d'environnement
 * d'openshorts n'ont jamais été portées : un calcul qui lit l'environnement où
 * il s'exécute n'est pas reproductible en test. Rien ne change de ce côté —
 * `shortlistSize` et `clipCountTargets` restent pures et **reçoivent** ces
 * valeurs. Ce fichier est seulement l'endroit d'où elles viennent, et le seul
 * qui sache qu'on peut les changer sans toucher au code.
 *
 * Les défauts eux-mêmes vivent dans `src/core/transcript.ts`, avec le calcul
 * qu'ils gouvernent : ce sont les défauts d'une règle, pas ceux d'un stockage,
 * et ce fichier ne fait que les surcharger.
 */

/**
 * Les clés reconnues, **dérivées des champs** plutôt que réénumérées : une
 * seconde liste tenue à la main diverge du type au premier ajout, et le réglage
 * qui manquerait ne serait jamais relu.
 */
const CHAMPS_DE_RÉGLAGE = Object.keys(DIMENSIONS_PAR_DÉFAUT) as (keyof DimensionsRepérage)[]

/** La clé telle qu'elle est stockée. Préfixée : d'autres familles suivront. */
function cléStockée(champ: keyof DimensionsRepérage): string {
  return `selection.${champ}`
}

/**
 * Le plus petit entier acceptable pour un champ.
 *
 * Un seul fait exception, et c'est là sa valeur signifiante : `clipsMaximum` à
 * zéro veut dire « aucun plafond ». Partout ailleurs zéro est une saisie ratée —
 * une durée nulle par clip diviserait par zéro, un ratio nul viderait la
 * présélection.
 */
function plancherDuChamp(champ: keyof DimensionsRepérage): number {
  return champ === 'clipsMaximum' ? 0 : 1
}

/**
 * Les réglages effectifs : ce que porte la base, complété par les défauts.
 *
 * **Ne lève jamais, et c'est délibéré.** Le repérage tourne en tâche de fond
 * derrière une transcription qui a coûté quarante minutes ; le faire échouer sur
 * une valeur mal saisie coûterait bien plus cher que de retomber sur le défaut.
 * Une valeur illisible ou hors bornes est donc ignorée **comme si elle était
 * absente** — exactement ce que `tailleDeLot` réserve à `SCORE_BATCH`
 * (`src/server/steps/candidates.ts`).
 */
export function getRéglages(db: Database.Database): DimensionsRepérage {
  const lignes = db.prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string
  }[]
  const enBase = new Map(lignes.map((ligne) => [ligne.key, ligne.value]))
  const réglages = { ...DIMENSIONS_PAR_DÉFAUT }
  for (const champ of CHAMPS_DE_RÉGLAGE) {
    const brut = enBase.get(cléStockée(champ))
    if (brut === undefined) continue
    // **Une suite de chiffres, ou rien** — ni `parseInt`, ni `Number` seul, qui
    // ont chacun leurs largesses. `parseInt` lit ce qu'il peut et jette le
    // reste : `"4.5"` devenait 4 et `"7abc"` devenait 7, si bien qu'une valeur
    // corrompue *modifiait* le repérage au lieu d'être ignorée comme cette
    // fonction l'annonce dix lignes plus haut. Une saisie à moitié comprise est
    // le pire des trois cas — pire que refusée, pire qu'acceptée telle quelle,
    // parce que personne ne peut deviner le nombre qui a fini par s'appliquer.
    // (relevé par Copilot)
    //
    // `Number` seul ne suffit pas non plus : la chaîne vide et les blancs valent
    // zéro, `"0x10"` vaut seize. Ce qui est stocké ici est un entier positif
    // écrit en clair, et rien d'autre n'a de sens à relire.
    if (!/^\d+$/.test(brut.trim())) continue
    const valeur = Number(brut.trim())
    if (!Number.isSafeInteger(valeur) || valeur < plancherDuChamp(champ)) continue
    réglages[champ] = valeur
  }
  return réglages
}

/**
 * Écrit un réglage.
 *
 * **Refuse une clé inconnue au lieu de la stocker.** Une clé mal orthographiée
 * s'écrirait sans bruit, ne serait jamais relue, et l'écran de réglages
 * afficherait le défaut en jurant avoir enregistré. Une valeur hors bornes est
 * refusée pour la raison inverse de `getRéglages` : ici quelqu'un attend une
 * réponse, et lui dire non tout de suite vaut mieux que de la lui ignorer plus
 * tard.
 */
export function setRéglage(
  db: Database.Database,
  champ: keyof DimensionsRepérage,
  valeur: number,
): void {
  if (!CHAMPS_DE_RÉGLAGE.includes(champ)) {
    throw new Error(`Réglage inconnu : ${String(champ)}`)
  }
  const plancher = plancherDuChamp(champ)
  // `isSafeInteger` et non `isInteger`, **la même règle que le lecteur** :
  // `isInteger(1e100)` est vrai, `String(1e100)` donne `"1e+100"`, et
  // `getRéglages` refuse cette écriture. Une écriture réussie se relisait donc
  // en défaut, ce qui est le pire des retours — l'écran de réglages aurait juré
  // avoir enregistré. (relevé par Copilot)
  if (!Number.isSafeInteger(valeur) || valeur < plancher) {
    throw new Error(
      `Réglage ${String(champ)} : un entier supérieur ou égal à ${plancher} est attendu, reçu ${valeur}.`,
    )
  }
  db.prepare(
    `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
  ).run(cléStockée(champ), String(valeur), Date.now())
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

/** Le numéro d'ordre du dernier geste appliqué, par champ de `Clip`. */
export type JetonsClip = Partial<Record<keyof Clip, number>>

function lireJetons(db: Database.Database, id: string): JetonsClip {
  const ligne = db.prepare('SELECT seqs FROM clips WHERE id = ?').get(id) as
    | { seqs: string }
    | undefined
  if (ligne === undefined) return {}
  try {
    const lus: unknown = JSON.parse(ligne.seqs)
    // Un objet, et des nombres dedans. Une colonne abîmée ne doit pas faire
    // écarter des écritures parfaitement fraîches en comparant à `undefined`
    // devenu `NaN` : on repart de zéro, ce qui rend simplement l'ordre au
    // hasard de l'arrivée — l'état d'avant cette colonne.
    if (typeof lus !== 'object' || lus === null || Array.isArray(lus)) return {}
    const jetons: JetonsClip = {}
    for (const [champ, valeur] of Object.entries(lus)) {
      if (typeof valeur === 'number' && Number.isFinite(valeur)) {
        jetons[champ as keyof Clip] = valeur
      }
    }
    return jetons
  } catch (cause) {
    console.warn(`Jetons illisibles pour le clip ${id} :`, cause)
    return {}
  }
}

/**
 * Le plus grand jeton que la base retient pour ce clip, tous champs confondus.
 *
 * Sert aux écritures **sans jeton** : elles n'entrent pas dans la course, mais
 * leur réponse porte le même contrat que les autres, et annoncer `0` là où la
 * base garde 300 donnerait à l'appelant un plancher faux — donc un recalage qui
 * l'enfonce au lieu de le sortir. (relevé par Copilot)
 */
export function plancherDOrdre(db: Database.Database, id: string): number {
  return Math.max(0, ...Object.values(lireJetons(db, id)))
}

/** Le résultat d'une écriture ordonnée. */
export type ÉcritureOrdonnée = {
  /** Le clip tel que la base le porte **après** l'écriture. */
  clip: Clip
  /**
   * Faux dès qu'un champ a été écarté parce qu'une écriture plus récente
   * l'avait déjà touché. Les autres champs du même patch, eux, sont écrits.
   */
  applied: boolean
  /**
   * Le plus grand jeton que la base retient pour ce clip, tous champs confondus.
   *
   * Il repart au client pour qu'il puisse se recaler : ses jetons viennent de son
   * horloge, et une horloge remise en arrière — un décalage NTP corrigé — lui
   * ferait produire des numéros inférieurs à ce que le serveur a déjà appliqué,
   * donc refuser ses écritures jusqu'à ce que l'horloge rattrape. Une réponse
   * suffit alors à lui apprendre le plancher. (relevé par Copilot)
   */
  seq: number
}

/**
 * Écrit un clip **champ par champ**, en écartant ceux qu'un geste plus récent a
 * déjà touchés.
 *
 * L'interface envoie délibérément des écritures qui se chevauchent, et rien ne
 * garantit que la première partie arrive la première : sans jeton, la base finit
 * sur la valeur la plus ancienne pendant que l'écran, lui, affiche la bonne — et
 * l'écart ne se voit qu'au rechargement (issue #21). Sérialiser les écritures
 * côté serveur ne réglerait rien : cela alignerait l'ordre de traitement sur
 * l'ordre d'arrivée, qui est précisément ce dont on se méfie.
 *
 * **La comparaison porte sur les champs, jamais sur la ligne entière.** Les
 * patches sont partiels : un `{ status }` et un `{ segments }` qui se croisent ne
 * se contredisent sur rien, et écarter le second parce que le premier est plus
 * récent perdrait un montage que l'ancien code, lui, gardait. C'est le défaut
 * inverse de celui qu'on corrige, et il coûte plus cher — une écriture perdue
 * plutôt qu'une écriture désordonnée. (relevé par Codex)
 *
 * `champs` est ce que le client a **envoyé**, pas ce qui a changé : un patch qui
 * réécrit une valeur identique reste une prise de position sur ce champ, et doit
 * dater le jeton comme une autre.
 *
 * **Faux ne veut pas dire « échec ».** L'appelant rend le clip tel quel : c'est
 * un résultat, pas une erreur d'enregistrement.
 */
export function putClipOrdonné(
  db: Database.Database,
  clip: Clip,
  champs: readonly (keyof Clip)[],
  seq: number,
): ÉcritureOrdonnée | undefined {
  // La transaction tient ensemble la lecture des jetons, la comparaison et les
  // deux écritures. Sans elle, la fenêtre qu'on ferme se rouvrirait entre la
  // comparaison et la ligne.
  const écrire = db.transaction((): ÉcritureOrdonnée | undefined => {
    const courant = getClip(db, clip.id)
    if (courant === undefined) return undefined

    const jetons = lireJetons(db, clip.id)
    const écartés = champs.filter((champ) => (jetons[champ] ?? 0) > seq)

    // On part du clip fusionné et on **rétablit** les champs écartés : les
    // champs que le client n'a pas envoyés gardent ainsi le traitement que
    // l'appelant leur a fait subir — la normalisation des segments, notamment,
    // qui s'applique à chaque écriture et pas seulement quand ils changent.
    const suivant = rétablir(clip, courant, écartés)
    putClip(db, suivant)

    const retenus = champs.filter((champ) => !écartés.includes(champ))
    const àJourOuInchangés: JetonsClip = { ...jetons }
    if (retenus.length > 0) {
      for (const champ of retenus) àJourOuInchangés[champ] = seq
      db.prepare('UPDATE clips SET seqs = @seqs WHERE id = @id').run({
        id: clip.id,
        seqs: JSON.stringify(àJourOuInchangés),
      })
    }

    const plancher = Math.max(0, ...Object.values(àJourOuInchangés))
    return { clip: suivant, applied: écartés.length === 0, seq: plancher }
  })
  return écrire()
}

/**
 * `cible` avec les champs nommés repris de `source`.
 *
 * L'`Object.assign` sur une clé calculée n'est pas un détour : TypeScript refuse
 * `copie[champ] = source[champ]` quand `champ` est une union de clés, alors que
 * l'affectation est correcte pour chacune prise séparément.
 */
function rétablir(cible: Clip, source: Clip, champs: readonly (keyof Clip)[]): Clip {
  const copie: Clip = { ...cible }
  for (const champ of champs) Object.assign(copie, { [champ]: source[champ] })
  return copie
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
    // **Les jetons d'ordre des survivants, relevés avant le DELETE.**
    //
    // `INSÉRER_CLIP` ne porte pas `seqs`, donc chaque survivant repartirait de
    // `{}` : une écriture ancienne encore en vol arriverait alors devant un
    // champ sans mémoire, passerait pour fraîche, et écraserait un geste plus
    // récent — #21 rouvert par une passe de repérage. La fenêtre est étroite,
    // mais c'est exactement celle que ce jeton existe pour fermer, et la
    // relever coûte une requête. (relevé par Copilot)
    const jetons = new Map(
      (
        db.prepare('SELECT id, seqs FROM clips WHERE projectId = ?').all(projectId) as {
          id: string
          seqs: string
        }[]
      ).map((ligne) => [ligne.id, ligne.seqs]),
    )

    db.prepare('DELETE FROM clips WHERE projectId = ?').run(projectId)
    const insérer = db.prepare(INSÉRER_CLIP)
    const rétablirJetons = db.prepare('UPDATE clips SET seqs = @seqs WHERE id = @id')
    for (const ligne of lignes) {
      // Après le DELETE : ce qui reste sous cet identifiant appartient
      // forcément à un autre projet. La transaction annule tout le lot.
      vérifierPropriété(db, ligne)
      insérer.run(ligne)
      const seqs = jetons.get(ligne.id)
      if (seqs !== undefined) rétablirJetons.run({ id: ligne.id, seqs })
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
