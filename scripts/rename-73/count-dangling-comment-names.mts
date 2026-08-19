/**
 * Compte les commentaires qui nomment encore un ancien identifiant de la
 * table — le même angle mort que celui qui a fait trouver les six
 * `this.name` par la preuve B plutôt que par la preuve A : un commentaire
 * qui n'a jamais changé de texte reste invisible à une comparaison
 * avant/après, qu'il soit juste ou faux. Un décompte, pas une correction —
 * l'orchestrateur tranche sur le nombre avant de lancer la correction.
 *
 * Même filtre que `proof-b-dangling-old-names.mts` et pour la même raison :
 * une bonne partie des ~1580 old_name de la table sont des mots français
 * courants pris seuls (« de », « fait », « force »…), qui apparaissent dans
 * la prose des commentaires sans viser aucun symbole. Restreint aux tokens
 * en forme d'identifiant composé (camelCase, PascalCase, underscore) —
 * jamais un mot isolé — pour ne compter que ce qui ressemble vraiment à un
 * nom de symbole recopié.
 *
 *     pnpm tsx scripts/rename-73/count-dangling-comment-names.mts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { ROOT, listProjectFiles } from "./project.mts";
import { loadSymbolEntries } from "./proof-inverse-tree.mts";

function loadOldNames(): Set<string> {
  const entries = loadSymbolEntries();
  return new Set(entries.map((e) => e.oldName.normalize("NFC")));
}

function extractComments(filePath: string, content: string): string[] {
  const ext = path.extname(filePath);
  const variant = ext === ".tsx" ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, content);
  const comments: string[] = [];
  let tok = scanner.scan();
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    if (tok === ts.SyntaxKind.SingleLineCommentTrivia || tok === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push(content.slice(scanner.getTokenStart(), scanner.getTokenEnd()));
    }
    tok = scanner.scan();
  }
  return comments;
}

const WHOLE_TOKEN_RE = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
function isCompoundShaped(token: string): boolean {
  return /[a-z][A-Z]/.test(token) || /[A-Z]{2,}/.test(token) || token.includes("_") || token.includes("$");
}

function tokenizeComment(comment: string): string[] {
  return (comment.normalize("NFC").match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? []).filter((t) => WHOLE_TOKEN_RE.test(t));
}

function main() {
  const oldNames = loadOldNames();
  const files = listProjectFiles();

  let rawCommentsWithHit = 0;
  const rawFilesWithHit = new Set<string>();
  let compoundCommentsWithHit = 0;
  const compoundFilesWithHit = new Set<string>();
  const compoundExamples: string[] = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const content = fs.readFileSync(file, "utf8");
    const comments = extractComments(rel, content);
    for (const comment of comments) {
      const tokens = tokenizeComment(comment);
      const hits = tokens.filter((t) => oldNames.has(t));
      if (hits.length === 0) continue;
      rawCommentsWithHit++;
      rawFilesWithHit.add(rel);
      const compoundHits = hits.filter(isCompoundShaped);
      if (compoundHits.length > 0) {
        compoundCommentsWithHit++;
        compoundFilesWithHit.add(rel);
        if (compoundExamples.length < 40) {
          compoundExamples.push(`  ${rel} : [${[...new Set(compoundHits)].join(", ")}]`);
        }
      }
    }
  }

  console.log(`Fichiers passés au crible : ${files.length}`);
  console.log(`\nBrut (tout token isolé qui est un old_name, mots français courants compris) :`);
  console.log(`  ${rawCommentsWithHit} commentaire(s), ${rawFilesWithHit.size} fichier(s).`);
  console.log(`\nEn forme d'identifiant composé (camelCase/PascalCase/underscore — le signal utile) :`);
  console.log(`  ${compoundCommentsWithHit} commentaire(s), ${compoundFilesWithHit.size} fichier(s).`);
  console.log(`\nExemples (jusqu'à 40) :`);
  for (const e of compoundExamples) console.log(e);
}

main();
