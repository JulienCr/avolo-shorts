/**
 * Complète 16 traductions restées partielles parce qu'un mot manquait au
 * dictionnaire (`dictionary.mts`) plutôt qu'à cause d'une collision —
 * `Inconnu`, `Boucle`, `Espace`, `Faute`, `Hors`, `Vivant` et surtout `est`
 * (11 fonctions/variables `estXxx`, jamais traduites en `isXxx`) n'y
 * figurent pas du tout. `classify.mts` documente lui-même cette fragilité :
 * « Sans accent et hors dictionnaire : on suppose l'anglais par défaut »
 * (classify.mts, `classifyWord`) — un mot français sans accent qui manque
 * au dictionnaire passe donc pour déjà anglais, silencieusement.
 *
 * Trouvé en croisant tous les mots des identifiants renommés contre un
 * lexique anglais (`nltk.corpus.words`, 236 736 entrées) : sur ~925 mots
 * distincts, 48 candidats après filtrage des flexions et du vocabulaire
 * technique, et 7 véritablement français une fois relus à la main.
 *
 * Un cas trouvé n'est délibérément pas corrigé ici : `detailHorsMedia`
 * (`tests/core/gemini.test.ts:18`) importe `../fixtures/gemini-detail-hors-media.json`
 * — renommer l'identifiant seul désynchroniserait son nom de celui du
 * fichier qu'il importe, un fichier de données hors du périmètre de ce
 * balayage (ni `src/`, ni `tests/*.ts`).
 *
 * Renomme par le service de langage — `findRenameLocations`, jamais un
 * remplacement textuel — exactement comme `apply.mts` et
 * `fix-collisions.mts`, dont ceci est le miroir pour une raison différente
 * (un mot jamais traduit, pas un nom bousculé par une collision).
 *
 *     pnpm tsx scripts/rename-73/fix-dictionary-gaps.mts --write
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { createProjectLanguageService, ROOT } from "./project.mts";
import { loadSymbolEntries, loadPairTsv, toCurrentPath, wordBoundaryRegex, findNodeAt, isDeclarationNameNode } from "./proof-inverse-tree.mts";
import { writeJson, writeTsv } from "./repair-tables-from-applied.mts";

interface Fix {
  file: string; // chemin d'origine, comme dans renames-identifiers.json
  line: number; // 1-based, la ligne de la déclaration à corriger
  oldTableName: string; // le newName actuellement enregistré dans la table — le texte à chercher dans le code
  correctedName: string;
  reason: string;
}

const FIXES: Fix[] = [
  {
    file: "src/server/run.ts",
    line: 107,
    oldTableName: "ProjectInconnuError",
    correctedName: "UnknownProjectError",
    reason: "« Inconnu » absent du dictionnaire — signalé par l'orchestrateur",
  },
  {
    file: "src/components/tri/fin-de-boucle.tsx",
    line: 31,
    oldTableName: "BoucleFin",
    correctedName: "LoopEnd",
    reason: "« Fin » et « Boucle » absents du dictionnaire — le fichier lui-même est déjà loop-end.tsx",
  },
  {
    file: "tests/server/sources.test.ts",
    line: 58,
    oldTableName: "withEspace",
    correctedName: "withSpace",
    reason: "« Espace » absent du dictionnaire",
  },
  { file: "scripts/dev-run.ts", line: 22, oldTableName: "estTarget", correctedName: "isTarget", reason: "« est » absent du dictionnaire" },
  { file: "src/core/erreurs.ts", line: 31, oldTableName: "estAbsolute", correctedName: "isAbsolute", reason: "« est » absent du dictionnaire" },
  { file: "src/core/parcours.ts", line: 29, oldTableName: "estGuard", correctedName: "isGuard", reason: "« est » absent du dictionnaire" },
  { file: "src/core/parcours.ts", line: 33, oldTableName: "estDiscarded", correctedName: "isDiscarded", reason: "« est » absent du dictionnaire" },
  { file: "src/lib/enregistrement.ts", line: 309, oldTableName: "estLast", correctedName: "isLast", reason: "« est » absent du dictionnaire" },
  {
    file: "src/server/octets.ts",
    line: 40,
    oldTableName: "estAAbsence",
    correctedName: "isAAbsence",
    reason: "« est » absent du dictionnaire — « Une » → « A » suit la convention déjà établie ailleurs (estUnMoignon → isAStub)",
  },
  { file: "src/server/secrets.ts", line: 128, oldTableName: "estReference", correctedName: "isReference", reason: "« est » absent du dictionnaire" },
  { file: "src/server/sources.ts", line: 158, oldTableName: "estAStub", correctedName: "isAStub", reason: "« est » absent du dictionnaire" },
  { file: "src/server/steps/candidates.ts", line: 441, oldTableName: "estTransient", correctedName: "isTransient", reason: "« est » absent du dictionnaire" },
  { file: "src/server/steps/render.ts", line: 1827, oldTableName: "renderEstStale", correctedName: "renderIsStale", reason: "« est » absent du dictionnaire" },
  {
    file: "tests/components/clip/panneau-export.test.tsx",
    line: 45,
    oldTableName: "nothingEstProduced",
    correctedName: "nothingIsProduced",
    reason: "« est » absent du dictionnaire",
  },
  {
    file: "src/server/steps/render.ts",
    line: 1053,
    oldTableName: "markerRejectFaute",
    correctedName: "markerRejectFault",
    reason: "« Faute » absent du dictionnaire",
  },
  {
    file: "tests/server/empreinte.test.ts",
    line: 774,
    oldTableName: "CLIP_SEGMENT_HORS",
    correctedName: "CLIP_SEGMENT_OUTSIDE",
    reason: "« Hors » absent du dictionnaire",
  },
  {
    file: "src/server/run.ts",
    line: 229,
    oldTableName: "editingVivant",
    correctedName: "editingAlive",
    reason: "« Vivant » absent du dictionnaire — style aligné sur sa jumelle déjà correcte, editingResponds",
  },
];

interface TextEdit {
  start: number;
  length: number;
  newText: string;
  source: string;
}

function main() {
  const write = process.argv.includes("--write");
  const { service } = createProjectLanguageService();
  const fileRenames = loadPairTsv("renames-files.tsv");
  const folderRenames = loadPairTsv("renames-folders.tsv");

  const editsByFile = new Map<string, TextEdit[]>();
  const claimed = new Map<string, Map<number, TextEdit>>();
  function pushEdit(fileAbs: string, edit: TextEdit) {
    const c = claimed.get(fileAbs) ?? new Map<number, TextEdit>();
    claimed.set(fileAbs, c);
    const existing = c.get(edit.start);
    if (existing) {
      if (existing.length === edit.length && existing.newText === edit.newText) return;
      throw new Error(`Conflit à ${fileAbs}@${edit.start} : "${existing.source}" vs "${edit.source}"`);
    }
    c.set(edit.start, edit);
    const list = editsByFile.get(fileAbs) ?? [];
    list.push(edit);
    editsByFile.set(fileAbs, list);
  }

  const applied: Array<Fix & { locations: number }> = [];

  for (const fix of FIXES) {
    const currentFileRel = toCurrentPath(fix.file, fileRenames, folderRenames);
    const currentFileAbs = path.join(ROOT, currentFileRel);
    if (!fs.existsSync(currentFileAbs)) throw new Error(`Fichier introuvable : ${currentFileRel} (${fix.oldTableName})`);
    const content = fs.readFileSync(currentFileAbs, "utf8");
    const kind: ts.ScriptKind = path.extname(currentFileRel) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(currentFileRel, content, ts.ScriptTarget.Latest, true, kind);
    const lineStarts = source.getLineStarts();
    const lineIndex = fix.line - 1;
    if (lineIndex < 0 || lineIndex >= lineStarts.length) throw new Error(`Ligne hors bornes : ${currentFileRel}:${fix.line}`);
    const lineStart = lineStarts[lineIndex];
    const lineEnd = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : content.length;
    const lineText = content.slice(lineStart, lineEnd);

    const re = wordBoundaryRegex(fix.oldTableName);
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
    if (validatedPos === null) throw new Error(`Déclaration "${fix.oldTableName}" non trouvée à ${currentFileRel}:${fix.line}`);

    const locations = service.findRenameLocations(currentFileAbs, validatedPos, false, false, {
      providePrefixAndSuffixTextForRename: false,
    } as ts.UserPreferences);
    if (!locations || locations.length === 0) throw new Error(`findRenameLocations vide pour "${fix.oldTableName}" à ${currentFileRel}:${fix.line}`);

    for (const loc of locations) {
      pushEdit(loc.fileName, {
        start: loc.textSpan.start,
        length: loc.textSpan.length,
        newText: fix.correctedName,
        source: `${fix.oldTableName}->${fix.correctedName} @ ${currentFileRel}:${fix.line}`,
      });
    }
    applied.push({ ...fix, locations: locations.length });
  }

  console.log(`${applied.length} correction(s) validée(s) :`);
  for (const a of applied) {
    console.log(`  ${a.file}:${a.line} — "${a.oldTableName}" -> "${a.correctedName}" (${a.locations} occurrence(s)) — ${a.reason}`);
  }
  const totalEdits = [...editsByFile.values()].reduce((n, l) => n + l.length, 0);
  console.log(`\n${editsByFile.size} fichier(s), ${totalEdits} édit(s) au total.`);

  if (!write) {
    console.log("\n(dry-run — relancer avec --write pour appliquer et régénérer les tables)");
    return;
  }

  for (const [fileAbs, edits] of editsByFile) {
    let content = fs.readFileSync(fileAbs, "utf8");
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    for (const e of sorted) {
      content = content.slice(0, e.start) + e.newText + content.slice(e.start + e.length);
    }
    fs.writeFileSync(fileAbs, content, "utf8");
  }
  console.log("Code corrigé.");

  // Met à jour renames-identifiers.json : chaque entrée dont newName était
  // l'un des noms incomplets ci-dessus prend le nom corrigé.
  const byOldTableName = new Map(FIXES.map((f) => [f.oldTableName, f.correctedName]));
  const entries = loadSymbolEntries();
  let changed = 0;
  const corrected = entries.map((e) => {
    const fix = byOldTableName.get(e.newName);
    if (fix === undefined) return e;
    changed++;
    return { ...e, newName: fix };
  });
  writeJson(corrected);
  const rowCount = writeTsv(corrected);
  console.log(`Table corrigée : ${changed} entrée(s) JSON mises à jour, ${rowCount} lignes TSV régénérées.`);
}

main();
