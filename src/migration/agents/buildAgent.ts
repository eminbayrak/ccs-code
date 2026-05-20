/**
 * BuildAgent — runs the project's build/type-check command and parses errors.
 *
 * Supports TypeScript (tsc), ESLint, Python (mypy/flake8), Go (go build), Rust (cargo).
 * Returns structured BuildError[] so FixerAgent can target exactly the right lines.
 */

import { exec } from "child_process";
import type { MigrationAgent, AgentResult, BuildInput, BuildOutput, BuildError } from "./types.js";
import { ok, fail } from "./types.js";

// ---------------------------------------------------------------------------
// Error parsers
// ---------------------------------------------------------------------------

/** TypeScript: src/foo.ts(12,5): error TS2345: Argument of type... */
function parseTscErrors(output: string): BuildError[] {
  const errors: BuildError[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    if (!m[1] || !m[2] || !m[3] || !m[4] || !m[5]) continue;
    errors.push({
      file: m[1].trim(),
      line: parseInt(m[2], 10),
      col: parseInt(m[3], 10),
      code: m[4],
      message: m[5].trim(),
    });
  }
  return errors;
}

/** ESLint JSON output */
function parseEslintJson(output: string): BuildError[] {
  const errors: BuildError[] = [];
  try {
    const results = JSON.parse(output) as Array<{
      filePath: string;
      messages: Array<{ severity: number; line?: number; column?: number; ruleId?: string; message: string }>;
    }>;
    for (const result of results) {
      for (const msg of result.messages ?? []) {
        if (msg.severity < 2) continue; // skip warnings
        errors.push({
          file: result.filePath,
          line: msg.line ?? 0,
          col: msg.column ?? 0,
          code: msg.ruleId ?? "eslint",
          message: msg.message,
        });
      }
    }
  } catch {}
  return errors;
}

/** Python mypy: src/foo.py:12: error: Incompatible... */
function parseMypyErrors(output: string): BuildError[] {
  const errors: BuildError[] = [];
  const re = /^(.+?):(\d+):\s+error:\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    if (!m[1] || !m[2] || !m[3]) continue;
    errors.push({
      file: m[1].trim(),
      line: parseInt(m[2], 10),
      col: 0,
      code: "mypy",
      message: m[3].trim(),
    });
  }
  return errors;
}

/** Go build: ./main.go:12:5: undefined: foo */
function parseGoErrors(output: string): BuildError[] {
  const errors: BuildError[] = [];
  const re = /^(.+?):(\d+):(\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    if (!m[1] || !m[2] || !m[3] || !m[4]) continue;
    errors.push({
      file: m[1].trim(),
      line: parseInt(m[2], 10),
      col: parseInt(m[3], 10),
      code: "go",
      message: m[4].trim(),
    });
  }
  return errors;
}

/** Rust cargo: error[E0425]: cannot find value `foo` in this scope --> src/main.rs:12:5 */
function parseCargoErrors(output: string): BuildError[] {
  const errors: BuildError[] = [];
  const re = /error\[(E\d+)\]:\s+(.+)\n\s+-->\s+(.+?):(\d+):(\d+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    if (!m[1] || !m[2] || !m[3] || !m[4] || !m[5]) continue;
    errors.push({
      file: m[3].trim(),
      line: parseInt(m[4], 10),
      col: parseInt(m[5], 10),
      code: m[1],
      message: m[2].trim(),
    });
  }
  return errors;
}

function parseErrors(command: string, output: string): BuildError[] {
  const cmd = command.toLowerCase();
  if (cmd.includes("tsc")) return parseTscErrors(output);
  if (cmd.includes("eslint") && output.trimStart().startsWith("[")) return parseEslintJson(output);
  if (cmd.includes("mypy")) return parseMypyErrors(output);
  if (cmd.includes("go build") || cmd.includes("go vet")) return parseGoErrors(output);
  if (cmd.includes("cargo")) return parseCargoErrors(output);
  // Generic: try tsc format first, then mypy
  const tsc = parseTscErrors(output);
  if (tsc.length > 0) return tsc;
  return parseMypyErrors(output);
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = exec(command, {
      cwd,
      env: { ...process.env },
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    }, (err, stdout, stderr) => {
      const exitCode = err?.code != null ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ exitCode, stdout, stderr });
    });

    child.on("error", (err) => {
      resolve({ exitCode: -1, stdout: "", stderr: err.message });
    });
  });
}

// ---------------------------------------------------------------------------
// BuildAgent
// ---------------------------------------------------------------------------

export class BuildAgent implements MigrationAgent<BuildInput, BuildOutput> {
  readonly name = "BuildAgent";

  private readonly timeoutMs: number;
  private readonly onProgress?: (msg: string) => void;

  constructor(opts?: { timeoutMs?: number; onProgress?: (msg: string) => void }) {
    this.timeoutMs = opts?.timeoutMs ?? 120_000;
    this.onProgress = opts?.onProgress;
  }

  async run(input: BuildInput): Promise<AgentResult<BuildOutput>> {
    const { command, cwd } = input;

    this.onProgress?.(`  Running: ${command}`);

    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await runCommand(command, cwd, this.timeoutMs);
    } catch (err) {
      return fail(
        `Build command failed to start: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }

    const rawOutput = (result.stdout + "\n" + result.stderr).trim();
    const success = result.exitCode === 0;
    const errors = success ? [] : parseErrors(command, rawOutput);

    if (success) {
      this.onProgress?.(`  ✓ Build passed`);
    } else {
      this.onProgress?.(`  ✗ Build failed: ${errors.length} error(s)`);
    }

    return ok({ success, errors, rawOutput });
  }
}
