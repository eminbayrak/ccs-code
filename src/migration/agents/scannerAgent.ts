/**
 * ScannerAgent — reads a source directory, builds a dependency graph,
 * and returns files in topological order (leaves first, dependents last).
 *
 * Parser strategy (mirrors codeIntelligence.ts):
 *   TS/JS/TSX/JSX  → TypeScript compiler AST (via astParser.ts) when available
 *   Python/Go/Java → Tree-sitter (via treeSitterParser.ts) when grammars installed
 *   Everything else → regex fallback
 *
 * Attaches symbol count + max complexity to each FileNode so WriterAgent
 * can inject structural context into its migration prompts.
 */

import { promises as fs } from "fs";
import { join, extname, resolve, relative, dirname } from "path";
import type { MigrationAgent, AgentResult, ScannerInput, ScannerOutput, FileNode } from "./types.js";
import { ok, fail } from "./types.js";
import {
  extractImportPathsAST,
  extractSymbolsAST,
  isAstParserAvailable,
} from "../astParser.js";
import {
  extractSymbolsTreeSitter,
  extractCallsTreeSitter,
  isTreeSitterAvailableForPath,
} from "../treeSitterParser.js";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "py",
  ".java": "java",
  ".cs": "cs",
  ".go": "go",
  ".rb": "rb",
  ".rs": "rs",
  ".swift": "swift",
  ".kt": "kotlin",
};

const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXT_TO_LANG));

// ---------------------------------------------------------------------------
// Default ignore patterns
// ---------------------------------------------------------------------------

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  ".ccs",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  "vendor",
  "target",
  "bin",
  "obj",
];

// ---------------------------------------------------------------------------
// Import extraction — regex patterns per language family
// ---------------------------------------------------------------------------

/** Extract internal import paths from TS/JS/JSX/TSX source */
function extractJsImports(content: string, filePath: string, sourceDir: string): string[] {
  const found: string[] = [];

  // ESM: import ... from './path'  |  import('./path')
  const esmStatic = /(?:^|;|\s)import\s+(?:.*?\s+from\s+)?['"](\.[^'"]+)['"]/gm;
  // ESM dynamic: import('./path')
  const esmDynamic = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  // CJS: require('./path')
  const cjsRequire = /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

  for (const pattern of [esmStatic, esmDynamic, cjsRequire]) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const raw = m[1];
      if (!raw || !raw.startsWith(".")) continue;
      const abs = resolveImport(filePath, raw, sourceDir);
      if (abs) found.push(abs);
    }
  }

  return [...new Set(found)];
}

/** Extract internal import paths from Python source */
function extractPyImports(content: string, filePath: string, sourceDir: string): string[] {
  const found: string[] = [];
  // from .module import X  |  from ..module import X
  const relImport = /^from\s+(\.+\w*(?:\.\w+)*)\s+import/gm;
  const fileDir = dirname(filePath);
  let m: RegExpExecArray | null;

  while ((m = relImport.exec(content)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    // Convert Python relative import notation to path
    const dots = raw.match(/^\.+/)?.[0] ?? "";
    const mod = raw.slice(dots.length);
    let base = fileDir;
    for (let i = 1; i < dots.length; i++) base = dirname(base);
    const candidate = join(base, ...mod.split(".")) + ".py";
    if (candidate.startsWith(sourceDir)) found.push(candidate);
  }

  return [...new Set(found)];
}

/**
 * Resolve a relative import path to an absolute path.
 * Tries: as-is, then common TS/JS extensions.
 */
async function resolveImportAsync(
  fromFile: string,
  rawImport: string,
  sourceDir: string,
): Promise<string | null> {
  const base = join(dirname(fromFile), rawImport);
  const candidates = [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".js",
    base + ".jsx",
    base + "/index.ts",
    base + "/index.js",
    base + "/index.tsx",
  ];

  for (const c of candidates) {
    if (!c.startsWith(sourceDir)) continue;
    try {
      await fs.access(c);
      return c;
    } catch {
      // not found, try next
    }
  }
  return null;
}

/** Synchronous version used for the regex pass (falls back to best-guess) */
function resolveImport(fromFile: string, rawImport: string, sourceDir: string): string | null {
  const base = join(dirname(fromFile), rawImport);
  if (!base.startsWith(sourceDir)) return null;
  // Return the base path — we'll confirm existence during the async walk
  return base;
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

async function walkDir(
  dir: string,
  ignore: Set<string>,
  results: string[],
): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as import("fs").Dirent[];
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryName = String(entry.name);
    if (ignore.has(entryName)) continue;
    const full = join(dir, entryName);
    if (entry.isDirectory()) {
      await walkDir(full, ignore, results);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entryName))) {
      results.push(full);
    }
  }
}

