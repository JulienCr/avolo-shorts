import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type { Clip, ClipStatus, Ratio, Segment } from '@/core/edl'
import { PLATFORMS } from '@/core/publication'
import type { PublicationRow } from '@/core/publication'

export type { PublicationRow } from '@/core/publication'
import { DEFAULT_SELECTION_DIMENSIONS, type SelectionDimensions } from '@/core/transcript'
import {
  DEFAULT_COPY_SOURCE_LOCALLY,
  DEFAULT_PUBLICATION_PREFERENCE,
  DEFAULT_SCHEDULE_HOURS,
  FRAMING_BOUNDS,
  FRAMING_SETTINGS_DEFAULTS,
  HOOK_ALIGNMENTS,
  HOOK_BOUNDS,
  HOOK_DEFAULTS,
  HOOK_FONTS,
  HOOK_POSITIONS,
  HOOK_TRANSITIONS,
  LLM_PROVIDERS,
  PUBLICATION_ADAPTER_CHOICES,
  type AiSettings,
  type FramingSettings,
  type HookSettings,
  type IngestionSettings,
  type PublicationSettings,
  type Settings,
} from '@/lib/api'
import { DEFAULT_MODEL } from '@/server/llm/defaults'
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

const SCHEMA = `
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
  seqs        TEXT NOT NULL DEFAULT '{}',
  -- Le hook : l'accroche incrustée dès la première image (retour d'usage §7).
  -- Vide par défaut, comme un clip qui n'en a pas encore.
  hookText    TEXT NOT NULL DEFAULT '',
  -- Un objet JSON **creux** : seules les clés que ce clip surcharge par
  -- rapport aux défauts globaux (famille \`hook\` du registre, plus bas).
  -- \`{}\` dit « aux valeurs globales » ; voir \`hookStyle\` sur \`Clip\`
  -- (\`core/edl.ts\`).
  hookStyle   TEXT NOT NULL DEFAULT '{}',
  -- Le libellé court posé au-dessus de l'accroche (« DÉFI 10 »). Du contenu,
  -- comme \`hookText\` : ses deux couleurs, elles, sont un réglage.
  hookBadge   TEXT NOT NULL DEFAULT '',
  -- La surcharge de cadrage par clip (issue #180, seconde moitié). Même
  -- convention que \`hookStyle\` deux lignes plus haut : \`{}\` dit « aux
  -- valeurs globales » (famille \`framing\` du registre, plus bas).
  framingStyle TEXT NOT NULL DEFAULT '{}'
);

-- Composite, dans l'ordre exact de \`getClips\` : filtre sur \`projectId\`, tri
-- sur \`pass, id\`. Un index sur la seule colonne \`projectId\` laissait SQLite
-- trier en mémoire. Le volume est négligeable et le restera, mais l'index coûte
-- le même geste à écrire. (relevé par Aristarque)
--
-- Nommé \`clips_by_project\` : c'était le seul objet de schéma en français
-- (\`clips_par_projet\`), et \`migrer\` ci-dessous le renomme sur une base qui le
-- porte encore.
CREATE INDEX IF NOT EXISTS clips_by_project ON clips(projectId, pass, id);

-- Les réglages, en clé/valeur et en portée unique : voir \`getRéglages\`.
CREATE TABLE IF NOT EXISTS settings (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);

-- Une ligne par couple (clip, plateforme). \`requestId\` diffère délibérément
-- de \`remoteId\` : un envoi Upload Post porte plusieurs plateformes en une
-- seule requête (spec publication §6.4), donc le repère de sondage est
-- partagé entre elles tandis que l'identifiant de publication ne l'est pas.
-- \`CREATE TABLE IF NOT EXISTS\` suffit ici, sans entrée dans \`migrer\` : la
-- table n'existait pas avant cette PR, il n'y a donc pas de base existante à
-- rattraper (voir la doctrine plus bas, « pas de table de migrations »).
CREATE TABLE IF NOT EXISTS publications (
  clipId               TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  platform             TEXT NOT NULL,
  status               TEXT NOT NULL,
  remoteId             TEXT,
  remoteUrl            TEXT,
  requestId            TEXT,
  error                TEXT,
  publishedFingerprint TEXT,
  createdAt            INTEGER NOT NULL,
  updatedAt            INTEGER NOT NULL,
  scheduledAt          INTEGER,
  PRIMARY KEY (clipId, platform)
);
-- Pas d'index sur \`scheduledAt\` : quelques centaines de lignes par an,
-- un index serait spéculatif.
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
function migrate(db: Database.Database): void {
  const columns = (db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map(
    (column) => column.name,
  )
  if (!columns.includes('seqs')) {
    db.exec(`ALTER TABLE clips ADD COLUMN seqs TEXT NOT NULL DEFAULT '{}'`)
  }
  // Le hook (retour d'usage §7) : deux colonnes de plus sur une base qui ne
  // les portait pas. Même défense que `seqs` juste au-dessus — le contrôle
  // porte sur la colonne, pas sur un numéro de version.
  if (!columns.includes('hookText')) {
    db.exec(`ALTER TABLE clips ADD COLUMN hookText TEXT NOT NULL DEFAULT ''`)
  }
  if (!columns.includes('hookStyle')) {
    db.exec(`ALTER TABLE clips ADD COLUMN hookStyle TEXT NOT NULL DEFAULT '{}'`)
  }
  // Le badge du hook, arrivé après les deux précédentes. Même défense.
  if (!columns.includes('hookBadge')) {
    db.exec(`ALTER TABLE clips ADD COLUMN hookBadge TEXT NOT NULL DEFAULT ''`)
  }
  // La surcharge de cadrage par clip (issue #180). Même défense.
  if (!columns.includes('framingStyle')) {
    db.exec(`ALTER TABLE clips ADD COLUMN framingStyle TEXT NOT NULL DEFAULT '{}'`)
  }
  // `seq`, son prédécesseur par ligne, n'a jamais quitté cette branche : le
  // laisser derrière nous ferait une colonne morte au nom presque identique à
  // celle qui compte, ce qui est le pire des deux mondes.
  if (columns.includes('seq')) {
    db.exec('ALTER TABLE clips DROP COLUMN seq')
  }
  // L'index composite est désormais `clips_by_project` (issue #73). Le SCHEMA
  // ci-dessus l'a déjà créé sous ce nom au moment où `migrate` s'exécute ; sur
  // une base qui portait encore l'ancien, `clips_par_projet`, les deux
  // coexisteraient sans qu'aucune erreur ne le signale — deux index sur les
  // mêmes colonnes, l'un mort. Aucune donnée n'est touchée, seul le schéma.
  db.exec('DROP INDEX IF EXISTS clips_par_projet')
}

/**
 * Les cinq champs de la famille `selection`, de leur ancien nom français vers
 * le nouveau nom anglais. Voir `migrateSelectionSettingKeys`.
 */
const LEGACY_SELECTION_KEYS: Readonly<Record<string, string>> = {
  minutesParClip: 'minutesPerClip',
  fenetresParClip: 'windowsPerClip',
  clipsMinimum: 'minimumClips',
  fenetresMinimum: 'minimumWindows',
  clipsMaximum: 'maximumClips',
}

/**
 * Renomme en place les clés `selection.<ancien-champ>` vers
 * `selection.<nouveau-champ>`, en conservant la valeur et l'horodatage.
 *
 * **Il n'existe pas de table de migrations ici** (voir `migrate`, qui traite
 * `clips` de la même façon) : le contrôle porte sur la présence de l'ancienne
 * clé, ce qui rend l'opération idempotente — la relancer sur une base déjà
 * migrée, ou sur une base neuve qui n'a jamais connu l'ancien nom, ne fait
 * rien.
 *
 * **Sans ce passage, une base existante retomberait sur les défauts sans un
 * mot.** `parseSetting` ignore une clé qu'il ne reconnaît pas — c'est son
 * contrat, voir plus haut —, et `selection.minutesParClip` orpheline
 * deviendrait indiscernable d'un réglage jamais posé. Le cas le plus cher est
 * `maximumClips` : sa valeur signifiante est `0` (« aucun plafond »), et ce
 * zéro-là disparaîtrait aussi silencieusement qu'un autre.
 *
 * **La nouvelle clé fait autorité si elle existe déjà** — une base migrée
 * deux fois, ou réglée entre-temps sous le nouveau nom par un processus plus
 * récent — et l'ancienne est simplement effacée sans écraser sa valeur.
 */
function migrateSelectionSettingKeys(db: Database.Database): void {
  const rows = db
    .prepare(`SELECT key, value, updatedAt FROM settings WHERE key LIKE 'selection.%'`)
    .all() as { key: string; value: string; updatedAt: number }[]
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const insertIfMissing = db.prepare(
    `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`,
  )
  const remove = db.prepare('DELETE FROM settings WHERE key = ?')
  db.transaction(() => {
    for (const [oldName, newName] of Object.entries(LEGACY_SELECTION_KEYS)) {
      const oldKey = `selection.${oldName}`
      const oldRow = byKey.get(oldKey)
      if (oldRow === undefined) continue
      const newKey = `selection.${newName}`
      if (!byKey.has(newKey)) {
        insertIfMissing.run(newKey, oldRow.value, oldRow.updatedAt)
      }
      remove.run(oldKey)
    }
  })()
}

/**
 * Efface `hook.size`, la clé qu'a remplacée `hook.sizePermille` le 20 août
 * 2026 quand le hook est passé de l'ASS à un PNG rasterisé.
 *
 * **Pas le patron de `migrateSelectionSettingKeys` : la valeur ne se
 * reporte pas.** Là-bas l'ancien et le nouveau nom désignaient la même
 * grandeur (renommage pur, issue #73) ; ici `size` était une taille en
 * unités de script ASS et `sizePermille` est une fraction de la largeur du
 * canevas — deux échelles sans correspondance. Reporter l'ancienne valeur
 * numérique sous la nouvelle clé donnerait un nombre qui a l'air valide et
 * qui ne veut plus rien dire. La base de production de ce dépôt ne porte
 * aujourd'hui aucune ligne `hook.size` (vérifié le 20 août 2026) : le coût
 * réel de cette purge est nul, et `HOOK_DEFAULTS.sizePermille` prend le
 * relais pour quiconque en aurait posé une.
 */
function migrateHookSizeSettingKey(db: Database.Database): void {
  db.prepare("DELETE FROM settings WHERE key = 'hook.size'").run()
}

/**
 * Retire `size` de chaque `hookStyle` de `clips`, en conservant les autres
 * clés. Complément de `migrateHookSizeSettingKey` juste au-dessus, qui ne
 * purge que `settings` : `HOOK_STYLE_SCHEMA` (`z.strictObject`, plus bas)
 * rejette l'objet entier dès qu'une clé inconnue traîne, donc un clip qui
 * portait encore `hookStyle.size` perdrait silencieusement **toutes** ses
 * autres surcharges au premier `readHookStyle` — pas seulement `size`.
 * Relevé en review sur la PR #117 (Aristarque et Copilot, indépendamment) ;
 * la base de production ne porte aujourd'hui aucun clip avec cette clé
 * (vérifié le 20 août 2026), donc le coût réel est nul, mais la fenêtre où
 * un tel clip aurait pu naître — entre le merge de #114 et cette migration —
 * existait, et la classe de défaut (un renommage de clé qui efface un clip
 * entier) survivrait au prochain renommage sans ce filet.
 *
 * On manipule le JSON brut plutôt que `HOOK_STYLE_SCHEMA` : passer par le
 * schéma strict reproduirait exactement le bug qu'on corrige. Une ligne dont
 * le JSON ne parse pas est laissée telle quelle — elle est déjà illisible
 * pour `readHookStyle`, cette migration ne répare pas ce cas-là.
 */
function migrateHookSizeClipColumn(db: Database.Database): void {
  const rows = db
    .prepare(`SELECT id, hookStyle FROM clips WHERE hookStyle LIKE '%"size"%'`)
    .all() as { id: string; hookStyle: string }[]
  const update = db.prepare('UPDATE clips SET hookStyle = ? WHERE id = ?')
  db.transaction(() => {
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.hookStyle)
      } catch {
        continue
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const record = parsed as Record<string, unknown>
      if (!('size' in record)) continue
      const rest = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'size'))
      update.run(JSON.stringify(rest), row.id)
    }
  })()
}

/**
 * Ajoute `scheduledAt` à `publications` sur une base ouverte avant le
 * planning (issue #195). Même défense que `migrate` pour `clips` : le
 * contrôle porte sur la colonne, pas sur un numéro de version.
 */
function migratePublicationsScheduledAt(db: Database.Database): void {
  const columns = (db.prepare('PRAGMA table_info(publications)').all() as { name: string }[]).map(
    (column) => column.name,
  )
  if (!columns.includes('scheduledAt')) {
    db.exec('ALTER TABLE publications ADD COLUMN scheduledAt INTEGER')
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
  db.exec(SCHEMA)
  migrate(db)
  migrateSelectionSettingKeys(db)
  migrateHookSizeSettingKey(db)
  migrateHookSizeClipColumn(db)
  migratePublicationsScheduledAt(db)
  return db
}

let shared: Database.Database | null = null

/**
 * La connexion du processus. `better-sqlite3` est synchrone et réentrant : une
 * seule connexion suffit, et en ouvrir une par requête coûterait le schéma à
 * chaque fois.
 */
export function getDb(): Database.Database {
  shared ??= openDb()
  return shared
}

/** Referme la connexion partagée. Pour les tests et l'arrêt du serveur. */
export function closeDb(): void {
  shared?.close()
  shared = null
}

/**
 * Ce qui se règle sans toucher au code, tenu en base plutôt qu'en constantes.
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
 *
 * **Un registre, et pas une validation par famille.** Le repérage est la
 * première famille de réglages ; le retour d'usage en annonce deux autres — le
 * fournisseur d'IA par usage (§6.1) et les défauts du hook (§6.3) —, qui
 * porteront des chaînes et des booléens là où celle-ci ne porte que des entiers.
 * Une validation écrite dans `setSetting` aurait donc été réécrite trois fois,
 * et les trois auraient divergé sur ce que « hors bornes » veut dire. Le préfixe
 * de la clé stockée avait été posé en prévoyant exactement cela (PR #64).
 *
 * **Jamais une clé d'API en clair ici**, et ce n'est pas une convention de
 * nommage : les secrets se lisent par `@/server/secrets`, qui les résout depuis
 * 1Password. Une famille « intelligence artificielle » stockera le *modèle* et
 * une *référence* au secret, jamais sa valeur — cette table se relit en clair
 * avec `sqlite3`, et le dépôt est public. Un test tient la règle en refusant
 * qu'un champ du registre porte un nom de secret.
 *
 * **Les noms des cinq champs de repérage sont désormais anglais**, comme le
 * reste des identifiants (`CLAUDE.md`). Ils étaient restés français parce
 * qu'ils sont persistés en clés `selection.<champ>` dans la table, et que les
 * traduire demandait une migration — voir `migrateSelectionSettingKeys` plus
 * bas, qui la porte. Ce champ de la dette de l'issue #73 est soldé ; le reste
 * suit dans une PR séparée.
 */

/**
 * Ce qu'un réglage sait être. Une famille nouvelle en ajoute au besoin.
 *
 * **`color`, et non un `pattern?: RegExp` générique sur `text`** — question
 * attendue en review. Le registre décrit une **forme**, close et à
 * orthographe canonique (voir `COLOR_PATTERN` et sa normalisation en
 * majuscules) ; un `pattern` générique serait l'échappatoire où le prochain
 * champ rangerait une règle métier, et comme ce registre ne porte aucune
 * prose (issue #78), rien n'expliquerait alors le refus. Un type nommé, si.
 *
 * **Pas de type décimal, et c'est une décision prise, pas une simplification**
 * — voir le commentaire de `parseSetting` sur `/^\d+$/` : un type flottant
 * rouvrirait la sérialisation, la précision, et la comparaison d'une valeur
 * arrondie à un seuil inclusif, que `CLAUDE.md` documente comme s'étant
 * réintroduite deux fois à un an d'écart. C'est pour ça que le hook porte
 * `durationMs`, un entier, plutôt que des secondes.
 */
export type SettingFieldType = 'integer' | 'text' | 'boolean' | 'color'

/** Un réglage, décrit une fois : sa forme, ses bornes et ce qu'il veut dire. */
export type SettingField = {
  /** La famille, qui est aussi le préfixe de la clé stockée. */
  family: keyof Settings
  name: string
  type: SettingFieldType
  defaultValue: number | string | boolean
  /**
   * Le plus petit entier acceptable. **Entiers seulement**, et absent ailleurs.
   *
   * Deux lectures de zéro coexistent selon le champ. Sur `maximumClips`, zéro
   * est une valeur signifiante : « aucun plafond ». Sur les cinq champs de la
   * famille `framing`, zéro est le plancher réel du domaine — pas une
   * sentinelle. Ailleurs, zéro est une saisie ratée.
   */
  min?: number
  /**
   * Le plus grand entier acceptable. **Entiers seulement, comme `min`, et
   * absent ailleurs.** `undefined` veut dire « pas de plafond » : les trois
   * familles qui existaient avant le hook (`selection`, `ai`, `ingestion`)
   * n'en portent aucun et restent inchangées. Câblée dans les deux fonctions, avec des
   * sémantiques opposées comme `min` : `parseSetting` ignore une valeur
   * au-delà comme il ignore déjà une valeur en-deçà du plancher ;
   * `validateSetting` lève.
   */
  max?: number
  /**
   * Pour un champ `text`, autorise la chaîne vide comme valeur valide et
   * significative — le seul cas aujourd'hui est `ai.ollamaBaseUrl`, où vide
   * veut dire « résoudre la passerelle WSL à l'exécution » (`CLAUDE.md`).
   * Absent ou faux, un texte vide reste refusé comme avant : un champ oublié,
   * pas un réglage.
   */
  allowEmpty?: boolean
  /**
   * Pour un champ `text`, l'ensemble fermé de valeurs admises — le fournisseur
   * d'un usage d'IA, par exemple. `undefined` laisse passer tout texte dans
   * les bornes de longueur. **C'est l'extension que le contrat de la PR C
   * demande** plutôt qu'une validation posée à côté : un fournisseur est un
   * texte contraint, pas une forme nouvelle.
   */
  enum?: readonly string[]
  /**
   * Pour un champ `text`, une forme au-delà de « non vide, assez court » —
   * aujourd'hui seule `'url'` existe, exigeant une URL absolue `http:`/`https:`
   * via `new URL`. Porté par la grammaire du champ plutôt que par un cas
   * particulier sur `ollamaBaseUrl` : un second champ URL l'hérite sans code
   * neuf.
   */
  format?: 'url'
}

/** `raw` analyse comme une URL absolue `http:`/`https:`. */
function isValidUrl(raw: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(raw).protocol)
  } catch {
    return false
  }
}

/**
 * Ce registre décrit la **forme** d'un réglage — type, défaut, bornes,
 * énumération — jamais sa prose. Le libellé et la description affichés à
 * l'écran vivent dans `src/components/settings/`, qui les reformule pour son
 * propre découpage (par exemple trois usages `ai.*` × fournisseur/modèle,
 * plutôt que sept champs plats). Un `label`/`description` ici serait une
 * seconde source sur la même question, et l'issue #78 a mesuré que les deux
 * avaient déjà divergé sans que personne ne le remarque : aucun code de
 * production ne les lisait, seuls deux tests vérifiaient qu'ils n'étaient pas
 * vides.
 */

/**
 * Les champs de la famille `selection`, **dérivés des défauts** plutôt que
 * réénumérés : une seconde liste tenue à la main diverge du type au premier
 * ajout, et le réglage qui manquerait ne serait jamais relu.
 */
const SELECTION_FIELDS: readonly SettingField[] = (
  Object.keys(DEFAULT_SELECTION_DIMENSIONS) as (keyof SelectionDimensions)[]
).map((name) => ({
  family: 'selection' as const,
  name,
  type: 'integer' as const,
  defaultValue: DEFAULT_SELECTION_DIMENSIONS[name],
  min: name === 'maximumClips' ? 0 : 1,
}))

/**
 * Les champs de la famille `ai`.
 *
 * **Un défaut par fournisseur, jamais un défaut unique** (`DEFAULT_MODEL`,
 * `@/server/llm/defaults`) : un modèle valable chez l'un part en 404 chez
 * l'autre. Les trois usages partent tous sur Gemini par défaut, avec le même
 * modèle que l'ancien `MODÈLE_PAR_DÉFAUT` en dur de `candidates.ts` — le
 * repérage se comporte à l'identique tant que personne n'a touché ce réglage.
 *
 * **Seuls les trois champs `selection*` sont branchés.** `correction*` et
 * `hook*` se règlent et se persistent — le retour d'usage §6.1 les annonce
 * tous les trois —, mais rien ne les lit encore : la correction du transcript
 * et la génération du hook n'existent pas.
 *
 * **Exhaustif par le type, sans prose** : la clé est `keyof AiSettings` et
 * `satisfies` fait échouer le type-check si un champ manque ou si un nom en
 * trop s'ajoute — la même garde que portait `AI_LABELS` avant que #78 ne
 * retire le `label`/`description` qu'il transportait avec elle. `AI_FIELDS`
 * en est dérivé, jamais réénuméré : un champ de `AiSettings` oublié ici ne
 * compile pas.
 */
const AI_FIELD_SHAPES = {
  selectionProvider: {
    type: 'text',
    defaultValue: 'gemini',
    enum: LLM_PROVIDERS,
  },
  selectionModel: {
    type: 'text',
    defaultValue: DEFAULT_MODEL.gemini,
  },
  correctionProvider: {
    type: 'text',
    defaultValue: 'gemini',
    enum: LLM_PROVIDERS,
  },
  correctionModel: {
    type: 'text',
    defaultValue: DEFAULT_MODEL.gemini,
  },
  hookProvider: {
    type: 'text',
    defaultValue: 'gemini',
    enum: LLM_PROVIDERS,
  },
  hookModel: {
    type: 'text',
    defaultValue: DEFAULT_MODEL.gemini,
  },
  ollamaBaseUrl: {
    type: 'text',
    defaultValue: '',
    allowEmpty: true,
    format: 'url',
  },
} satisfies Record<keyof AiSettings, Omit<SettingField, 'family' | 'name'>>

const AI_FIELDS: readonly SettingField[] = (
  Object.keys(AI_FIELD_SHAPES) as (keyof AiSettings)[]
).map((name) => ({ family: 'ai' as const, name, ...AI_FIELD_SHAPES[name] }))

/**
 * Les champs de la famille `ingestion`.
 *
 * **La première famille à exercer le type `boolean`.** Les branches booléennes
 * de `parseSetting` et `validateSetting` existaient déjà, sans famille pour les
 * emprunter : c'est cette généralisation-là qui fait qu'ajouter un réglage se
 * résume à décrire une forme, plutôt qu'à réécrire une validation.
 *
 * **Exhaustif par le type, sans prose**, comme `AI_FIELD_SHAPES` : la clé est
 * `keyof IngestionSettings`, et `satisfies` refuse de compiler s'il manque un
 * champ ou s'il en traîne un de trop.
 */
const INGESTION_FIELD_SHAPES = {
  copySourceLocally: { type: 'boolean', defaultValue: DEFAULT_COPY_SOURCE_LOCALLY },
} satisfies Record<keyof IngestionSettings, Omit<SettingField, 'family' | 'name'>>

const INGESTION_FIELDS: readonly SettingField[] = (
  Object.keys(INGESTION_FIELD_SHAPES) as (keyof IngestionSettings)[]
).map((name) => ({ family: 'ingestion' as const, name, ...INGESTION_FIELD_SHAPES[name] }))

/**
 * Les champs de la famille `hook` — les défauts globaux du hook (retour
 * d'usage §6.3), branchés dès cette PR : l'écran des réglages les enregistre,
 * et `hookStyle` sur `Clip` s'en sert comme base à surcharger.
 *
 * **Même patron qu'`AI_FIELD_SHAPES`, `satisfies` compris** : la clé est
 * `keyof HookSettings`, et un champ oublié ou en trop casse le type-check
 * plutôt que de diverger en silence.
 *
 * **Les défauts viennent de `HOOK_DEFAULTS`** (`@/core/hook`), pas d'une
 * valeur littérale recopiée ici : c'est la même constante que lit
 * `hook-section.tsx` pour son bouton « Revenir à … » et pour ce qu'il affiche
 * pendant le chargement. Deux littéraux à la main auraient fini par diverger
 * au premier défaut changé.
 */
const HOOK_FIELD_SHAPES = {
  enabled: { type: 'boolean', defaultValue: HOOK_DEFAULTS.enabled },
  durationMs: { type: 'integer', defaultValue: HOOK_DEFAULTS.durationMs, ...HOOK_BOUNDS.durationMs },
  font: { type: 'text', defaultValue: HOOK_DEFAULTS.font, enum: HOOK_FONTS },
  sizePermille: {
    type: 'integer',
    defaultValue: HOOK_DEFAULTS.sizePermille,
    ...HOOK_BOUNDS.sizePermille,
  },
  cornerRadiusPermille: {
    type: 'integer',
    defaultValue: HOOK_DEFAULTS.cornerRadiusPermille,
    ...HOOK_BOUNDS.cornerRadiusPermille,
  },
  uppercase: { type: 'boolean', defaultValue: HOOK_DEFAULTS.uppercase },
  position: { type: 'text', defaultValue: HOOK_DEFAULTS.position, enum: HOOK_POSITIONS },
  alignment: { type: 'text', defaultValue: HOOK_DEFAULTS.alignment, enum: HOOK_ALIGNMENTS },
  textColor: { type: 'color', defaultValue: HOOK_DEFAULTS.textColor },
  backgroundColor: { type: 'color', defaultValue: HOOK_DEFAULTS.backgroundColor },
  backgroundOpacity: {
    type: 'integer',
    defaultValue: HOOK_DEFAULTS.backgroundOpacity,
    ...HOOK_BOUNDS.backgroundOpacity,
  },
  enter: { type: 'text', defaultValue: HOOK_DEFAULTS.enter, enum: HOOK_TRANSITIONS },
  exit: { type: 'text', defaultValue: HOOK_DEFAULTS.exit, enum: HOOK_TRANSITIONS },
  badgeColor: { type: 'color', defaultValue: HOOK_DEFAULTS.badgeColor },
  badgeBackground: { type: 'color', defaultValue: HOOK_DEFAULTS.badgeBackground },
} satisfies Record<keyof HookSettings, Omit<SettingField, 'family' | 'name'>>

const HOOK_FIELDS: readonly SettingField[] = (
  Object.keys(HOOK_FIELD_SHAPES) as (keyof HookSettings)[]
).map((name) => ({ family: 'hook' as const, name, ...HOOK_FIELD_SHAPES[name] }))

/**
 * Les six champs `framing` (issue #180) : split-screen (PR #176) et plancher
 * de taille (PR #177), jusqu'ici en dur dans `FRAMING_DEFAULTS`.
 *
 * **Même patron que `HOOK_FIELD_SHAPES`** : `keyof FramingSettings`, défauts
 * et bornes tirés de `FRAMING_SETTINGS_DEFAULTS`/`FRAMING_BOUNDS`, jamais
 * recopiés. **Sans prose** (issue #78) : le libellé de chaque champ vit dans
 * `framing-section.tsx`, pas ici.
 */
const FRAMING_FIELD_SHAPES = {
  splitScreen: { type: 'boolean', defaultValue: FRAMING_SETTINGS_DEFAULTS.splitScreen },
  splitMinShotMs: {
    type: 'integer',
    defaultValue: FRAMING_SETTINGS_DEFAULTS.splitMinShotMs,
    ...FRAMING_BOUNDS.splitMinShotMs,
  },
  splitMinCellWidthPermille: {
    type: 'integer',
    defaultValue: FRAMING_SETTINGS_DEFAULTS.splitMinCellWidthPermille,
    ...FRAMING_BOUNDS.splitMinCellWidthPermille,
  },
  splitBleedTolerancePermille: {
    type: 'integer',
    defaultValue: FRAMING_SETTINGS_DEFAULTS.splitBleedTolerancePermille,
    ...FRAMING_BOUNDS.splitBleedTolerancePermille,
  },
  splitBleedSharePermille: {
    type: 'integer',
    defaultValue: FRAMING_SETTINGS_DEFAULTS.splitBleedSharePermille,
    ...FRAMING_BOUNDS.splitBleedSharePermille,
  },
  sizeFloorPermille: {
    type: 'integer',
    defaultValue: FRAMING_SETTINGS_DEFAULTS.sizeFloorPermille,
    ...FRAMING_BOUNDS.sizeFloorPermille,
  },
} satisfies Record<keyof FramingSettings, Omit<SettingField, 'family' | 'name'>>

const FRAMING_FIELDS: readonly SettingField[] = (
  Object.keys(FRAMING_FIELD_SHAPES) as (keyof FramingSettings)[]
).map((name) => ({ family: 'framing' as const, name, ...FRAMING_FIELD_SHAPES[name] }))

/**
 * Les champs de la famille `publication` : quel connecteur porte chaque
 * plateforme, `auto` par défaut. **Même patron que les familles précédentes**,
 * `satisfies` compris ; l'énumération de chaque champ vient de
 * `PUBLICATION_ADAPTER_CHOICES` (`@/lib/api`), pour ne pas la retenir deux fois.
 */
const PUBLICATION_FIELD_SHAPES = {
  instagram: {
    type: 'text',
    defaultValue: DEFAULT_PUBLICATION_PREFERENCE,
    enum: PUBLICATION_ADAPTER_CHOICES.instagram,
  },
  facebook: {
    type: 'text',
    defaultValue: DEFAULT_PUBLICATION_PREFERENCE,
    enum: PUBLICATION_ADAPTER_CHOICES.facebook,
  },
  tiktok: {
    type: 'text',
    defaultValue: DEFAULT_PUBLICATION_PREFERENCE,
    enum: PUBLICATION_ADAPTER_CHOICES.tiktok,
  },
  youtube: {
    type: 'text',
    defaultValue: DEFAULT_PUBLICATION_PREFERENCE,
    enum: PUBLICATION_ADAPTER_CHOICES.youtube,
  },
  // Pas d'`enum` ici : la forme `HH:MM[,HH:MM]*` n'est pas un ensemble fermé de
  // littéraux. `sanitizeScheduleHours` la valide à la lecture, plus bas.
  scheduleHours: { type: 'text', defaultValue: DEFAULT_SCHEDULE_HOURS },
  // `true` par défaut : la tâche planifiée existe pour publier. Un défaut à
  // `false` ferait d'une installation neuve un scheduler qui tourne sans
  // rien faire tout en paraissant installé — le silence que ce champ existe
  // pour bannir (issue publication-scheduler, PR F).
  autoPublish: { type: 'boolean', defaultValue: true },
} satisfies Record<keyof PublicationSettings, Omit<SettingField, 'family' | 'name'>>

const PUBLICATION_FIELDS: readonly SettingField[] = (
  Object.keys(PUBLICATION_FIELD_SHAPES) as (keyof PublicationSettings)[]
).map((name) => ({ family: 'publication' as const, name, ...PUBLICATION_FIELD_SHAPES[name] }))

/** Tous les réglages que l'application connaît. L'écran de réglages se lit ici. */
export const SETTING_FIELDS: readonly SettingField[] = [
  ...SELECTION_FIELDS,
  ...AI_FIELDS,
  ...INGESTION_FIELDS,
  ...HOOK_FIELDS,
  ...FRAMING_FIELDS,
  ...PUBLICATION_FIELDS,
]

/** Le champ décrit par une famille et un nom, ou `undefined` s'il n'existe pas. */
export function settingField(family: string, name: string): SettingField | undefined {
  return SETTING_FIELDS.find((f) => f.family === family && f.name === name)
}

/**
 * Les familles que le registre connaît.
 *
 * **Elle existe pour qu'une famille inconnue *vide* soit refusée elle aussi.**
 * Contrôler le champ suffisait tant que le patch en portait un : `{"hook": {}}`
 * ne déclenchait aucun tour de boucle, donc aucun contrôle, et le `PUT`
 * répondait 200 sur une famille qui n'existe pas — exactement le silence que le
 * refus des clés inconnues existe pour fermer, une couche plus haut.
 * (relevé par Codex)
 */
const FAMILIES = new Set<string>(SETTING_FIELDS.map((f) => f.family))

/** La clé telle qu'elle est stockée. Préfixée par la famille. */
function storedKey(field: SettingField): string {
  return `${field.family}.${field.name}`
}

/**
 * Une valeur refusée à l'écriture. La frontière HTTP en fait un 400.
 *
 * Une classe et non une `Error` nue : `statusFor` doit pouvoir la reconnaître
 * sans lire son message, sinon le refus d'une saisie ressortirait en 500 et
 * enverrait chercher un défaut du serveur là où il n'y en a pas.
 */
export class InvalidSettingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSettingError'
  }
}

/** De combien de caractères un réglage de texte a besoin, et pas un de plus. */
const TEXT_MAX = 2_048

/**
 * La forme canonique d'une couleur du registre : `#` puis six chiffres
 * hexadécimaux, **majuscules à la lecture comme à l'écriture**. Exportée pour
 * que `PATCH /api/clips/:id` valide `hookStyle.textColor`/`backgroundColor`
 * avec exactement la même forme que le registre — une seule source, pas une
 * regex réécrite à la main de l'autre côté.
 */
