/**
 * Catalogue trois déclarations que `collect.mts` n'a jamais suivies, trouvées
 * par la preuve inverse *après* la réparation des 105 noms divergents
 * (`repair-tables-from-applied.mts`) — un résidu d'une nature différente : pas
 * un nom enregistré faux, un symbole **absent** de la table.
 *
 * `collect.mts` ne suit que 12 formes de déclaration (variable, paramètre,
 * élément de déstructuration, fonction, méthode, classe, alias de type,
 * propriété d'interface, import…) — jamais une clé de propriété d'objet
 * littéral (`{ clé: valeur }`), qui n'en fait pas partie. Les trois cas :
 *
 *   1. `src/core/framing.ts:926` — `let meilleur = { images: -1, centre: cible }` :
 *      la clé `centre` est une propriété d'objet littéral, jamais suivie.
 *      Sa traduction (`center`) est la même que partout ailleurs où `centre`
 *      apparaît dans ce dépôt — une traduction ordinaire, seulement jamais
 *      cataloguée.
 *   2. `src/core/framing.ts:1194` — `const shots: ShotFraming[] = plans.map(...)` :
 *      `shots` était **déjà anglais** avant le balayage (vérifié contre
 *      `origin/main`), jamais candidat à une traduction. Il a été déplacé en
 *      `framedShots` parce qu'un renommage voisin, à la ligne 1137
 *      (`plans` → `shots`, celui-là bien catalogué), est venu occuper son nom
 *      dans la même portée.
 *   3. `tests/lib/editing.test.ts:65` — `const { words, lines } = indexTranscript(lignes, [])` :
 *      la liaison déstructurée `lines` était déjà anglaise, jamais candidate.
 *      Déplacée en `indexed` parce que `lignes` — l'argument passé sur cette
 *      même ligne — est **le même identifiant** que la variable englobante
 *      déjà renommée `lignes` → `lines` (ligne 53) : sans le déplacement,
 *      la liaison locale aurait masqué la variable qu'elle vient de lire.
 *
 * Un déplacement par collision n'est pas une traduction : le cas 1 en est
 * une (jamais cataloguée), les cas 2 et 3 ne le sont pas (l'identifiant
 * d'origine était déjà anglais). La colonne `note` du TSV régénéré porte
 * cette distinction pour qui lit la table plutôt que le diff.
 *
 *     pnpm tsx scripts/rename-73/catalogue-uncatalogued.mts --write
 */
import { type SymbolEntry, loadSymbolEntries, buildIdentifierEditPlan, loadPairTsv } from "./proof-inverse-tree.mts";
import { writeJson, writeTsv } from "./repair-tables-from-applied.mts";

const NEW_ENTRIES: SymbolEntry[] = [
  {
    oldName: "centre",
    newName: "center",
    kind: "propertyAssignment",
    file: "src/core/framing.ts",
    line: 926,
    note: "clé de propriété d'un objet littéral — jamais suivie par collect.mts (traduction ordinaire, seulement jamais cataloguée)",
  },
  {
    oldName: "shots",
    newName: "framedShots",
    kind: "variable",
    file: "src/core/framing.ts",
    line: 1194,
    note: "déjà anglais avant le balayage — déplacé par collision avec plans→shots à la ligne 1137, jamais candidat à une traduction",
  },
  {
    oldName: "lines",
    newName: "indexed",
    kind: "bindingElement",
    file: "tests/lib/editing.test.ts",
    line: 65,
    note: "déjà anglais avant le balayage — déplacé par collision avec lignes→lines (la variable englobante lue sur la même ligne), jamais candidat à une traduction",
  },
];

function main() {
  const write = process.argv.includes("--write");

  const existing = loadSymbolEntries();
  const merged = [...existing, ...NEW_ENTRIES];

  const fileRenames = loadPairTsv("renames-files.tsv");
  const folderRenames = loadPairTsv("renames-folders.tsv");

  console.log(`Validation des ${NEW_ENTRIES.length} nouvelles entrées contre l'arbre actuel...`);
  const { editsByFile, notFound, conflicts } = buildIdentifierEditPlan(NEW_ENTRIES, fileRenames, folderRenames);
  if (notFound.length > 0) {
    console.error(`ÉCHEC — ${notFound.length} entrée(s) non localisée(s) :`);
    for (const e of notFound) console.error(`  "${e.oldName}" -> "${e.newName}" (${e.file}:${e.line})`);
    process.exit(1);
  }
  if (conflicts.length > 0) {
    console.error(`ÉCHEC — ${conflicts.length} conflit(s) :`);
    for (const c of conflicts) console.error(`  ${c}`);
    process.exit(1);
  }
  const totalEdits = [...editsByFile.values()].reduce((n, l) => n + l.length, 0);
  console.log(`  OK — ${editsByFile.size} fichier(s), ${totalEdits} édit(s) au total pour ces 3 entrées.`);

  if (!write) {
    console.log("\n(dry-run — relancer avec --write pour écrire renames-identifiers.json et .tsv)");
    return;
  }

  writeJson(merged);
  const rowCount = writeTsv(merged);
  console.log(`\nÉcrit renames-identifiers.json (${merged.length} symboles, +${NEW_ENTRIES.length}) et renames-identifiers.tsv (${rowCount} lignes).`);
}

main();
