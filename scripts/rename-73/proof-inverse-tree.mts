/**
 * Preuve inverse — rien d'autre que la table n'a bougé.
 *
 * La plus forte des trois preuves de l'issue #73, et celle qui répond
 * directement à l'objection « cette PR ne sera pas relue » : elle rend
 * mécanique l'affirmation que le diff de 195 fichiers ne contient **rien**
 * que les substitutions de `renames-identifiers.tsv`, `renames-files.tsv` et
 * `renames-folders.tsv` — pas une ligne déplacée, pas un espacement changé,
 * pas une amélioration glissée en chemin.
 *
 * ## Pourquoi une substitution textuelle globale ne marche pas
 *
 * Le premier jet de cette preuve substituait chaque `new_name` par son
 * `old_name` par un remplacement textuel sur frontière de mot, appliqué à
 * tout le fichier. Sur ce dépôt, ça corrompt le code : `de` → `from` est une
 * ligne réelle de la table (un paramètre nommé `de` dans une fonction qui
 * allait `de` quelque chose `à` quelque chose d'autre), mais substituer
 * `from` → `de` **partout** réécrit aussi le mot-clé ES `from` de tous les
 * `import { X } from "next/font/google"` du dépôt, sans lien avec ce
 * paramètre. Le même sort touche `font`→`police`, `title`→`titre`,
 * `value`→`valeurs`, `target`→`cible`, `size`→`taille`, `name`→`nom` et
 * une bonne douzaine d'autres : des mots anglais courts et courants, qui
 * sont *à la fois* la cible légitime d'un renommage précis quelque part et
 * un mot-clé ou un identifiant sans rapport ailleurs. C'est exactement la
 * classe de bug que `CLAUDE.md` documente pour `chemin`→`path` face à
 * `node:path` — en beaucoup plus large à l'envers, parce que l'anglais a
 * moins de collisions de ce genre que le français n'en a créées en sens
 * inverse.
 *
 * ## La méthode retenue : la même que `apply.mts`, à l'envers
 *
 * `apply.mts` ne renomme jamais par le texte — il utilise
 * `findRenameLocations` du service de langage TypeScript, qui résout le
 * *symbole* précis derrière une position et rend exactement ses occurrences,
 * jamais un mot qui ressemble. Cette preuve fait la même chose en sens
 * inverse, symbole par symbole plutôt que nom par nom — voir le commentaire
 * sur `SymbolEntry` pour la raison (`renames-identifiers.tsv` agrège
 * plusieurs déclarations distinctes sous un même nom, `renames-identifiers.json`
 * les garde séparées) :
 *
 *   1. Pour chaque entrée de `renames-identifiers.json`, `file:line` donne
 *      un emplacement **avant** renommage. Ce fichier est ramené à son
 *      chemin actuel (`renames-files.tsv` / `renames-folders.tsv`, sens
 *      direct), et sur la même ligne — un renommage d'identifiant ne change
 *      jamais le nombre de lignes d'un fichier — chaque occurrence du token
 *      `newName` est essayée jusqu'à ce qu'un test syntaxique
 *      (`isDeclarationNameNode`) confirme qu'elle est bien le nom **déclaré**
 *      à cet endroit — jamais une simple référence — avant d'être retenue
 *      (voir le commentaire sur `buildIdentifierEditPlan` : cette validation
 *      existe parce que le nom enregistré dans la table peut ne plus être le
 *      texte exact présent dans le code, pour au moins un symbole observé).
 *   2. `findRenameLocations` à cette position validée, sur le service de
 *      langage construit sur l'arbre **actuel** (`HEAD`), rend toutes les
 *      occurrences de ce symbole précis, projet entier — jamais un autre
 *      symbole qui porte le même texte ailleurs.
 *   3. Chaque occurrence est éditée vers `oldName`. Deux entrées qui
 *      revendiquent le même empan avec le même texte sont bénignes (le même
 *      symbole vu deux fois) ; avec un texte différent, c'est un vrai
 *      conflit, reporté plutôt que silencieusement écrasé.
 *   4. Les spécificateurs de module (`@/...`, relatifs, `import()`
 *      dynamique) sont ramenés à ce qu'ils désignaient dans `origin/main`,
 *      par résolution de leur rôle syntaxique (jamais par le texte) — la
 *      seule exception de chaîne littérale, comme dans la preuve A.
 *   5. Les fichiers et dossiers renommés sont ramenés à leur chemin
 *      d'origine.
 *   6. `diff -rq` puis `diff -ru` contre `origin/main`. Un diff vide *est*
 *      la preuve.
 *
 * Cette méthode élimine par construction le risque de non-injectivité par
 * *nom* (deux `oldName` distincts partageant un `newName`, ou un `newName`
 * qui collisionne avec un mot-clé ou un symbole existant) : elle ne
 * travaille jamais par nom, seulement par symbole résolu. Ce qui reste
 * possible — et qui ferait légitimement échouer cette preuve — est
 * l'échec de la validation sur une entrée (aucune occurrence du `newName`
 * attendu, sur la ligne attendue, ne se confirme comme la déclaration), ou
 * deux symboles distincts qui revendiquent le même empan avec un texte
 * différent : les deux sont comptés et listés, pas masqués.
 *
 *     pnpm tsx scripts/rename-73/proof-inverse-tree.mts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript";
import { ROOT, createProjectLanguageService } from "./project.mts";

const SCRATCH_ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "proof-inverse-"));
const SCOPE_DIRS = ["src", "scripts", "tests"];

function archiveTree(ref: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  const tarBuf = execFileSync("git", ["archive", ref, ...SCOPE_DIRS], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 512,
  });
  execFileSync("tar", ["-x", "-C", dest], { input: tarBuf });
}

function rmrf(p: string) {
  fs.rmSync(p, { recursive: true, force: true });
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** Une entrée de `renames-identifiers.json` — **un symbole**, pas un nom
 * agrégé. `renames-identifiers.tsv` regroupe par texte de nom : une seule
 * ligne pour `sonde`, alors que 4 déclarations distinctes portent ce nom
 * dans 4 fichiers différents (`occurrences: 4`), et le TSV ne garde que la
 * position de la première (`first_seen`). Bâtir le plan d'édition depuis le
 * TSV en ratait donc 3 sur 4 : `findRenameLocations` à la position de la
 * première déclaration ne rend que **ses** occurrences, jamais celles des 3
 * autres symboles qui partagent le même texte ailleurs. Le JSON, lui, donne
 * les 4145 déclarations individuellement — un régime symétrique à celui que
 * `apply.mts` a suivi dans le sens direct. */
