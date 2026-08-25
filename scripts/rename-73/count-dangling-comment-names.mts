/**
 * Compte les tokens en forme d'identifiant, cités entre accents graves dans
 * un commentaire, qui ne désignent **aucun** identifiant du programme
 * aujourd'hui — un critère durable, indépendant de la table d'un balayage
 * particulier : contrairement à l'ancien critère (« figure dans
 * `renames-identifiers.tsv` »), celui-ci voit aussi bien un nom mort par
 * cette table que par un renommage antérieur, à la main ou par une autre PR.
 *
 * **Extraction par l'arbre, pas par le scanner.** `ts.createScanner` n'a
 * aucune notion de continuation de template literal : sur `` `${x}.suite` ``,
 * il prend le backtick fermant pour le début d'un nouveau template et avale
 * tout le reste du fichier — commentaires compris — dans un seul jeton
 * (`proof-a-strings-and-comments.mts`, qui a mesuré la méthode aveugle sur
 * 113 fichiers sur 206). Ce script descend l'arbre réel
 * (`getLeadingCommentRanges`/`getTrailingCommentRanges`), comme la preuve A.
 *
 * **Le total brut est le chiffre qui compte, jamais un total déjà filtré.**
 * Une bonne partie des tokens trouvés ne sont pas des noms morts du dépôt —
 * une constante POSIX, un nom d'API DOM/Node, un mot-clé SQL, un drapeau
 * ffmpeg, un champ ASS, un symbole Python (dont ceux, bien vivants, de
 * `worker/detect.py`, hors du périmètre TypeScript balayé), une variable
 * d'environnement, un champ d'API externe (Gemini/OpenAI/Meta/TikTok), une
 * référence au dépôt prédécesseur `openshorts`, un repère de format
 * (date, horodatage, couleur) ou une donnée de test. Ce script les nomme,
 * catégorie par catégorie, avec leurs occurrences : c'est une répartition
 * auditable du brut, jamais un filtre qui le réduit en silence. La table des
 * exclusions expire comme n'importe quelle table — c'est pour ça que le
 * total affiché en premier est toujours le brut, jamais le restant.
 *
 *     pnpm tsx scripts/rename-73/count-dangling-comment-names.mts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { ROOT, listProjectFiles } from "./project.mts";

/** Un identifiant TypeScript complet — lettres Unicode, chiffres, `_`, `$`. */
const WHOLE_TOKEN_RE = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** Une frontière de casse interne, un underscore ou un `$` — jamais un mot
 * de prose isolé. Classes Unicode, pas `[a-z]`/`[A-Z]` : un nom dont la
 * frontière de casse suit une lettre accentuée (`relevéPrésence`) ne matche
 * ni l'une ni l'autre (issue #73, revue de la preuve elle-même).
 *
 * Un token de moins de deux caractères, ou dont le seul signal composé est
 * un `$`/`_` en bord (`l$`, `_$`) plutôt qu'interne, n'est jamais retenu : le
 * signal composé se juge sur le token débarrassé de ses `$`/`_` de bord, pas
 * sur le token brut — sinon `l$` reste compound via son `$` de bord seul.
 * Aucun identifiant réel du dépôt n'emploie `$`, vérifié — ces formes ne
 * viennent que d'un `${nom}` de template literal recopié dans un
 * commentaire, jamais d'un symbole cité. */
function isCompoundShaped(token: string): boolean {
  if (token.length < 2) return false;
  const core = token.replace(/^[_$]+|[_$]+$/gu, "");
  if (core.length === 0) return false;
  return /\p{Ll}\p{Lu}/u.test(core) || /\p{Lu}{2,}/u.test(core) || core.includes("_") || core.includes("$");
}

/** Tous les `ts.Identifier`/`ts.PrivateIdentifier` du programme — la
 * définition de « ce qui existe » contre laquelle un token cité se compare.
 * Couvre les déclarations et toutes leurs références, y compris les accès de
 * propriété (`obj.name`), puisque ce sont aussi des `Identifier`. */
function collectProgramIdentifiers(sources: readonly ts.SourceFile[]): Set<string> {
  const identifiers = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      identifiers.add(node.text.normalize("NFC"));
    }
    ts.forEachChild(node, visit);
  };
  for (const source of sources) visit(source);
  return identifiers;
}

