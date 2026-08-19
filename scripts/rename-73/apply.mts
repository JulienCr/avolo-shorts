/**
 * Applique la table de renommage — jamais par remplacement textuel. Trois
 * temps, tous calculés contre le programme **original**, non modifié, avant
 * la moindre écriture :
 *
 *   1. Pour chaque symbole de la table, `findRenameLocations` (findInStrings
 *      et findInComments à `false`) donne tous ses emplacements, projet
 *      entier.
 *   2. Pour chaque déplacement de fichier (dossiers renommés développés en
 *      fichiers, plus les renommages de fichiers directs), `getEditsForFileRename`
 *      donne les spécificateurs de module à ajuster ailleurs — la seule
 *      exception de chaîne littérale admise par le contrat.
 *   3. Les deux jeux d'édits sont fusionnés par fichier, triés par position
 *      décroissante, et appliqués en une passe : une édition en fin de
 *      fichier ne décale jamais la position d'une édition qui la précède.
 *
 * Les fichiers déplacés sont d'abord `git mv`-és tels quels (pour que git
 * suive le renommage), puis leur contenu édité est écrit par-dessus.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as ts from "typescript";
import { collectCandidates } from "./collect.mts";
import { classify, type Classified } from "./classify.mts";
import { PHRASE_OVERRIDES } from "./dictionary.mts";
import { FOLDER_RENAMES, FILE_RENAMES } from "./folders-and-files.mts";
import { createProjectLanguageService, ROOT } from "./project.mts";

interface TextEdit {
  start: number;
  length: number;
  newText: string;
  source: string; // pour les messages d'erreur en cas de chevauchement
}

function applyPhraseOverrides(c: Classified): Classified {
  const override = PHRASE_OVERRIDES[c.oldName];
  if (override === undefined) return c;
  return { ...c, proposedName: override, needsRename: true, unresolvedWords: [] };
}

/** Développe FOLDER_RENAMES en un déplacement par fichier qu'il contient,
 * composé avec FILE_RENAMES quand une entrée exacte existe (le dossier ET le
 * nom de base changent), sinon seul le dossier change. */
