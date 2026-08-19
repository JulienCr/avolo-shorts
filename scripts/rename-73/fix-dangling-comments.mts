/**
 * Substitue, dans les commentaires et les titres de test
 * (`describe`/`it`/`test`), chaque ancien identifiant de la table par son
 * nouveau — la correction du constat fait par
 * `count-dangling-comment-names.mts` (217 occurrences en forme de symbole,
 * dans 100 fichiers) et de la moitié cosmétique des trouvailles de la
 * preuve B (les titres de test qui recopient l'ancien nom du symbole
 * testé). Tiré **uniquement de la table** — jamais un remplacement
 * inventé, jamais une reformulation.
 *
 * ## La forme, pas le mot
 *
 * Un ancien nom (`chemin`, `plans`, `durée`…) est souvent aussi un mot
 * français ordinaire. Le discriminant est la forme, jamais le mot seul :
 *
 *   - identifiant composé (camelCase, PascalCase, `snake_case`) ;
 *   - entre accents graves (`` `chemin` ``) ;
 *   - immédiatement suivi de `(` (forme d'appel, `chemin(...)`).
 *
 * Un mot français nu, minuscule, seul dans une phrase, n'est touché sous
 * aucune de ces trois formes — c'est de la prose, elle reste en français.
 *
 * ## L'ambiguïté se résout par fichier, jamais par service de langage
 *
 * La table n'est pas une bijection (`chemin` → `path`, mais aussi
 * `filePath`/`thumbPath`/`resultPath`/`fingerprintPath` selon la
 * déclaration). Un commentaire n'a pas de portée lexicale : impossible de
 * demander à TypeScript quelle déclaration il désigne. La résolution :
 *
 *   1. Si un ancien nom n'a qu'un seul nouveau nom dans toute la table,
 *      aucune ambiguïté — substitué partout.
 *   2. Sinon, si le fichier qui porte le commentaire contient
 *      exactement une déclaration de cet ancien nom (`renames-identifiers.json`,
 *      champ `file`, ramené au chemin actuel), c'est son nouveau nom à
 *      elle qui s'applique — résolu par fichier.
 *   3. Sinon (zéro ou plusieurs candidats dans ce fichier), rien n'est
 *      substitué : le cas est listé, pas deviné. Dix commentaires laissés
 *      valent mieux que trois faussés.
 *
 *     pnpm tsx scripts/rename-73/fix-dangling-comments.mts --write
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { ROOT, listProjectFiles } from "./project.mts";
import { loadSymbolEntries, toCurrentPath, loadPairTsv, type SymbolEntry } from "./proof-inverse-tree.mts";

const WHOLE_TOKEN_RE = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
function isCompoundShaped(token: string): boolean {
  return /[a-z][A-Z]/.test(token) || /[A-Z]{2,}/.test(token) || token.includes("_") || token.includes("$");
}

interface TokenMatch {
  text: string;
  start: number; // relatif au texte du commentaire/chaîne
  end: number;
}

/** Les tokens identifiant-shaped d'un texte, avec leur position — pour
 * décider ensuite, en regardant les caractères voisins dans le texte
 * complet, s'ils portent l'une des trois formes de symbole. */
function findTokens(text: string): TokenMatch[] {
  const out: TokenMatch[] = [];
  const re = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function isSymbolShaped(token: TokenMatch, fullText: string): boolean {
  if (isCompoundShaped(token.text)) return true;
  const before = fullText[token.start - 1];
  const after = fullText[token.end];
  if (before === "`" && after === "`") return true;
  if (after === "(") return true;
  return false;
}

interface Resolution {
  resolved: string | null;
  reason: string;
}

function buildResolver(entries: SymbolEntry[], fileRenames: Array<{ from: string; to: string }>, folderRenames: Array<{ from: string; to: string }>) {
  const globalCandidates = new Map<string, Set<string>>();
  for (const e of entries) {
    const set = globalCandidates.get(e.oldName) ?? new Set<string>();
    set.add(e.newName);
    globalCandidates.set(e.oldName, set);
  }
  // Pour chaque (oldName, currentFile) : les newName déclarés dans ce fichier.
  const byOldNameAndFile = new Map<string, Map<string, Set<string>>>();
  for (const e of entries) {
    const currentFile = toCurrentPath(e.file, fileRenames, folderRenames);
    const byFile = byOldNameAndFile.get(e.oldName) ?? new Map<string, Set<string>>();
    byOldNameAndFile.set(e.oldName, byFile);
    const set = byFile.get(currentFile) ?? new Set<string>();
    set.add(e.newName);
    byFile.set(currentFile, set);
  }

  return function resolve(oldName: string, currentFileRel: string): Resolution {
    const globals = globalCandidates.get(oldName);
    if (!globals) return { resolved: null, reason: "absent de la table" };
    if (globals.size === 1) return { resolved: [...globals][0], reason: "non ambigu" };
    const localSet = byOldNameAndFile.get(oldName)?.get(currentFileRel);
    if (localSet && localSet.size === 1) return { resolved: [...localSet][0], reason: "résolu par fichier" };
    return {
      resolved: null,
      reason: localSet && localSet.size > 1 ? `fichier lui-même ambigu [${[...localSet].join(", ")}]` : `aucune déclaration locale, candidats globaux [${[...globals].join(", ")}]`,
    };
  };
}

interface EditSpan {
  start: number; // absolu dans le fichier
  end: number;
  newText: string;
}

const TEST_CALL_NAMES = new Set(["describe", "it", "test"]);

function isTestTitleStringLiteral(node: ts.StringLiteral): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (parent.arguments[0] !== node) return false;
  let callee = parent.expression;
  // describe.each(...)(...), it.skip(...), test.only(...) : le nom de base
  // avant le premier point.
  while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
  while (ts.isCallExpression(callee)) callee = callee.expression; // describe.each(x)(...)
  return ts.isIdentifier(callee) && TEST_CALL_NAMES.has(callee.text);
}