/** Un commentaire par position de départ, jamais compté deux fois : plusieurs
 * nœuds imbriqués peuvent partager le même `getFullStart()` (proof-A). */
function extractComments(source: ts.SourceFile, content: string): string[] {
  const comments: string[] = [];
  const seenStarts = new Set<number>();
  const collectLeading = (node: ts.Node) => {
    const fullStart = node.getFullStart();
    if (seenStarts.has(fullStart)) return;
    seenStarts.add(fullStart);
    for (const r of ts.getLeadingCommentRanges(content, fullStart) ?? []) {
      comments.push(content.slice(r.pos, r.end));
    }
  };
  const visit = (node: ts.Node) => {
    collectLeading(node);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  for (const r of ts.getTrailingCommentRanges(content, source.endOfFileToken.getFullStart()) ?? []) {
    comments.push(content.slice(r.pos, r.end));
  }
  return comments;
}

const BACKTICK_RE = /`([^`]+)`/g;
const TOKEN_IN_SPAN_RE = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

/** Les tokens en forme d'identifiant composé, cités entre accents graves
 * dans un commentaire — sans jugement sur leur vie ou leur mort. */
function tokensBacktickedIn(comment: string): string[] {
  const out: string[] = [];
  const normalized = comment.normalize("NFC");
  let span: RegExpExecArray | null;
  BACKTICK_RE.lastIndex = 0;
  while ((span = BACKTICK_RE.exec(normalized))) {
    let tok: RegExpExecArray | null;
    TOKEN_IN_SPAN_RE.lastIndex = 0;
    while ((tok = TOKEN_IN_SPAN_RE.exec(span[1]))) {
      if (WHOLE_TOKEN_RE.test(tok[0]) && isCompoundShaped(tok[0])) out.push(tok[0]);
    }
  }
  return out;
}

/**
 * Populations connues qui ne sont pas des noms du dépôt, nommées catégorie
 * par catégorie plutôt que noyées dans un seul filtre — chacune vérifiée à
 * la main contre son fichier d'origine, et challengeable, plutôt qu'un total
 * qui se contente d'être plus petit. Voir le corps de la PR #172 pour le
 * détail des vérifications (une par catégorie, pas une par token).
 */
const KNOWN_NON_REPO: Readonly<Record<string, readonly string[]>> = {
  "POSIX errno / signaux / limites": [
    "ENOENT", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR", "EINVAL",
    "ENOSPC", "EMFILE", "ENFILE", "ENAMETOOLONG", "EIO", "EAGAIN", "EBUSY",
    "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTEMPTY",
    "ESTALE", "ENOTCONN", "ESRCH", "NAME_MAX", "W_OK", "INT64_MIN",
    "SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGABRT",
  ],
  // API DOM / Web / Node / bibliothèques UI, dont le nom est imposé par la
  // plateforme ou la dépendance, pas par ce dépôt.
  "API DOM / Web / Node / bibliothèques": [
    "AbortError", "AbortController", "AbortSignal", "ResizeObserver",
    "IntersectionObserver", "MutationObserver", "requestAnimationFrame",
    "cancelAnimationFrame", "HTMLVideoElement", "HTMLElement", "DOMException",
    "CustomEvent", "FormData", "URLSearchParams", "structuredClone",
    "auxclick", "keepMounted", "InvalidStateError", "flushSync",
    "localStorage", "toLocaleString", "lastIndex", "globalThis",
    "offsetHeight", "offsetWidth", "scrollHeight", "clientHeight",
    "ArrayBufferLike", "BlobPart", "ReadStream", "MAX_SAFE_INTEGER", "NFD",
    "ERR_INVALID_STATE", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "DEP0137",
    "toWeb", "uncaughtException", "child_process", "nodeBuiltin",
    "useCollapsibleRoot", "calculateRange", "outerSize", "queryAll",
    "NODE_ENV",
  ],
  "Champs ASS (libass)": [
    "PlayResX", "PlayResY", "BorderStyle", "ScaledBorderAndShadow", "WrapStyle",
    "RRGGBB", "AABBGGRR", "ScriptType", "MarginL", "MarginR", "MarginV",
    "BackColour", "HAABBGGRR", "HBBGGRR",
  ],
  "Drapeaux ffmpeg/ffprobe et unités audio": [
    "PROHIBITED_CONTENT", "eof_action", "scene_boundaries",
    "hwaccel_output_format", "pix_fmt", "av_get_token", "ffmpeg_utils",
    "h264_nvenc", "nvenc_available", "general_render_cmd", "filter_complex",
    "force_original_aspect_ratio", "LUFS", "select_streams",
  ],
  // Mots-clés et objets de schéma SQL/SQLite — vivent dans le texte SQL,
  // jamais comme identifiant TS, donc invisibles à l'ensemble des
  // identifiants par construction. `clips_by_project`/`clips_par_projet`
  // sont respectivement le nom courant et l'ancien nom d'un même index,
  // documentés côte à côte en toutes lettres (db.ts:142-145).
  "SQL / SQLite": [
    "CREATE", "CONFLICT", "DELETE", "IF", "EXISTS", "DO", "UPDATE", "SET",
    "CASCADE", "PRAGMA", "table_info", "INSERT", "FROM", "DROP",
    "foreign_keys", "clips_by_project", "clips_par_projet",
  ],
  // Symboles Python — stdlib/PyTorch pour la plupart ; les six derniers sont
  // vivants dans `worker/detect.py`, hors du périmètre TypeScript balayé.
  "Python (stdlib, PyTorch, ou vivant dans worker/detect.py)": [
    "bisect_left", "bisect_right", "empty_cache", "__pycache__", "NameError",
    "ModuleNotFoundError", "snake_case", "pythonX",
    "person_anchor", "_scene_candidates", "collective_shift",
    "composition_switches", "refine_switch", "run_replay",
    "shots_from_boundaries", "scores_de_scène", "boîtes_du_lot",
  ],
  // Champs et constantes d'API de plateformes externes — Meta/Instagram,
  // TikTok, OpenAI, Gemini, 1Password, Next.js/@next/env.
  "Champs d'API de plateformes externes": [
    "instagram_basic", "instagram_content_publish", "instagram_business_",
    "business_management", "media_publish", "FINISHED", "PUBLISHED",
    "video_reels", "async_upload", "invalid_client", "invalid_grant",
    "invalid_params", "param_error", "error_type", "errCode", "SELF_ONLY",
    "spam_risk_user_banned_from_posting", "privacyStatus", "MEDIA_UPLOAD",
    "DIRECT_POST", "tool_calls", "function_call", "additionalProperties",
    "anyOf", "content_filter", "CONTENT_FILTER", "SAFETY", "MODEL_ARMOR",
    "OP_SERVICE_ACCOUNT_TOKEN", "loadEnvConfig", "updateInitialEnv",
    "initial_prompt", "MAX_TOKENS",
  ],
  // Références au dépôt prédécesseur `openshorts`, explicitement nommé
  // comme tel dans chaque commentaire qui les porte — pas un nom de ce dépôt.
  "Références au dépôt prédécesseur openshorts": [
    "gemini_worker", "CLIP_SHORTLIST_MAX", "CLIP_TARGET_MIN",
    "snap_clip_to_words", "search_window", "min_duration", "max_duration",
    "_collect_word_blocks", "generate_ass", "clip_selection",
  ],
  // Repères de prompt Gemini — vivent dans le texte d'un template literal
  // (`HOOK_PATTERNS`, prompts.ts), jamais comme identifiant TS.
  "Repères de prompt (texte de template literal)": [
    "HOOK", "PLAYBOOK", "TRANSCRIPT_LANGUAGE", "WINDOWS_JSON", "WORDS_JSON",
  ],
  // Repères de format — date, horodatage, couleur — cités pour leur forme,
  // jamais comme un symbole.
  "Repères de format (date, horodatage, couleur)": [
    "AAAA", "MM", "JJ", "SS", "FFE500", "H00E5FF", "H0000E5FF",
  ],
  // Identifiants de fixture : des valeurs de chaîne réutilisées dans les
  // tests, jamais déclarées comme symbole TS — `window_002` est une entrée
  // de tableau, pas une variable.
  "Identifiants de fixture (valeurs de test, pas des symboles)": [
    "clip_01", "clip_07", "clip_verif_", "window_002", "window_009", "window_011",
  ],
  // Références documentaires : un commentaire qui cite `CLAUDE.md` ou
  // `ROADMAP.md` fait son travail, il ne cite pas un symbole mort.
  "Références documentaires": ["CLAUDE", "ROADMAP", "README"],
  // Mots isolés utilisés pour leur sens, entre accents graves pour
  // l'emphase — jamais un identifiant du dépôt. Vérifiés un par un contre
  // leur fichier : `APRÈS` est de la prose en capitales, `CLÉ` un
  // espace-réservé dans un exemple de référence 1Password, `KEY`/`TOKEN`/
  // `SECRET` les motifs qu'un filtre naïf abandonné cherchait, `DcY8KVBCml7`
  // l'identifiant réel d'une publication TikTok citée en exemple, `ERROR`
  // et `MP4` des fragments de format de journal/extension de fichier.
  "Emphase, exemple ou motif — pas un identifiant": [
    "APRÈS", "CLÉ", "KEY", "TOKEN", "SECRET", "DcY8KVBCml7", "ERROR", "MP4",
    "PORT", "TZ",
  ],
};

function buildExclusionIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const [category, tokens] of Object.entries(KNOWN_NON_REPO)) {
    for (const token of tokens) index.set(token, category);
  }
  return index;
}

interface Finding {
  token: string;
  citations: number;
  files: Set<string>;
}

function main() {
  const files = listProjectFiles();
  const sources: { rel: string; source: ts.SourceFile; content: string }[] = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const content = fs.readFileSync(file, "utf8");
    const kind = path.extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, kind);
    sources.push({ rel, source, content });
  }

  const programIdentifiers = collectProgramIdentifiers(sources.map((s) => s.source));
  const findings = new Map<string, Finding>();

  for (const { rel, source, content } of sources) {
    for (const comment of extractComments(source, content)) {
      for (const token of tokensBacktickedIn(comment)) {
        if (programIdentifiers.has(token)) continue; // désigne bien quelque chose de vivant
        const entry = findings.get(token) ?? { token, citations: 0, files: new Set() };
        entry.citations++;
        entry.files.add(rel);
        findings.set(token, entry);
      }
    }
  }

  const exclusionIndex = buildExclusionIndex();
  const byCategory = new Map<string, Finding[]>();
  const unexplained: Finding[] = [];
  let citationsExcluded = 0;

  for (const finding of findings.values()) {
    const category = exclusionIndex.get(finding.token);
    if (category === undefined) {
      unexplained.push(finding);
      continue;
    }
    citationsExcluded += finding.citations;
    const bucket = byCategory.get(category) ?? [];
    bucket.push(finding);
    byCategory.set(category, bucket);
  }

  const totalCitations = [...findings.values()].reduce((n, f) => n + f.citations, 0);

  console.log(`Fichiers passés au crible : ${files.length}`);
  console.log(
    `\nBrut — tokens en forme d'identifiant composé, cités entre accents graves, ` +
      `absents de l'ensemble des identifiants du programme :`,
  );
  console.log(`  ${findings.size} token(s) distinct(s), ${totalCitations} citation(s).`);

  console.log(`\nRépartition, catégorie par catégorie (${citationsExcluded} citation(s) exclue(s)) :`);
  for (const [category, list] of byCategory) {
    const citations = list.reduce((n, f) => n + f.citations, 0);
    console.log(`\n  ${category} — ${list.length} token(s), ${citations} citation(s) :`);
    for (const f of list.sort((a, b) => b.citations - a.citations)) {
      console.log(`    ${f.token} : ${f.citations} (${f.files.size} fichier(s))`);
    }
  }

  console.log(
    `\nRestant — candidats à un nom mort du dépôt, non classés (${unexplained.length} token(s), ` +
      `${totalCitations - citationsExcluded} citation(s)), à trier un par un contre ` +
      `\`scripts/rename-73/\` :`,
  );
  for (const f of unexplained.sort((a, b) => b.citations - a.citations)) {
    console.log(`  ${f.token} : ${f.citations} (${[...f.files].sort().join(", ")})`);
  }
}

main();
