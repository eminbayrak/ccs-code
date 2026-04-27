/**
 * AST-based symbol and call-graph extraction for JavaScript and TypeScript.
 *
 * Uses the TypeScript compiler parser that is already part of the repo toolchain.
 * That keeps this usable in restricted company environments: no native modules,
 * no downloaded binaries, and no extra parser package beyond the existing TS
 * tooling. The structural pass is deterministic AST parsing; call resolution is
 * intentionally lightweight name matching, not full type-flow analysis.
 */

import { createRequire } from "node:module";
import type { CodeCallEdge, CodeSymbol, CodeSymbolKind } from "./codeIntelligence.js";

const _require = createRequire(import.meta.url);
// Keep this as `any` so CCS can still compile in stripped-down environments.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tsApi: any = null;

function getTypeScript() {
  if (!tsApi) {
    try {
      tsApi = _require("typescript");
    } catch {
      tsApi = null;
    }
  }
  return tsApi;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TsNode = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SourceFile = any;

export type ASTSymbol = CodeSymbol & { complexity?: number; params?: number };

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new", "typeof",
  "await", "function", "class", "interface", "else", "try", "do", "foreach",
  "lock", "namespace", "require", "import", "console", "Promise", "Boolean",
  "String", "Number", "Object", "Array", "JSON", "Math", "Date",
]);

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use", "route"]);

function scriptKind(path: string, ts: any) {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(ts|mts|cts)$/i.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function parseFile(file: { path: string; content: string }): SourceFile | null {
  const ts = getTypeScript();
  if (!ts) return null;
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file.path)) return null;
  try {
    return ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file.path, ts),
    );
  } catch {
    return null;
  }
}

function lineOf(sourceFile: SourceFile, node: TsNode): number {
  const pos = typeof node.getStart === "function" ? node.getStart(sourceFile) : node.pos ?? 0;
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function lineEndOf(sourceFile: SourceFile, node: TsNode): number {
  const pos = typeof node.getEnd === "function" ? node.getEnd() : node.end ?? node.pos ?? 0;
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function textOf(sourceFile: SourceFile, node: TsNode | undefined): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (typeof node.escapedText === "string") return node.escapedText;
  if (typeof node.getText === "function") return node.getText(sourceFile);
  return "";
}

function symbolId(file: string, name: string, line: number): string {
  return `symbol:${file}:${name}:${line}`;
}

function eachChild(node: TsNode, cb: (child: TsNode) => void) {
  if (typeof node.forEachChild === "function") {
    node.forEachChild(cb);
  }
}

function walk(node: TsNode, visitor: (node: TsNode, parent: TsNode | null) => void, parent: TsNode | null = null) {
  if (!node) return;
  visitor(node, parent);
  eachChild(node, (child) => walk(child, visitor, node));
}

function computeComplexity(node: TsNode, ts: any): number {
  let complexity = 1;
  walk(node, (child) => {
    switch (child.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.CaseClause:
        complexity++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const operator = child.operatorToken?.kind;
        if (
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity++;
        }
        break;
      }
      default:
        break;
    }
  });
  return complexity;
}

function addSymbol(
  sourceFile: SourceFile,
  out: ASTSymbol[],
  filePath: string,
  componentName: string | undefined,
  name: string,
  kind: CodeSymbolKind,
  node: TsNode,
  complexityNode?: TsNode,
  params?: number,
) {
  if (!name || KEYWORDS.has(name)) return;
  const lineStart = lineOf(sourceFile, node);
  out.push({
    id: symbolId(filePath, name, lineStart),
    name,
    kind,
    file: filePath,
    lineStart,
    lineEnd: lineEndOf(sourceFile, node),
    component: componentName,
    complexity: complexityNode ? computeComplexity(complexityNode, getTypeScript()) : undefined,
    params,
  });
}

function isFunctionLike(node: TsNode, ts: any): boolean {
  return [
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
    ts.SyntaxKind.Constructor,
  ].includes(node.kind);
}

function routeHandlerName(sourceFile: SourceFile, call: TsNode, ts: any): string | null {
  if (call.kind !== ts.SyntaxKind.CallExpression) return null;
  const expression = call.expression;
  if (expression?.kind !== ts.SyntaxKind.PropertyAccessExpression) return null;
  const method = textOf(sourceFile, expression.name).toLowerCase();
  if (!HTTP_METHODS.has(method)) return null;
  const first = call.arguments?.[0];
  if (!first) return null;

  let route = "";
  if (first.kind === ts.SyntaxKind.StringLiteral || first.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    route = textOf(sourceFile, first);
  } else if (first.kind === ts.SyntaxKind.TemplateExpression) {
    route = "`...`";
  }
  if (!route) return null;

  return `${method.toUpperCase()} ${route}`;
}

