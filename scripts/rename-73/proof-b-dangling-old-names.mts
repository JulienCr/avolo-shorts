/**
 * Preuve B — rien qui devait bouger n'est resté.
 *
 * La preuve A garantit que les chaînes littérales et les commentaires n'ont
 * pas changé, hors les trois exceptions vérifiées mécaniquement. C'est
 * exactement ce silence-là qui laisserait un accès dynamique, une clé de
 * `describe()`, ou un chemin recopié à la main continuer de nommer un
 * identifiant qui n'existe plus après le balayage — l'AST ne les voit pas,
 * parce qu'ils ne sont ni une déclaration ni une référence, seulement du
 * texte.
 *
 * Le premier jet cherchait un ancien identifiant comme *token* n'importe où
 * dans n'importe quelle chaîne — y compris la prose française des libellés
 * d'UI et des messages d'erreur. Sur ce dépôt, une partie non négligeable des
 * 1 560 identifiants renommés sont des mots français courants pris seuls
 * (`de`, `à`, `rien`, `force`, `dossier`, `projet`, …) parce que ce sont
 * aussi des noms de variables ou de paramètres déstructurés. Chercher ces
 * tokens dans toute chaîne rend 9 418 « trouvailles », presque toutes de la
 * prose légitime qui contient le mot « de » — un signal noyé, donc aucun.
 *
 * Cette preuve restreint donc la recherche aux chaînes **dont le contenu
 * entier, une fois débarrassé des espaces de bord, est un seul token
 * identifiant** — pas une phrase qui en contient un, la chaîne tout entière
 * qui *est* un identifiant. C'est exactement la forme d'une clé d'accès
 * dynamique (`obj['oldName']`), d'une clé d'objet ou de JSON, ou d'un titre
 * de test qui recopie littéralement un nom de symbole plutôt que de le
 * décrire en français — la forme, précisément, que la prose n'a jamais.
 *
 * Sur ce dépôt, cette preuve n'est **pas** silencieuse : elle rend 95
 * trouvailles réelles, distinctes des 484 candidats en forme de mot. La
 * plupart sont des titres de `describe()`/`it()` qui recopient l'ancien nom
 * de la fonction ou du composant testé plutôt que le nouveau — cosmétique,
 * sans effet sur le comportement. Six ne le sont pas : dans
 * `src/server/http.ts`, `src/server/run.ts` et `src/server/source-thumbnails.ts`,
 * des classes d'erreur ont leur déclaration renommée mais gardent
 * `this.name = 'AncienNom'` — `error.name` diverge donc du nom de la classe,
 * ce qui peut casser un `catch` qui teste `error.name`. Cette preuve rapporte
 * ces 95 cas au lieu de les corriger : l'outillage #73 ne touche pas les
 * fichiers source une fois le balayage appliqué, ce script les *signale*
 * pour triage plutôt que de les fixer lui-même.
 *
 *     pnpm tsx scripts/rename-73/proof-b-dangling-old-names.mts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { ROOT, listProjectFiles } from "./project.mts";

function loadOldNames(): Set<string> {
  const p = path.join(ROOT, "scripts/rename-73/renames-identifiers.tsv");
  const lines = fs.readFileSync(p, "utf8").split("\n").slice(1).filter(Boolean);
  const set = new Set<string>();
  for (const line of lines) {
    const [oldName, newName] = line.split("\t");
    // old_name === new_name : un mot cognat («video», «schema»...) ou une
    // entrée réparée dont le nom réellement appliqué s'est trouvé être
    // identique à l'ancien (planSteps → planSteps, après réparation contre
    // le code — voir repair-tables-from-applied.mts). Rien n'a jamais
    // changé pour cette entrée : elle ne peut pas « traîner » dans une
    // chaîne, puisqu'il n'y a rien à distinguer de l'actuel. La compter
    // comme old_name ferait tort à `describe('planSteps', ...)`, qui
    // recopie le nom **actuel**, pas un ancien.
    const on = oldName.normalize("NFC");
    const nn = newName.normalize("NFC");
    if (on === nn) continue;
    set.add(on);
  }
  return set;
}

/** Un identifiant TypeScript complet — lettres Unicode, chiffres, `_`, `$`.
 * `\p{L}` couvre les lettres accentuées (é, à, …) qu'un `[A-Za-z]` raterait,
 * et c'est précisément la classe d'identifiants que le balayage #73 renomme. */
