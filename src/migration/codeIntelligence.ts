import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";
import {
  extractSymbolsAST,
  extractCallsAST,
  isAstParserAvailable,
  type ASTSymbol,
} from "./astParser.js";
import {
  extractSymbolsTreeSitter,
  extractCallsTreeSitter,
  isTreeSitterAvailableForPath,
  treeSitterSpecForPath,
  type TreeSitterSymbol,
} from "./treeSitterParser.js";

export type CodeSymbolKind = "class" | "interface" | "function" | "method" | "handler";

export type CodeSymbol = {
  id: string;
  name: string;
  kind: CodeSymbolKind;
  file: string;
  lineStart: number;
  lineEnd: number;
  component?: string;
  /** Cyclomatic complexity (AST path only, JS/TS files) */
  complexity?: number;
  /** Number of parameters (AST path only) */
  params?: number;
};

export type CodeCallEdge = {
  sourceSymbolId: string;
  sourceName: string;
  targetName: string;
  targetSymbolId?: string;
  file: string;
  line: number;
  component?: string;
};

export type CodeIntelligenceArtifact = {
  schemaVersion: "1.0";
  generatedAt: string;
  repoUrl: string;
  migration: FrameworkInfo;
  analysisMethod: "ast" | "regex" | "hybrid";
  stats: {
    filesScanned: number;
    symbols: number;
    resolvedCalls: number;
    unresolvedCalls: number;
    /** Average cyclomatic complexity across JS/TS symbols with AST data */
    avgComplexity?: number;
    /** Symbols with complexity > 10 (high risk for migration) */
    highComplexitySymbols?: number;
    /** Files parsed with the built-in TypeScript compiler parser */
    typeScriptAstFiles?: number;
    /** Files parsed with optional Tree-sitter grammars */
    treeSitterFiles?: number;
    /** Files scanned with regex fallback */
    regexFiles?: number;
  };
  symbols: CodeSymbol[];
  calls: CodeCallEdge[];
  components: Array<{
    name: string;
    symbols: number;
    outgoingCalls: number;
    incomingCalls: number;
    /** Highest complexity symbol in this component */
    maxComplexity?: number;
  }>;
};

// ---------------------------------------------------------------------------
// Regex-based fallback (for Python, Java, C#, and when AST parsing is unavailable)
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new", "typeof",
  "sizeof", "using", "await", "function", "class", "interface", "else",
  "try", "do", "foreach", "lock", "checked", "unchecked", "namespace",
]);

function symbolId(file: string, name: string, line: number): string {
  return `symbol:${file}:${name}:${line}`;
}

function componentForFile(path: string, analyses: ComponentAnalysis[]): string | undefined {
  const exact = analyses.find((a) => a.component.filePaths.includes(path));
  if (exact) return exact.component.name;
  const suffix = analyses.find((a) =>
    a.component.filePaths.some((f) => path.endsWith(f) || f.endsWith(path))
  );
  return suffix?.component.name;
}

function extension(path: string): string {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function isJsTs(ext: string): boolean {
  return ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext);
}

type ParserKind = "typescript_ast" | "tree_sitter" | "regex";

function parserKindForFile(file: { path: string; content: string }, typeScriptAstAvailable: boolean): ParserKind {
  const ext = extension(file.path);
  if (typeScriptAstAvailable && isJsTs(ext)) return "typescript_ast";
  if (treeSitterSpecForPath(file.path) && isTreeSitterAvailableForPath(file.path)) return "tree_sitter";
  return "regex";
}

