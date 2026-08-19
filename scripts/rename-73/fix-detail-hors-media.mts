/**
 * Renomme `detailHorsMedia` en `detailOutsideMedia` — le seul mot du
 * dictionnaire (« Hors ») que `fix-dictionary-gaps.mts` avait délibérément
 * laissé de côté, parce que l'identifiant nomme le fichier de fixture qu'il
 * importe (`tests/fixtures/gemini-detail-hors-media.json`) : renommer l'un
 * sans l'autre les aurait désynchronisés.
 *
 * Signalé par l'orchestrateur en revue du balayage du delta de la PR #103 :
 * une fixture de test n'a pas la portée de persistance d'un fichier de
 * production (rien d'autre ne la lit, rien ne l'écrit à l'exécution — elle
 * est committée) — les deux bougent donc ensemble ici :
 *
 *   1. `git mv tests/fixtures/gemini-detail-hors-media.json
 *          tests/fixtures/gemini-detail-outside-media.json` (fait à part,
 *      avant ce script).
 *   2. Le spécificateur d'import mis à jour à la main dans
 *      `tests/core/gemini.test.ts` (fait à part aussi — un chemin de module
 *      n'est pas un identifiant, `findRenameLocations` ne le touche pas).
 *   3. Ce script : l'identifiant, par le service de langage — jamais un
 *      remplacement textuel — exactement comme `fix-dictionary-gaps.mts`,
 *      dont ceci complète le cas laissé en suspens (un seul fix, pas besoin
 *      de la table `FIXES[]`).
 *
 *     pnpm tsx scripts/rename-73/fix-detail-hors-media.mts --write
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { createProjectLanguageService, ROOT } from "./project.mts";
import { loadSymbolEntries, wordBoundaryRegex, findNodeAt, isDeclarationNameNode } from "./proof-inverse-tree.mts";
import { writeJson, writeTsv } from "./repair-tables-from-applied.mts";

const FILE = "tests/core/gemini.test.ts";
const LINE = 18;
const OLD_TABLE_NAME = "detailHorsMedia";
const CORRECTED_NAME = "detailOutsideMedia";

function main() {
  const write = process.argv.includes("--write");
  const { service } = createProjectLanguageService();

  const fileAbs = path.join(ROOT, FILE);
  const content = fs.readFileSync(fileAbs, "utf8");
  const source = ts.createSourceFile(FILE, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineStarts = source.getLineStarts();
  const lineIndex = LINE - 1;
  const lineStart = lineStarts[lineIndex];
  const lineEnd = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : content.length;
  const lineText = content.slice(lineStart, lineEnd);

  const re = wordBoundaryRegex(OLD_TABLE_NAME);
  let match: RegExpExecArray | null;
  let validatedPos: number | null = null;
  while ((match = re.exec(lineText)) !== null) {
    const candidatePos = lineStart + match.index;
    const node = findNodeAt(source, candidatePos, source);
    if (node && isDeclarationNameNode(node)) {
      validatedPos = candidatePos;
      break;
    }
  }
  if (validatedPos === null) throw new Error(`Déclaration "${OLD_TABLE_NAME}" non trouvée à ${FILE}:${LINE}`);

  const locations = service.findRenameLocations(fileAbs, validatedPos, false, false, {
    providePrefixAndSuffixTextForRename: false,
  } as ts.UserPreferences);
  if (!locations || locations.length === 0) throw new Error(`findRenameLocations vide pour "${OLD_TABLE_NAME}"`);

  console.log(`"${OLD_TABLE_NAME}" -> "${CORRECTED_NAME}" : ${locations.length} occurrence(s)`);
  for (const loc of locations) console.log(`  ${loc.fileName}@${loc.textSpan.start}`);

  if (!write) {
    console.log("\n(dry-run — relancer avec --write pour appliquer et régénérer les tables)");
    return;
  }

  // Un seul fichier concerné ici (vérifié ci-dessus par le compte
  // d'occurrences) : édits triés par position décroissante pour que les
  // offsets des édits précédents restent valides.
  const byFile = new Map<string, ts.RenameLocation[]>();
  for (const loc of locations) {
    const list = byFile.get(loc.fileName) ?? [];
    list.push(loc);
    byFile.set(loc.fileName, list);
  }
  for (const [fname, locs] of byFile) {
    let fileContent = fs.readFileSync(fname, "utf8");
    const sorted = [...locs].sort((a, b) => b.textSpan.start - a.textSpan.start);
    for (const loc of sorted) {
      fileContent =
        fileContent.slice(0, loc.textSpan.start) +
        CORRECTED_NAME +
        fileContent.slice(loc.textSpan.start + loc.textSpan.length);
    }
    fs.writeFileSync(fname, fileContent, "utf8");
  }
  console.log("Code corrigé.");

  const entries = loadSymbolEntries();
  let changed = 0;
  const corrected = entries.map((e) => {
    if (e.newName !== OLD_TABLE_NAME) return e;
    changed++;
    return { ...e, newName: CORRECTED_NAME };
  });
  writeJson(corrected);
  const rowCount = writeTsv(corrected);
  console.log(`Table corrigée : ${changed} entrée(s) JSON mise(s) à jour, ${rowCount} lignes TSV régénérées.`);
}

main();