export interface SymbolEntry {
  oldName: string;
  newName: string;
  kind: string;
  file: string; // chemin d'origine (avant renommage de fichier/dossier)
  line: number; // 1-based
  /** Pourquoi cette entrée n'était pas dans la table d'origine — absente pour
   * les 4145 symboles que `collect.mts` a réellement suivis, présente pour
   * les quelques-uns catalogués après coup (voir
   * `scripts/rename-73/catalogue-uncatalogued.mts`). */
  note?: string;
}

export function loadSymbolEntries(): SymbolEntry[] {
  const p = path.join(ROOT, "scripts/rename-73/renames-identifiers.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as SymbolEntry[];
}

export function loadPairTsv(name: string): Array<{ from: string; to: string }> {
  const p = path.join(ROOT, "scripts/rename-73", name);
  const lines = fs.readFileSync(p, "utf8").split("\n").slice(1).filter(Boolean);
  return lines.map((line) => {
    const [from, to] = line.split("\t");
    return { from, to };
  });
}

/** Chemin actuel (après renommage de fichier/dossier) pour un chemin
 * d'origine donné — le sens direct, celui que `apply.mts` a suivi. */
export function toCurrentPath(originalPath: string, fileRenames: Array<{ from: string; to: string }>, folderRenames: Array<{ from: string; to: string }>): string {
  const explicit = fileRenames.find((r) => r.from === originalPath);
  if (explicit) return explicit.to;
  for (const folder of folderRenames) {
    if (originalPath === folder.from || originalPath.startsWith(folder.from + "/")) {
      return folder.to + originalPath.slice(folder.from.length);
    }
  }
  return originalPath;
}

/** Chemin d'origine (avant renommage de fichier/dossier) pour un chemin
 * actuel donné — l'inverse exact de `toCurrentPath`. */
function toOriginalPath(currentPath: string, fileRenames: Array<{ from: string; to: string }>, folderRenames: Array<{ from: string; to: string }>): string {
  const explicit = fileRenames.find((r) => r.to === currentPath);
  if (explicit) return explicit.from;
  for (const folder of folderRenames) {
    if (currentPath === folder.to || currentPath.startsWith(folder.to + "/")) {
      return folder.from + currentPath.slice(folder.to.length);
    }
  }
  return currentPath;
}

export interface NameResolution {
  resolved: string | null;
  reason: string;
}

/**
 * Résout un ancien nom en son nouveau nom **dans un fichier donné** — le
 * seul recours quand une table n'est pas une bijection (`chemin` → `path`,
 * mais aussi `filePath`/`thumbPath`/`resultPath`/`fingerprintPath` selon la
 * déclaration) et que le point d'usage — un commentaire, un titre de test —
 * n'a pas de portée lexicale : impossible de demander au service de langage
 * quelle déclaration il désigne.
 *
 *   1. Un seul `newName` dans toute la table pour cet `oldName` : aucune
 *      ambiguïté, valable dans n'importe quel fichier.
 *   2. Sinon, si CE fichier contient exactement une déclaration de cet
 *      `oldName` (`renames-identifiers.json`, champ `file`, ramené au
 *      chemin actuel) : son `newName` s'applique — résolu par fichier.
 *   3. Sinon (zéro ou plusieurs candidats locaux) : non résolu. Mieux vaut
 *      un cas non résolu qu'un cas deviné.
 *
 * Partagé par `fix-dangling-comments.mts` (qui substitue) et
 * `proof-a-strings-and-comments.mts` (qui vérifie une substitution déjà
 * faite) — les deux doivent s'accorder sur la même règle, sous peine que la
 * preuve rejette une substitution que l'outil vient pourtant de faire
 * correctement.
 */
export function buildResolver(
  entries: SymbolEntry[],
  fileRenames: Array<{ from: string; to: string }>,
  folderRenames: Array<{ from: string; to: string }>
): (oldName: string, currentFileRel: string) => NameResolution {
  const globalCandidates = new Map<string, Set<string>>();
  for (const e of entries) {
    const set = globalCandidates.get(e.oldName) ?? new Set<string>();
    set.add(e.newName);
    globalCandidates.set(e.oldName, set);
  }
  const byOldNameAndFile = new Map<string, Map<string, Set<string>>>();
  for (const e of entries) {
    const currentFile = toCurrentPath(e.file, fileRenames, folderRenames);
    const byFile = byOldNameAndFile.get(e.oldName) ?? new Map<string, Set<string>>();
    byOldNameAndFile.set(e.oldName, byFile);
    const set = byFile.get(currentFile) ?? new Set<string>();
    set.add(e.newName);
    byFile.set(currentFile, set);
  }

  return function resolve(oldName: string, currentFileRel: string): NameResolution {
    const globals = globalCandidates.get(oldName);
    if (!globals) return { resolved: null, reason: "absent de la table" };
    if (globals.size === 1) return { resolved: [...globals][0], reason: "non ambigu" };
    const localSet = byOldNameAndFile.get(oldName)?.get(currentFileRel);
    if (localSet && localSet.size === 1) return { resolved: [...localSet][0], reason: "résolu par fichier" };
    return {
      resolved: null,
      reason:
        localSet && localSet.size > 1
          ? `fichier lui-même ambigu [${[...localSet].join(", ")}]`
          : `aucune déclaration locale, candidats globaux [${[...globals].join(", ")}]`,
    };
  };
}

/** Un identifiant TypeScript complet — lettres Unicode, chiffres, `_`, `$`. */
export function wordBoundaryRegex(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, "gu");
}

