/**
 * Balayage de src/ + scripts/ + tests/ : collecte tous les identifiants
 * *déclarés* (variables, fonctions, types, propriétés, paramètres, membres
 * d'enum, imports/exports locaux…), dédupliqués par symbole TypeScript, et
 * calcule leur découpage en mots pour la classification français/anglais.
 *
 * Module pur (pas de CLI) : `scan.mts` l'exécute et imprime du JSON,
 * `table.mts` l'importe directement pour construire la table de renommage.
 */
import * as ts from "typescript";
import * as path from "node:path";
import { createProjectLanguageService, ROOT } from "./project.mts";
import { hasAccent, splitWords } from "./words.mts";

export interface Candidate {
  id: number;
  oldName: string;
  kind: string;
  file: string;
  line: number;
  hasAccent: boolean;
  words: string[];
  exported: boolean;
  /** Offset de caractère (0-based) du nom dans le fichier — pour
   * `languageService.findRenameLocations`. Absent du JSON écrit par
   * scan.mts (bruit pour un humain qui le relit) mais présent tant qu'on
   * reste en mémoire : apply.mts le lit directement depuis collectCandidates(),
   * jamais depuis le JSON sur disque. */
  pos: number;
}

const DECL_KIND_NAMES: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.VariableDeclaration]: "variable",
  [ts.SyntaxKind.FunctionDeclaration]: "function",
  [ts.SyntaxKind.ClassDeclaration]: "class",
  [ts.SyntaxKind.InterfaceDeclaration]: "interface",
  [ts.SyntaxKind.TypeAliasDeclaration]: "typeAlias",
  [ts.SyntaxKind.EnumDeclaration]: "enum",
  [ts.SyntaxKind.EnumMember]: "enumMember",
  [ts.SyntaxKind.PropertyDeclaration]: "classProperty",
  [ts.SyntaxKind.PropertySignature]: "interfaceProperty",
  [ts.SyntaxKind.MethodDeclaration]: "method",
  [ts.SyntaxKind.MethodSignature]: "methodSignature",
  [ts.SyntaxKind.GetAccessor]: "getter",
  [ts.SyntaxKind.SetAccessor]: "setter",
  [ts.SyntaxKind.Parameter]: "parameter",
  [ts.SyntaxKind.BindingElement]: "bindingElement",
  [ts.SyntaxKind.TypeParameter]: "typeParameter",
  [ts.SyntaxKind.ImportSpecifier]: "importLocal",
  [ts.SyntaxKind.ImportClause]: "importDefault",
  [ts.SyntaxKind.NamespaceImport]: "importNamespace",
  [ts.SyntaxKind.ExportSpecifier]: "exportLocal",
  [ts.SyntaxKind.ModuleDeclaration]: "namespace",
  [ts.SyntaxKind.FunctionExpression]: "functionExpr",
  [ts.SyntaxKind.ClassExpression]: "classExpr",
};

export function collectCandidates(): Candidate[] {
  const { service, files } = createProjectLanguageService();
  const program = service.getProgram();
  if (!program) throw new Error("Impossible de construire le programme TypeScript.");
  const checker = program.getTypeChecker();

  const bySymbol = new Map<ts.Symbol, Candidate>();
  let nextId = 1;

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;

    const visit = (node: ts.Node) => {
      const kindName = DECL_KIND_NAMES[node.kind];
      if (kindName) {
        const withName = node as unknown as { name?: ts.Node };
        const nameNode = withName.name;
        if (nameNode && ts.isIdentifier(nameNode)) {
          const symbol = checker.getSymbolAtLocation(nameNode);
          if (symbol && !bySymbol.has(symbol)) {
            const oldName = nameNode.text;
            const start = nameNode.getStart();
            const { line } = source.getLineAndCharacterOfPosition(start);
            const exported =
              !!symbol.declarations?.some(
                (d) =>
                  !!(ts.getCombinedModifierFlags(d as ts.Declaration) & ts.ModifierFlags.Export)
              ) || false;
            bySymbol.set(symbol, {
              id: nextId++,
              oldName,
              kind: kindName,
              file: path.relative(ROOT, file),
              line: line + 1,
              hasAccent: hasAccent(oldName),
              words: splitWords(oldName),
              exported,
              pos: start,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return [...bySymbol.values()].sort((a, b) => a.id - b.id);
}