function detectSymbolsRegex(
  file: { path: string; content: string },
  component: string | undefined,
): CodeSymbol[] {
  const ext = extension(file.path);
  const lines = file.content.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];

  const add = (name: string, kind: CodeSymbolKind, index: number) => {
    if (!name || KEYWORDS.has(name)) return;
    symbols.push({
      id: symbolId(file.path, name, index + 1),
      name,
      kind,
      file: file.path,
      lineStart: index + 1,
      lineEnd: lines.length,
      component,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;

    if (isJsTs(ext)) {
      const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
      const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/);
      const functionMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
      const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
      const routeMatch = trimmed.match(/\brouter\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/);
      if (classMatch) add(classMatch[1]!, "class", i);
      else if (interfaceMatch) add(interfaceMatch[1]!, "interface", i);
      else if (functionMatch) add(functionMatch[1]!, "function", i);
      else if (arrowMatch) add(arrowMatch[1]!, "function", i);
      else if (routeMatch) add(`${routeMatch[1]!.toUpperCase()} ${routeMatch[2]!}`, "handler", i);
      continue;
    }

    if (ext === "py") {
      const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)/);
      const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      if (classMatch) add(classMatch[1]!, "class", i);
      else if (defMatch) add(defMatch[1]!, "function", i);
      continue;
    }

    if (["cs", "java"].includes(ext)) {
      const classMatch = trimmed.match(/^(?:public|private|protected|internal|sealed|abstract|static|partial|\s)*(?:class)\s+([A-Za-z_]\w*)/);
      const interfaceMatch = trimmed.match(/^(?:public|private|protected|internal|\s)*interface\s+([A-Za-z_]\w*)/);
      const methodMatch = trimmed.match(/^(?:public|private|protected|internal|static|async|virtual|override|sealed|partial|final|synchronized|\s)+[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>)/);
      if (classMatch) add(classMatch[1]!, "class", i);
      else if (interfaceMatch) add(interfaceMatch[1]!, "interface", i);
      else if (methodMatch) add(methodMatch[1]!, "method", i);
      continue;
    }

    const genericFunction = trimmed.match(/^(?:function|sub|procedure)\s+([A-Za-z_]\w*)/i);
    if (genericFunction) add(genericFunction[1]!, "function", i);
  }

  symbols.sort((a, b) => a.lineStart - b.lineStart);
  for (let i = 0; i < symbols.length; i++) {
    symbols[i]!.lineEnd = (symbols[i + 1]?.lineStart ?? (lines.length + 1)) - 1;
  }
  return symbols;
}

function detectCallsRegex(
  file: { path: string; content: string },
  fileSymbols: CodeSymbol[],
  byName: Map<string, CodeSymbol[]>,
): CodeCallEdge[] {
  const calls: CodeCallEdge[] = [];
  const lines = file.content.split(/\r?\n/);
  const symbolForLine = (line: number) =>
    [...fileSymbols].reverse().find((s) => line >= s.lineStart && line <= s.lineEnd);

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const source = symbolForLine(lineNumber);
    if (!source) continue;
    const line = lines[i] ?? "";
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const targetName = match[1] ?? "";
      if (!targetName || KEYWORDS.has(targetName) || targetName === source.name) continue;
      const candidates = byName.get(targetName.toLowerCase()) ?? [];
      const target =
        candidates.find((c) => c.file === source.file) ??
        candidates.find((c) => c.component === source.component) ??
        candidates[0];
      calls.push({
        sourceSymbolId: source.id,
        sourceName: source.name,
        targetName,
        targetSymbolId: target?.id,
        file: file.path,
        line: lineNumber,
        component: source.component,
      });
    }
  }

  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.sourceSymbolId}:${call.targetSymbolId ?? call.targetName}:${call.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main builder — AST first, regex fallback
// ---------------------------------------------------------------------------

function buildNameIndex(symbols: CodeSymbol[]): Map<string, CodeSymbol[]> {
  const byName = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(symbol);
    byName.set(key, list);
  }
  return byName;
}