const stripExt = (p: string) => p.replace(/\.(ts|tsx|mts)$/, "");

/** Le nœud le plus profond de `root` qui couvre `pos` — pour un identifiant,
 * c'est l'identifiant lui-même, puisqu'il n'a pas d'enfant. */
export function findNodeAt(root: ts.Node, pos: number, source: ts.SourceFile): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (pos >= node.getStart(source) && pos < node.getEnd()) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(root);
  return found;
}

/** `true` si `node` est l'identifiant **déclaré** d'une construction (une
 * variable, un paramètre, un élément de déstructuration, une méthode, une
 * propriété d'interface, un import, …) — jamais une simple référence à ce
 * nom ailleurs dans le fichier.
 *
 * C'est le garde-fou qui remplace un premier jet basé sur
 * `getDefinitionAtPosition` : sur une déstructuration sans annotation de
 * type (`{ largeur }: Props`), TypeScript résout « aller à la définition »
 * jusqu'à la propriété d'interface d'origine plutôt que de désigner le
 * lien local lui-même — un comportement correct pour un éditeur, faux pour
 * ce qu'on cherche à vérifier ici (est-ce *cette* déclaration-là). Un test
 * purement syntaxique — « ce nœud est-il le champ `name` d'un nœud
 * déclaratif » — n'a pas ce problème : il ne suit aucune résolution de
 * type, il lit l'arbre tel qu'écrit. */