// ---------------------------------------------------------------------------
// Build per-file nodes — AST-first, regex fallback
// ---------------------------------------------------------------------------

const tsJsExts = new Set(["ts", "tsx", "js", "jsx"]);
const astAvailable = isAstParserAvailable();

async function buildFileNode(
  filePath: string,
  sourceDir: string,
): Promise<FileNode> {
  const ext = extname(filePath);
  const lang = EXT_TO_LANG[ext] ?? "unknown";
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return { path: filePath, dependsOn: [], lang, lines: 0 };
  }

  const lines = content.split("\n").length;
  const file = { path: filePath, content };
  let rawDeps: string[] = [];
  let symbolCount: number | undefined;
  let maxComplexity: number | undefined;
  let analysisMethod: FileNode["analysisMethod"] = "regex";

  // ── TS/JS: prefer TypeScript compiler AST ────────────────────────────────
  if (tsJsExts.has(lang) && astAvailable) {
    // Import paths — accurate, handles re-exports and dynamic import()
    rawDeps = extractImportPathsAST(file);

    // Symbol metadata — attach to FileNode for WriterAgent context
    const symbols = extractSymbolsAST(file, undefined);
    symbolCount = symbols.length;
    maxComplexity = symbols.reduce(
      (max, s) => Math.max(max, s.complexity ?? 1),
      0,
    ) || undefined;
    analysisMethod = "ast";

  // ── TS/JS fallback: regex when TypeScript compiler not available ──────────
  } else if (tsJsExts.has(lang)) {
    rawDeps = extractJsImports(content, filePath, sourceDir);
    analysisMethod = "regex";

  // ── Tree-sitter: Python, Go, Java, C#, Rust etc. ─────────────────────────
  } else if (isTreeSitterAvailableForPath(filePath)) {
    // Tree-sitter gives us symbols; import paths via regex for now
    // (Tree-sitter import extraction would need per-language query strings)
    const symbols = extractSymbolsTreeSitter(file, undefined);
    symbolCount = symbols.length;
    maxComplexity = symbols.reduce(
      (max, s) => Math.max(max, (s as { complexity?: number }).complexity ?? 1),
      0,
    ) || undefined;
    analysisMethod = "tree_sitter";

    // Still use regex for the import/dep graph
    if (lang === "py") {
      rawDeps = extractPyImports(content, filePath, sourceDir);
    }

  // ── Pure regex fallback ───────────────────────────────────────────────────
  } else {
    if (lang === "py") {
      rawDeps = extractPyImports(content, filePath, sourceDir);
    }
    analysisMethod = "regex";
  }

  // Resolve raw import specifiers → absolute paths that exist on disk
  const resolvedDeps: string[] = [];
  for (const dep of rawDeps) {
    // AST gives us the raw specifier (e.g. "./utils"); regex gives us an
    // already-joined path. Normalise both to a relative-from-file specifier.
    const specifier = dep.startsWith(".") ? dep : relative(dirname(filePath), dep);
    const resolved = await resolveImportAsync(filePath, specifier, sourceDir);
    if (resolved && resolved !== filePath) resolvedDeps.push(resolved);
  }

  return {
    path: filePath,
    dependsOn: [...new Set(resolvedDeps)],
    lang,
    lines,
    symbolCount,
    maxComplexity,
    analysisMethod,
  };
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn's algorithm)
// ---------------------------------------------------------------------------