export const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/

/** Longueur au-delà de laquelle la valeur brute d'un avertissement est tronquée. */
const RAW_LOG_MAX = 80

/**
 * Avertit qu'une ligne existante ne s'est pas relue, et rend `undefined` pour
 * que l'appelant retombe sur le défaut. **N'existe que pour une ligne qui
 * existe déjà** : `effectiveSettings` n'appelle `parseSetting` que sur un
 * `raw` tiré de la table, jamais sur un champ absent — une ligne absente est
 * l'expression normale d'un défaut et ne doit rien dire.
 */
function warnRejected(field: SettingField, raw: string): undefined {
  const shown = raw.length > RAW_LOG_MAX ? `${raw.slice(0, RAW_LOG_MAX)}…` : raw
  console.warn(
    `Réglage ${storedKey(field)} : valeur stockée invalide (${JSON.stringify(shown)}), retour au défaut ${JSON.stringify(field.defaultValue)}.`,
  )
  return undefined
}

/**
 * Relit une valeur stockée, ou rend `undefined` si elle n'a aucun sens.
 *
 * **Exportée avec `validateSetting` parce que les familles qui exerceront les
 * types `text` et `boolean` n'existent pas encore.** Ces deux branches sont la
 * généralisation elle-même — ce qui fait qu'une famille nouvelle décrit ses
 * champs au lieu de réécrire sa validation —, et sans elles le registre ne
 * serait qu'une table d'entiers déguisée. Les laisser sans test jusqu'à ce
 * qu'une famille arrive reviendrait à les découvrir fausses le jour où quelqu'un
 * s'en sert.
 *
 * **Une suite de chiffres, ou rien** — ni `parseInt`, ni `Number` seul, qui ont
 * chacun leurs largesses. `parseInt` lit ce qu'il peut et jette le reste :
 * `"4.5"` devenait 4 et `"7abc"` devenait 7, si bien qu'une valeur corrompue
 * *modifiait* le repérage au lieu d'être ignorée comme `effectiveSettings`
 * l'annonce. Une saisie à moitié comprise est le pire des trois cas — pire que
 * refusée, pire qu'acceptée telle quelle, parce que personne ne peut deviner le
 * nombre qui a fini par s'appliquer. (relevé par Copilot)
 *
 * `Number` seul ne suffit pas non plus : la chaîne vide et les blancs valent
 * zéro, `"0x10"` vaut seize.
 */