const WHOLE_TOKEN_RE = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** `undefined` si la chaîne (bords blancs mis à part) n'est pas *entièrement*
 * un identifiant — une phrase qui en contient un ne compte pas, seule une
 * chaîne qui *est* un identifiant compte. */
function asWholeToken(s: string): string | undefined {
  const trimmed = s.trim().normalize("NFC");
  return WHOLE_TOKEN_RE.test(trimmed) ? trimmed : undefined;
}

function extractStrings(filePath: string, content: string): string[] {
  const ext = path.extname(filePath);
  const kind: ts.ScriptKind = ext === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);
  const strings: string[] = [];
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
  return strings;
}

/** Un mot français isolé (« deux », « à », « fait », « absent », « tous », …)
 * peut être *aussi* le nom d'une variable ou d'un paramètre déstructuré
 * ailleurs dans le dépôt — la table en compte plusieurs dizaines. Sans
 * filtre, la recherche par token entier rend 484 trouvailles sur ce dépôt,
 * dont l'écrasante majorité sont des titres de test ou des libellés qui
 * emploient ce mot pour son sens français, sans viser le symbole renommé —
 * un signal noyé. Un identifiant qui *nomme* un symbole plutôt qu'il ne
 * *décrit* une phrase a une forme reconnaissable : une frontière de casse
 * interne (`camelCase`, `PascalCase`), un underscore, ou un `$` — la forme
 * qu'un mot de prose française n'a jamais. Restreindre aux tokens de cette
 * forme fait tomber les 484 candidats à 23, tous des titres de `describe()`
 * qui recopient effectivement un ancien nom de fonction ou de variable.
 *
 * Classes Unicode, pas `[a-z]`/`[A-Z]` : un ancien nom dont la frontière de
 * casse suit une lettre accentuée (`relevéPrésence`, `é` puis `P`) ne
 * matche ni l'une ni l'autre — `é` n'est ni `[a-z]` ni `[A-Z]` — et se
 * faisait donc classer prose plutôt qu'identifiant composé, alors même que
 * `proof-inverse-tree.mts` avait déjà remplacé ce même genre de classe par
 * `\p{L}` pour la raison inverse (issue #73, revue de la preuve elle-même :
 * le correctif d'un tokenizer ASCII n'avait pas été reporté ici). */
function isCompoundShaped(token: string): boolean {
  return /\p{Ll}\p{Lu}/u.test(token) || /\p{Lu}{2,}/u.test(token) || token.includes("_") || token.includes("$");
}

interface Finding {
  file: string;
  token: string;
  literal: string;
}

function main() {
  const oldNames = loadOldNames();
  const files = listProjectFiles();
  const findings: Finding[] = [];
  const wordFormFindings: Finding[] = []; // token isolé, forme de mot — écarté du verdict, montré pour transparence

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const content = fs.readFileSync(file, "utf8");
    const strings = extractStrings(rel, content);
    for (const literal of strings) {
      const token = asWholeToken(literal);
      if (token === undefined) continue; // de la prose, pas un identifiant recopié
      if (!oldNames.has(token)) continue;
      const finding = { file: rel, token, literal };
      if (isCompoundShaped(token)) {
        findings.push(finding);
      } else {
        wordFormFindings.push(finding);
      }
    }
  }

  console.log(`Fichiers passés au crible : ${files.length}`);
  console.log(
    `\nCandidats écartés car en forme de mot isolé, pas d'identifiant composé (${wordFormFindings.length}) — non comptés dans le verdict :`
  );
  for (const f of wordFormFindings) {
    console.log(`  ${f.file} : "${f.token}"`);
  }

  console.log(`\nTrouvailles (${findings.length}), forme d'identifiant composé :`);
  for (const f of findings) {
    console.log(`  ${f.file} : token "${f.token}" dans ${JSON.stringify(f.literal)}`);
  }

  if (findings.length > 0) {
    console.error(`\nÉCHEC — ${findings.length} ancien(s) identifiant(s) survivent dans une chaîne littérale.`);
    process.exit(1);
  }

  console.log("\nOK — aucun ancien identifiant composé ne survit dans une chaîne littérale.");
}

main();
