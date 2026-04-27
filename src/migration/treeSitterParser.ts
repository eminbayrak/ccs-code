/**
 * Optional Tree-sitter parser layer for non-JS/TS languages.
 *
 * Tree-sitter's Node runtime uses a native binding, so CCS loads it lazily and
 * treats it as an optional accelerator. If the binding or a grammar package is
 * not installed, callers simply fall back to the regex scanner. This is the
 * right behavior for locked-down enterprise desktops where native package
 * installation can vary by machine.
 */

import { createRequire } from "node:module";
import type { CodeCallEdge, CodeSymbol, CodeSymbolKind } from "./codeIntelligence.js";

const _require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSNode = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSLanguage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSParser = any;

export type TreeSitterSymbol = CodeSymbol & {
  complexity?: number;
  params?: number;
};

type GrammarSpec = {
  id: "python" | "java" | "csharp" | "go";
  packageName: string;
  languageExport?: string;
  symbolTypes: Partial<Record<string, CodeSymbolKind>>;
  callTypes: Set<string>;
};

const GRAMMARS: Record<string, GrammarSpec> = {
  py: {
    id: "python",
    packageName: "tree-sitter-python",
    symbolTypes: {
      class_definition: "class",
      function_definition: "function",
    },
    callTypes: new Set(["call"]),
  },
  java: {
    id: "java",
    packageName: "tree-sitter-java",
    symbolTypes: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "class",
      record_declaration: "class",
      method_declaration: "method",
      constructor_declaration: "method",
    },
    callTypes: new Set(["method_invocation", "object_creation_expression"]),
  },
  cs: {
    id: "csharp",
    packageName: "tree-sitter-c-sharp",
    symbolTypes: {
      class_declaration: "class",
      interface_declaration: "interface",
      struct_declaration: "class",
      record_declaration: "class",
      method_declaration: "method",
      constructor_declaration: "method",
      property_declaration: "method",
    },
    callTypes: new Set(["invocation_expression", "object_creation_expression"]),
  },
  go: {
    id: "go",
    packageName: "tree-sitter-go",
    symbolTypes: {
      function_declaration: "function",
      method_declaration: "method",
      type_declaration: "class",
    },
    callTypes: new Set(["call_expression"]),
  },
};

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "case", "catch", "return", "throw", "new",
  "await", "yield", "lambda", "self", "this", "super", "print", "len", "range",
  "str", "int", "float", "bool", "list", "dict", "set", "map", "filter",
]);