export function parseSetting(
  field: SettingField,
  raw: string,
): number | string | boolean | undefined {
  switch (field.type) {
    case 'integer': {
      if (!/^\d+$/.test(raw.trim())) return warnRejected(field, raw)
      const value = Number(raw.trim())
      if (!Number.isSafeInteger(value) || value < (field.min ?? 0)) return warnRejected(field, raw)
      // **Ignorée comme le plancher, jamais levée** : c'est `parseSetting`,
      // la lecture tolérante. `field.max` est absent partout sauf pour le
      // hook, donc les familles existantes ne voient jamais cette branche.
      if (field.max !== undefined && value > field.max) return warnRejected(field, raw)
      return value
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : warnRejected(field, raw)
    case 'color': {
      // Même normalisation qu'à l'écriture (`validateSetting`) : la lecture
      // et l'écriture doivent s'accorder sur ce qu'une valeur stockée veut
      // dire, exactement comme pour les trois autres types.
      const trimmed = raw.trim()
      return COLOR_PATTERN.test(trimmed) ? trimmed.toUpperCase() : warnRejected(field, raw)
    }
    case 'text': {
      // **Les mêmes bornes que `validateSetting`, et c'est le contrat.** Une
      // valeur stockée vide, blanche ou trop longue passait ici alors que
      // l'écriture la refuse : le lecteur annonce qu'une valeur invalide est
      // ignorée au profit du défaut, et il en laissait passer trois formes.
      // Une table éditée à la main avec `sqlite3` est le seul chemin qui y mène,
      // et c'est précisément le chemin qu'on ne contrôle pas.
      // (relevé par Copilot)
      //
      // **`allowEmpty` est l'exception nommée, pas un relâchement général** :
      // `ai.ollamaBaseUrl` est le seul champ qui la porte, et vide y est une
      // valeur à part entière plutôt qu'un champ oublié.
      if (field.allowEmpty && raw === '') return raw
      if (raw.trim() === '' || raw.length > TEXT_MAX) return warnRejected(field, raw)
      if (field.enum !== undefined && !field.enum.includes(raw)) return warnRejected(field, raw)
      // **Sur le chemin de lecture aussi** : une ligne existante écrite avant
      // que le champ ne porte `format: 'url'` — ou modifiée à la main — reste
      // sinon acceptée pour toujours, alors que l'écriture la refuse depuis.
      if (field.format === 'url' && !isValidUrl(raw)) return warnRejected(field, raw)
      return raw
    }
  }
}

/** La forme stockée d'une valeur déjà validée. */
function serialize(value: number | string | boolean): string {
  return typeof value === 'string' ? value : String(value)
}

/**
 * Valide une valeur reçue, ou lève.
 *
 * **L'inverse exact de `parseSetting`, et c'est délibéré** : là, une valeur
 * illisible est ignorée parce que le repérage tourne derrière une transcription
 * qui a coûté quarante minutes ; ici quelqu'un attend une réponse, et lui dire
 * non tout de suite vaut mieux que de l'ignorer plus tard.
 */
export function validateSetting(
  field: SettingField,
  value: unknown,
): number | string | boolean {
  const key = storedKey(field)
  switch (field.type) {
    case 'integer': {
      const min = field.min ?? 0
      // `isSafeInteger` et non `isInteger`, **la même règle que le lecteur** :
      // `isInteger(1e100)` est vrai, `String(1e100)` donne `"1e+100"`, et
      // `parseSetting` refuse cette écriture. Une écriture réussie se relisait
      // donc en défaut, ce qui est le pire des retours — l'écran de réglages
      // aurait juré avoir enregistré. (relevé par Copilot)
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new InvalidSettingError(
          `Réglage ${key} : un entier supérieur ou égal à ${min} est attendu, reçu ${JSON.stringify(value)}.`,
        )
      }
      // **Lève, contrairement à `parseSetting`** : c'est l'inverse exact, et
      // c'est le contrat de cette fonction — quelqu'un attend une réponse.
      if (field.max !== undefined && value > field.max) {
        throw new InvalidSettingError(
          `Réglage ${key} : un entier au plus égal à ${field.max} est attendu, reçu ${JSON.stringify(value)}.`,
        )
      }
      return value
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new InvalidSettingError(
          `Réglage ${key} : un booléen est attendu, reçu ${JSON.stringify(value)}.`,
        )
      }
      return value
    }
    case 'color': {
      if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
        throw new InvalidSettingError(
          `Réglage ${key} : une couleur #RRGGBB est attendue, reçu ${JSON.stringify(value)}.`,
        )
      }
      return value.toUpperCase()
    }
    case 'text': {
      const isEmpty = value === ''
      if (
        typeof value !== 'string' ||
        value.length > TEXT_MAX ||
        (isEmpty && !field.allowEmpty) ||
        (!isEmpty && value.trim() === '')
      ) {
        throw new InvalidSettingError(
          field.allowEmpty
            ? `Réglage ${key} : un texte d'au plus ${TEXT_MAX} caractères est attendu (vide accepté).`
            : `Réglage ${key} : un texte non vide d'au plus ${TEXT_MAX} caractères est attendu.`,
        )
      }
      if (field.enum !== undefined && !field.enum.includes(value)) {
        throw new InvalidSettingError(
          `Réglage ${key} : une valeur parmi ${field.enum.join(', ')} est attendue, reçu ${JSON.stringify(value)}.`,
        )
      }
      // **Vide n'est jamais une URL invalide** : quand `allowEmpty` l'a
      // laissé passer, il veut dire « non configuré », un état légitime que
      // `isValidUrl` rejetterait sinon comme n'importe quel autre texte creux.
      if (field.format === 'url' && !isEmpty && !isValidUrl(value)) {
        throw new InvalidSettingError(
          `Réglage ${key} : une URL absolue http:// ou https:// est attendue, reçu ${JSON.stringify(value)}.`,
        )
      }
      return value
    }
  }
}

