/**
 * MigrationOrchestrator — the main loop.
 *
 * Reads the migration plan, dispatches agents in dependency order,
 * tracks per-file progress, handles failures with retry, and calls
 * VerifierAgent at the end for a final green-light check.
 *
 * Flow per file:
 *   pending → in_progress
 *   → WriterAgent (LLM transform)
 *   → BuildAgent (type-check / compile)
 *   → if build fails: FixerAgent (up to MAX_FIX_ATTEMPTS) → BuildAgent again
 *   → done | error
 *
 * After all files:
 *   → VerifierAgent (forbidden patterns + final build + optional tests)
 */

import { promises as fs } from "fs";
import { join, resolve } from "path";
import type { AgentContext } from "./types.js";
import { ScannerAgent } from "./scannerAgent.js";
import { PlannerAgent } from "./plannerAgent.js";
import { WriterAgent } from "./writerAgent.js";
import { BuildAgent } from "./buildAgent.js";
import { FixerAgent } from "./fixerAgent.js";
import { VerifierAgent } from "./verifierAgent.js";
import {
  loadRun,
  saveRun,
  markFileInProgress,
  markFileDone,
  markFileError,
  markFileSkipped,
  markRunStarted,
  markRunCompleted,
  nextPendingFile,
  getProgress,
  formatProgressBar,
  planFilePath,
} from "../migrationState.js";
import { loadPrompt } from "../promptLibrary.js";
import type { LLMProvider } from "../../llm/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_FIX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrchestratorOptions = {
  repoDir: string;
  provider: LLMProvider;
  onProgress?: (msg: string) => void;
  /** If true, stop after the first file error instead of continuing */
  failFast?: boolean;
  /** If set, only migrate files matching this glob/substring */
  fileFilter?: string;
  /** Dry run — plan and scan but don't write any files */
  dryRun?: boolean;
};

export type OrchestratorResult = {
  ok: boolean;
  filesTotal: number;
  filesDone: number;
  filesError: number;
  filesSkipped: number;
  verifierPassed: boolean | null;
  summary: string;
};

// ---------------------------------------------------------------------------
// Plan command — scan + plan, write migration-run.json
// ---------------------------------------------------------------------------

export async function planMigration(opts: {
  repoDir: string;
  transformation: string;
  provider: LLMProvider;
  buildCommand?: string;
  sourceDir?: string;
  onProgress?: (msg: string) => void;
}): Promise<{ planFile: string; fileCount: number }> {
  const { repoDir, transformation, provider, buildCommand, sourceDir, onProgress } = opts;
  const absRepoDir = resolve(repoDir);
  const planFile = planFilePath(absRepoDir);

  const ctx: AgentContext = {
    provider,
    repoDir: absRepoDir,
    planFile,
    onProgress,
  };

  // Scanner
  const scanner = new ScannerAgent({ onProgress });
  const scanResult = await scanner.run({
    sourceDir: sourceDir ?? join(absRepoDir, "src"),
    ignore: [],
  });

  if (!scanResult.ok) {
    throw new Error(`ScannerAgent failed: ${scanResult.error}`);
  }

  // Planner
  const planner = new PlannerAgent(ctx);
  const planResult = await planner.run({
    transformation,
    scan: scanResult.value,
    buildCommand,
  });

  if (!planResult.ok) {
    throw new Error(`PlannerAgent failed: ${planResult.error}`);
  }

  return { planFile, fileCount: planResult.value.filePaths.length };
}

// ---------------------------------------------------------------------------
// Run command — execute an existing plan
// ---------------------------------------------------------------------------

