/**
 * Répare `renames-identifiers.tsv` et `.json` pour qu'ils disent le nom
 * **réellement appliqué**, ajustements anti-collision compris.
 *
 * La preuve inverse (`proof-inverse-tree.mts`) a trouvé 105 déclarations sur
 * 4 145 dont le `newName` enregistré ne correspond plus au texte présent
 * dans le code — un nom ajusté localement pour éviter une collision (par
 * `fix-collisions.mts`, ou à la main, jamais reporté dans la table). Le code
 * est correct (tests verts, type-check propre) ; c'est la table qui est
 * fausse pour ces 105 entrées. Or c'est cette table qui tient lieu de
 * review : une carte inexacte sur 2,5 % de sa surface ne peut pas remplacer
 * la lecture du diff qu'elle prétend remplacer.
 *
 * Ce script ne renomme rien et ne supprime aucune entrée — les 105
 * déclarations restent, avec leur nom corrigé plutôt qu'effacées, parce que
 * ce sont des renommages réels. Il :
 *
 *   1. Réutilise `buildIdentifierEditPlan` de `proof-inverse-tree.mts` pour
 *      obtenir la liste `notFound` — les entrées dont `newName` ne se
 *      retrouve plus comme nom déclaré à l'emplacement `file:line` attendu.
 *   2. Pour chacune, scanne la ligne entière (pas seulement le token
 *      attendu) à la recherche de tout identifiant qui est le nom
 *      **déclaré** d'une construction (`isDeclarationNameNode`, le même
 *      test que la preuve inverse), et ne retient le candidat que si son
 *      rôle syntaxique correspond au `kind` enregistré (`variable` implique
 *      un parent `VariableDeclaration`, etc.) — sans ce filtre, une ligne
 *      qui déclare plusieurs identifiants de rôles différents rendrait la
 *      résolution ambiguë.
 *   3. S'il reste exactement un candidat, c'est le nom réellement appliqué :
 *      corrige `newName` dans le JSON, tel quel — **aucun jugement sur la
 *      qualité du nom**, seulement sur son exactitude face au code.
 *   4. S'il reste zéro ou plusieurs candidats, l'entrée est rapportée comme
 *      non résolue automatiquement plutôt que devinée.
 *   5. Régénère `renames-identifiers.tsv` depuis le JSON corrigé, groupé par
 *      la paire **(old_name, new_name)** et non plus par old_name seul :
 *      l'ajustement anti-collision est parfois local à une poignée
 *      d'occurrences (`chemin` reste `path` dans la plupart des cas, mais
 *      devient `filePath`/`thumbPath`/`resultPath`/`fingerprintPath` dans
 *      quelques autres) — une ligne par old_name mentirait par
 *      construction dès qu'un même nom de départ a plusieurs arrivées
 *      réelles.
 *
 *     pnpm tsx scripts/rename-73/repair-tables-from-applied.mts
 *     pnpm tsx scripts/rename-73/repair-tables-from-applied.mts --write
 *
 * Sans `--write`, n'affiche que le rapport (dry-run). Avec `--write`, écrit
 * les deux fichiers corrigés.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { ROOT } from "./project.mts";
import {
  type SymbolEntry,
  loadSymbolEntries,
  loadPairTsv,
  toCurrentPath,
  isDeclarationNameNode,
  buildIdentifierEditPlan,
} from "./proof-inverse-tree.mts";

/** Correspondance entre le `kind` enregistré par `collect.mts` et le type de
 * nœud parent attendu pour l'identifiant déclaré — le même vocabulaire que
 * `classify.mts` a utilisé pour le produire. */
function kindMatches(kind: string, parent: ts.Node): boolean {
  switch (kind) {
    case "variable":
      return ts.isVariableDeclaration(parent);
    case "parameter":
      return ts.isParameter(parent);
    case "bindingElement":
      return ts.isBindingElement(parent);
    case "function":
      return ts.isFunctionDeclaration(parent);
    case "functionExpr":
      return ts.isFunctionExpression(parent);
    case "method":
      return ts.isMethodDeclaration(parent);
    case "methodSignature":
      return ts.isMethodSignature(parent);
    case "class":
      return ts.isClassDeclaration(parent) || ts.isClassExpression(parent);
    case "typeAlias":
      return ts.isTypeAliasDeclaration(parent);
    case "interfaceProperty":
      return ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent);
    case "importLocal":
      return ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent);
    case "importDefault":
      return ts.isImportClause(parent);
    default:
      return false;
  }
}

interface Resolution {
  entry: SymbolEntry;
  resolvedName: string | undefined;
  candidates: string[]; // pour diagnostic quand ce n'est pas exactement 1
}