const SCHEDULE_HOUR_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Filtre `publication.scheduleHours` à ses éléments `HH:MM`, quatre au plus.
 *
 * Le registre (`parseSetting`) ne sait valider qu'un texte non vide, pas cette
 * forme composite — une valeur comme `19:00,bogus` la traverserait donc
 * intacte. Une entrée mal formée est ignorée plutôt que de faire échouer tout
 * le champ, et une liste qui ne survit à rien retombe sur le défaut.
 */
export function sanitizeScheduleHours(raw: string): string {
  const kept = raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => SCHEDULE_HOUR_PATTERN.test(h))
    .slice(0, 4)
  return kept.length > 0 ? kept.join(',') : DEFAULT_SCHEDULE_HOURS
}

/**
 * Les réglages effectifs : ce que porte la base, complété par les défauts.
 *
 * **Ne lève jamais, et c'est délibéré.** Le repérage tourne en tâche de fond
 * derrière une transcription qui a coûté quarante minutes ; le faire échouer sur
 * une valeur mal saisie coûterait bien plus cher que de retomber sur le défaut.
 * Une valeur illisible ou hors bornes est donc ignorée **comme si elle était
 * absente** — exactement ce que `batchSize` réserve à `SCORE_BATCH`
 * (`src/server/steps/candidates.ts`).
 */
