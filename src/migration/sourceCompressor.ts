// ---------------------------------------------------------------------------
// Source file compressor — inspired by Repomix's Tree-sitter compression.
//
// Problem: large C#/Java/Go source files embedded in slash commands can be
// 400-800 lines. Most of that is boilerplate inside method bodies. Claude
// needs to see method signatures, business rules (guard clauses, validations),
// DB calls, and return types — not 50 lines of XML serialisation or string
// formatting in the middle of a method.
//
// Strategy: keep full file for short files. For long files, find method bodies
// (by tracking brace depth) and compress any body longer than COMPRESS_THRESHOLD
// by keeping the head + tail of the body and replacing the middle with a marker.
// If the compressor cannot reliably parse a file it returns the original unchanged.
//
// Languages handled: C#, Java, Go, TypeScript, JavaScript.
// Python uses indentation-based compression (separate function).
// Other extensions: returned unchanged.
// ---------------------------------------------------------------------------

export interface CompressionResult {
  content: string;
  originalLines: number;
  compressedLines: number;
  savedLines: number;
  compressed: boolean;
}

// Number of lines in a method body below which we never compress.
const COMPRESS_THRESHOLD = 30;
// Lines to keep from the TOP of a compressed method body (guard clauses, validations, key logic).
const KEEP_HEAD = 20;
// Lines to keep from the BOTTOM of a compressed method body (return statements, cleanup).
const KEEP_TAIL = 5;
// Minimum total file size before compression is attempted.
const MIN_FILE_LINES = 80;

// ---------------------------------------------------------------------------
// Brace-language compression (C#, Java, Go, TypeScript, JavaScript)
// ---------------------------------------------------------------------------

// Count net brace depth change on a single line, ignoring braces inside
// string literals and single-line comments.
function netBraceChange(line: string): number {
  let depth = 0;
  let inSingleStr = false;
  let inDoubleStr = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;

    // Single-line comment — stop counting braces from here
    if (!inSingleStr && !inDoubleStr && ch === "/" && line[i + 1] === "/") break;

    // String literal tracking (simplified — doesn't handle multi-line strings)
    if (ch === "'" && !inDoubleStr) { inSingleStr = !inSingleStr; i++; continue; }
    if (ch === '"' && !inSingleStr) { inDoubleStr = !inDoubleStr; i++; continue; }
    if (ch === "\\" && (inSingleStr || inDoubleStr)) { i += 2; continue; }

    if (!inSingleStr && !inDoubleStr) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }
    i++;
  }
  return depth;
}

// A line is the start of a method/function definition if it contains
// access modifiers + parentheses and has an opening brace (possibly on the
// next line). This heuristic is conservative — false negatives (missed methods
// that don't compress) are fine; false positives (non-methods that compress)
// are the problem to avoid.
function looksLikeMethodSignature(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("#")) return false;
  // Must have parentheses
  if (!t.includes("(")) return false;
  // Must have an access modifier, common return type keyword, or function keyword
  if (
    !/\b(public|private|protected|internal|static|async|override|virtual|sealed|abstract|func|fn|def)\b/.test(t)
  ) return false;
  // Exclude lines that are calls (followed by semicolon or comma) vs declarations
  if (t.endsWith(";") || t.endsWith(",")) return false;
  // Exclude lambda / delegate expressions
  if (t.includes("=>") && !t.includes("{")) return false;
  return true;
}