export function isDeclarationNameNode(node: ts.Node): boolean {
  if (!ts.isIdentifier(node)) return false;
  const parent = node.parent;
  if (!parent) return false;
  const declLike =
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isBindingElement(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isEnumMember(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isGetAccessor(parent) ||
    ts.isSetAccessor(parent);
  if (!declLike) return false;
  const withName = parent as unknown as { name?: ts.Node };
  return withName.name === node;
}

interface TextEdit {
  start: number;
  length: number;
  newText: string;
  source: string;
}

/** Construit le plan d'édition symbole par symbole en interrogeant le
 * service de langage TypeScript construit sur l'arbre `HEAD` **actuel** (le
 * worktree, pas une copie) — exactement le service que `apply.mts` utilise,
 * retourné à l'envers via `findRenameLocations`. Une entrée par symbole
 * (`renames-identifiers.json`, 4145 déclarations), jamais par nom agrégé —
 * voir le commentaire sur `SymbolEntry`.
 *
 * Chaque position candidate est **validée avant d'être utilisée** :
 * `isDeclarationNameNode` doit confirmer que le token trouvé est bien le nom
 * **déclaré** à cet endroit, jamais une référence. Sans ce garde-fou, une
 * entrée dont le `newName`
 * enregistré ne correspond plus exactement au texte actuel — un nom
 * ajusté après coup pour éviter une collision locale, en dehors de
 * `fix-collisions.mts` et jamais reporté dans la table — peut faire trouver
 * un *autre* token sur la même ligne (typiquement un appel à un symbole sans
 * rapport dont le nom contient le `newName` recherché) et renommer le
 * mauvais symbole. Repéré sur `scripts/dev-ingest.ts:88` : la table dit
 * `sondage → probe`, le code dit `const probed = await probe(...)` — sans
 * validation, la recherche de "probe" trouve l'appel à la fonction importée
 * `probe` (déclarée dans `src/server/ffprobe.ts`) et non la déclaration
 * locale `probed`, et le plan d'édition renomme l'import par erreur. Avec la
 * validation, cette entrée échoue proprement (`notFound`) au lieu de
 * corrompre le fichier. */
export function buildIdentifierEditPlan(
  entries: SymbolEntry[],
  fileRenames: Array<{ from: string; to: string }>,
  folderRenames: Array<{ from: string; to: string }>
): { editsByFile: Map<string, TextEdit[]>; notFound: SymbolEntry[]; conflicts: string[] } {
  const { service } = createProjectLanguageService();
  const editsByFile = new Map<string, TextEdit[]>();
  const claimedByFileAndStart = new Map<string, Map<number, TextEdit>>();
  const notFound: SymbolEntry[] = [];
  const conflicts: string[] = [];

  function pushEdit(fileAbs: string, edit: TextEdit) {
    const claimed = claimedByFileAndStart.get(fileAbs) ?? new Map<number, TextEdit>();
    claimedByFileAndStart.set(fileAbs, claimed);
    const existing = claimed.get(edit.start);
    if (existing) {
      if (existing.length === edit.length && existing.newText === edit.newText) return; // même symbole, deux chemins
      conflicts.push(`${fileAbs} @ ${edit.start} : "${existing.source}" vs "${edit.source}"`);
      return;
    }
    claimed.set(edit.start, edit);
    const list = editsByFile.get(fileAbs) ?? [];
    list.push(edit);
    editsByFile.set(fileAbs, list);
  }

  for (const e of entries) {
    const currentFileRel = toCurrentPath(e.file, fileRenames, folderRenames);
    const currentFileAbs = path.join(ROOT, currentFileRel);
    if (!fs.existsSync(currentFileAbs)) {
      notFound.push(e);
      continue;
    }
    const content = fs.readFileSync(currentFileAbs, "utf8");
    // setParentNodes: true — indispensable, isDeclarationNameNode lit .parent.
    const source = ts.createSourceFile(currentFileRel, content, ts.ScriptTarget.Latest, true);
    const lineStarts = source.getLineStarts();
    const lineIndex = e.line - 1;
    if (lineIndex < 0 || lineIndex >= lineStarts.length) {
      notFound.push(e);
      continue;
    }
    const lineStart = lineStarts[lineIndex];
    const lineEnd = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : content.length;
    const lineText = content.slice(lineStart, lineEnd);
    const re = wordBoundaryRegex(e.newName);
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
    if (validatedPos === null) {
      notFound.push(e);
      continue;
    }

    const locations = service.findRenameLocations(currentFileAbs, validatedPos, false, false, {
      providePrefixAndSuffixTextForRename: false,
    } as ts.UserPreferences);
    if (!locations || locations.length === 0) {
      notFound.push(e);
      continue;
    }
    for (const loc of locations) {
      pushEdit(loc.fileName, {
        start: loc.textSpan.start,
        length: loc.textSpan.length,
        newText: e.oldName,
        source: `${e.newName}->${e.oldName} @ ${currentFileRel}:${e.line}`,
      });
    }
  }

  return { editsByFile, notFound, conflicts };
}

/** Résout une chaîne de spécificateur de module (`@/...` ou relative) en un
 * chemin de dépôt sans extension, relatif au fichier qui la porte. `null`
 * pour un paquet externe (ni `@/`, ni `.`), qu'aucune table ne connaît. */
function resolveSpecifier(literal: string, containingFileRel: string): string | null {
  if (literal.startsWith("@/")) return "src/" + literal.slice(2);
  if (literal.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(containingFileRel), literal));
  }
  return null;
}

interface SpecifierNode {
  start: number;
  end: number;
  quote: string;
  text: string;
}

/** Les spécificateurs d'import/export/require/import() dynamique d'un
 * fichier — jamais une chaîne littérale ordinaire, seulement celles dont le
 * rôle syntaxique est de nommer un module. */
