/**
 * VerifierAgent — final gate before a migration is declared complete.
 *
 * Checks:
 * 1. Grep every migrated file for forbidden patterns — zero tolerance
 * 2. Run the full build command one last time
 * 3. Optionally run the test suite
 *
 * Returns a structured VerifierOutput so the Orchestrator can surface
 * exactly what still needs fixing.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { exec } from "child_process";
import type { MigrationAgent, AgentResult, VerifierInput, VerifierOutput } from "./types.js";
import { ok } from "./types.js";

// ---------------------------------------------------------------------------
// Forbidden pattern search
// ---------------------------------------------------------------------------

async function walkFiles(dir: string, results: string[]): Promise<void> {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".ccs", "coverage"]);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, results);
    else if (e.isFile()) results.push(full);
  }
}

async function findForbiddenInFiles(
  repoDir: string,
  patterns: string[],
): Promise<Array<{ pattern: string; files: string[] }>> {
  if (patterns.length === 0) return [];

  const allFiles: string[] = [];
  await walkFiles(repoDir, allFiles);

  // Only check source files
  const sourceFiles = allFiles.filter((f) =>
    /\.(ts|tsx|js|jsx|mjs|cjs|py|java|cs|go|rb|rs)$/.test(f),
  );

  const results: Array<{ pattern: string; files: string[] }> = [];

  for (const pattern of patterns) {
    const matchingFiles: string[] = [];
    for (const filePath of sourceFiles) {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        if (content.includes(pattern)) {
          matchingFiles.push(filePath);
        }
      } catch {
        // skip unreadable
      }
    }
    if (matchingFiles.length > 0) {
      results.push({ pattern, files: matchingFiles });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    exec(command, {
      cwd,
      env: { ...process.env },
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const exitCode = err?.code != null ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ exitCode, output: stdout + stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// VerifierAgent
// ---------------------------------------------------------------------------

export class VerifierAgent implements MigrationAgent<VerifierInput, VerifierOutput> {
  readonly name = "VerifierAgent";

  private readonly onProgress?: (msg: string) => void;

  constructor(opts?: { onProgress?: (msg: string) => void }) {
    this.onProgress = opts?.onProgress;
  }

  async run(input: VerifierInput): Promise<AgentResult<VerifierOutput>> {
    const { repoDir, forbiddenPatterns, buildCommand, testCommand } = input;

    // 1. Check forbidden patterns
    this.onProgress?.(`Verifying: scanning for forbidden patterns…`);
    const remainingPatterns = await findForbiddenInFiles(repoDir, forbiddenPatterns);

    if (remainingPatterns.length > 0) {
      for (const { pattern, files } of remainingPatterns) {
        this.onProgress?.(`  ✗ Forbidden "${pattern}" still in: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3} more` : ""}`);
      }
    } else {
      this.onProgress?.(`  ✓ No forbidden patterns found`);
    }

    // 2. Final build
    this.onProgress?.(`Verifying: running final build…`);
    const buildResult = await runCommand(buildCommand, repoDir);
    const buildPassed = buildResult.exitCode === 0;
    this.onProgress?.(`  ${buildPassed ? "✓" : "✗"} Build ${buildPassed ? "passed" : "FAILED"}`);

    // 3. Tests (optional)
    let testsPassed: boolean | null = null;
    if (testCommand) {
      this.onProgress?.(`Verifying: running tests…`);
      const testResult = await runCommand(testCommand, repoDir, 300_000);
      testsPassed = testResult.exitCode === 0;
      this.onProgress?.(`  ${testsPassed ? "✓" : "✗"} Tests ${testsPassed ? "passed" : "FAILED"}`);
    }

    // 4. Compose summary
    const passed =
      remainingPatterns.length === 0 &&
      buildPassed &&
      (testsPassed === null || testsPassed === true);

    const summaryLines: string[] = [];
    if (remainingPatterns.length > 0) {
      summaryLines.push(
        `${remainingPatterns.length} forbidden pattern(s) still present: ${remainingPatterns.map((r) => `"${r.pattern}"`).join(", ")}`,
      );
    }
    if (!buildPassed) summaryLines.push("Build failed");
    if (testsPassed === false) summaryLines.push("Tests failed");
    if (passed) summaryLines.push("All checks passed — migration complete ✓");

    return ok({
      passed,
      remainingPatterns,
      buildPassed,
      testsPassed,
      summary: summaryLines.join("; "),
    });
  }
}
