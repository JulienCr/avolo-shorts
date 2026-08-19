/**
 * Construit la table de renommage — l'artefact central de la PR, le premier
 * commit. Deux sorties :
 *
 *   - `renames-identifiers.tsv` : une ligne par **nom distinct**, lisible à
 *     l'œil. Le nom traduit est une fonction pure du nom d'origine (même
 *     dictionnaire, même style de casse), donc deux symboles qui partagent un
 *     nom partagent toujours sa traduction — regrouper par nom ne perd rien,
 *     et évite une table à 4400 lignes où le même couple se répète des
 *     centaines de fois.
 *   - `renames-identifiers.json` : une ligne par **symbole** (fichier, ligne,
 *     position), pour qu'apply.mts retrouve chaque déclaration précise sans
 *     redemander au TypeScript Language Service de rejuger qui est français.
 *
 * Écrit aussi `renames-folders.tsv` et `renames-files.tsv`, à part.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { collectCandidates } from "./collect.mts";
import { classify, type Classified } from "./classify.mts";
import { PHRASE_OVERRIDES } from "./dictionary.mts";
import { FOLDER_RENAMES, FILE_RENAMES } from "./folders-and-files.mts";
import { ROOT } from "./project.mts";

const OUT_DIR = path.join(ROOT, "scripts", "rename-73");

function applyPhraseOverrides(c: Classified): Classified {
  const override = PHRASE_OVERRIDES[c.oldName];
  if (override === undefined) return c;
  return { ...c, proposedName: override, needsRename: true, unresolvedWords: [] };
}

function main() {
  const classified = collectCandidates().map(classify).map(applyPhraseOverrides);
  const toRename = classified.filter((c) => c.needsRename);

  const stillUnresolved = toRename.filter((c) => c.unresolvedWords.length > 0);
  if (stillUnresolved.length > 0) {
    console.error(`${stillUnresolved.length} identifiants restent non résolus :`);
    for (const c of stillUnresolved) {
      console.error(`  ${c.oldName} (${c.file}:${c.line}) — mots : ${c.unresolvedWords.join(", ")}`);
    }
    throw new Error("Résous ces mots dans dictionary.mts avant de générer la table.");
  }

  const invalid = toRename.filter((c) => !c.proposedName || c.proposedName.length === 0);
  if (invalid.length > 0) {
    console.error(`${invalid.length} identifiants sans nom proposé valide :`);
    for (const c of invalid) console.error(`  ${c.oldName} (${c.file}:${c.line})`);
    throw new Error("Un renommage ne peut pas produire un nom vide.");
  }

  // Cohérence nom → nom : la traduction est une fonction pure de oldName (+
  // du dictionnaire), donc jamais deux valeurs pour la même clé. Vérifié
  // plutôt que supposé — une future PHRASE_OVERRIDE mal ciblée le casserait
  // silencieusement sinon.
  const nameToNew = new Map<string, string>();
  for (const c of toRename) {
    const existing = nameToNew.get(c.oldName);
    if (existing !== undefined && existing !== c.proposedName) {
      throw new Error(
        `Incohérence : "${c.oldName}" traduit à la fois en "${existing}" et en "${c.proposedName}" (${c.file}:${c.line}).`
      );
    }
    nameToNew.set(c.oldName, c.proposedName!);
  }

  // --- renames-identifiers.tsv (par nom distinct, lisible à l'œil) ---
  const byName = new Map<string, Classified[]>();
  for (const c of toRename) {
    const list = byName.get(c.oldName) ?? [];
    list.push(c);
    byName.set(c.oldName, list);
  }
  const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));
  const tsvLines = ["old_name\tnew_name\toccurrences\tfirst_seen"];
  for (const name of names) {
    const occurrences = byName.get(name)!;
    const first = occurrences[0];
    tsvLines.push(
      `${name}\t${nameToNew.get(name)}\t${occurrences.length}\t${first.file}:${first.line}`
    );
  }
  fs.writeFileSync(path.join(OUT_DIR, "renames-identifiers.tsv"), tsvLines.join("\n") + "\n");

  // --- renames-identifiers.json (par symbole, pour apply.mts) ---
  const perSymbol = toRename.map((c) => ({
    id: c.id,
    oldName: c.oldName,
    newName: nameToNew.get(c.oldName)!,
    kind: c.kind,
    file: c.file,
    line: c.line,
  }));
  fs.writeFileSync(
    path.join(OUT_DIR, "renames-identifiers.json"),
    JSON.stringify(perSymbol, null, 2) + "\n"
  );

  // --- renames-folders.tsv / renames-files.tsv (à part, pas noyés) ---
  const folderLines = ["from\tto", ...FOLDER_RENAMES.map((f) => `${f.from}\t${f.to}`)];
  fs.writeFileSync(path.join(OUT_DIR, "renames-folders.tsv"), folderLines.join("\n") + "\n");

  const fileLines = ["from\tto", ...FILE_RENAMES.map((f) => `${f.from}\t${f.to}`)];
  fs.writeFileSync(path.join(OUT_DIR, "renames-files.tsv"), fileLines.join("\n") + "\n");

  console.error(`identifiants à renommer : ${toRename.length} symboles, ${names.length} noms distincts`);
  console.error(`dossiers renommés : ${FOLDER_RENAMES.length}`);
  console.error(`fichiers renommés : ${FILE_RENAMES.length}`);
}

main();