export function extractSymbolsAST(
  file: { path: string; content: string },
  componentName: string | undefined,
): ASTSymbol[] {
  const ts = getTypeScript();
  const sourceFile = parseFile(file);
  if (!ts || !sourceFile) return [];

  const symbols: ASTSymbol[] = [];

  walk(sourceFile, (node) => {
    if (node.kind === ts.SyntaxKind.ClassDeclaration || node.kind === ts.SyntaxKind.ClassExpression) {
      const name = textOf(sourceFile, node.name);
      addSymbol(sourceFile, symbols, file.path, componentName, name, "class", node);
      return;
    }

    if (node.kind === ts.SyntaxKind.InterfaceDeclaration) {
      const name = textOf(sourceFile, node.name);
      addSymbol(sourceFile, symbols, file.path, componentName, name, "interface", node);
      return;
    }

    if (node.kind === ts.SyntaxKind.FunctionDeclaration) {
      const name = textOf(sourceFile, node.name);
      addSymbol(sourceFile, symbols, file.path, componentName, name, "function", node, node, node.parameters?.length);
      return;
    }

    if (node.kind === ts.SyntaxKind.VariableDeclaration) {
      const name = textOf(sourceFile, node.name);
      const init = node.initializer;
      if (init && (init.kind === ts.SyntaxKind.ArrowFunction || init.kind === ts.SyntaxKind.FunctionExpression)) {
        addSymbol(sourceFile, symbols, file.path, componentName, name, "function", node, init, init.parameters?.length);
      }
      return;
    }

    if (
      node.kind === ts.SyntaxKind.MethodDeclaration ||
      node.kind === ts.SyntaxKind.GetAccessor ||
      node.kind === ts.SyntaxKind.SetAccessor
    ) {
      const name = textOf(sourceFile, node.name);
      if (name && name !== "constructor") {
        addSymbol(sourceFile, symbols, file.path, componentName, name, "method", node, node, node.parameters?.length);
      }
      return;
    }

    const handlerName = routeHandlerName(sourceFile, node, ts);
    if (handlerName) {
      const lastArg = node.arguments?.[node.arguments.length - 1];
      const complexityNode = lastArg && isFunctionLike(lastArg, ts) ? lastArg : undefined;
      addSymbol(
        sourceFile,
        symbols,
        file.path,
        componentName,
        handlerName,
        "handler",
        node,
        complexityNode,
        complexityNode?.parameters?.length,
      );
    }
  });

  symbols.sort((a, b) => a.lineStart - b.lineStart || a.name.localeCompare(b.name));
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    if (seen.has(symbol.id)) return false;
    seen.add(symbol.id);
    return true;
  });
}