export function effectiveSettings(db: Database.Database): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string
  }[]
  const stored = new Map(rows.map((row) => [row.key, row.value]))

  const families = {
    selection: { ...DEFAULT_SELECTION_DIMENSIONS },
    // Dérivé de `AI_FIELDS`, comme `SELECTION_FIELDS` l'est de
    // `DEFAULT_SELECTION_DIMENSIONS` : une seconde liste de défauts tenue à la main
    // diverge du registre au premier champ ajouté.
    ai: Object.fromEntries(AI_FIELDS.map((f) => [f.name, f.defaultValue])) as unknown as AiSettings,
    ingestion: Object.fromEntries(
      INGESTION_FIELDS.map((f) => [f.name, f.defaultValue]),
    ) as unknown as IngestionSettings,
    // Même dérivation, pour la même raison, pour les onze défauts du hook.
    hook: Object.fromEntries(
      HOOK_FIELDS.map((f) => [f.name, f.defaultValue]),
    ) as unknown as HookSettings,
    // Même dérivation, pour les six défauts globaux du cadrage.
    framing: Object.fromEntries(
      FRAMING_FIELDS.map((f) => [f.name, f.defaultValue]),
    ) as unknown as FramingSettings,
    // Même dérivation, pour les quatre défauts `auto` de la publication.
    publication: Object.fromEntries(
      PUBLICATION_FIELDS.map((f) => [f.name, f.defaultValue]),
    ) as unknown as PublicationSettings,
  }
  for (const field of SETTING_FIELDS) {
    const raw = stored.get(storedKey(field))
    if (raw === undefined) continue
    const value = parseSetting(field, raw)
    if (value === undefined) continue
    // L'assertion vaut ce que vaut le registre : le seul chemin qui écrive une
    // valeur ici passe par `validateSetting`, qui la contraint au type du champ.
    ;(families[field.family] as Record<string, unknown>)[field.name] = value
  }
  families.publication.scheduleHours = sanitizeScheduleHours(families.publication.scheduleHours)
  return families
}

