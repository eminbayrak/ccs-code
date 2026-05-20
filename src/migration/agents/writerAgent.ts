/**
 * WriterAgent — THE CORE TRANSFORMATION ENGINE.
 *
 * Loads a file, builds a migration prompt with the template + file content,
 * calls the LLM, writes the result to disk.
 *
 * Before writing: creates a backup at {path}.ccs-bak so changes are always reversible.
 * After writing: does a naive diff to estimate lines changed.
 */

import { promises as fs } from "fs";
import { dirname, extname } from "path";
import type { MigrationAgent, AgentResult, WriterInput, WriterOutput, AgentContext } from "./types.js";
import { ok, fail } from "./types.js";

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildMigrationPrompt(
  promptTemplate: string,
  filePath: string,
  fileContent: string,
  meta?: { symbolCount?: number; maxComplexity?: number; analysisMethod?: string },
): string {
  const ext = extname(filePath).slice(1) || "text";

  // Build a structural context note when AST/Tree-sitter data is available
  let structuralContext = "";
  if (meta?.symbolCount != null || meta?.maxComplexity != null) {
    const parts: string[] = [];
    if (meta.symbolCount != null) parts.push(`${meta.symbolCount} symbol(s)`);
    if (meta.maxComplexity != null) parts.push(`max cyclomatic complexity ${meta.maxComplexity}`);
    if (meta.maxComplexity != null && meta.maxComplexity > 10) {
      parts.push("**high complexity — preserve logic carefully**");
    }
    const method = meta.analysisMethod === "ast"
      ? "TypeScript AST"
      : meta.analysisMethod === "tree_sitter"
        ? "Tree-sitter"
        : "static analysis";
    structuralContext = `\n**Structural analysis** (${method}): ${parts.join(", ")}`;
  }

  return `${promptTemplate}

---

## File to Migrate

**File:** \`${filePath}\`${structuralContext}

\`\`\`${ext}
${fileContent}
\`\`\`

---

## Instructions

Apply every transformation rule in "What to Change" above to the file shown.
- Return ONLY the transformed file content — no explanations, no markdown fences, no commentary.
- Preserve all comments, blank lines, and formatting where not being migrated.
- If a section is already in the target format, leave it exactly as-is.
- If an edge case applies, follow the Edge Cases guidance.
- NEVER introduce forbidden patterns.
- Output MUST be valid, compilable code.`;
}

// ---------------------------------------------------------------------------
// Diff — rough line count
// ---------------------------------------------------------------------------

function countChangedLines(before: string, after: string): number {
  const aLines = before.split("\n");
  const bLines = after.split("\n");
  const setA = new Set(aLines);
  const setB = new Set(bLines);
  let changed = 0;
  for (const l of bLines) if (!setA.has(l)) changed++;
  for (const l of aLines) if (!setB.has(l)) changed++;
  return changed;
}

// ---------------------------------------------------------------------------
// Strip markdown fences the LLM might accidentally include
// ---------------------------------------------------------------------------

function stripCodeFences(content: string): string {
  // Remove leading ```lang and trailing ```
  const fenced = content.match(/^```[\w-]*\n([\s\S]*?)\n```\s*$/);
  if (fenced?.[1] != null) return fenced[1];
  // Also strip if surrounded without newlines
  return content.replace(/^```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
}

// ---------------------------------------------------------------------------
// WriterAgent
// ---------------------------------------------------------------------------

export class WriterAgent implements MigrationAgent<WriterInput, WriterOutput> {
  readonly name = "WriterAgent";

  private readonly ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  async run(input: WriterInput): Promise<AgentResult<WriterOutput>> {
    const { filePath, promptTemplate, fileContent, symbolCount, maxComplexity, analysisMethod } = input;

    // 1. Build backup path
    const backupPath = `${filePath}.ccs-bak`;

    // 2. Write backup
    try {
      await fs.writeFile(backupPath, fileContent, "utf-8");
    } catch (err) {
      return fail(
        `Failed to write backup for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }

    // 3. Build the full migration prompt (with structural context when available)
    const prompt = buildMigrationPrompt(promptTemplate, filePath, fileContent, {
      symbolCount,
      maxComplexity,
      analysisMethod,
    });

    // 4. Call LLM
    let transformed: string;
    try {
      transformed = await this.ctx.provider.chat(
        [{ role: "user", content: prompt }],
        "You are an expert code migration engine. Output ONLY the transformed code — no markdown, no explanations.",
      );
    } catch (err) {
      return fail(
        `LLM call failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        true, // recoverable — can retry
      );
    }

    // 5. Clean up any accidental fences
    const cleaned = stripCodeFences(transformed.trim());

    // 6. Sanity check — LLM shouldn't return empty content
    if (cleaned.trim().length === 0) {
      return fail(`LLM returned empty content for ${filePath}`, true);
    }

    // 7. Write transformed file
    try {
      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, cleaned, "utf-8");
    } catch (err) {
      // Try to restore backup
      try {
        await fs.copyFile(backupPath, filePath);
      } catch {}
      return fail(
        `Failed to write transformed file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }

    const linesChanged = countChangedLines(fileContent, cleaned);

    return ok({ filePath, backupPath, linesChanged });
  }
}