function findModuleSpecifiers(filePath: string, content: string): SpecifierNode[] {
  const ext = path.extname(filePath);
  const kind: ts.ScriptKind = ext === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);
  const found: SpecifierNode[] = [];

  const record = (node: ts.StringLiteral) => {
    const start = node.getStart(source);
    const end = node.getEnd();
    found.push({ start, end, quote: content[start], text: node.text });
  };

  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
        record(node.arguments[0] as ts.StringLiteral);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Ramène les spécificateurs de module de `dirB` à ce qu'ils désignaient dans
 * `origin/main`, pendant que les fichiers sont encore à leur emplacement
 * `HEAD` — c'est-à-dire *avant* la passe de déplacement de fichiers, pour que
 * la reconstruction d'un spécificateur relatif se calcule à partir des
 * emplacements d'origine des deux côtés (le fichier qui importe et le
 * fichier importé), la seule paire cohérente avec ce que porte
 * `origin/main`. Tourne *après* la passe d'édition d'identifiants — les deux
 * passes visent des empans disjoints (un nom lié vs. le texte d'un
 * spécificateur), donc l'ordre entre elles n'affecte pas la correction, mais
 * chacune relit le fichier à chaque appel pour ne jamais travailler sur des
 * positions périmées. */
function reverseModuleSpecifiers(dirB: string, filesAtHead: string[], pathMap: Map<string, string>): number {
  let editedFiles = 0;
  for (const rel of filesAtHead) {
    if (!/\.(ts|tsx|mts)$/.test(rel)) continue;
    const abs = path.join(dirB, rel);
    const content = fs.readFileSync(abs, "utf8");
    const specifiers = findModuleSpecifiers(rel, content);
    if (specifiers.length === 0) continue;

    const origSelf = pathMap.get(stripExt(rel)) ?? stripExt(rel);
    const edits: Array<{ start: number; end: number; newText: string }> = [];

    for (const spec of specifiers) {
      const resolved = resolveSpecifier(spec.text, rel);
      if (resolved === null) continue; // paquet externe
      const origTarget = pathMap.get(resolved);
      if (origTarget === undefined) continue; // pas un fichier du périmètre suivi (asset, css, etc.)

      let newText: string;
      if (spec.text.startsWith("@/")) {
        if (!origTarget.startsWith("src/")) continue; // ne devrait pas arriver, alias réservé à src/
        newText = "@/" + origTarget.slice("src/".length);
      } else {
        let rel2 = path.posix.relative(path.posix.dirname(origSelf), origTarget);
        if (!rel2.startsWith(".")) rel2 = "./" + rel2;
        newText = rel2;
      }
      if (newText === spec.text) continue;
      edits.push({ start: spec.start, end: spec.end, newText: `${spec.quote}${newText}${spec.quote}` });
    }

    if (edits.length === 0) continue;
    edits.sort((a, b) => b.start - a.start);
    let newContent = content;
    for (const e of edits) {
      newContent = newContent.slice(0, e.start) + e.newText + newContent.slice(e.end);
    }
    fs.writeFileSync(abs, newContent, "utf8");
    editedFiles++;
  }
  return editedFiles;
}

/**
 * Recolle en forme raccourcie (`{ x }`) une propriété ou une liaison de
 * déstructuration que la substitution symbole par symbole a laissée en
 * forme développée (`{ x: x }`) — la clé et la valeur, renommées chacune
 * indépendamment par leur propre `findRenameLocations`, convergent parfois
 * vers exactement le même texte sans que rien ne les recolle. `apply.mts`
 * ne rencontre jamais ce cas dans le sens direct (`providePrefixAndSuffixTextForRename: false`
 * empêche justement TypeScript de développer une forme raccourcie à
 * l'aller) ; au retour, une substitution textuelle sur deux symboles
 * distincts qui se rejoignent n'a par construction aucun moyen de le
 * savoir sans relire l'arbre après coup. Repéré sur trois fichiers,
 * `src/core/framing.ts` (`shots: shots`), `src/server/rendus.ts`
 * (`chemin: chemin`) et `tests/lib/editing.test.ts` (`lines: lines`) —
 * jamais une clé de table manquante, un artefact de cette reconstruction.
 *
 * **Ne recolle que ce que cette reconstruction a elle-même développé.**
 * Un premier jet collait toute paire `clé: valeur` de texte identique,
 * y compris celles que le code portait déjà sous cette forme avant tout
 * balayage — trouvé sur `src/app/api/clips/[id]/route.ts`, où
 * `framing: framing` est la forme choisie par l'auteur, jamais touchée
 * par aucun renommage (ni `framing` la clé ni `framing` la valeur ne
 * sont dans la table), et que le collage aurait pourtant raccourcie à
 * tort. Le garde-fou : ne recoller que si la **ligne** diffère de ce que
 * porte le worktree actuel (`HEAD`, non modifié par ce script) au même
 * numéro de ligne dans le fichier d'origine — un renommage d'identifiant
 * ne change jamais le nombre de lignes, la même hypothèse que partout
 * ailleurs dans cette preuve. Une ligne identique à `HEAD` n'a par
 * construction reçu aucune substitution ; ce qu'elle porte est à laisser
 * intact, forme développée comprise. */
