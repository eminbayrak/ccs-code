/**
 * PlannerAgent — given a natural language transformation description and a scan result,
 * selects the best migration prompt and writes the initial migration plan to disk.
 *
 * One LLM call if no prompt matches (to generate a custom system prompt on the fly).
 * Zero LLM calls if a prompt template already exists in the library.
 */

import { promises as fs } from "fs";
import { join, resolve, relative } from "path";
import type { MigrationAgent, AgentResult, PlannerInput, PlannerOutput, AgentContext } from "./types.js";
import { ok, fail } from "./types.js";
import { findBestPrompt, createPromptTemplate, listPrompts } from "../promptLibrary.js";
import { initRun, planFilePath } from "../migrationState.js";
import type { FileRecord } from "../migrationState.js";

// ---------------------------------------------------------------------------
// Build command auto-detection
// ---------------------------------------------------------------------------

async function detectBuildCommand(repoDir: string): Promise<string> {
  // 1. tsconfig.json → tsc --noEmit
  try {
    await fs.access(join(repoDir, "tsconfig.json"));
    // Check if tsc is available via package.json
    const pkgRaw = await fs.readFile(join(repoDir, "package.json"), "utf-8").catch(() => "{}");
    const pkg = JSON.parse(pkgRaw);
    const devDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (devDeps["typescript"]) {
      return "npx tsc --noEmit";
    }
  } catch {
    // no tsconfig
  }

  // 2. package.json with a build script
  try {
    const pkgRaw = await fs.readFile(join(repoDir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    if (pkg.scripts?.build) return "npm run build";
    if (pkg.scripts?.typecheck) return "npm run typecheck";
    if (pkg.scripts?.check) return "npm run check";
  } catch {
    // no package.json
  }

  // 3. pom.xml → Maven
  try {
    await fs.access(join(repoDir, "pom.xml"));
    return "mvn compile -q";
  } catch {}

  // 4. Cargo.toml → Rust
  try {
    await fs.access(join(repoDir, "Cargo.toml"));
    return "cargo check";
  } catch {}

  // 5. go.mod → Go
  try {
    await fs.access(join(repoDir, "go.mod"));
    return "go build ./...";
  } catch {}

  // 6. requirements.txt or pyproject.toml → Python (no compile step, use flake8/mypy if available)
  try {
    await fs.access(join(repoDir, "pyproject.toml"));
    return "python -m mypy . --ignore-missing-imports";
  } catch {}

  // Fallback
  return "echo 'No build command detected — add one to ccs.yaml'";
}

// ---------------------------------------------------------------------------
// Test command auto-detection
// ---------------------------------------------------------------------------

async function detectTestCommand(repoDir: string): Promise<string | null> {
  try {
    const pkgRaw = await fs.readFile(join(repoDir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    if (pkg.scripts?.test) return "npm test -- --passWithNoTests";
    if (pkg.scripts?.["test:ci"]) return "npm run test:ci";
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// LLM-generated fallback prompt
// ---------------------------------------------------------------------------

async function generateCustomPrompt(
  transformation: string,
  ctx: AgentContext,
  promptsDir: string,
): Promise<string> {
  const slug = transformation
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  const existingPrompts = await listPrompts(promptsDir);
  const examples = existingPrompts
    .slice(0, 2)
    .map((p) => `### Example: ${p.name}\n${p.content.slice(0, 500)}`)
    .join("\n\n---\n\n");

  const systemPrompt = `You are a migration prompt author. Write a precise, machine-readable migration prompt for the CCS Code migration system.

The prompt MUST follow this exact structure with these exact headings:
# Migration: <title>
## Trigger Keywords
## Languages
## What to Change
## Before
## After
## Edge Cases
## Forbidden Patterns
## Acceptance Criteria

Forbidden Patterns should list exact strings (one per bullet) that MUST NOT appear in files after migration.
Acceptance Criteria should be a checkbox list.

Here are example prompts for reference:
${examples}`;

  const userMsg = `Write a migration prompt for the following transformation:

"${transformation}"

Be specific about what patterns to replace and what the replacements should look like.`;

  const content = await ctx.provider.chat(
    [{ role: "user", content: userMsg }],
    systemPrompt,
  );

  // Write to prompt library for reuse
  const promptPath = join(promptsDir, `${slug}.md`);
  await fs.mkdir(promptsDir, { recursive: true });
  await fs.writeFile(promptPath, content, "utf-8");

  return promptPath;
}

// ---------------------------------------------------------------------------
// PlannerAgent
// ---------------------------------------------------------------------------

export class PlannerAgent implements MigrationAgent<PlannerInput, PlannerOutput> {
  readonly name = "PlannerAgent";

  private readonly ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  async run(input: PlannerInput): Promise<AgentResult<PlannerOutput>> {
    const { transformation, scan, buildCommand: forcedBuild } = input;
    const { repoDir, planFile, onProgress } = this.ctx;
    const absRepoDir = resolve(repoDir);
    const promptsDir = join(absRepoDir, "vault", "migrations", "prompts");

    onProgress?.(`Planning migration: "${transformation}"`);

    // 1. Select or generate prompt
    onProgress?.(`  Searching prompt library…`);
    let promptPath: string;
    const bestPrompt = await findBestPrompt(transformation, promptsDir);

    if (bestPrompt) {
      onProgress?.(`  ✓ Found matching prompt: ${bestPrompt.name}`);
      promptPath = bestPrompt.path;
    } else {
      onProgress?.(`  No match found — generating custom prompt with LLM…`);
      try {
        promptPath = await generateCustomPrompt(transformation, this.ctx, promptsDir);
        onProgress?.(`  ✓ Generated custom prompt`);
      } catch (err) {
        return fail(
          `Failed to generate custom prompt: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    }

    // 2. Detect build command
    const buildCommand = forcedBuild ?? (await detectBuildCommand(absRepoDir));
    const testCommand = await detectTestCommand(absRepoDir);
    onProgress?.(`  Build command: ${buildCommand}`);

    // 3. Extract forbidden patterns from the prompt
    const promptContent = await fs.readFile(promptPath, "utf-8").catch(() => "");
    const forbiddenPatterns = extractForbiddenPatterns(promptContent);
    onProgress?.(`  Forbidden patterns: ${forbiddenPatterns.length}`);

    // 4. Build ordered FileRecord list from scan — carry AST metadata forward
    const files: FileRecord[] = scan.orderedFiles.map((node) => ({
      path: relative(absRepoDir, node.path),
      status: "pending",
      dependsOn: node.dependsOn.map((dep) => relative(absRepoDir, dep)),
      lang: node.lang,
      attempts: 0,
      startedAt: null,
      completedAt: null,
      lastError: null,
      backupPath: null,
      symbolCount: node.symbolCount,
      maxComplexity: node.maxComplexity,
      analysisMethod: node.analysisMethod,
    }));

    onProgress?.(`  Planned ${files.length} files`);

    // 5. Create plan ID
    const planId = `run-${Date.now()}`;

    // 6. Init migration state
    try {
      await initRun(planFile, {
        id: planId,
        transformation,
        promptFile: relative(absRepoDir, promptPath),
        buildCommand,
        testCommand,
        forbiddenPatterns,
        files,
      });
    } catch (err) {
      return fail(
        `Failed to write migration plan: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }

    onProgress?.(`  ✓ Plan saved to ${planFile}`);

    return ok({
      planId,
      transformation,
      promptFile: promptPath,
      buildCommand,
      filePaths: scan.orderedFiles.map((n) => n.path),
    });
  }
}

// ---------------------------------------------------------------------------
// Helper: extract Forbidden Patterns from prompt markdown
// ---------------------------------------------------------------------------

function extractForbiddenPatterns(content: string): string[] {
  const match = content.match(/##\s+Forbidden Patterns\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!match?.[1]) return [];
  return match[1]
    .split("\n")
    .map((l) => l.replace(/^[-*`\s]+/, "").replace(/`/g, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}