/**
 * Six déclarations restent ambiguës même après le départage par
 * auto-correspondance : leur ligne porte deux identifiants du même rôle
 * syntaxique (deux paramètres, par exemple), ni l'un ni l'autre ne
 * reprenant le texte de `oldName`, donc aucune règle générique ne les
 * tranche. Résolues à la main, une à une, en lisant le fichier — chacune
 * justifiée :
 *
 *   - `src/core/gemini/parse.ts:318` — `const [début, fin] = snapToWords(...)`
 *     est devenu `const [snappedStart, fin] = ...` : `début` → `start`
 *     collisionnait avec le `start` déjà lié quelques lignes plus haut
 *     (`const { start, end, predicted_score } = lu.data`), d'où le
 *     préfixe local. `fin` n'est d'ailleurs renommé nulle part dans la
 *     table — encore un identifiant français que le balayage n'a jamais
 *     marqué, propre mais hors du périmètre de cette réparation.
 *   - `src/server/steps/analysis.ts:592` et `transcript.ts:415` —
 *     `const relayer = (flux, journaliser: boolean) => ...` est devenu
 *     `(stream, shouldLog: boolean)` : `journaliser`, un verbe utilisé
 *     comme indicateur booléen, est devenu l'idiome anglais `shouldLog`
 *     plutôt qu'un nom en `-ing` ou en `-er`. `stream` correspond à un
 *     autre nom d'origine (`flux`), sans rapport avec `journaliser`.
 *   - `src/server/rendus.ts:50`, `src/server/steps/render.ts:620` et
 *     `:1115` — trois fonctions à deux paramètres où `chemin` devient
 *     `filePath` (le même ajustement que la centaine d'autres occurrences
 *     de `chemin` déjà résolues automatiquement), l'autre paramètre
 *     (`type`, `fingerprint`, `content`) venant d'un nom d'origine
 *     différent.
 */
const MANUAL_RESOLUTIONS: ReadonlyMap<string, string> = new Map([
  ["src/core/gemini/parse.ts:318:début", "snappedStart"],
  ["src/server/steps/analysis.ts:592:journaliser", "shouldLog"],
  ["src/server/steps/transcript.ts:415:journaliser", "shouldLog"],
  ["src/server/rendus.ts:50:chemin", "filePath"],
  ["src/server/steps/render.ts:620:chemin", "filePath"],
  ["src/server/steps/render.ts:1115:chemin", "filePath"],
]);

/** Scanne toute la ligne `entry.line` du fichier actuel pour l'identifiant
 * **déclaré** dont le rôle syntaxique correspond à `entry.kind` — sans
 * présupposer le texte, contrairement à la validation de la preuve inverse. */
