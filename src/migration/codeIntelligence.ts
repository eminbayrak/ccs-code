import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";

export type CodeSymbolKind = "class" | "interface" | "function" | "method" | "handler";

export type CodeSymbol = {
  id: string;
  name: string;
  kind: CodeSymbolKind;
  file: string;
  lineStart: number;
  lineEnd: number;
  component?: string;
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
  stats: {
    filesScanned: number;
    symbols: number;
    resolvedCalls: number;
    unresolvedCalls: number;
  };
  symbols: CodeSymbol[];
  calls: CodeCallEdge[];
  components: Array<{
    name: string;
    symbols: number;
    outgoingCalls: number;
    incomingCalls: number;
  }>;
};

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new", "typeof",
  "sizeof", "using", "await", "function", "class", "interface", "else",
  "try", "do", "foreach", "lock", "checked", "unchecked", "namespace",
]);

function symbolId(file: string, name: string, line: number): string {
  return `symbol:${file}:${name}:${line}`;
}

function componentForFile(path: string, analyses: ComponentAnalysis[]): string | undefined {
  const exact = analyses.find((analysis) => analysis.component.filePaths.includes(path));
  if (exact) return exact.component.name;
  const suffix = analyses.find((analysis) =>
    analysis.component.filePaths.some((file) => path.endsWith(file) || file.endsWith(path))
  );
  return suffix?.component.name;
}

function extension(path: string): string {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function detectSymbols(file: { path: string; content: string }, analyses: ComponentAnalysis[]): CodeSymbol[] {
  const ext = extension(file.path);
  const component = componentForFile(file.path, analyses);
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

    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(`.${ext}`)) {
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

function resolveCall(name: string, source: CodeSymbol, byName: Map<string, CodeSymbol[]>): CodeSymbol | undefined {
  const candidates = byName.get(name.toLowerCase()) ?? [];
  return candidates.find((candidate) => candidate.file === source.file) ??
    candidates.find((candidate) => candidate.component && candidate.component === source.component) ??
    candidates[0];
}

function detectCalls(
  file: { path: string; content: string },
  fileSymbols: CodeSymbol[],
  byName: Map<string, CodeSymbol[]>,
): CodeCallEdge[] {
  const calls: CodeCallEdge[] = [];
  const lines = file.content.split(/\r?\n/);
  const symbolForLine = (line: number) =>
    [...fileSymbols].reverse().find((symbol) => line >= symbol.lineStart && line <= symbol.lineEnd);

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const source = symbolForLine(lineNumber);
    if (!source) continue;
    const line = lines[i] ?? "";
    const matcher = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    for (const match of line.matchAll(matcher)) {
      const targetName = match[1] ?? "";
      if (!targetName || KEYWORDS.has(targetName) || targetName === source.name) continue;
      const target = resolveCall(targetName, source, byName);
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

  const symbols = [...uniqueFiles.values()].flatMap((file) => detectSymbols(file, input.analyses));
  const byName = buildNameIndex(symbols);
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    const list = symbolsByFile.get(symbol.file) ?? [];
    list.push(symbol);
    symbolsByFile.set(symbol.file, list);
  }

  const calls = [...uniqueFiles.values()].flatMap((file) =>
    detectCalls(file, symbolsByFile.get(file.path) ?? [], byName)
  );

  const components = input.analyses.map((analysis) => {
    const componentSymbols = symbols.filter((symbol) => symbol.component === analysis.component.name);
    const symbolIds = new Set(componentSymbols.map((symbol) => symbol.id));
    return {
      name: analysis.component.name,
      symbols: componentSymbols.length,
      outgoingCalls: calls.filter((call) => symbolIds.has(call.sourceSymbolId)).length,
      incomingCalls: calls.filter((call) => call.targetSymbolId && symbolIds.has(call.targetSymbolId)).length,
    };
  });

  return {
    schemaVersion: "1.0",
    generatedAt: input.generatedAt,
    repoUrl: input.repoUrl,
    migration: input.frameworkInfo,
    stats: {
      filesScanned: uniqueFiles.size,
      symbols: symbols.length,
      resolvedCalls: calls.filter((call) => call.targetSymbolId).length,
      unresolvedCalls: calls.filter((call) => !call.targetSymbolId).length,
    },
    symbols,
    calls,
    components,
  };
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function formatCodeIntelligenceMarkdown(artifact: CodeIntelligenceArtifact): string {
  const componentRows = artifact.components.map((component) =>
    `| ${escapeTable(component.name)} | ${component.symbols} | ${component.outgoingCalls} | ${component.incomingCalls} |`
  );
  const symbolRows = artifact.symbols.slice(0, 80).map((symbol) =>
    `| ${escapeTable(symbol.name)} | ${symbol.kind} | ${escapeTable(symbol.component ?? "-")} | ${escapeTable(symbol.file)}:${symbol.lineStart} |`
  );
  const callRows = artifact.calls.filter((call) => call.targetSymbolId).slice(0, 80).map((call) =>
    `| ${escapeTable(call.sourceName)} | ${escapeTable(call.targetName)} | ${escapeTable(call.component ?? "-")} | ${escapeTable(call.file)}:${call.line} |`
  );

  return `# Code Intelligence

_Generated: ${artifact.generatedAt}_

This artifact is a lightweight static code map built without external parser dependencies. It detects symbols and call relationships where they are visible from source text. Treat it as deeper evidence for planning and impact analysis, not as a complete compiler-grade call graph.

## Summary

- **Files scanned:** ${artifact.stats.filesScanned}
- **Symbols detected:** ${artifact.stats.symbols}
- **Resolved calls:** ${artifact.stats.resolvedCalls}
- **Unresolved calls:** ${artifact.stats.unresolvedCalls}

## Component Symbol Coverage

| Component | Symbols | Outgoing Calls | Incoming Calls |
|---|---:|---:|---:|
${componentRows.join("\n") || "| _none_ | 0 | 0 | 0 |"}

## Symbols

| Symbol | Kind | Component | Location |
|---|---|---|---|
${symbolRows.join("\n") || "| _none_ |  |  |  |"}

## Resolved Calls

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
