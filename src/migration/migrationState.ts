/**
 * MigrationState — persistent per-file progress tracker.
 *
 * Lives at: {repoDir}/.ccs/migration-run.json
 *
 * The Orchestrator reads and writes this file as the single source of truth.
 * All agents update state through this module — never write the file directly.
 */

import { promises as fs } from "fs";
import { join, relative } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "error"
  | "skipped";

export type FileRecord = {
  /** Path relative to repoDir */
  path: string;
  status: FileStatus;
  /** Internal imports this file depends on (relative paths) */
  dependsOn: string[];
  /** Language: ts | js | py | java | cs | go etc. */
  lang: string;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  /** Last error message if status === "error" */
  lastError: string | null;
  /** Path to backup file created before writing */
  backupPath: string | null;
  /** Symbol count from AST/Tree-sitter — used by WriterAgent for context */
  symbolCount?: number;
  /** Max cyclomatic complexity — flags high-risk files */
  maxComplexity?: number;
  /** Parser used during scan */
  analysisMethod?: "ast" | "tree_sitter" | "regex";
};

export type MigrationRun = {
  /** Unique ID: timestamp slug */
  id: string;
  /** Natural language description of the transformation */
  transformation: string;
  /** Path to the prompt file used */
  promptFile: string;
  /** Shell command used to validate after each file */
  buildCommand: string;
  /** Optional test command for final verification */
  testCommand: string | null;
  /** Patterns that must NOT remain after migration */
  forbiddenPatterns: string[];
  /** Ordered list of files to migrate */
  files: FileRecord[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Overall status */
  status: "planned" | "running" | "completed" | "failed" | "paused";
};

// ---------------------------------------------------------------------------
// File location
// ---------------------------------------------------------------------------

export function planFilePath(repoDir: string): string {
  return join(repoDir, ".ccs", "migration-run.json");
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export async function loadRun(planFile: string): Promise<MigrationRun> {
  const raw = await fs.readFile(planFile, "utf-8");
  return JSON.parse(raw) as MigrationRun;
}

export async function saveRun(planFile: string, run: MigrationRun): Promise<void> {
  await fs.mkdir(join(planFile, ".."), { recursive: true });
  await fs.writeFile(planFile, JSON.stringify(run, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Mutations — always load → mutate → save
// ---------------------------------------------------------------------------

export async function initRun(
  planFile: string,
  run: Omit<MigrationRun, "createdAt" | "startedAt" | "completedAt" | "status">,
): Promise<MigrationRun> {
  const full: MigrationRun = {
    ...run,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    status: "planned",
  };
  await saveRun(planFile, full);
  return full;
}

export async function markFileInProgress(planFile: string, filePath: string): Promise<void> {
  const run = await loadRun(planFile);
  const rec = run.files.find((f) => f.path === filePath);
  if (!rec) return;
  rec.status = "in_progress";
  rec.startedAt = new Date().toISOString();
  rec.attempts += 1;
  await saveRun(planFile, run);
}

export async function markFileDone(
  planFile: string,
  filePath: string,
  backupPath: string,
): Promise<void> {
  const run = await loadRun(planFile);
  const rec = run.files.find((f) => f.path === filePath);
  if (!rec) return;
  rec.status = "done";
  rec.completedAt = new Date().toISOString();
  rec.backupPath = backupPath;
  rec.lastError = null;
  await saveRun(planFile, run);
}

export async function markFileError(
  planFile: string,
  filePath: string,
  error: string,
): Promise<void> {
  const run = await loadRun(planFile);
  const rec = run.files.find((f) => f.path === filePath);
  if (!rec) return;
  rec.status = "error";
  rec.lastError = error;
  await saveRun(planFile, run);
}

export async function markFileSkipped(planFile: string, filePath: string): Promise<void> {
  const run = await loadRun(planFile);
  const rec = run.files.find((f) => f.path === filePath);
  if (!rec) return;
  rec.status = "skipped";
  rec.completedAt = new Date().toISOString();
  await saveRun(planFile, run);
}

export async function markRunStarted(planFile: string): Promise<void> {
  const run = await loadRun(planFile);
  run.status = "running";
  run.startedAt = run.startedAt ?? new Date().toISOString();
  await saveRun(planFile, run);
}

export async function markRunCompleted(planFile: string): Promise<void> {
  const run = await loadRun(planFile);
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  await saveRun(planFile, run);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function nextPendingFile(run: MigrationRun): FileRecord | null {
  for (const file of run.files) {
    if (file.status !== "pending") continue;
    // Check all dependencies are done or skipped before picking this file
    const depsReady = file.dependsOn.every((dep) => {
      const depRec = run.files.find((f) => f.path === dep);
      return !depRec || depRec.status === "done" || depRec.status === "skipped";
    });
    if (depsReady) return file;
  }
  return null;
}

export function getProgress(run: MigrationRun): {
  total: number;
  done: number;
  error: number;
  pending: number;
  inProgress: number;
  skipped: number;
  percentDone: number;
} {
  const total = run.files.length;
  const done = run.files.filter((f) => f.status === "done").length;
  const error = run.files.filter((f) => f.status === "error").length;
  const pending = run.files.filter((f) => f.status === "pending").length;
  const inProgress = run.files.filter((f) => f.status === "in_progress").length;
  const skipped = run.files.filter((f) => f.status === "skipped").length;
  return {
    total, done, error, pending, inProgress, skipped,
    percentDone: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

export function formatProgressBar(run: MigrationRun): string {
  const p = getProgress(run);
  const width = 30;
  const filled = Math.round((p.done / (p.total || 1)) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return [
    `[${bar}] ${p.percentDone}%`,
    `  ✓ done: ${p.done}  ✗ error: ${p.error}  ○ pending: ${p.pending}  → in-progress: ${p.inProgress}`,
  ].join("\n");
}

export function relativePath(repoDir: string, absPath: string): string {
  return relative(repoDir, absPath);
}
