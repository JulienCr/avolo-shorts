/**
 * Le socle partagé du balayage de l'issue #73 : construire un unique
 * ts.LanguageService couvrant src/, scripts/ et tests/, et rien d'autre.
 *
 * Volontairement séparé de scan/apply/prove-* : les quatre scripts doivent
 * voir exactement le même programme, sinon un symbole résolu par l'un peut
 * ne plus exister pour l'autre.
 */
import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");

const SCAN_DIRS = ["src", "scripts", "tests"];
const EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);

export function listProjectFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (EXTENSIONS.has(path.extname(entry.name))) {
        // Exclure les scripts de l'outillage du balayage lui-même : ils ne
        // font pas partie du périmètre à renommer.
        if (full.includes(`${path.sep}rename-73${path.sep}`)) continue;
        out.push(full);
      }
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d));
  return out.sort();
}

export function createProjectLanguageService(): {
  service: ts.LanguageService;
  files: string[];
} {
  const files = listProjectFiles();
  const versions = new Map<string, number>();
  for (const f of files) versions.set(f, 1);

  const tsconfigPath = path.join(ROOT, "tsconfig.json");
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT);

  const servicesHost: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: (fileName) => String(versions.get(fileName) ?? 0),
    getScriptSnapshot: (fileName) => {
      if (!fs.existsSync(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf8"));
    },
    getCurrentDirectory: () => ROOT,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(servicesHost, ts.createDocumentRegistry());
  return { service, files };
}