function expandMoves(): Array<{ from: string; to: string }> {
  const fileRenameByFrom = new Map(FILE_RENAMES.map((f) => [f.from, f.to]));
  const moves: Array<{ from: string; to: string }> = [];
  const consumedFileRenames = new Set<string>();

  for (const folder of FOLDER_RENAMES) {
    const abs = path.join(ROOT, folder.from);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new Error(`Sous-dossier inattendu sous ${folder.from} : ${entry.name}`);
      }
      const fromRel = path.posix.join(folder.from, entry.name);
      const explicit = fileRenameByFrom.get(fromRel);
      if (explicit) {
        moves.push({ from: fromRel, to: explicit });
        consumedFileRenames.add(fromRel);
      } else {
        // Le dossier bouge, pas le nom de base (ex. candidate-card.tsx,
        // app-bar.tsx — déjà en anglais).
        moves.push({ from: fromRel, to: path.posix.join(folder.to, entry.name) });
      }
    }
  }

  for (const f of FILE_RENAMES) {
    if (!consumedFileRenames.has(f.from)) moves.push(f);
  }

  return moves;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

  const { service } = createProjectLanguageService();
  const program = service.getProgram();
  if (!program) throw new Error("Impossible de construire le programme TypeScript.");

  const classified = collectCandidates().map(classify).map(applyPhraseOverrides);
  let toRename = classified.filter((c) => c.needsRename);
  if (toRename.some((c) => c.unresolvedWords.length > 0 || !c.proposedName)) {
    throw new Error("Des identifiants restent non résolus — lance table.mts d'abord, il échoue fort dessus.");
  }
  if (limit) toRename = toRename.slice(0, limit);

  const editsByFile = new Map<string, TextEdit[]>();
  function pushEdit(file: string, edit: TextEdit) {
    const list = editsByFile.get(file) ?? [];
    list.push(edit);
    editsByFile.set(file, list);
  }

  // --- 1. Renommages de symboles ---
  let renameLocationsCount = 0;
  for (const c of toRename) {
    const absFile = path.join(ROOT, c.file);
    const locations = service.findRenameLocations(absFile, c.pos, false, false, {
      providePrefixAndSuffixTextForRename: false,
    } as ts.UserPreferences);
    if (!locations || locations.length === 0) {
      throw new Error(
        `findRenameLocations n'a rien trouvé pour "${c.oldName}" (${c.file}:${c.line}, pos ${c.pos}).`
      );
    }
    for (const loc of locations) {
      renameLocationsCount++;
      pushEdit(loc.fileName, {
        start: loc.textSpan.start,
        length: loc.textSpan.length,
        newText: c.proposedName!,
        source: `rename ${c.oldName}->${c.proposedName} @ ${c.file}:${c.line}`,
      });
    }
  }

  // --- 2. Déplacements de fichiers : spécificateurs de module ---
  const moves = expandMoves();
  const formatOptions: ts.FormatCodeSettings = {};
  const preferences: ts.UserPreferences = {};
  let fileRenameEditCount = 0;
  for (const move of moves) {
    const fromAbs = path.join(ROOT, move.from);
    const toAbs = path.join(ROOT, move.to);
    const fileEdits = service.getEditsForFileRename(fromAbs, toAbs, formatOptions, preferences);
    for (const fe of fileEdits) {
      for (const change of fe.textChanges) {
        fileRenameEditCount++;
        pushEdit(fe.fileName, {
          start: change.span.start,
          length: change.span.length,
          newText: change.newText,
          source: `file-rename ${move.from}->${move.to} touches ${fe.fileName}`,
        });
      }
    }
  }

  console.error(`emplacements de renommage de symboles : ${renameLocationsCount}`);
  console.error(`édits de spécificateurs de module (déplacements de fichiers) : ${fileRenameEditCount}`);
  console.error(`fichiers touchés au total : ${editsByFile.size}`);

  if (dryRun) {
    console.error("--dry-run : aucune écriture.");
    return;
  }

  // --- 3. Fusion + application, fichier par fichier ---
  const movesByFrom = new Map(moves.map((m) => [path.join(ROOT, m.from), path.join(ROOT, m.to)]));

  // Chevauchement : deux édits qui se recouvrent viendraient de deux
  // symboles distincts touchant le même texte — jamais légitime pour un
  // renommage sémantique. Vérifié pour **tous** les fichiers avant la
  // moindre écriture : un renommage qui échoue au milieu de 197 fichiers ne
  // doit pas laisser une moitié réécrite et l'autre non.
  const sortedByFile = new Map<string, TextEdit[]>();
  for (const [file, edits] of editsByFile) {
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1].start;
      const curEnd = sorted[i].start + sorted[i].length;
      if (curEnd > prevEnd) {
        throw new Error(
          `Édits chevauchants dans ${file} :\n  ${sorted[i - 1].source}\n  ${sorted[i].source}`
        );
      }
    }
    sortedByFile.set(file, sorted);
  }

  for (const [file, sorted] of sortedByFile) {
    let content = fs.readFileSync(file, "utf8");
    for (const e of sorted) {
      content = content.slice(0, e.start) + e.newText + content.slice(e.start + e.length);
    }

    const targetFile = movesByFrom.get(file) ?? file;
    if (targetFile !== file) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    }
    fs.writeFileSync(targetFile, content, "utf8");
    if (targetFile !== file) {
      fs.unlinkSync(file);
    }
  }

  // Fichiers déplacés mais sans aucune édition de contenu (rare, mais un
  // fichier renommé sans import entrant ni symbole français dedans ne
  // laisserait sinon que l'ancien chemin sur le disque).
  for (const move of moves) {
    const fromAbs = path.join(ROOT, move.from);
    const toAbs = path.join(ROOT, move.to);
    if (!editsByFile.has(fromAbs) && fs.existsSync(fromAbs)) {
      fs.mkdirSync(path.dirname(toAbs), { recursive: true });
      fs.renameSync(fromAbs, toAbs);
    }
  }

  console.error("Renommage appliqué. Reste : git add explicite, puis les quatre portes.");
}

main();