export async function runMigration(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  const { repoDir, provider, onProgress, failFast = false, fileFilter, dryRun = false } = opts;
  const absRepoDir = resolve(repoDir);
  const planFile = planFilePath(absRepoDir);

  // Load plan
  let run = await loadRun(planFile);
  onProgress?.(`\nMigration: "${run.transformation}"`);
  onProgress?.(`Plan: ${planFile}`);
  onProgress?.(`Files: ${run.files.length}\n`);

  if (dryRun) {
    onProgress?.(`[DRY RUN] Would migrate ${run.files.length} files`);
    return {
      ok: true,
      filesTotal: run.files.length,
      filesDone: 0,
      filesError: 0,
      filesSkipped: 0,
      verifierPassed: null,
      summary: `[DRY RUN] ${run.files.length} files planned`,
    };
  }

  // Mark run started
  await markRunStarted(planFile);

  // Load prompt template once
  let promptTemplate = "";
  try {
    const promptMeta = await loadPrompt(join(absRepoDir, run.promptFile));
    promptTemplate = promptMeta.content;
  } catch {
    onProgress?.(`Warning: could not load prompt file ${run.promptFile} — proceeding without template`);
  }

  const ctx: AgentContext = {
    provider,
    repoDir: absRepoDir,
    planFile,
    onProgress,
  };

  const writer = new WriterAgent(ctx);
  const builder = new BuildAgent({ onProgress });
  const fixer = new FixerAgent(ctx);

  let hadError = false;

  // Main loop — process files in dependency order
  while (true) {
    run = await loadRun(planFile);
    const fileRec = nextPendingFile(run);
    if (!fileRec) break;

    // Apply filter if set
    if (fileFilter && !fileRec.path.includes(fileFilter)) {
      await markFileSkipped(planFile, fileRec.path);
      continue;
    }

    const absFilePath = join(absRepoDir, fileRec.path);
    onProgress?.(`\n→ ${fileRec.path}`);

    // Mark in progress
    await markFileInProgress(planFile, fileRec.path);

    // Read file content
    let fileContent: string;
    try {
      fileContent = await fs.readFile(absFilePath, "utf-8");
    } catch (err) {
      const msg = `Cannot read file: ${err instanceof Error ? err.message : String(err)}`;
      onProgress?.(`  ✗ ${msg}`);
      await markFileError(planFile, fileRec.path, msg);
      hadError = true;
      if (failFast) break;
      continue;
    }

    // --- WriterAgent — pass AST metadata for richer prompt context ---
    const writeResult = await writer.run({
      filePath: absFilePath,
      promptTemplate,
      fileContent,
      symbolCount: fileRec.symbolCount,
      maxComplexity: fileRec.maxComplexity,
      analysisMethod: fileRec.analysisMethod,
    });

    if (!writeResult.ok) {
      onProgress?.(`  ✗ Writer failed: ${writeResult.error}`);
      await markFileError(planFile, fileRec.path, writeResult.error);
      hadError = true;
      if (failFast) break;
      continue;
    }

    onProgress?.(`  ✓ Transformed (${writeResult.value.linesChanged} lines changed)`);

    // --- BuildAgent (after write) ---
    let buildResult = await builder.run({
      command: run.buildCommand,
      cwd: absRepoDir,
    });

    if (!buildResult.ok) {
      onProgress?.(`  ✗ Build check failed: ${buildResult.error}`);
      await markFileError(planFile, fileRec.path, buildResult.error);
      hadError = true;
      if (failFast) break;
      continue;
    }

    // --- FixerAgent loop if build has errors ---
    let fixAttempt = 0;
    while (!buildResult.value.success && fixAttempt < MAX_FIX_ATTEMPTS) {
      fixAttempt++;

      // Read current (post-write) content for fixer
      let currentContent: string;
      try {
        currentContent = await fs.readFile(absFilePath, "utf-8");
      } catch {
        currentContent = fileContent;
      }

      const fixResult = await fixer.run({
        filePath: absFilePath,
        fileContent: currentContent,
        errors: buildResult.value.errors,
        promptTemplate,
        attemptNumber: fixAttempt,
      });

      if (!fixResult.ok) {
        onProgress?.(`  ✗ Fixer failed: ${fixResult.error}`);
        break;
      }

      // Re-run build after fix
      buildResult = await builder.run({
        command: run.buildCommand,
        cwd: absRepoDir,
      });

      if (!buildResult.ok) break;
    }

    if (!buildResult.ok || !buildResult.value.success) {
      const errMsg =
        buildResult.ok
          ? `Build still failing after ${fixAttempt} fix attempt(s): ${buildResult.value.errors
              .slice(0, 3)
              .map((e) => `[${e.code}] ${e.message}`)
              .join("; ")}`
          : buildResult.error;
      onProgress?.(`  ✗ Could not fix: ${errMsg}`);
      await markFileError(planFile, fileRec.path, errMsg);
      hadError = true;
      if (failFast) break;
      continue;
    }

    // Success
    await markFileDone(planFile, fileRec.path, writeResult.value.backupPath);
    onProgress?.(`  ✓ Done`);

    // Show progress bar every 5 files
    run = await loadRun(planFile);
    const p = getProgress(run);
    if (p.done % 5 === 0 || p.done === p.total) {
      onProgress?.(`\n${formatProgressBar(run)}\n`);
    }
  }

  // Mark run completed
  await markRunCompleted(planFile);

  // Final progress
  run = await loadRun(planFile);
  onProgress?.(`\n${formatProgressBar(run)}\n`);

  // --- VerifierAgent ---
  onProgress?.(`Running final verification…`);
  const verifier = new VerifierAgent({ onProgress });
  const verifyResult = await verifier.run({
    repoDir: absRepoDir,
    forbiddenPatterns: run.forbiddenPatterns,
    buildCommand: run.buildCommand,
    testCommand: run.testCommand ?? undefined,
  });

  let verifierPassed: boolean | null = null;
  if (verifyResult.ok) {
    verifierPassed = verifyResult.value.passed;
    onProgress?.(`\nVerification: ${verifyResult.value.summary}`);
  }

  const progress = getProgress(run);
  const summary = [
    `Migration "${run.transformation}" complete.`,
    `  ✓ done: ${progress.done}  ✗ error: ${progress.error}  ○ skipped: ${progress.skipped}`,
    verifierPassed === true
      ? `  ✓ All verification checks passed`
      : verifierPassed === false
        ? `  ✗ Verification failed — see above`
        : ``,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ok: !hadError && verifierPassed !== false,
    filesTotal: progress.total,
    filesDone: progress.done,
    filesError: progress.error,
    filesSkipped: progress.skipped,
    verifierPassed,
    summary,
  };
}
