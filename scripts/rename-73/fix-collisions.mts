/**
 * Nettoyage post-application : `apply.mts` renomme des symboles un par un,
 * corrects chacun pris isolément, mais deux traductions indépendantes
 * peuvent retomber sur le même mot anglais dans la même portée — un import
 * `path` de `node:path` et une variable locale traduite depuis `chemin`, par
 * exemple. `pnpm type-check` les repère (identifiant dupliqué, variable
 * utilisée avant sa déclaration...) ; ce script les corrige un par un, par
 * la même API sémantique que apply.mts (`findRenameLocations`, jamais un
 * remplacement textuel), sur le nom local précis plutôt que sur le mot en
 * général — renommer "path" comme mot dans le dictionnaire recréerait la
 * même collision ailleurs.
 *
 * Usage : pnpm tsx scripts/rename-73/fix-collisions.mts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { createProjectLanguageService, ROOT } from "./project.mts";

interface Fix {
  file: string; // relatif à ROOT
  line: number; // 1-based, la ligne de la déclaration à renommer
  oldName: string;
  newName: string;
  reason: string;
}

const FIXES: Fix[] = [
  {
    file: "src/server/steps/render.ts",
    line: 1003,
    oldName: "path",
    newName: "filePath",
    reason: "variable locale (ex-\"chemin\") shadowant l'import `path` de node:path",
  },
  {
    file: "tests/server/analysis.test.ts",
    line: 428,
    oldName: "path",
    newName: "filePath",
    reason: "idem, boucle sur des fichiers factices",
  },
  {
    file: "tests/server/analysis.test.ts",
    line: 530,
    oldName: "path",
    newName: "filePath",
    reason: "idem",
  },
  {
    file: "tests/server/analysis.test.ts",
    line: 563,
    oldName: "path",
    newName: "filePath",
    reason: "idem",
  },
  {
    file: "tests/server/ingest.test.ts",
    line: 239,
    oldName: "path",
    newName: "filePath",
    reason: "idem",
  },
  {
    file: "tests/server/source-thumbnails.test.ts",
    line: 55,
    oldName: "path",
    newName: "filePath",
    reason: "idem",
  },
  // tests/lib/autosave-auto.test.tsx — PAS ici, à dessein. C'est le seul cas
  // où le nom colle une déclaration locale à un import de même nom **au même
  // niveau de portée** (module), condition exacte de "TS2440 Import
  // declaration conflicts with local declaration" : findRenameLocations,
  // interrogé à cette position, confond alors les deux déclarations et les
  // renomme *ensemble* vers le même nom — constaté ici, ça a renommé le vrai
  // `act` de @testing-library/react dans onze fichiers du dépôt entier, sans
  // rapport avec ce fichier. Corrigé à la main : import et l'unique appel
  // interne restent `act`, la déclaration locale et ses 53 appels externes
  // deviennent `actAsync`. La leçon pour la prochaine collision de cette
  // forme précise : ne jamais passer par le Language Service, un
  // remplacement scopé au fichier et à la portée fait l'affaire.
  {
    file: "tests/core/captions.test.ts",
    line: 17,
    oldName: "text",
    newName: "textOf",
    reason: "fonction locale (ex-\"texteDe\", \"de\" tombé en glue) shadowant la variable locale \"text\", déjà anglaise avant renommage",
  },
  {
    file: "tests/core/phase.test.ts",
    line: 230,
    oldName: "count",
    newName: "result",
    reason: "variable locale de test shadowant la fonction importée `count` de @/core/phase (ex-\"compte\"/\"compter\")",
  },
  {
    file: "tests/components/clip/transcript-surface.test.tsx",
    line: 54,
    oldName: "lines",
    newName: "raw",
    reason: "variable locale (ex-\"brut\") shadowant la seconde \"lines\" déstructurée juste après",
  },
  {
    file: "tests/server/paths.test.ts",
    line: 205,
    oldName: "fallback",
    newName: "existingFolder",
    reason: "variable locale (ex-\"repli\", un dossier de test) shadowant la seconde \"fallback\" déstructurée juste après",
  },
];

function findDeclarationPos(
  source: ts.SourceFile,
  line: number,
  name: string
): number | null {
  const lineStart = source.getPositionOfLineAndCharacter(line - 1, 0);
  const lineEndChar = source.text.indexOf("\n", lineStart);
  const lineEnd = lineEndChar === -1 ? source.text.length : lineEndChar;

  let found: number | null = null;
  const visit = (node: ts.Node) => {
    if (found !== null) return;
    if (node.getStart() >= lineStart && node.getStart() < lineEnd) {
      if (ts.isIdentifier(node) && node.text === name && isBindingName(node)) {
        found = node.getStart();
        return;
      }
    }
    if (node.getStart() < lineEnd && node.getEnd() > lineStart) {
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  return found;
}

function isBindingName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const withName = parent as unknown as { name?: ts.Node };
  return withName.name === node;
}

function main() {
  const { service } = createProjectLanguageService();
  const program = service.getProgram();
  if (!program) throw new Error("Impossible de construire le programme TypeScript.");

  const editsByFile = new Map<string, Array<{ start: number; length: number; newText: string }>>();

  for (const fix of FIXES) {
    const absFile = path.join(ROOT, fix.file);
    const source = program.getSourceFile(absFile);
    if (!source) throw new Error(`Fichier introuvable dans le programme : ${fix.file}`);

    const pos = findDeclarationPos(source, fix.line, fix.oldName);
    if (pos === null) {
      throw new Error(
        `"${fix.oldName}" introuvable en position de liaison à ${fix.file}:${fix.line} — le fichier a-t-il bougé depuis ?`
      );
    }

    const locations = service.findRenameLocations(absFile, pos, false, false, {
      providePrefixAndSuffixTextForRename: false,
    } as ts.UserPreferences);
    if (!locations || locations.length === 0) {
      throw new Error(`findRenameLocations n'a rien trouvé pour ${fix.file}:${fix.line} ("${fix.oldName}").`);
    }

    for (const loc of locations) {
      const list = editsByFile.get(loc.fileName) ?? [];
      list.push({ start: loc.textSpan.start, length: loc.textSpan.length, newText: fix.newName });
      editsByFile.set(loc.fileName, list);
    }
    console.error(`${fix.file}:${fix.line} — "${fix.oldName}" → "${fix.newName}" (${locations.length} emplacement(s)) — ${fix.reason}`);
  }

  for (const [file, edits] of editsByFile) {
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let content = fs.readFileSync(file, "utf8");
    for (const e of sorted) {
      content = content.slice(0, e.start) + e.newText + content.slice(e.start + e.length);
    }
    fs.writeFileSync(file, content, "utf8");
  }

  console.error(`\n${FIXES.length} collisions corrigées dans ${editsByFile.size} fichier(s).`);
}

main();