function compressBraceLanguage(lines: string[]): CompressionResult {
  const originalLines = lines.length;
  const out: string[] = [];
  let savedLines = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!looksLikeMethodSignature(line)) {
      out.push(line);
      i++;
      continue;
    }

    // Found a likely method signature. Look ahead up to 3 lines for the
    // opening brace that starts the body.
    const sigLines: string[] = [line];
    let braceDepth = netBraceChange(line);
    let j = i + 1;

    while (j < lines.length && braceDepth === 0 && j < i + 4) {
      const ahead = lines[j]!;
      sigLines.push(ahead);
      braceDepth += netBraceChange(ahead);
      j++;
    }

    if (braceDepth <= 0) {
      // Couldn't find opening brace — not a method declaration, emit as-is
      out.push(...sigLines);
      i = j;
      continue;
    }

    // Collect the method body (everything from braceDepth > 0 back to 0)
    const bodyLines: string[] = [];
    let depth = braceDepth;

    while (j < lines.length && depth > 0) {
      const bodyLine = lines[j]!;
      bodyLines.push(bodyLine);
      depth += netBraceChange(bodyLine);
      j++;
    }

    // bodyLines includes the closing brace line
    const closingBrace = bodyLines.pop() ?? "}";
    const body = bodyLines;

    if (body.length > COMPRESS_THRESHOLD) {
      const omitted = body.length - KEEP_HEAD - KEEP_TAIL;
      const indent = body[0]?.match(/^(\s+)/)?.[1] ?? "    ";
      out.push(...sigLines);
      out.push(...body.slice(0, KEEP_HEAD));
      out.push(`${indent}// ✂ ${omitted} lines omitted — see full source in repos/`);
      out.push(...body.slice(-KEEP_TAIL));
      out.push(closingBrace);
      savedLines += omitted;
    } else {
      out.push(...sigLines);
      out.push(...body);
      out.push(closingBrace);
    }

    i = j;
  }

  const compressedLines = out.length;
  return {
    content: out.join("\n"),
    originalLines,
    compressedLines,
    savedLines,
    compressed: savedLines > 0,
  };
}

// ---------------------------------------------------------------------------
// Python compression — indentation-based
// ---------------------------------------------------------------------------

function compressPython(lines: string[]): CompressionResult {
  const originalLines = lines.length;
  const out: string[] = [];
  let savedLines = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    const isFuncOrClass = trimmed.startsWith("def ") || trimmed.startsWith("async def ") || trimmed.startsWith("class ");

    if (!isFuncOrClass) {
      out.push(line);
      i++;
      continue;
    }

    // Found function/class definition. Collect the signature (may span multiple
    // lines if params are on separate lines).
    const sigLines: string[] = [line];
    const baseIndent = line.length - line.trimStart().length;
    i++;

    // Multi-line signature: collect until we see a line with ':' at end
    while (i < lines.length && !sigLines[sigLines.length - 1]!.trimEnd().endsWith(":")) {
      sigLines.push(lines[i]!);
      i++;
    }

    // Collect body: all lines more indented than the def/class
    const bodyLines: string[] = [];
    while (i < lines.length) {
      const bodyLine = lines[i]!;
      if (bodyLine.trim() === "") { bodyLines.push(bodyLine); i++; continue; }
      const bodyIndent = bodyLine.length - bodyLine.trimStart().length;
      if (bodyIndent <= baseIndent) break;
      bodyLines.push(bodyLine);
      i++;
    }

    if (bodyLines.length > COMPRESS_THRESHOLD) {
      const omitted = bodyLines.length - KEEP_HEAD - KEEP_TAIL;
      const indent = " ".repeat(baseIndent + 4);
      out.push(...sigLines);
      out.push(...bodyLines.slice(0, KEEP_HEAD));
      out.push(`${indent}# ✂ ${omitted} lines omitted — see full source in repos/`);
      out.push(...bodyLines.slice(-KEEP_TAIL));
      savedLines += omitted;
    } else {
      out.push(...sigLines);
      out.push(...bodyLines);
    }
  }

  const compressedLines = out.length;
  return {
    content: out.join("\n"),
    originalLines,
    compressedLines,
    savedLines,
    compressed: savedLines > 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const BRACE_LANGS = new Set(["cs", "java", "go", "ts", "js", "tsx", "jsx"]);

export function compressSourceFile(
  content: string,
  filePath: string,
): CompressionResult {
  const lines = content.split("\n");
  const originalLines = lines.length;
  const noOp: CompressionResult = { content, originalLines, compressedLines: originalLines, savedLines: 0, compressed: false };

  if (originalLines < MIN_FILE_LINES) return noOp;

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  try {
    if (BRACE_LANGS.has(ext)) return compressBraceLanguage(lines);
    if (ext === "py") return compressPython(lines);
  } catch {
    // If anything goes wrong, return original unchanged — safety first
    return noOp;
  }

  return noOp;
}

export function formatCompressionStats(results: CompressionResult[]): string {
  const totalSaved = results.reduce((s, r) => s + r.savedLines, 0);
  if (totalSaved === 0) return "";
  const totalOrig = results.reduce((s, r) => s + r.originalLines, 0);
  const pct = Math.round((totalSaved / totalOrig) * 100);
  return `Compressed source: ${totalOrig} → ${totalOrig - totalSaved} lines (${pct}% reduction, ${totalSaved} lines omitted)`;
}