function findContainingSymbol(line: number, symbols: ASTSymbol[]): ASTSymbol | undefined {
  let best: ASTSymbol | undefined;
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

function callTargetName(sourceFile: SourceFile, node: TsNode, ts: any): string {
  if (node.kind !== ts.SyntaxKind.CallExpression) return "";
  const expression = node.expression;
  if (!expression) return "";
  if (expression.kind === ts.SyntaxKind.Identifier) return textOf(sourceFile, expression);
  if (expression.kind === ts.SyntaxKind.PropertyAccessExpression) return textOf(sourceFile, expression.name);
  return "";
}

export function extractCallsAST(
  file: { path: string; content: string },
  fileSymbols: ASTSymbol[],
  byName: Map<string, ASTSymbol[]>,
): CodeCallEdge[] {
  const ts = getTypeScript();
  const sourceFile = parseFile(file);
  if (!ts || !sourceFile) return [];

  const calls: CodeCallEdge[] = [];
  const seen = new Set<string>();

  walk(sourceFile, (node) => {
    if (node.kind !== ts.SyntaxKind.CallExpression) return;
    const targetName = callTargetName(sourceFile, node, ts);
    if (!targetName || KEYWORDS.has(targetName)) return;

    const line = lineOf(sourceFile, node);
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

export function isAstParserAvailable(): boolean {
  return getTypeScript() !== null;
}

// ---------------------------------------------------------------------------
// Type-flow: heritage clause extraction (implements / extends)
// ---------------------------------------------------------------------------

export type ImplementsEdge = {
  /** The class or symbol that implements/extends */
  className: string;
  classSymbolId: string;
  classFile: string;
  /** The interface or base class name */
  targetName: string;
  kind: "implements" | "extends";
};

/**
 * Extract all `implements X` and `extends X` relationships from a TS/JS file.
 * This is the foundation of type-flow resolution — once we know which concrete
 * class implements an interface, we can resolve calls to interface methods.
 */
export function extractImplementsEdges(
  file: { path: string; content: string },
  fileSymbols: ASTSymbol[],
): ImplementsEdge[] {
  const ts = getTypeScript();
  const sourceFile = parseFile(file);
  if (!ts || !sourceFile) return [];

  const edges: ImplementsEdge[] = [];
  const seen = new Set<string>();

  walk(sourceFile, (node) => {
    const isClass =
      node.kind === ts.SyntaxKind.ClassDeclaration ||
      node.kind === ts.SyntaxKind.ClassExpression;
    const isInterface = node.kind === ts.SyntaxKind.InterfaceDeclaration;
    if (!isClass && !isInterface) return;

    const className = textOf(sourceFile, node.name);
    if (!className) return;

    const symbol = fileSymbols.find((s) => s.name === className && s.file === file.path);
    if (!symbol) return;

    // heritageClauses covers both `implements X, Y` and `extends Z`
    const clauses: TsNode[] = node.heritageClauses ?? [];
    for (const clause of clauses) {
      // clause.token: SyntaxKind.ExtendsKeyword or SyntaxKind.ImplementsKeyword
      const kind: "extends" | "implements" =
        clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends";

      for (const type of clause.types ?? []) {
        const targetName = textOf(sourceFile, type.expression);
        if (!targetName || KEYWORDS.has(targetName)) continue;
        const key = `${symbol.id}:${kind}:${targetName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          className,
          classSymbolId: symbol.id,
          classFile: file.path,
          targetName,
          kind,
        });
      }
    }
  });

  return edges;
}

// ---------------------------------------------------------------------------
// Type-flow: resolve interface call edges to concrete implementations
// ---------------------------------------------------------------------------

export type ResolvedCall = {
  /** The original unresolved call (targetName is an interface method) */
  original: CodeCallEdge;
  /** Concrete symbol IDs that could handle this call */
  implementations: string[];
};

/**
 * Given a set of call edges and a map of interface→implementation symbol IDs,
 * return enriched calls where unresolved interface method calls are linked to
 * all known concrete implementations.
 *
 * This is a lightweight "duck-typing" resolution: any class that has a method
 * with the same name as the called method AND implements the interface is
 * considered a candidate.
 */
export function resolveCallsWithTypeFlow(
  calls: CodeCallEdge[],
  implementsEdges: ImplementsEdge[],
  allSymbols: ASTSymbol[],
): ResolvedCall[] {
  // Build: interface name → concrete class names
  const interfaceImpls = new Map<string, string[]>();
  for (const edge of implementsEdges) {
    if (edge.kind !== "implements") continue;
    const existing = interfaceImpls.get(edge.targetName.toLowerCase()) ?? [];
    if (!existing.includes(edge.className)) {
      existing.push(edge.className);
      interfaceImpls.set(edge.targetName.toLowerCase(), existing);
    }
  }

  const byName = new Map<string, ASTSymbol[]>();
  for (const s of allSymbols) {
    const key = s.name.toLowerCase();
    const bucket = byName.get(key) ?? [];
    bucket.push(s);
    byName.set(key, bucket);
  }

  const resolved: ResolvedCall[] = [];

  for (const call of calls) {
    // Only process calls that are still unresolved (no targetSymbolId)
    if (call.targetSymbolId) continue;

    const targetLower = call.targetName.toLowerCase();
    const implementations: string[] = [];

    // Check every interface to see if a method matches the call target
    for (const [ifaceName, classNames] of interfaceImpls) {
      for (const className of classNames) {
        const methodCandidates = byName.get(targetLower) ?? [];
        for (const method of methodCandidates) {
          if (
            method.name.toLowerCase() === targetLower &&
            (method.kind === "method" || method.kind === "function") &&
            // Method belongs to a class that implements this interface
            allSymbols.some(
              (s) =>
                s.name === className &&
                (s.kind === "class") &&
                implementsEdges.some(
                  (e) =>
                    e.className === className &&
                    e.targetName.toLowerCase() === ifaceName &&
                    e.kind === "implements",
                ),
            )
          ) {
            if (!implementations.includes(method.id)) {
              implementations.push(method.id);
            }
          }
        }
      }
    }

    if (implementations.length > 0) {
      resolved.push({ original: call, implementations });
    }
  }

  return resolved;
}