function collapseShorthand(
  dirB: string,
  files: string[],
  fileRenames: Array<{ from: string; to: string }>,
  folderRenames: Array<{ from: string; to: string }>
): number {
  let editedFiles = 0;
  for (const rel of files) {
    if (!/\.(ts|tsx|mts)$/.test(rel)) continue;
    const abs = path.join(dirB, rel);
    const content = fs.readFileSync(abs, "utf8");
    const kind: ts.ScriptKind = path.extname(rel) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, kind);
    const lineStarts = source.getLineStarts();

    const currentFileAbs = path.join(ROOT, toCurrentPath(rel, fileRenames, folderRenames));
    const pristineLines = fs.existsSync(currentFileAbs) ? fs.readFileSync(currentFileAbs, "utf8").split("\n") : undefined;

    const touchedLine = (pos: number): boolean => {
      if (!pristineLines) return false;
      const lineIndex = source.getLineAndCharacterOfPosition(pos).line;
      const lineStart = lineStarts[lineIndex];
      const lineEnd = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : content.length;
      const currentLineText = content.slice(lineStart, lineEnd);
      const pristineLineText = pristineLines[lineIndex];
      return pristineLineText === undefined || currentLineText !== pristineLineText + (currentLineText.endsWith("\n") ? "\n" : "");
    };

    const edits: Array<{ start: number; end: number; newText: string }> = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        ts.isIdentifier(node.initializer) &&
        node.name.text === node.initializer.text &&
        touchedLine(node.getStart(source))
      ) {
        edits.push({ start: node.getStart(source), end: node.initializer.getEnd(), newText: node.name.text });
      } else if (
        ts.isBindingElement(node) &&
        node.propertyName &&
        !node.dotDotDotToken &&
        !node.initializer &&
        ts.isIdentifier(node.propertyName) &&
        ts.isIdentifier(node.name) &&
        node.propertyName.text === node.name.text &&
        touchedLine(node.getStart(source))
      ) {
        edits.push({ start: node.getStart(source), end: node.name.getEnd(), newText: node.propertyName.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    if (edits.length === 0) continue;
    edits.sort((a, b) => b.start - a.start);
    let newContent = content;
    for (const e of edits) {
      newContent = newContent.slice(0, e.start) + e.newText + newContent.slice(e.end);
    }
    fs.writeFileSync(abs, newContent, "utf8");
    editedFiles++;
  }
  return editedFiles;
}

/** Découpe un contenu en tokens d'identifiant (lettres Unicode, chiffres,
 * `_`, `$`) et en tout le reste, sur la même grille des deux côtés — pour
 * comparer terme à terme plutôt que ligne à ligne.
 *
 * Un tiret interne fait partie du token, pas une frontière : un basename
 * kebab-case renommé (`vignettes-sources` → `source-thumbnails`) est une
 * seule entrée de `buildResidualNewToOld`, sous sa forme complète — le
 * couper en `vignettes`/`sources` ferait chercher ces demi-mots un par un,
 * où ils n'existent pas individuellement, et un renommage qui permute
 * l'ordre des mots (`ecran-clip` → `clip-screen`) ne serait même plus une
 * substitution position par position une fois les moitiés séparées. Même
 * correctif que le tokenizer de `isPureSubstitution` dans
 * `proof-a-strings-and-comments.mts` (issue #73, revue de la preuve
 * elle-même), étendu ici pour la même raison. */
export function tokenizeContent(s: string): string[] {
  return s.split(/([\p{L}\p{N}_$]+(?:-[\p{L}\p{N}_$]+)*)/gu);
}

/** La table, dans le sens dont un résidu a besoin : new → tous les old
 * possibles (généralement un seul, parfois plusieurs — non-injectivité).
 * Deux sources : les identifiants (`renames-identifiers.json`) et les
 * basenames de fichiers/dossiers renommés (`renames-files.tsv`,
 * `renames-folders.tsv`) — un spécificateur de module *incrusté dans une
 * chaîne littérale* (une sonde compilée à la volée, comme
 * `tests/core/etapes.test.ts` — déjà une exception connue de la preuve A)
 * porte le nom de fichier, pas le nom d'un symbole : `parcours` → `phase`
 * n'est nulle part dans `renames-identifiers.*`, seulement dans
 * `renames-files.tsv`. Sans quoi un résidu parfaitement légitime se
 * classerait à tort en anomalie.
 *
 * Les basenames à plusieurs mots (`vignettes-sources` → `source-thumbnails`)
 * sont ajoutés sous leur forme complète, pas décomposés mot à mot — c'est
 * le tokenizer de `tokenizeContent` qui les garde entiers, donc l'entrée
 * `newToOld` peut elle aussi rester une comparaison exacte plutôt qu'une
 * recomposition. Ancien défaut, corrigé ici pour la troisième fois dans
 * cette PR : un nom composé (accentué dans la preuve B, kebab-case ici)
 * échappait à une classe de caractères ou une frontière de mot qui ne le
 * reconnaissait pas comme une seule unité. */
export function buildResidualNewToOld(
  entries: SymbolEntry[],
  fileRenames: Array<{ from: string; to: string }>,
  folderRenames: Array<{ from: string; to: string }>
): Map<string, Set<string>> {
  const newToOld = new Map<string, Set<string>>();
  for (const e of entries) {
    const set = newToOld.get(e.newName) ?? new Set<string>();
    set.add(e.oldName);
    newToOld.set(e.newName, set);
  }
  for (const pair of [...fileRenames, ...folderRenames]) {
    const oldBase = path.basename(pair.from, path.extname(pair.from));
    const newBase = path.basename(pair.to, path.extname(pair.to));
    const set = newToOld.get(newBase) ?? new Set<string>();
    set.add(oldBase);
    newToOld.set(newBase, set);
  }
  return newToOld;
}

/** Classe un résidu de diff entre deux fichiers : soit il s'explique
 * *entièrement* par des substitutions `newName → oldName` connues de la
 * table (chaque token qui diffère est exactement une entrée de
 * `buildResidualNewToOld`, jamais une reformulation ni un déplacement),
 * soit non — auquel cas c'est une vraie anomalie, pas un résidu documenté.
 * C'est la preuve inverse qui se retourne sur son propre résultat : elle ne
 * se contente pas d'un diff non vide, elle vérifie que ce diff ne contient,
 * lui non plus, rien d'autre que la table. */
export function classifyResidual(
  contentA: string,
  contentB: string,
  newToOld: Map<string, Set<string>>
): { explained: boolean; unexplainedTokens: Array<{ a: string; b: string }> } {
  const a = tokenizeContent(contentA);
  const b = tokenizeContent(contentB);
  if (a.length !== b.length) return { explained: false, unexplainedTokens: [{ a: "(nombre de tokens différent)", b: "" }] };
  const unexplained: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const candidates = newToOld.get(b[i]);
    if (candidates && candidates.has(a[i])) continue;
    unexplained.push({ a: a[i], b: b[i] });
  }
  return { explained: unexplained.length === 0, unexplainedTokens: unexplained };
}

