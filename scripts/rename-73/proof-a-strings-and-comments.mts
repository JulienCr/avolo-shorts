/**
 * Preuve A — rien qui ne devait pas bouger n'a bougé.
 *
 * Pour chaque fichier modifié entre `origin/main` et la tête de cette
 * branche (au sens de git, donc en suivant les renommages), extrait par
 * l'AST TypeScript — jamais par expression régulière, jamais sur le texte
 * brut — tous les commentaires et toutes les chaînes littérales, avant et
 * après, et compare.
 *
 * Trois exceptions, chacune vérifiée mécaniquement contre les tables du
 * renommage plutôt qu'admise sur parole :
 *
 *   (a) le spécificateur d'un import/export, statique ou dynamique — vérifié
 *       contre renames-files.tsv / renames-folders.tsv (le chemin cible doit
 *       correspondre à un renommage de fichier connu) ;
 *   (b) une chaîne au niveau des types (accès indexé `T['clé']`) qui reflète
 *       une propriété renommée — vérifiée contre renames-identifiers.tsv
 *       (l'ancien ET le nouveau nom doivent y figurer) ;
 *   (c) un commentaire dont la différence s'explique intégralement par une
 *       substitution ancien → nouveau tirée de renames-identifiers.tsv —
 *       jamais une reformulation, jamais une traduction, jamais un mot
 *       français abîmé.
 *
 * Tout le reste qui diffère fait échouer la preuve. Elle rend la liste des
 * exceptions rencontrées, justifiée ligne à ligne — pas un silence.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as ts from "typescript";
import { ROOT } from "./project.mts";

const BASE_REF = process.argv[2] ?? "origin/main";

/** Deux chaînes d'aspect identique peuvent être deux suites d'octets
 * distinctes — `é` précomposé (U+00E9) contre `e` + accent combinant
 * (U+0065 U+0301). Toute comparaison passe par NFC des deux côtés, jamais
 * par la forme brute lue sur le disque. */
function nfc(s: string | undefined): string | undefined {
  return s?.normalize("NFC");
}

interface Extracted {
  comments: string[];
  strings: string[];
}

function extract(filePath: string, content: string): Extracted {
  const ext = path.extname(filePath);
  const kind: ts.ScriptKind = ext === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);

  const comments: string[] = [];
  const strings: string[] = [];

  // Commentaires : via le scanner, qui les voit tous (de tête comme de
  // traîne), plutôt que ts.getLeadingCommentRanges nœud par nœud, qui en
  // raterait au sommet du fichier et entre deux nœuds sans relation directe.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, kind, content);
  scanner.setText(content);
  let tok = scanner.scan();
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    if (
      tok === ts.SyntaxKind.SingleLineCommentTrivia ||
      tok === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      comments.push(content.slice(scanner.getTokenStart(), scanner.getTokenEnd()));
    }
    tok = scanner.scan();
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      strings.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { comments, strings };
}

