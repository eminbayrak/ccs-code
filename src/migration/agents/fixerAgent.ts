/**
 * FixerAgent — takes build errors and attempts targeted LLM-assisted fixes.
 *
 * Strategy:
 * 1. Group errors by file
 * 2. For each errored file: read current content + error list → LLM → write fix
 * 3. Returns whether the fix was applied (doesn't re-run the build — that's BuildAgent's job)
 *
 * Max 3 fix attempts per file per migration cycle (enforced by Orchestrator).
 */

import { promises as fs } from "fs";
import { extname } from "path";
import type { MigrationAgent, AgentResult, FixerInput, FixerOutput, AgentContext } from "./types.js";
import type { BuildError } from "./types.js";
import { ok, fail } from "./types.js";

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildFixPrompt(
  filePath: string,
  fileContent: string,
  errors: BuildError[],
  promptTemplate: string,
  attemptNumber: number,
): string {
  const ext = extname(filePath).slice(1) || "text";
  const errList = errors
    .map((e) => `  Line ${e.line}, col ${e.col} [${e.code}]: ${e.message}`)
    .join("\n");

  return `You previously migrated the following file as part of a code migration. The migration produced build errors that need to be fixed.

## Migration Context
${promptTemplate.slice(0, 1000)}…

## File with Errors

**File:** \`${filePath}\`
**Fix attempt:** ${attemptNumber}

\`\`\`${ext}
${fileContent}
\`\`\`

## Build Errors to Fix

${errList}

## Instructions

Fix ONLY the errors listed above. Do not re-apply the migration rules — the migration already happened.
- Return ONLY the corrected file content — no explanations, no markdown fences, no commentary.
- Preserve all lines that are NOT causing errors.
- Prefer minimal changes: fix the error on the affected line, don't restructure unrelated code.
- If the same error appears on multiple lines, fix all occurrences.
- Output MUST be valid, compilable code.`;
}

// ---------------------------------------------------------------------------
// Strip markdown fences (same as WriterAgent)
// ---------------------------------------------------------------------------

function stripCodeFences(content: string): string {
  const fenced = content.match(/^```[\w-]*\n([\s\S]*?)\n```\s*$/);
  if (fenced?.[1] != null) return fenced[1];
  return content.replace(/^```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
}

// ---------------------------------------------------------------------------
// Rough line diff
// ---------------------------------------------------------------------------

function countChangedLines(before: string, after: string): number {
  const setA = new Set(before.split("\n"));
  const setB = new Set(after.split("\n"));
  let changed = 0;
  for (const l of after.split("\n")) if (!setA.has(l)) changed++;
  for (const l of before.split("\n")) if (!setB.has(l)) changed++;
  return changed;
}

// ---------------------------------------------------------------------------
// FixerAgent
// ---------------------------------------------------------------------------

export class FixerAgent implements MigrationAgent<FixerInput, FixerOutput> {
  readonly name = "FixerAgent";

  private readonly ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  async run(input: FixerInput): Promise<AgentResult<FixerOutput>> {
    const { filePath, fileContent, errors, promptTemplate, attemptNumber } = input;

    if (errors.length === 0) {
      return ok({ filePath, fixed: true, linesChanged: 0 });
    }

    this.ctx.onProgress?.(`  Fixing ${errors.length} error(s) in ${filePath} (attempt ${attemptNumber})`);

    const prompt = buildFixPrompt(filePath, fileContent, errors, promptTemplate, attemptNumber);

    // LLM fix call
    let fixed: string;
    try {
      fixed = await this.ctx.provider.chat(
        [{ role: "user", content: prompt }],
        "You are an expert code fixer. Output ONLY the corrected code — no markdown, no explanations.",
      );
    } catch (err) {
      return fail(
        `LLM call failed during fix attempt: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }

    const cleaned = stripCodeFences(fixed.trim());

    if (cleaned.trim().length === 0) {
      return fail(`FixerAgent returned empty content for ${filePath}`, true);
    }

    // Write fixed file
    try {
      await fs.writeFile(filePath, cleaned, "utf-8");
    } catch (err) {
      return fail(
        `Failed to write fixed file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }

    const linesChanged = countChangedLines(fileContent, cleaned);
    this.ctx.onProgress?.(`  ✓ Fix written (${linesChanged} lines changed)`);

    return ok({ filePath, fixed: true, linesChanged });
  }
}
