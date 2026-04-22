import { promises as fs } from "fs";
import { join } from "path";

export type SoapCallSite = {
  callerFile: string;
  lineNumber: number;
  serviceNamespace: string;
  methodName: string;
  actionName: string | null;
  isXmlResponse: boolean;
  parameterFlags: string[];
  rawConfig: string;
};

type ScanResult = {
  callSites: SoapCallSite[];
  filesScanned: number;
  filesWithCalls: number;
};

const JS_EXTENSIONS = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"]);

// ---------------------------------------------------------------------------
// Field extractors — all operate on the raw config object text
// ---------------------------------------------------------------------------

function extractStringField(text: string, field: string): string | null {
  const match = text.match(new RegExp(`${field}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`));
  return match?.[1] ?? null;
}

function extractBoolField(text: string, field: string): boolean {
  const match = text.match(new RegExp(`${field}\\s*:\\s*(true|false)`));
  return match?.[1] === "true";
}

function extractParameterFlags(text: string): string[] {
  const flags: string[] = [];
  const flagRegex = /\bis([A-Z][a-zA-Z]+)\s*:\s*true/g;
  let m: RegExpExecArray | null;
  while ((m = flagRegex.exec(text)) !== null) {
    flags.push(`is${m[1]}`);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Config object extraction
// ---------------------------------------------------------------------------

function extractInlineConfig(text: string, callIndex: number): string | null {
  // Find the opening brace right after constructSoapRequest(
  let depth = 0;
  let start = -1;
  let i = callIndex;

  // Advance past `constructSoapRequest(`
  while (i < text.length && text[i] !== "(") i++;
  i++; // skip (

  // Skip whitespace
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;

  if (text[i] !== "{") return null; // not an inline object

  start = i;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractVariableConfig(text: string, callIndex: number): string | null {
  // Find the variable name passed as first argument
  let i = callIndex;
  while (i < text.length && text[i] !== "(") i++;
  i++;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;

  if (text[i] === "{") return null; // inline, handled elsewhere

  // Capture the variable name
  const varMatch = text.slice(i).match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  if (!varMatch) return null;
  const varName = varMatch[1];

  // Search backwards from callIndex for `const/let/var <varName> = {`
  const before = text.slice(0, callIndex);
  // Look for the last assignment to this variable
  const assignRegex = new RegExp(
    `(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`,
    "g"
  );
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = assignRegex.exec(before)) !== null) lastMatch = m;

  if (!lastMatch) return null;

  // Extract the object starting at the `{`
  const objStart = lastMatch.index + lastMatch[0].length - 1;
  let depth = 0;
  for (let j = objStart; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") {
      depth--;
      if (depth === 0) return text.slice(objStart, j + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Single file scanner
// ---------------------------------------------------------------------------

export function scanFileForSoapCalls(
  filePath: string,
  content: string
): SoapCallSite[] {
  if (!content.includes("constructSoapRequest")) return [];

  const results: SoapCallSite[] = [];
  const callRegex = /constructSoapRequest\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = callRegex.exec(content)) !== null) {
    const callIndex = match.index;

    // Try inline first, then variable
    const rawConfig =
      extractInlineConfig(content, callIndex) ??
      extractVariableConfig(content, callIndex);

    if (!rawConfig) continue;

    const serviceNamespace = extractStringField(rawConfig, "serviceNamespace");
    const methodName = extractStringField(rawConfig, "methodName");

    if (!serviceNamespace || !methodName) continue;

    // Determine line number
    const lineNumber = content.slice(0, callIndex).split("\n").length;

    results.push({
      callerFile: filePath,
      lineNumber,
      serviceNamespace,
      methodName,
      actionName: extractStringField(rawConfig, "actionName"),
      isXmlResponse: extractBoolField(rawConfig, "isXmlResponse"),
      parameterFlags: extractParameterFlags(rawConfig),
      rawConfig,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Repo-level scanner — given an array of {path, content} pairs
// ---------------------------------------------------------------------------

export function scanFiles(
  files: Array<{ path: string; content: string }>
): ScanResult {
  const allCallSites: SoapCallSite[] = [];
  let filesWithCalls = 0;

  for (const { path, content } of files) {
    const ext = path.slice(path.lastIndexOf("."));
    if (!JS_EXTENSIONS.has(ext)) continue;

    const callSites = scanFileForSoapCalls(path, content);
    if (callSites.length > 0) {
      filesWithCalls++;
      allCallSites.push(...callSites);
    }
  }

  return {
    callSites: allCallSites,
    filesScanned: files.length,
    filesWithCalls,
  };
}

// ---------------------------------------------------------------------------
// Filesystem scanner — reads files from a local directory
// ---------------------------------------------------------------------------

export async function scanDirectory(rootDir: string): Promise<ScanResult> {
  const files: Array<{ path: string; content: string }> = [];

  async function walk(dir: string) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (!JS_EXTENSIONS.has(ext)) continue;
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          files.push({ path: fullPath, content });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(rootDir);
  return scanFiles(files);
}

// ---------------------------------------------------------------------------
// Deduplicate call sites by serviceNamespace — one entry per unique service
// ---------------------------------------------------------------------------

export function groupByNamespace(
  callSites: SoapCallSite[]
): Map<string, SoapCallSite[]> {
  const map = new Map<string, SoapCallSite[]>();
  for (const site of callSites) {
    const existing = map.get(site.serviceNamespace) ?? [];
    existing.push(site);
    map.set(site.serviceNamespace, existing);
  }
  return map;
}