/**
 * Ce qui dimensionne le repérage. La vue que `runCandidates` consomme.
 *
 * Une projection d'`effectiveSettings`, et non un second lecteur : deux façons
 * de lire la même table finiraient par ne plus s'accorder sur ce qu'une valeur
 * corrompue vaut.
 */
export function getSettings(db: Database.Database): SelectionDimensions {
  return effectiveSettings(db).selection
}

/**
 * Faut-il fabriquer une copie de travail locale avant d'exploiter la source ?
 *
 * Une projection d'`effectiveSettings`, comme `getSettings` : la question se
 * pose à quatre endroits — l'ingestion, le plan d'exécution, l'entrée des étapes
 * et l'export —, et quatre lectures directes de la table finiraient par ne plus
 * s'accorder sur ce qu'une valeur corrompue vaut.
 *
 * **Elle accepte `null`, et rend alors le défaut du registre.** Les tests et les
 * scripts passent `db: null` pour dire « n'ouvre aucune base » ; leur laisser
 * écrire `?? true` de leur côté poserait le défaut une seconde fois, à
 * l'endroit exact où il divergerait sans que rien ne le signale.
 */
export function copiesSourceLocally(db: Database.Database | null): boolean {
  if (db === null) return INGESTION_FIELD_SHAPES.copySourceLocally.defaultValue
  return effectiveSettings(db).ingestion.copySourceLocally
}

/**
 * Applique un patch partiel et rend les réglages **résultants**.
 *
 * **Refuse une clé inconnue au lieu de la stocker.** Une clé mal orthographiée
 * s'écrirait sans bruit, ne serait jamais relue, et l'écran de réglages
 * afficherait le défaut en jurant avoir enregistré.
 *
 * **Rien n'est écrit tant que tout n'est pas validé.** Un patch dont le
 * troisième champ est hors bornes ne doit pas laisser les deux premiers en base :
 * l'écran recevrait un 400 et afficherait l'état d'avant, alors que la moitié de
 * sa saisie serait passée.
 *
 * **Et changer un réglage ne recalcule rien** (retour d'usage §6.1 et §11) : les
 * émissions déjà analysées gardent leurs propositions, un recalcul reste une
 * action explicite. Rien ici ne touche à la table `clips` ni à un artefact.
 */
export function applySettings(db: Database.Database, patch: unknown): Settings {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new InvalidSettingError('Le corps attendu est un objet de familles de réglages.')
  }

  const toWrite: { key: string; value: string }[] = []
  for (const [family, fields] of Object.entries(patch as Record<string, unknown>)) {
    if (fields === undefined) continue
    if (!FAMILIES.has(family)) {
      throw new InvalidSettingError(`Famille de réglages inconnue : ${family}`)
    }
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      throw new InvalidSettingError(
        `Famille de réglages ${JSON.stringify(family)} : un objet est attendu.`,
      )
    }
    for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
      if (value === undefined) continue
      const field = settingField(family, name)
      if (field === undefined) {
        throw new InvalidSettingError(`Réglage inconnu : ${family}.${name}`)
      }
      toWrite.push({ key: storedKey(field), value: serialize(validateSetting(field, value)) })
    }
  }

  const insert = db.prepare(
    `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
  )
  const now = Date.now()
  db.transaction(() => {
    for (const { key, value } of toWrite) insert.run(key, value, now)
  })()

  return effectiveSettings(db)
}

/**
 * Écrit un réglage de repérage. Le raccourci des tests et des scripts.
 *
 * `applySettings` est la porte de la route, celle-ci est la porte du code : elle
 * nomme un champ typé plutôt qu'une paire famille/clé, donc une faute de frappe
 * y est une erreur de compilation. Les deux passent par la même validation.
 */
export function setSetting(
  db: Database.Database,
  field: keyof SelectionDimensions,
  value: number,
): void {
  applySettings(db, { selection: { [field]: value } })
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

/**
 * La forme d'un style de hook surchargé, **une seule fois** : `PATCH
 * /api/clips/:id` la réutilise en stricte pour refuser une clé inconnue ou
 * hors bornes, et `readHookStyle` ci-dessous en tolérante pour la relecture
 * d'une colonne abîmée. Les bornes viennent de `HOOK_BOUNDS`, la même source
 * que la famille `hook` du registre plus haut — `CLAUDE.md`, « une seule
 * source pour les bornes, pas une liste réécrite à la main ».
 *
 * **Les couleurs se normalisent en majuscules ici aussi**, par le même
 * `.transform` que `parseSetting`/`validateSetting` appliquent à la famille
 * `hook` (`COLOR_PATTERN`, forme canonique documentée juste au-dessus). Un
 * schéma qui ne ferait que valider le motif laisserait passer `#a1b2c3` tel
 * quel, brisant l'invariant « majuscules à la lecture comme à l'écriture »
 * pour toute surcharge par clip. (relevé par Copilot)
 */
export const HOOK_STYLE_SHAPE = {
  enabled: z.boolean(),
  durationMs: z.number().int().min(HOOK_BOUNDS.durationMs.min).max(HOOK_BOUNDS.durationMs.max),
  font: z.enum(HOOK_FONTS),
  sizePermille: z.number().int().min(HOOK_BOUNDS.sizePermille.min).max(HOOK_BOUNDS.sizePermille.max),
  cornerRadiusPermille: z
    .number()
    .int()
    .min(HOOK_BOUNDS.cornerRadiusPermille.min)
    .max(HOOK_BOUNDS.cornerRadiusPermille.max),
  uppercase: z.boolean(),
  position: z.enum(HOOK_POSITIONS),
  alignment: z.enum(HOOK_ALIGNMENTS),
  textColor: z
    .string()
    .regex(COLOR_PATTERN)
    .transform((v) => v.toUpperCase()),
  backgroundColor: z
    .string()
    .regex(COLOR_PATTERN)
    .transform((v) => v.toUpperCase()),
  backgroundOpacity: z
    .number()
    .int()
    .min(HOOK_BOUNDS.backgroundOpacity.min)
    .max(HOOK_BOUNDS.backgroundOpacity.max),
  enter: z.enum(HOOK_TRANSITIONS),
  exit: z.enum(HOOK_TRANSITIONS),
  badgeColor: z
    .string()
    .regex(COLOR_PATTERN)
    .transform((v) => v.toUpperCase()),
  badgeBackground: z
    .string()
    .regex(COLOR_PATTERN)
    .transform((v) => v.toUpperCase()),
} satisfies Record<keyof HookSettings, z.ZodType>

/**
 * Le style qu'un clip surcharge, relu **sans jamais lever**. Une colonne
 * abîmée retombe sur `{}` avec un avertissement — comme `lireTokens` pour
 * `seqs`, et pour la même raison : une valeur illisible ne doit pas rendre un
 * clip entier illisible.
 *
 * **Le `console.warn` ne couvre que l'échec de `JSON.parse`**, exactement
 * comme `lireTokens` : une forme reconnaissable comme JSON mais dont une clé
 * est hors bornes, au mauvais type ou simplement inconnue retombe sur `{}` en
 * silence, via le `.catch({})` du schéma — le même partage que `lireTokens`
 * applique déjà entre son `try/catch` et son filtrage silencieux par type.
 *
 * **`z.strictObject`, pas `z.object`.** Un schéma non strict tronquerait une
 * clé inconnue au lieu de rejeter l'objet entier — `{ size: 72, chapeau: true }`
 * relirait `{ size: 72 }` plutôt que `{}`, un comportement partiel que les deux
 * autres cas de corruption (valeur hors bornes, clé seule inconnue) refusent
 * déjà : la relecture est tout ou rien, jamais un filtrage clé par clé.
 */
const HOOK_STYLE_SCHEMA = z.strictObject(HOOK_STYLE_SHAPE).partial().catch({})

function readHookStyle(raw: string, clipId: string): Partial<HookSettings> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    console.warn(`Style de hook illisible pour le clip ${clipId} :`, cause)
    return {}
  }
  return HOOK_STYLE_SCHEMA.parse(parsed)
}

/**
 * La forme d'une surcharge de cadrage par clip, sur le patron de
 * `HOOK_STYLE_SHAPE` : les bornes viennent de `FRAMING_BOUNDS`, la même
 * source que la famille `framing` du registre plus haut.
 */