function main() {
  const entries = loadSymbolEntries();
  const fileRenames = loadPairTsv("renames-files.tsv");
  const folderRenames = loadPairTsv("renames-folders.tsv");

  console.log("Construction du plan d'édition (findRenameLocations sur l'arbre HEAD actuel, un symbole à la fois)...");
  const { editsByFile, notFound, conflicts } = buildIdentifierEditPlan(entries, fileRenames, folderRenames);
  const totalEdits = [...editsByFile.values()].reduce((n, l) => n + l.length, 0);
  console.log(`  ${entries.length} symboles (renames-identifiers.json), ${editsByFile.size} fichiers concernés, ${totalEdits} édits.`);
  if (notFound.length > 0) {
    console.log(`  ${notFound.length} symbole(s) non localisé(s) ou non validé(s) par isDeclarationNameNode :`);
    for (const e of notFound) console.log(`    "${e.oldName}" → "${e.newName}" (${e.file}:${e.line}, ${e.kind})`);
  }
  if (conflicts.length > 0) {
    console.log(`  ${conflicts.length} conflit(s) réel(s) (même empan, deux textes différents revendiqués) :`);
    for (const c of conflicts) console.log(`    ${c}`);
  }

  const dirA = path.join(SCRATCH_ROOT, "origin-main");
  const dirB = path.join(SCRATCH_ROOT, "head-reversed");
  console.log(`\nRépertoire jetable : ${SCRATCH_ROOT}`);

  console.log("Extraction de origin/main...");
  archiveTree("origin/main", dirA);

  console.log("Extraction de HEAD...");
  archiveTree("HEAD", dirB);
  rmrf(path.join(dirB, "scripts/rename-73")); // outillage neuf, hors périmètre de la table

  console.log("Application du plan d'édition sur la copie...");
  let filesEdited = 0;
  for (const [fileAbs, edits] of editsByFile) {
    const rel = path.relative(ROOT, fileAbs);
    const target = path.join(dirB, rel);
    if (!fs.existsSync(target)) continue; // ex. scripts/rename-73, déjà retiré
    let content = fs.readFileSync(target, "utf8");
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    for (const e of sorted) {
      content = content.slice(0, e.start) + e.newText + content.slice(e.start + e.length);
    }
    fs.writeFileSync(target, content, "utf8");
    filesEdited++;
  }
  console.log(`  ${filesEdited} fichiers édités.`);

  const filesInB = listFiles(dirB);
  const pathMap = new Map<string, string>();
  for (const rel of filesInB) {
    pathMap.set(stripExt(rel), stripExt(toOriginalPath(rel, fileRenames, folderRenames)));
  }

  console.log("Renversement des spécificateurs de module (imports, exports, require, import() dynamique)...");
  const specifierEditedFiles = reverseModuleSpecifiers(dirB, filesInB, pathMap);
  console.log(`  ${specifierEditedFiles} fichiers dont au moins un spécificateur a été ramené à son chemin d'origine.`);

  console.log("Renommage des chemins à l'envers...");
  const moves: Array<{ from: string; to: string }> = [];
  for (const rel of filesInB) {
    const orig = toOriginalPath(rel, fileRenames, folderRenames);
    if (orig !== rel) moves.push({ from: rel, to: orig });
  }
  for (const m of moves) {
    const fromAbs = path.join(dirB, m.from);
    const toAbs = path.join(dirB, m.to);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
  }
  console.log(`  ${moves.length} fichiers ramenés à leur chemin d'origine.`);

  // Un dossier vidé de tout son contenu par les déplacements ci-dessus reste
  // sur le disque (renameSync ne nettoie pas son dossier source) — `diff -rq`
  // le rapporterait comme « présent seulement du côté HEAD », alors que rien
  // n'y vit plus. Purge récursive, feuilles d'abord.
  function pruneEmptyDirs(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name));
    }
    if (fs.readdirSync(dir).length === 0 && dir !== dirB) fs.rmdirSync(dir);
  }
  pruneEmptyDirs(dirB);

  console.log("Recollage des propriétés/liaisons développées en trop (clé et valeur convergentes)...");
  const filesAfterMoves = listFiles(dirB);
  const collapsedFiles = collapseShorthand(dirB, filesAfterMoves, fileRenames, folderRenames);
  console.log(`  ${collapsedFiles} fichier(s) recollés en forme raccourcie.`);

  console.log("\nComparaison à origin/main...");
  let diffOutput = "";
  try {
    diffOutput = execFileSync("diff", ["-rq", dirA, dirB], { encoding: "utf8" });
  } catch (e: unknown) {
    diffOutput = (e as { stdout?: string }).stdout ?? String(e);
  }

  if (diffOutput.trim() === "") {
    console.log("OK — diff vide. L'inverse de la table reconstruit origin/main exactement.");
    rmrf(SCRATCH_ROOT);
    return;
  }

  console.error("ÉCHEC — le diff n'est pas vide. Classification du résidu :\n");

  const newToOld = buildResidualNewToOld(entries, fileRenames, folderRenames);

  const differingFiles = diffOutput
    .split("\n")
    .filter((l) => l.startsWith("Files ") && l.endsWith(" differ"))
    .map((l) => l.slice("Files ".length, -" differ".length).split(" and "));
  const onlyInOne = diffOutput.split("\n").filter((l) => l.startsWith("Only in "));

  let explainedCount = 0;
  const unexplainedFiles: string[] = [];
  for (const [pathA, pathB] of differingFiles) {
    const contentA = fs.readFileSync(pathA, "utf8");
    const contentB = fs.readFileSync(pathB, "utf8");
    const { explained, unexplainedTokens } = classifyResidual(contentA, contentB, newToOld);
    const rel = path.relative(dirA, pathA);
    if (explained) {
      explainedCount++;
      console.error(`  [résidu attendu, entièrement expliqué par la table] ${rel}`);
    } else {
      unexplainedFiles.push(rel);
      console.error(`  [ANOMALIE — pas une substitution connue de la table] ${rel}`);
      for (const t of unexplainedTokens.slice(0, 10)) {
        console.error(`      origin/main: ${JSON.stringify(t.a)}  vs  reconstruit: ${JSON.stringify(t.b)}`);
      }
    }
  }

  console.error(
    `\n${differingFiles.length} fichier(s) diffèrent : ${explainedCount} entièrement expliqués par la table (résidu documenté, ${notFound.length} symboles non localisés/validés plus haut), ${unexplainedFiles.length} anomalie(s) réelle(s).`
  );
  if (onlyInOne.length > 0) {
    console.error(`${onlyInOne.length} entrée(s) « Only in » (présentes d'un seul côté) :`);
    for (const l of onlyInOne) console.error(`  ${l}`);
  }
  if (unexplainedFiles.length > 0 || onlyInOne.length > 0) {
    console.error(`\n(répertoires jetables conservés pour inspection : ${SCRATCH_ROOT})`);
    process.exit(1);
  }

  console.error(
    "\nDiff non vide, mais chaque différence est individuellement une substitution new_name→old_name connue de la table (aucun autre changement) : le résidu est documenté, pas une anomalie. Voir le corps de la PR pour le compte exact."
  );
  rmrf(SCRATCH_ROOT);
  process.exit(1);
}

// Ne s'exécute que si ce fichier est le point d'entrée — `repair-tables-from-applied.mts`
// importe `buildIdentifierEditPlan` d'ici et ne doit pas relancer toute la preuve inverse
// (archivage, diff contre origin/main) au chargement du module.
if (import.meta.url === `file://${process.argv[1]}`) main();