function resolveActualAppliedName(
  entry: SymbolEntry,
  fileRenames: Array<{ from: string; to: string }>,
  folderRenames: Array<{ from: string; to: string }>
): Resolution {
  const currentFileRel = toCurrentPath(entry.file, fileRenames, folderRenames);
  const currentFileAbs = path.join(ROOT, currentFileRel);
  if (!fs.existsSync(currentFileAbs)) {
    return { entry, resolvedName: undefined, candidates: [] };
  }
  const content = fs.readFileSync(currentFileAbs, "utf8");
  const source = ts.createSourceFile(currentFileRel, content, ts.ScriptTarget.Latest, true);
  const lineStarts = source.getLineStarts();
  const lineIndex = entry.line - 1;
  if (lineIndex < 0 || lineIndex >= lineStarts.length) {
    return { entry, resolvedName: undefined, candidates: [] };
  }
  const lineStart = lineStarts[lineIndex];
  const lineEnd = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : content.length;

  const candidates: string[] = [];
  const visit = (node: ts.Node) => {
    const start = node.getStart(source);
    if (start >= lineStart && start < lineEnd && ts.isIdentifier(node) && isDeclarationNameNode(node)) {
      const parent = node.parent;
      if (kindMatches(entry.kind, parent)) candidates.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const uniq = [...new Set(candidates)];
  if (uniq.length === 1) return { entry, resolvedName: uniq[0], candidates: uniq };

  // Départage : une ligne qui déclare deux identifiants du même rôle (deux
  // paramètres, par exemple) ne se résout pas par le rôle syntaxique seul.
  // Si l'un des candidats est *exactement* le texte de `oldName`, c'est que
  // cette occurrence précise n'a jamais été renommée — un résultat
  // légitime (ex. « force », déjà un mot anglais, n'avait pas besoin de
  // traduction malgré ce que la table proposait) — et sans ambiguïté
  // puisqu'un autre candidat, sur la même ligne, ne peut pas être aussi
  // ce texte-là sans que ce soit littéralement le même identifiant.
  if (uniq.length > 1 && uniq.includes(entry.oldName)) {
    return { entry, resolvedName: entry.oldName, candidates: uniq };
  }

  const manualKey = `${entry.file}:${entry.line}:${entry.oldName}`;
  const manual = MANUAL_RESOLUTIONS.get(manualKey);
  if (manual !== undefined) return { entry, resolvedName: manual, candidates: uniq };

  return { entry, resolvedName: undefined, candidates: uniq };
}

export function writeJson(entries: SymbolEntry[]) {
  const p = path.join(ROOT, "scripts/rename-73/renames-identifiers.json");
  fs.writeFileSync(p, JSON.stringify(entries, null, 2) + "\n");
}

/** Régénère `renames-identifiers.tsv`, groupé par le triplet (old_name,
 * new_name, note) — voir l'en-tête du fichier. La 5e colonne `note` reste
 * vide pour l'écrasante majorité des lignes ; elle ne porte un texte que
 * pour les entrées qu'aucun `first_seen` de `collect.mts` n'a jamais
 * suivies — ajoutées après coup par `catalogue-uncatalogued.mts` — pour
 * qu'un lecteur du TSV voie tout de suite pourquoi une ligne existe sans
 * avoir à deviner. La note fait partie de la clé de groupe, pas seulement
 * la paire (old_name, new_name) : `centre` → `center` a 6 occurrences
 * suivies depuis toujours et une 7e jamais cataloguée avant aujourd'hui —
 * les fondre sous une note commune masquerait laquelle des sept est
 * l'exception, les séparer en deux lignes le dit directement. */
export function writeTsv(entries: SymbolEntry[]) {
  const p = path.join(ROOT, "scripts/rename-73/renames-identifiers.tsv");
  const groups = new Map<string, SymbolEntry[]>();
  for (const e of entries) {
    const key = `${e.oldName}\t${e.newName}\t${e.note ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const rows = [...groups.entries()].map(([key, list]) => {
    const [oldName, newName, note] = key.split("\t");
    const sorted = [...list].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
    const first = sorted[0];
    return { oldName, newName, occurrences: list.length, firstSeen: `${first.file}:${first.line}`, note };
  });
  rows.sort((a, b) => (a.oldName === b.oldName ? a.newName.localeCompare(b.newName) : a.oldName.localeCompare(b.oldName)));

  const lines = ["old_name\tnew_name\toccurrences\tfirst_seen\tnote"];
  for (const r of rows) lines.push(`${r.oldName}\t${r.newName}\t${r.occurrences}\t${r.firstSeen}\t${r.note}`);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return rows.length;
}

function main() {
  const write = process.argv.includes("--write");

  const entries = loadSymbolEntries();
  const fileRenames = loadPairTsv("renames-files.tsv");
  const folderRenames = loadPairTsv("renames-folders.tsv");

  console.log("Détection des entrées dont le newName enregistré ne correspond plus au code...");
  const { notFound } = buildIdentifierEditPlan(entries, fileRenames, folderRenames);
  console.log(`  ${notFound.length} entrée(s) à réparer sur ${entries.length}.`);

  const resolutions = notFound.map((e) => resolveActualAppliedName(e, fileRenames, folderRenames));
  const resolved = resolutions.filter((r) => r.resolvedName !== undefined);
  const unresolved = resolutions.filter((r) => r.resolvedName === undefined);

  console.log(`\nRésolues automatiquement (${resolved.length}) :`);
  for (const r of resolved) {
    console.log(`  ${r.entry.file}:${r.entry.line} — "${r.entry.oldName}" : "${r.entry.newName}" (table) -> "${r.resolvedName}" (code)`);
  }

  if (unresolved.length > 0) {
    console.error(`\nNON résolues automatiquement (${unresolved.length}) — nécessitent une revue manuelle :`);
    for (const r of unresolved) {
      console.error(
        `  ${r.entry.file}:${r.entry.line} (${r.entry.kind}) — "${r.entry.oldName}" -> "${r.entry.newName}" attendu, candidats trouvés : [${r.candidates.join(", ")}]`
      );
    }
  }

  const byId = new Map(entries.map((e) => [e, e] as const));
  void byId;
  const resolvedByEntry = new Map(resolved.map((r) => [r.entry, r.resolvedName!] as const));
  const correctedEntries = entries.map((e) => {
    const fix = resolvedByEntry.get(e);
    return fix ? { ...e, newName: fix } : e;
  });

  const changedCount = correctedEntries.filter((e, i) => e.newName !== entries[i].newName).length;
  console.log(`\n${changedCount} entrée(s) corrigée(s) dans le JSON.`);

  if (!write) {
    console.log("\n(dry-run — relancer avec --write pour écrire renames-identifiers.json et .tsv)");
    if (unresolved.length > 0) process.exit(1);
    return;
  }

  writeJson(correctedEntries);
  const rowCount = writeTsv(correctedEntries);
  console.log(`\nÉcrit renames-identifiers.json (${correctedEntries.length} symboles) et renames-identifiers.tsv (${rowCount} lignes, groupées par (old_name, new_name)).`);

  if (unresolved.length > 0) {
    console.error(`\n${unresolved.length} entrée(s) restent NON résolues — la table les garde avec leur ancien newName, à traiter manuellement.`);
    process.exit(1);
  }
}

// Ne s'exécute que si ce fichier est le point d'entrée — `catalogue-uncatalogued.mts`
// importe writeJson/writeTsv d'ici sans vouloir relancer cette réparation.
if (import.meta.url === `file://${process.argv[1]}`) main();