function gitShow(ref: string, filePath: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${filePath}`], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
      stdio: ["ignore", "pipe", "ignore"], // stderr coupé : "n'existe pas à cette réf" est attendu pour un fichier neuf, pas une panne.
    });
  } catch {
    return null; // fichier absent à cette réf (créé ou renommé)
  }
}

interface RenamedFile {
  from: string;
  to: string;
}

function loadTsv(name: string): RenamedFile[] {
  const p = path.join(ROOT, "scripts/rename-73", name);
  const lines = fs.readFileSync(p, "utf8").split("\n").slice(1).filter(Boolean);
  return lines.map((line) => {
    const [from, to] = line.split("\t");
    return { from, to };
  });
}

function loadIdentifierTable(): Map<string, string> {
  const p = path.join(ROOT, "scripts/rename-73/renames-identifiers.tsv");
  const lines = fs.readFileSync(p, "utf8").split("\n").slice(1).filter(Boolean);
  const m = new Map<string, string>();
  for (const line of lines) {
    const [oldName, newName] = line.split("\t");
    m.set(oldName.normalize("NFC"), newName.normalize("NFC"));
  }
  return m;
}

/** Le chemin cible d'une chaîne "compte" comme spécificateur de module
 * renommé si, une fois résolu en chemin de dépôt — `@/...` vers `src/...`,
 * ou relatif au fichier qui le porte —, il correspond à l'un des fichiers
 * renommés, ou tombe sous l'un des dossiers renommés (renames-folders.tsv)
 * pour un fichier du dossier qui n'a pas de ligne propre dans
 * renames-files.tsv (son nom de base n'a pas changé). */
function isKnownModuleRename(
  literal: string,
  containingFile: string,
  renamedFiles: RenamedFile[],
  renamedFolders: RenamedFile[]
): boolean {
  const stripExt = (p: string) => p.replace(/\.(ts|tsx|mts)$/, "");
  const norm = (p: string) => stripExt(p).replace(/^\.\//, "");
  let resolved: string;
  if (literal.startsWith("@/")) {
    resolved = "src/" + literal.slice(2);
  } else if (literal.startsWith(".")) {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(containingFile), literal));
  } else {
    resolved = literal; // package externe, ou déjà un chemin de dépôt
  }
  const litNorm = norm(resolved);

  if (renamedFiles.some((r) => litNorm === norm(r.to) || litNorm === norm(r.from))) return true;
  if (renamedFolders.some((r) => litNorm.startsWith(norm(r.to) + "/") || litNorm.startsWith(norm(r.from) + "/"))) {
    return true;
  }
  return false;
}

function isKnownTypeIndexRename(literal: string, idTable: Map<string, string>): boolean {
  return idTable.has(literal) || [...idTable.values()].includes(literal);
}

function basenameNoExt(p: string): string {
  return path.basename(p).replace(/\.(ts|tsx|mts)$/, "");
}

/** Basename (sans extension) → basenames cibles possibles (sans extension),
 * pour reconnaître un spécificateur de module *incrusté dans une chaîne
 * plus large* — la sonde TypeScript compilée à la volée de etapes.test.ts,
 * par exemple, porte `'@/core/parcours'` au milieu d'un `import` tenu comme
 * texte. Un ensemble, pas une valeur unique : deux fichiers distincts
 * peuvent partager un même nom de base (`src/core/parcours.ts` → `phase`,
 * `src/lib/parcours.ts` → `navigation`) — cette fonction n'a que le nom de
 * base sous les yeux, jamais le dossier, donc ne tranche pas laquelle des
 * deux cibles est la bonne ; elle accepte les deux plutôt que d'en écraser
 * une au hasard de l'ordre du tableau. */
function buildBasenameMap(renamedFiles: RenamedFile[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const r of renamedFiles) {
    const key = basenameNoExt(r.from);
    const set = m.get(key) ?? new Set<string>();
    set.add(basenameNoExt(r.to));
    m.set(key, set);
  }
  return m;
}

/** Une chaîne (commentaire ou littéral) "ancienne" est admise à devenir la
 * "nouvelle" si la différence entière s'explique par une ou plusieurs
 * substitutions ancien→nouveau tirées soit de la table des identifiants,
 * soit — token par token — des noms de base de fichiers renommés. Jamais
 * une reformulation, jamais un mot français abîmé : chaque token qui diffère
 * doit être *exactement* une entrée de l'une des deux tables. */
function isPureSubstitution(
  beforeRaw: string,
  afterRaw: string,
  idTable: Map<string, string>,
  basenameMap: Map<string, Set<string>>
): boolean {
  const before = beforeRaw.normalize("NFC");
  const after = afterRaw.normalize("NFC");
  if (before === after) return true;
  // Tokenise les deux chaînes sur la même grille (mots vs séparateurs), et
  // vérifie que chaque désaccord est couvert par l'une des deux tables.
  const tokenize = (s: string) => s.split(/([A-Za-z_$][A-Za-z0-9_$]*)/g);
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (idTable.get(a[i]) === b[i]) continue;
    if (basenameMap.get(a[i])?.has(b[i]) === true) continue;
    return false;
  }
  return true;
}

interface Exception {
  file: string;
  kind: "module-specifier" | "type-index" | "comment-substitution";
  before: string;
  after: string;
}

function main() {
  const changedFiles = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `${BASE_REF}...HEAD`],
    { cwd: ROOT, encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx|mts)$/.test(f))
    .filter((f) => !f.startsWith("scripts/rename-73/"));

  const renamedFiles = loadTsv("renames-files.tsv");
  const renamedFolders = loadTsv("renames-folders.tsv");
  const idTable = loadIdentifierTable();
  const basenameMap = buildBasenameMap(renamedFiles);

  const exceptions: Exception[] = [];
  const failures: string[] = [];
  let filesCompared = 0;

  for (const file of changedFiles) {
    const currentPath = path.join(ROOT, file);
    if (!fs.existsSync(currentPath)) continue; // fichier supprimé/déplacé, rien à comparer côté "après"
    const after = fs.readFileSync(currentPath, "utf8");

    // Retrouver la version "avant" : soit ce même chemin sur la base, soit
    // — pour un fichier renommé — son ancien chemin, tiré de la table.
    let before = gitShow(BASE_REF, file);
    let beforePath = file;
    if (before === null) {
      const renameEntry = renamedFiles.find((r) => r.to === file);
      if (renameEntry) {
        before = gitShow(BASE_REF, renameEntry.from);
        beforePath = renameEntry.from;
      }
    }
    if (before === null) continue; // fichier neuf, rien à comparer

    filesCompared++;
    const beforeExtracted = extract(beforePath, before);
    const afterExtracted = extract(file, after);

    // --- Chaînes littérales ---
    const maxStrings = Math.max(beforeExtracted.strings.length, afterExtracted.strings.length);
    if (beforeExtracted.strings.length !== afterExtracted.strings.length) {
      failures.push(
        `${file} : nombre de chaînes littérales différent (${beforeExtracted.strings.length} → ${afterExtracted.strings.length})`
      );
    }
    for (let i = 0; i < maxStrings; i++) {
      const b = beforeExtracted.strings[i];
      const a = afterExtracted.strings[i];
      if (nfc(b) === nfc(a)) continue;
      if (a !== undefined && isKnownModuleRename(a, file, renamedFiles, renamedFolders)) {
        exceptions.push({ file, kind: "module-specifier", before: b ?? "", after: a });
        continue;
      }
      if (a !== undefined && b !== undefined && isKnownTypeIndexRename(a, idTable) && isKnownTypeIndexRename(b, idTable)) {
        exceptions.push({ file, kind: "type-index", before: b, after: a });
        continue;
      }
      if (a !== undefined && b !== undefined && isPureSubstitution(b, a, idTable, basenameMap)) {
        exceptions.push({ file, kind: "module-specifier", before: b, after: a });
        continue;
      }
      failures.push(`${file} : chaîne littérale modifiée sans exception reconnue :\n    avant: ${JSON.stringify(b)}\n    après: ${JSON.stringify(a)}`);
    }

    // --- Commentaires ---
    const maxComments = Math.max(beforeExtracted.comments.length, afterExtracted.comments.length);
    if (beforeExtracted.comments.length !== afterExtracted.comments.length) {
      failures.push(
        `${file} : nombre de commentaires différent (${beforeExtracted.comments.length} → ${afterExtracted.comments.length})`
      );
    }
    for (let i = 0; i < maxComments; i++) {
      const b = beforeExtracted.comments[i];
      const a = afterExtracted.comments[i];
      if (nfc(b) === nfc(a)) continue;
      if (a !== undefined && b !== undefined && isPureSubstitution(b, a, idTable, basenameMap)) {
        exceptions.push({ file, kind: "comment-substitution", before: b, after: a });
        continue;
      }
      failures.push(`${file} : commentaire modifié au-delà d'une substitution d'identifiant :\n    avant: ${JSON.stringify(b)}\n    après: ${JSON.stringify(a)}`);
    }
  }

  console.log(`Fichiers comparés : ${filesCompared}`);
  console.log(`\nExceptions (${exceptions.length}), chacune vérifiée mécaniquement :`);
  for (const e of exceptions) {
    console.log(`  [${e.kind}] ${e.file}\n    avant: ${JSON.stringify(e.before)}\n    après: ${JSON.stringify(e.after)}`);
  }

  if (failures.length > 0) {
    console.error(`\nÉCHEC — ${failures.length} changement(s) non justifié(s) :`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("\nOK — aucune chaîne ni aucun commentaire n'a changé hors des exceptions ci-dessus.");
}

main();