export const FRAMING_STYLE_SHAPE = {
  splitScreen: z.boolean(),
  splitMinShotMs: z
    .number()
    .int()
    .min(FRAMING_BOUNDS.splitMinShotMs.min)
    .max(FRAMING_BOUNDS.splitMinShotMs.max),
  splitMinCellWidthPermille: z
    .number()
    .int()
    .min(FRAMING_BOUNDS.splitMinCellWidthPermille.min)
    .max(FRAMING_BOUNDS.splitMinCellWidthPermille.max),
  splitBleedTolerancePermille: z
    .number()
    .int()
    .min(FRAMING_BOUNDS.splitBleedTolerancePermille.min)
    .max(FRAMING_BOUNDS.splitBleedTolerancePermille.max),
  splitBleedSharePermille: z
    .number()
    .int()
    .min(FRAMING_BOUNDS.splitBleedSharePermille.min)
    .max(FRAMING_BOUNDS.splitBleedSharePermille.max),
  sizeFloorPermille: z
    .number()
    .int()
    .min(FRAMING_BOUNDS.sizeFloorPermille.min)
    .max(FRAMING_BOUNDS.sizeFloorPermille.max),
} satisfies Record<keyof FramingSettings, z.ZodType>

const FRAMING_STYLE_SCHEMA = z.strictObject(FRAMING_STYLE_SHAPE).partial().catch({})

/**
 * Le style de cadrage qu'un clip surcharge, relu **sans jamais lever** — même
 * contrat que `readHookStyle` juste au-dessus : un `JSON.parse` raté se dit
 * (`console.warn`), une clé hors bornes ou inconnue retombe sur `{}` en
 * silence via le `.catch({})` du schéma.
 */
function readFramingStyle(raw: string, clipId: string): Partial<FramingSettings> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    console.warn(`Style de cadrage illisible pour le clip ${clipId} :`, cause)
    return {}
  }
  return FRAMING_STYLE_SCHEMA.parse(parsed)
}

/** La forme brute d'une ligne de `clips`, avant reconversion. */
type LineClip = {
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
  hookText: string
  hookBadge: string
  hookStyle: string
  framingStyle: string
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
const STATUSES: Record<ClipStatus, true> = {
  candidate: true,
  kept: true,
  discarded: true,
  exported: true,
}

function valueAdmitted<T extends string>(admitted: Record<T, true>, raw: string, field: string): T {
  if (!Object.hasOwn(admitted, raw)) {
    throw new Error(`Valeur inattendue en base pour ${field} : ${JSON.stringify(raw)}`)
  }
  return raw as T
}

function analyzeSegments(json: string, clipId: string): Segment[] {
  const raw: unknown = JSON.parse(json)
  if (!Array.isArray(raw)) throw new Error(`segments n'est pas une liste (clip ${clipId})`)
  return raw.map((s) => {
    const seg = s as Partial<Segment>
    if (typeof seg?.start !== 'number' || typeof seg?.end !== 'number') {
      throw new Error(`segment illisible (clip ${clipId}) : ${JSON.stringify(s)}`)
    }
    return { start: seg.start, end: seg.end }
  })
}

function clipSinceLine(line: LineClip): Clip {
  return {
    id: line.id,
    projectId: line.projectId,
    segments: analyzeSegments(line.segments, line.id),
    ratio: valueAdmitted(RATIOS, line.ratio, 'ratio'),
    cropX: line.cropX,
    // `Boolean(0)` et `Boolean(1)`, mais surtout pas la ligne brute : renvoyer
    // un `0` là où le reste du code attend un booléen marche partout sauf dans
    // un `JSON.stringify`, qui l'expose tel quel à l'interface.
    captions: line.captions !== 0,
    branding: line.branding !== 0,
    title: line.title,
    description: line.description,
    status: valueAdmitted(STATUSES, line.status, 'status'),
    pass: line.pass,
    hookText: line.hookText,
    hookBadge: line.hookBadge,
    hookStyle: readHookStyle(line.hookStyle, line.id),
    framingStyle: readFramingStyle(line.framingStyle, line.id),
  }
}

function lineSinceClip(clip: Clip): LineClip {
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
    hookText: clip.hookText,
    hookBadge: clip.hookBadge,
    hookStyle: JSON.stringify(clip.hookStyle),
    framingStyle: JSON.stringify(clip.framingStyle),
  }
}

// **Trois endroits, pas un**, pour `hookText`/`hookBadge`/`hookStyle`/
// `framingStyle` : la liste des colonnes, le `VALUES` et le `DO UPDATE SET`.
// Oublier le troisième laisserait un `putClip` sur un clip existant garder le
// hook ou le cadrage d'avant sans un mot.
const INSERT_CLIP = `
  INSERT INTO clips (id, projectId, segments, ratio, cropX, captions, branding,
                     title, description, status, pass, hookText, hookBadge, hookStyle,
                     framingStyle)
  VALUES (@id, @projectId, @segments, @ratio, @cropX, @captions, @branding,
          @title, @description, @status, @pass, @hookText, @hookBadge, @hookStyle,
          @framingStyle)
  ON CONFLICT(id) DO UPDATE SET
    segments     = excluded.segments,
    ratio        = excluded.ratio,
    cropX        = excluded.cropX,
    captions     = excluded.captions,
    branding     = excluded.branding,
    title        = excluded.title,
    description  = excluded.description,
    status       = excluded.status,
    pass         = excluded.pass,
    hookText     = excluded.hookText,
    hookBadge    = excluded.hookBadge,
    hookStyle    = excluded.hookStyle,
    framingStyle = excluded.framingStyle`

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
function verifyProperty(db: Database.Database, line: LineClip): void {
  const existant = db.prepare('SELECT projectId FROM clips WHERE id = ?').get(line.id) as
    | { projectId: string }
    | undefined
  if (existant && existant.projectId !== line.projectId) {
    throw new Error(
      `Le clip ${line.id} appartient au projet ${existant.projectId} : un identifiant de clip est unique pour toute la base, il ne change pas de projet.`,
    )
  }
}

/** Écrit un clip. C'est ce que fait `PATCH /api/clips/:id` après relecture. */
export function putClip(db: Database.Database, clip: Clip): void {
  const line = lineSinceClip(clip)
  verifyProperty(db, line)
  db.prepare(INSERT_CLIP).run(line)
}

/** Le numéro d'ordre du dernier geste appliqué, par champ de `Clip`. */
export type TokensClip = Partial<Record<keyof Clip, number>>