export function buildCodeIntelligenceArtifact(input: {
  repoUrl: string;
  generatedAt: string;
  frameworkInfo: FrameworkInfo;
  analyses: ComponentAnalysis[];
  sourceFiles: Array<{ path: string; content: string }>;
}): CodeIntelligenceArtifact {
  const uniqueFiles = new Map<string, { path: string; content: string }>();
  for (const file of input.sourceFiles) {
    if (!uniqueFiles.has(file.path)) uniqueFiles.set(file.path, file);
  }

  const files = [...uniqueFiles.values()];
  const typeScriptAstAvailable = isAstParserAvailable();
  const parserByPath = new Map(files.map((file) => [
    file.path,
    parserKindForFile(file, typeScriptAstAvailable),
  ] as const));
  const typeScriptAstFiles = [...parserByPath.values()].filter((kind) => kind === "typescript_ast").length;
  const treeSitterFiles = [...parserByPath.values()].filter((kind) => kind === "tree_sitter").length;
  const regexFiles = [...parserByPath.values()].filter((kind) => kind === "regex").length;
  const analysisMethod: "ast" | "regex" | "hybrid" =
    typeScriptAstFiles + treeSitterFiles > 0
      ? regexFiles > 0 ? "hybrid" : "ast"
      : "regex";

  // Pass 1 — extract symbols
  const symbols: CodeSymbol[] = files.flatMap((file) => {
    const ext = extension(file.path);
    const component = componentForFile(file.path, input.analyses);

    const parserKind = parserByPath.get(file.path) ?? "regex";
    if (parserKind === "typescript_ast" && isJsTs(ext)) {
      // AST path: precise extraction with complexity metrics
      return extractSymbolsAST(file, component) as CodeSymbol[];
    }
    if (parserKind === "tree_sitter") {
      return extractSymbolsTreeSitter(file, component) as CodeSymbol[];
    }
    // Regex fallback: Python, Java, C#, and non-JS/TS files
    return detectSymbolsRegex(file, component);
  });

  // Build cross-file name index
  const byName = buildNameIndex(symbols);

  // Group symbols by file for call resolution
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    const list = symbolsByFile.get(symbol.file) ?? [];
    list.push(symbol);
    symbolsByFile.set(symbol.file, list);
  }

  // Pass 2 — extract call edges
  const calls: CodeCallEdge[] = files.flatMap((file) => {
    const ext = extension(file.path);
    const fileSymbols = symbolsByFile.get(file.path) ?? [];

    const parserKind = parserByPath.get(file.path) ?? "regex";
    if (parserKind === "typescript_ast" && isJsTs(ext)) {
      return extractCallsAST(file, fileSymbols as ASTSymbol[], byName as Map<string, ASTSymbol[]>);
    }
    if (parserKind === "tree_sitter") {
      return extractCallsTreeSitter(file, fileSymbols as TreeSitterSymbol[], byName as Map<string, TreeSitterSymbol[]>);
    }
    return detectCallsRegex(file, fileSymbols, byName);
  });

  // Component-level rollup
  const components = input.analyses.map((analysis) => {
    const componentSymbols = symbols.filter((s) => s.component === analysis.component.name);
    const symbolIds = new Set(componentSymbols.map((s) => s.id));
    const complexities = componentSymbols
      .map((s) => s.complexity)
      .filter((c): c is number => c !== undefined);
    return {
      name: analysis.component.name,
      symbols: componentSymbols.length,
      outgoingCalls: calls.filter((c) => symbolIds.has(c.sourceSymbolId)).length,
      incomingCalls: calls.filter((c) => c.targetSymbolId && symbolIds.has(c.targetSymbolId)).length,
      maxComplexity: complexities.length > 0 ? Math.max(...complexities) : undefined,
    };
  });

  // Complexity stats across all symbols
  const complexities = symbols
    .map((s) => s.complexity)
    .filter((c): c is number => c !== undefined);
  const avgComplexity =
    complexities.length > 0
      ? Math.round((complexities.reduce((a, b) => a + b, 0) / complexities.length) * 10) / 10
      : undefined;
  const highComplexitySymbols = complexities.filter((c) => c > 10).length;

  return {
    schemaVersion: "1.0",
    generatedAt: input.generatedAt,
    repoUrl: input.repoUrl,
    migration: input.frameworkInfo,
    analysisMethod,
    stats: {
      filesScanned: uniqueFiles.size,
      symbols: symbols.length,
      resolvedCalls: calls.filter((c) => c.targetSymbolId).length,
      unresolvedCalls: calls.filter((c) => !c.targetSymbolId).length,
      ...(avgComplexity !== undefined && { avgComplexity }),
      ...(complexities.length > 0 && { highComplexitySymbols }),
      typeScriptAstFiles,
      treeSitterFiles,
      regexFiles,
    },
    symbols,
    calls,
    components,
  };
}