interface FileResult {
  file: string;
  edits: number;
  skipped: Array<{ oldName: string; reason: string; context: string }>;
}

function processFile(
  absPath: string,
  relPath: string,
  resolve: (oldName: string, file: string) => Resolution
): FileResult {
  const content = fs.readFileSync(absPath, "utf8");
  const ext = path.extname(relPath);
  const kind: ts.ScriptKind = ext === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const variant = ext === ".tsx" ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const source = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, kind);

  const spans: EditSpan[] = [];
  const skipped: Array<{ oldName: string; reason: string; context: string }> = [];
  const skippedSeen = new Set<string>();

  function handleSegment(segStart: number, segText: string) {
    const tokens = findTokens(segText);
    for (const tok of tokens) {
      if (!isSymbolShaped(tok, segText)) continue;
      const { resolved, reason } = resolve(tok.text, relPath);
      if (resolved === null) {
        const key = `${tok.text}|${reason}`;
        if (!skippedSeen.has(key)) {
          skippedSeen.add(key);
          skipped.push({ oldName: tok.text, reason, context: segText.slice(Math.max(0, tok.start - 20), tok.end + 20) });
        }
        continue;
      }
      spans.push({ start: segStart + tok.start, end: segStart + tok.end, newText: resolved });
    }
  }

  // Commentaires — via le scanner, comme proof-a/count.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, content);
  scanner.setText(content);
  let tok = scanner.scan();
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    if (tok === ts.SyntaxKind.SingleLineCommentTrivia || tok === ts.SyntaxKind.MultiLineCommentTrivia) {
      const start = scanner.getTokenStart();
      const end = scanner.getTokenEnd();
      handleSegment(start, content.slice(start, end));
    }
    tok = scanner.scan();
  }

  // Titres de test — describe/it/test(<premier argument>, ...).
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && isTestTitleStringLiteral(node)) {
      const start = node.getStart(source);
      const end = node.getEnd();
      // node.text est décodé (échappements résolus) ; on travaille sur le
      // texte source brut pour ne jamais désynchroniser guillemets/échappements.
      handleSegment(start, content.slice(start, end));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (spans.length === 0) return { file: relPath, edits: 0, skipped };

  spans.sort((a, b) => b.start - a.start);
  let newContent = content;
  for (const s of spans) {
    newContent = newContent.slice(0, s.start) + s.newText + newContent.slice(s.end);
  }
  fs.writeFileSync(absPath, newContent, "utf8");
  return { file: relPath, edits: spans.length, skipped };
}

function main() {
  const write = process.argv.includes("--write");
  const entries = loadSymbolEntries();
  const fileRenames = loadPairTsv("renames-files.tsv");
  const folderRenames = loadPairTsv("renames-folders.tsv");
  const resolve = buildResolver(entries, fileRenames, folderRenames);

  const files = listProjectFiles();
  let totalEdits = 0;
  let filesEdited = 0;
  const allSkipped: Array<{ file: string; oldName: string; reason: string; context: string }> = [];

  if (!write) {
    // Dry-run : ne rien écrire, juste compter — relit toujours le fichier
    // réel, donc on simule en mémoire via une copie jetable du contenu.
    console.log("(dry-run non supporté pour ce script — il travaille en place. Utiliser --write.)");
    console.log("Aperçu du nombre de fichiers concernés via count-dangling-comment-names.mts.");
    return;
  }

  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    const result = processFile(abs, rel, resolve);
    if (result.edits > 0) {
      filesEdited++;
      totalEdits += result.edits;
    }
    for (const s of result.skipped) allSkipped.push({ file: rel, ...s });
  }

  console.log(`${filesEdited} fichier(s) édités, ${totalEdits} substitution(s).`);
  if (allSkipped.length > 0) {
    console.log(`\n${allSkipped.length} occurrence(s) laissée(s), listées (cas ambigus) :`);
    for (const s of allSkipped) {
      console.log(`  ${s.file} : "${s.oldName}" — ${s.reason}\n      ...${s.context}...`);
    }
  }
}

main();