function lireTokens(db: Database.Database, id: string): TokensClip {
  const line = db.prepare('SELECT seqs FROM clips WHERE id = ?').get(id) as
    | { seqs: string }
    | undefined
  if (line === undefined) return {}
  try {
    const read: unknown = JSON.parse(line.seqs)
    // Un objet, et des nombres dedans. Une colonne abîmée ne doit pas faire
    // écarter des écritures parfaitement fraîches en comparant à `undefined`
    // devenu `NaN` : on repart de zéro, ce qui rend simplement l'ordre au
    // hasard de l'arrivée — l'état d'avant cette colonne.
    if (typeof read !== 'object' || read === null || Array.isArray(read)) return {}
    const tokens: TokensClip = {}
    for (const [field, value] of Object.entries(read)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        tokens[field as keyof Clip] = value
      }
    }
    return tokens
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
export function floorDOrder(db: Database.Database, id: string): number {
  return Math.max(0, ...Object.values(lireTokens(db, id)))
}

/** Le résultat d'une écriture ordonnée. */
export type WriteOrdered = {
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
export function putClipOrdered(
  db: Database.Database,
  clip: Clip,
  fields: readonly (keyof Clip)[],
  seq: number,
): WriteOrdered | undefined {
  // La transaction tient ensemble la lecture des jetons, la comparaison et les
  // deux écritures. Sans elle, la fenêtre qu'on ferme se rouvrirait entre la
  // comparaison et la ligne.
  const write = db.transaction((): WriteOrdered | undefined => {
    const current = getClip(db, clip.id)
    if (current === undefined) return undefined

    const tokens = lireTokens(db, clip.id)
    const discarded = fields.filter((field) => (tokens[field] ?? 0) > seq)

    // On part du clip fusionné et on **rétablit** les champs écartés : les
    // champs que le client n'a pas envoyés gardent ainsi le traitement que
    // l'appelant leur a fait subir — la normalisation des segments, notamment,
    // qui s'applique à chaque écriture et pas seulement quand ils changent.
    const next = restore(clip, current, discarded)
    putClip(db, next)

    const kept = fields.filter((field) => !discarded.includes(field))
    const toDayOrUnchanged: TokensClip = { ...tokens }
    if (kept.length > 0) {
      for (const field of kept) toDayOrUnchanged[field] = seq
      db.prepare('UPDATE clips SET seqs = @seqs WHERE id = @id').run({
        id: clip.id,
        seqs: JSON.stringify(toDayOrUnchanged),
      })
    }

    const floor = Math.max(0, ...Object.values(toDayOrUnchanged))
    return { clip: next, applied: discarded.length === 0, seq: floor }
  })
  return write()
}

/**
 * `cible` avec les champs nommés repris de `source`.
 *
 * L'`Object.assign` sur une clé calculée n'est pas un détour : TypeScript refuse
 * `copie[champ] = source[champ]` quand `champ` est une union de clés, alors que
 * l'affectation est correcte pour chacune prise séparément.
 */
function restore(target: Clip, source: Clip, fields: readonly (keyof Clip)[]): Clip {
  const copy: Clip = { ...target }
  for (const field of fields) Object.assign(copy, { [field]: source[field] })
  return copy
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
  const seen = new Set<string>()
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
    if (seen.has(clip.id)) {
      throw new Error(`Le clip ${clip.id} apparaît deux fois dans le même lot.`)
    }
    seen.add(clip.id)
  }

  const lines = clips.map((clip) => lineSinceClip({ ...clip, projectId }))
  const write = db.transaction(() => {
    // **Les jetons d'ordre des survivants, relevés avant le DELETE.**
    //
    // `INSERT_CLIP` ne porte pas `seqs`, donc chaque survivant repartirait de
    // `{}` : une écriture ancienne encore en vol arriverait alors devant un
    // champ sans mémoire, passerait pour fraîche, et écraserait un geste plus
    // récent — #21 rouvert par une passe de repérage. La fenêtre est étroite,
    // mais c'est exactement celle que ce jeton existe pour fermer, et la
    // relever coûte une requête. (relevé par Copilot)
    const tokens = new Map(
      (
        db.prepare('SELECT id, seqs FROM clips WHERE projectId = ?').all(projectId) as {
          id: string
          seqs: string
        }[]
      ).map((line) => [line.id, line.seqs]),
    )

    // **Les publications des survivants, relevées avant le DELETE.**
    //
    // `publications.clipId` porte `ON DELETE CASCADE` (`src/server/db.ts:157`) :
    // sans ce relevé, le `DELETE` qui suit efface aussi l'état `published`
    // d'un clip qui ressort du même repérage sous le même identifiant, et
    // permet une republication sans `force` sur une plateforme déjà en ligne.
    // (relevé par Copilot)
    const publications = new Map<string, PublicationRow[]>()
    for (const clip of clips) {
      const rows = getPublications(db, clip.id)
      if (rows.length > 0) publications.set(clip.id, rows)
    }

    db.prepare('DELETE FROM clips WHERE projectId = ?').run(projectId)
    const insert = db.prepare(INSERT_CLIP)
    const restoreTokens = db.prepare('UPDATE clips SET seqs = @seqs WHERE id = @id')
    for (const line of lines) {
      // Après le DELETE : ce qui reste sous cet identifiant appartient
      // forcément à un autre projet. La transaction annule tout le lot.
      verifyProperty(db, line)
      insert.run(line)
      const seqs = tokens.get(line.id)
      if (seqs !== undefined) restoreTokens.run({ id: line.id, seqs })
      for (const row of publications.get(line.id) ?? []) upsertPublication(db, row)
    }
  })
  write()
}

export function getClips(db: Database.Database, projectId: string): Clip[] {
  const lines = db
    .prepare('SELECT * FROM clips WHERE projectId = ? ORDER BY pass, id')
    .all(projectId) as LineClip[]
  return lines.map(clipSinceLine)
}

export function getClip(db: Database.Database, id: string): Clip | undefined {
  const line = db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as LineClip | undefined
  return line && clipSinceLine(line)
}

/** Les publications d'un clip, dans un ordre stable — celui des plateformes déclarées en base. */
export function getPublications(db: Database.Database, clipId: string): PublicationRow[] {
  return db
    .prepare('SELECT * FROM publications WHERE clipId = ? ORDER BY platform')
    .all(clipId) as PublicationRow[]
}

/**
 * Pose ou met à jour une ligne. `createdAt` ne fait pas partie du `SET` : une
 * mise à jour ne doit pas réécrire la date de première réservation.
 */
export function upsertPublication(db: Database.Database, row: PublicationRow): void {
  db.prepare(
    `INSERT INTO publications
       (clipId, platform, status, remoteId, remoteUrl, requestId, error, publishedFingerprint, createdAt, updatedAt, scheduledAt)
     VALUES (@clipId, @platform, @status, @remoteId, @remoteUrl, @requestId, @error, @publishedFingerprint, @createdAt, @updatedAt, @scheduledAt)
     ON CONFLICT(clipId, platform) DO UPDATE SET
       status               = excluded.status,
       remoteId             = excluded.remoteId,
       remoteUrl            = excluded.remoteUrl,
       requestId            = excluded.requestId,
       error                = excluded.error,
       publishedFingerprint = excluded.publishedFingerprint,
       updatedAt            = excluded.updatedAt`,
  ).run(row)
}

/**
 * Les clips exportés, toutes émissions confondues (spec planning §5.3).
 *
 * **Sans filtre de projet**, à la différence de `getClips` : le planning est
 * transversal. L'ordre lexicographique sur `id` suffit — un `clipId` préfixe
 * celui de son `projectId`, qui commence par la date de tournage — sans qu'il
 * faille joindre `clips` à `projects` pour trier par date.
 */
export function listExportedClips(db: Database.Database): Clip[] {
  const lines = db.prepare("SELECT * FROM clips WHERE status = 'exported' ORDER BY id").all() as LineClip[]
  return lines.map(clipSinceLine)
}

/**
 * Les échéances entre `from` (inclus) et `to` (exclu), quel que soit leur
 * statut. **Ne regarde ni le statut du clip ni `deliveryToDay`** : le
 * calendrier lit les publications, jamais le vivier (spec planning §5.2) — un
 * clip reprogrammé qui redescend à `kept` reste sur le calendrier.
 */
export function listSchedule(db: Database.Database, from: number, to: number): PublicationRow[] {
  return db
    .prepare(
      'SELECT * FROM publications WHERE scheduledAt >= ? AND scheduledAt < ? ORDER BY scheduledAt, platform',
    )
    .all(from, to) as PublicationRow[]
}

/** La plus ancienne échéance encore `planned` et due, ou `undefined` si rien ne l'est. */
export function nextDueSchedule(
  db: Database.Database,
  now: number,
): { clipId: string; scheduledAt: number } | undefined {
  const row = db
    .prepare(
      `SELECT clipId, scheduledAt FROM publications
       WHERE status = 'planned' AND scheduledAt IS NOT NULL AND scheduledAt <= ?
       ORDER BY scheduledAt LIMIT 1`,
    )
    .get(now) as { clipId: string; scheduledAt: number } | undefined
  return row
}

/**
 * Pose l'échéance des quatre plateformes pour chaque clip, en une transaction.
 *
 * **Reprogrammer un clip déjà `planned` déplace sa date au lieu d'en écrire
 * une seconde ligne** — la clause `WHERE` du `DO UPDATE` ne touche que les
 * lignes encore `planned`. Une ligne qui porte déjà un résultat
 * (`published`, `submitted`, `failed`, `in_progress`) n'est ni mise à jour ni
 * dupliquée : on n'efface pas l'histoire d'une publication qui a eu lieu.
 */
export function schedulePublications(
  db: Database.Database,
  clipIds: readonly string[],
  scheduledAt: number,
  now: number,
): void {
  const upsert = db.prepare(
    `INSERT INTO publications
       (clipId, platform, status, remoteId, remoteUrl, requestId, error, publishedFingerprint, createdAt, updatedAt, scheduledAt)
     VALUES (@clipId, @platform, 'planned', NULL, NULL, NULL, NULL, NULL, @now, @now, @scheduledAt)
     ON CONFLICT(clipId, platform) DO UPDATE SET
       scheduledAt = excluded.scheduledAt,
       updatedAt   = excluded.updatedAt
     WHERE publications.status = 'planned'`,
  )
  db.transaction(() => {
    for (const clipId of clipIds) {
      for (const platform of PLATFORMS) {
        upsert.run({ clipId, platform, now, scheduledAt })
      }
    }
  })()
}

/**
 * Retire les lignes encore `planned` des clips donnés, rend le nombre
 * supprimé. Les lignes qui portent déjà un résultat restent : on ne réécrit
 * pas l'histoire d'une publication qui a eu lieu.
 */
export function unschedulePublications(db: Database.Database, clipIds: readonly string[]): number {
  if (clipIds.length === 0) return 0
  const placeholders = clipIds.map(() => '?').join(', ')
  const result = db
    .prepare(`DELETE FROM publications WHERE clipId IN (${placeholders}) AND status = 'planned'`)
    .run(...clipIds)
  return result.changes
}

/**
 * Le clip porte-t-il une échéance encore à honorer ?
 *
 * **`planned`, pas seulement `scheduledAt` non nul.** Un clip publié la
 * semaine dernière porte encore `scheduledAt` sur des lignes `published` ou
 * `failed` ; seule une ligne `planned` désigne un envoi qui n'a pas encore eu
 * lieu (#205).
 */
export function hasPendingSchedule(db: Database.Database, clipId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM publications
       WHERE clipId = ? AND status = 'planned' AND scheduledAt IS NOT NULL
       LIMIT 1`,
    )
    .get(clipId)
  return row !== undefined
}