function topoSort(nodes: FileNode[]): FileNode[] {
  const pathIndex = new Map<string, FileNode>();
  for (const n of nodes) pathIndex.set(n.path, n);

  // Filter deps to only include files in our scan set
  const inDegree = new Map<string, number>();
  const adjReverse = new Map<string, string[]>(); // dep → files that depend on it

  for (const n of nodes) {
    inDegree.set(n.path, 0);
    adjReverse.set(n.path, []);
  }

  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (!pathIndex.has(dep)) continue;
      inDegree.set(n.path, (inDegree.get(n.path) ?? 0) + 1);
      adjReverse.get(dep)!.push(n.path);
    }
  }

  const queue: string[] = [];
  for (const [path, deg] of inDegree) {
    if (deg === 0) queue.push(path);
  }

  const sorted: FileNode[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const node = pathIndex.get(cur);
    if (node) sorted.push(node);
    for (const dependent of adjReverse.get(cur) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  // Any nodes left out (cycle) — append at end
  for (const n of nodes) {
    if (!sorted.find((s) => s.path === n.path)) sorted.push(n);
  }

  return sorted;
}

// ---------------------------------------------------------------------------
// ScannerAgent
// ---------------------------------------------------------------------------

export class ScannerAgent implements MigrationAgent<ScannerInput, ScannerOutput> {
  readonly name = "ScannerAgent";

  private readonly onProgress?: (msg: string) => void;

  constructor(opts?: { onProgress?: (msg: string) => void }) {
    this.onProgress = opts?.onProgress;
  }

  async run(input: ScannerInput): Promise<AgentResult<ScannerOutput>> {
    const { sourceDir, ignore = [] } = input;
    const absSourceDir = resolve(sourceDir);

    try {
      await fs.access(absSourceDir);
    } catch {
      return fail(`Source directory not found: ${absSourceDir}`, false);
    }

    const ignoreSet = new Set([...DEFAULT_IGNORE, ...ignore]);
    this.onProgress?.(`Scanning ${absSourceDir}…`);

    // Walk
    const filePaths: string[] = [];
    await walkDir(absSourceDir, ignoreSet, filePaths);
    this.onProgress?.(`  Found ${filePaths.length} source files`);

    // Build nodes
    const nodes: FileNode[] = [];
    for (const fp of filePaths) {
      const node = await buildFileNode(fp, absSourceDir);
      nodes.push(node);
    }

    // Topo sort
    const orderedFiles = topoSort(nodes);

    // Language summary
    const languages: Record<string, number> = {};
    for (const n of orderedFiles) {
      languages[n.lang] = (languages[n.lang] ?? 0) + 1;
    }

    const langSummary = Object.entries(languages)
      .map(([l, c]) => `${l}:${c}`)
      .join(", ");
    this.onProgress?.(`  Languages: ${langSummary}`);

    // Report parser coverage
    const astFiles = orderedFiles.filter((f) => f.analysisMethod === "ast").length;
    const tsFiles = orderedFiles.filter((f) => f.analysisMethod === "tree_sitter").length;
    const regexFiles = orderedFiles.filter((f) => f.analysisMethod === "regex").length;
    const methodParts: string[] = [];
    if (astFiles > 0) methodParts.push(`${astFiles} AST`);
    if (tsFiles > 0) methodParts.push(`${tsFiles} Tree-sitter`);
    if (regexFiles > 0) methodParts.push(`${regexFiles} regex`);
    if (methodParts.length > 0) this.onProgress?.(`  Parsed: ${methodParts.join(", ")}`);

    const highComplexity = orderedFiles.filter((f) => (f.maxComplexity ?? 0) > 10).length;
    if (highComplexity > 0) this.onProgress?.(`  ⚠ ${highComplexity} file(s) with complexity > 10 — will need careful review`);

    this.onProgress?.(`  Dependency-ordered: ${orderedFiles.length} files`);

    return ok({ orderedFiles, totalFiles: orderedFiles.length, languages });
  }
}