const COMPLEXITY_TYPES = new Set([
  "if_statement",
  "elif_clause",
  "for_statement",
  "enhanced_for_statement",
  "while_statement",
  "do_statement",
  "except_clause",
  "catch_clause",
  "case_statement",
  "case_clause",
  "switch_section",
  "conditional_expression",
  "ternary_expression",
  "list_comprehension",
  "dictionary_comprehension",
  "set_comprehension",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ParserCtor: any | null | undefined;
const languageCache = new Map<string, TSLanguage | null>();

function extension(path: string): string {
  return path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

function loadParserCtor() {
  if (ParserCtor !== undefined) return ParserCtor;
  try {
    ParserCtor = _require("tree-sitter");
  } catch {
    ParserCtor = null;
  }
  return ParserCtor;
}

function loadLanguage(spec: GrammarSpec): TSLanguage | null {
  if (languageCache.has(spec.id)) return languageCache.get(spec.id) ?? null;
  try {
    const mod = _require(spec.packageName);
    const language =
      spec.languageExport ? mod?.[spec.languageExport] :
      mod?.language ?? mod?.default ?? mod;
    languageCache.set(spec.id, language ?? null);
    return language ?? null;
  } catch {
    languageCache.set(spec.id, null);
    return null;
  }
}

export function treeSitterSpecForPath(path: string): GrammarSpec | null {
  return GRAMMARS[extension(path)] ?? null;
}

export function isTreeSitterAvailableForPath(path: string): boolean {
  const spec = treeSitterSpecForPath(path);
  if (!spec) return false;
  return Boolean(loadParserCtor() && loadLanguage(spec));
}

function parseFile(file: { path: string; content: string }): { spec: GrammarSpec; tree: TSNode } | null {
  const spec = treeSitterSpecForPath(file.path);
  if (!spec) return null;
  const Parser = loadParserCtor();
  const language = loadLanguage(spec);
  if (!Parser || !language) return null;

  try {
    const parser: TSParser = new Parser();
    parser.setLanguage(language);
    return { spec, tree: parser.parse(file.content).rootNode };
  } catch {
    return null;
  }
}

function childrenOf(node: TSNode): TSNode[] {
  return Array.isArray(node?.namedChildren) ? node.namedChildren : [];
}

function walk(node: TSNode, visitor: (node: TSNode, parent: TSNode | null) => void, parent: TSNode | null = null) {
  if (!node) return;
  visitor(node, parent);
  for (const child of childrenOf(node)) {
    walk(child, visitor, node);
  }
}

function lineStart(node: TSNode): number {
  return (node.startPosition?.row ?? 0) + 1;
}

function lineEnd(node: TSNode): number {
  return (node.endPosition?.row ?? node.startPosition?.row ?? 0) + 1;
}

function text(node: TSNode | null | undefined): string {
  return typeof node?.text === "string" ? node.text : "";
}

function nameNode(node: TSNode): TSNode | null {
  return node.childForFieldName?.("name") ??
    childrenOf(node).find((child) => /identifier$|^identifier$|property_identifier|type_identifier/.test(child.type)) ??
    null;
}

function nameOf(node: TSNode): string {
  return text(nameNode(node)).replace(/^["'`]|["'`]$/g, "");
}

function parameterCount(node: TSNode): number | undefined {
  const params = node.childForFieldName?.("parameters") ??
    childrenOf(node).find((child) => /parameter/.test(child.type));
  if (!params) return undefined;
  return childrenOf(params).filter((child) =>
    /parameter|identifier/.test(child.type) && child.type !== "parameters"
  ).length;
}

function symbolId(file: string, name: string, line: number): string {
  return `symbol:${file}:${name}:${line}`;
}

function computeComplexity(node: TSNode): number {
  let complexity = 1;
  walk(node, (child) => {
    if (COMPLEXITY_TYPES.has(child.type)) {
      complexity++;
      return;
    }
    if (child.type === "binary_expression" || child.type === "boolean_operator") {
      const raw = text(child);
      const matches = raw.match(/\&\&|\|\||\?\?|(?:\band\b)|(?:\bor\b)/g);
      if (matches) complexity += matches.length;
    }
  });
  return complexity;
}

function goTypeName(node: TSNode): string {
  const typeSpec = childrenOf(node).find((child) => child.type === "type_spec");
  return nameOf(typeSpec ?? node);
}

function methodName(node: TSNode, spec: GrammarSpec): string {
  if (spec.id === "go" && node.type === "type_declaration") return goTypeName(node);
  return nameOf(node);
}

export function extractSymbolsTreeSitter(
  file: { path: string; content: string },
  componentName: string | undefined,
): TreeSitterSymbol[] {
  const parsed = parseFile(file);
  if (!parsed) return [];

  const symbols: TreeSitterSymbol[] = [];
  walk(parsed.tree, (node) => {
    const kind = parsed.spec.symbolTypes[node.type];
    if (!kind) return;
    const name = methodName(node, parsed.spec);
    if (!name || KEYWORDS.has(name)) return;
    const start = lineStart(node);
    symbols.push({
      id: symbolId(file.path, name, start),
      name,
      kind,
      file: file.path,
      lineStart: start,
      lineEnd: lineEnd(node),
      component: componentName,
      complexity: kind === "class" || kind === "interface" ? undefined : computeComplexity(node),
      params: parameterCount(node),
    });
  });

  symbols.sort((a, b) => a.lineStart - b.lineStart || a.name.localeCompare(b.name));
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    if (seen.has(symbol.id)) return false;
    seen.add(symbol.id);
    return true;
  });
}

function findContainingSymbol(line: number, symbols: TreeSitterSymbol[]): TreeSitterSymbol | undefined {
  let best: TreeSitterSymbol | undefined;
  for (const symbol of symbols) {
    if (line < symbol.lineStart || line > symbol.lineEnd) continue;
    const bestSize = best ? best.lineEnd - best.lineStart : Number.POSITIVE_INFINITY;
    const size = symbol.lineEnd - symbol.lineStart;
    if (!best || size < bestSize || (size === bestSize && symbol.lineStart >= best.lineStart)) {
      best = symbol;
    }
  }
  return best;
}

function lastIdentifier(raw: string): string {
  const matches = raw.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return matches[matches.length - 1] ?? "";
}

function callName(node: TSNode, spec: GrammarSpec): string {
  const byName = nameOf(node);
  if (byName) return byName;

  const fn = node.childForFieldName?.("function");
  if (fn) return lastIdentifier(text(fn));

  if (spec.id === "java" && node.type === "method_invocation") {
    return lastIdentifier(text(node));
  }

  if (spec.id === "csharp" && node.type === "invocation_expression") {
    return lastIdentifier(text(childrenOf(node)[0] ?? node));
  }

  if (spec.id === "go" && node.type === "call_expression") {
    return lastIdentifier(text(childrenOf(node)[0] ?? node));
  }

  if (spec.id === "python" && node.type === "call") {
    return lastIdentifier(text(childrenOf(node)[0] ?? node));
  }

  return "";
}

export function extractCallsTreeSitter(
  file: { path: string; content: string },
  fileSymbols: TreeSitterSymbol[],
  byName: Map<string, TreeSitterSymbol[]>,
): CodeCallEdge[] {
  const parsed = parseFile(file);
  if (!parsed) return [];

  const calls: CodeCallEdge[] = [];
  const seen = new Set<string>();

  walk(parsed.tree, (node) => {
    if (!parsed.spec.callTypes.has(node.type)) return;
    const targetName = callName(node, parsed.spec);
    if (!targetName || KEYWORDS.has(targetName)) return;

    const line = lineStart(node);
    const source = findContainingSymbol(line, fileSymbols);
    if (!source || source.name === targetName) return;

    const candidates = byName.get(targetName.toLowerCase()) ?? [];
    const target =
      candidates.find((candidate) => candidate.file === source.file) ??
      candidates.find((candidate) => candidate.component === source.component) ??
      candidates[0];

    const key = `${source.id}:${target?.id ?? targetName}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);

    calls.push({
      sourceSymbolId: source.id,
      sourceName: source.name,
      targetName,
      targetSymbolId: target?.id,
      file: file.path,
      line,
      component: source.component,
    });
  });

  return calls;
}