// ---------------------------------------------------------------------------
// Markdown formatter — updated to show AST method + complexity
// ---------------------------------------------------------------------------

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function formatCodeIntelligenceMarkdown(artifact: CodeIntelligenceArtifact): string {
  const isAST = artifact.analysisMethod === "ast";
  const isHybrid = artifact.analysisMethod === "hybrid";

  const componentRows = artifact.components.map((c) =>
    `| ${escapeTable(c.name)} | ${c.symbols} | ${c.outgoingCalls} | ${c.incomingCalls} | ${c.maxComplexity ?? "-"} |`
  );

  const symbolRows = artifact.symbols.slice(0, 100).map((s) =>
    `| ${escapeTable(s.name)} | ${s.kind} | ${escapeTable(s.component ?? "-")} | ${s.complexity ?? "-"} | ${escapeTable(s.file)}:${s.lineStart} |`
  );

  const callRows = artifact.calls
    .filter((c) => c.targetSymbolId)
    .slice(0, 100)
    .map((c) =>
      `| ${escapeTable(c.sourceName)} | ${escapeTable(c.targetName)} | ${escapeTable(c.component ?? "-")} | ${escapeTable(c.file)}:${c.line} |`
    );

  const highComplexity = artifact.symbols
    .filter((s) => (s.complexity ?? 0) > 10)
    .sort((a, b) => (b.complexity ?? 0) - (a.complexity ?? 0))
    .slice(0, 20);

  const highComplexityRows = highComplexity.map((s) =>
    `| ${escapeTable(s.name)} | ${s.complexity} | ${escapeTable(s.component ?? "-")} | ${escapeTable(s.file)}:${s.lineStart} |`
  );

  return `# Code Intelligence

_Generated: ${artifact.generatedAt}_
_Analysis method: **${isAST ? "AST (TypeScript parser)" : isHybrid ? "Hybrid AST + regex" : "Regex"}**_

${
  isAST
    ? "This artifact was built with deterministic AST parsing for all scanned source files. JS/TS uses the TypeScript parser; Python/Java/C#/Go use Tree-sitter when their grammar packages are installed. Call edges are resolved by a lightweight symbol index, not full type-flow analysis."
    : isHybrid
      ? "This artifact combines AST parsing with regex fallback. JS/TS uses the TypeScript parser; Python/Java/C#/Go use Tree-sitter when available. Treat regex-scanned files as approximate."
      : "This artifact was built using regex-based source scanning. Results are approximate because no AST parser was available."
}

## Summary

| Metric | Value |
|---|---|
| Files scanned | ${artifact.stats.filesScanned} |
| Symbols detected | ${artifact.stats.symbols} |
| Resolved calls | ${artifact.stats.resolvedCalls} |
| Unresolved calls | ${artifact.stats.unresolvedCalls} |
| TypeScript AST files | ${artifact.stats.typeScriptAstFiles ?? 0} |
| Tree-sitter files | ${artifact.stats.treeSitterFiles ?? 0} |
| Regex fallback files | ${artifact.stats.regexFiles ?? 0} |
${artifact.stats.avgComplexity !== undefined ? `| Avg cyclomatic complexity | ${artifact.stats.avgComplexity} |` : ""}
${artifact.stats.highComplexitySymbols !== undefined ? `| High-complexity symbols (>10) | ${artifact.stats.highComplexitySymbols} |` : ""}

## Component Coverage

| Component | Symbols | Outgoing Calls | Incoming Calls | Max Complexity |
|---|---:|---:|---:|---:|
${componentRows.join("\n") || "| _none_ | 0 | 0 | 0 | - |"}

${
  highComplexity.length > 0
    ? `## High-Complexity Symbols (Migration Risk)

Symbols with cyclomatic complexity > 10 carry the highest migration risk.
Each branch is a potential place where behavior can diverge in the target language.

| Symbol | Complexity | Component | Location |
|---|---:|---|---|
${highComplexityRows.join("\n")}
`
    : ""
}

## All Symbols

| Symbol | Kind | Component | Complexity | Location |
|---|---|---|---:|---|
${symbolRows.join("\n") || "| _none_ |  |  |  |  |"}

## Resolved Call Graph

| From | To | Component | Location |
|---|---|---|---|
${callRows.join("\n") || "| _none_ |  |  |  |"}
`;
}

export async function writeCodeIntelligenceArtifacts(
  dir: string,
  artifact: CodeIntelligenceArtifact,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "code-intelligence.json");
  const markdownPath = join(dir, "code-intelligence.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  await fs.writeFile(markdownPath, formatCodeIntelligenceMarkdown(artifact), "utf-8");
  return { jsonPath, markdownPath };
}
