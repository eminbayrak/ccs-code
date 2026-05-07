/**
 * ClaudeCodeProvider
 *
 * Runs `claude --print` as a subprocess so CCS Code can use Claude models
 * without a separate ANTHROPIC_API_KEY — it piggybacks on the auth that
 * Claude Code itself manages (claude login).
 *
 * Setup:
 *   npm install -g @anthropic-ai/claude-code
 *   claude login
 *
 * Config (.ccs/config.json):
 *   { "provider": "claudecode", "model": "claude-sonnet-4-6" }
 */

import { spawn } from "node:child_process";
import type { LLMProvider, Message } from "./base.js";

export type SetupIssue = { severity: "error" | "warn"; message: string };

export type ClaudeCodeProviderOptions = {
  /** Path to the claude binary. Defaults to "claude" (resolved from PATH). */
  command?: string;
  /** Model name passed via --model. Defaults to "claude-sonnet-4-6". */
  model?: string;
  /** Timeout in ms for a single request. Defaults to 10 minutes. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ProcessResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function trimForError(text: string, maxChars = 2_000): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function runProcess(
  command: string,
  args: string[],
  input: string | null,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`[ClaudeCodeProvider] Timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ exitCode: exitCode ?? -1, signal, stdout, stderr });
    });

    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Formats a Message[] + optional systemPrompt into the plain-text prompt
 * that gets piped to `claude --print` via stdin.
 */
export function buildClaudePrompt(messages: Message[], systemPrompt?: string): string {
  const parts: string[] = [];

  if (systemPrompt?.trim()) {
    parts.push(`## System Instructions\n${systemPrompt.trim()}`);
  }

  for (const msg of messages) {
    const label =
      msg.role === "assistant" ? "Assistant Message"
      : msg.role === "system"    ? "System Message"
      :                            "User Message";
    parts.push(`## ${label}\n${msg.content}`);
  }

  return `${parts.join("\n\n").trim()}\n`;
}

// ---------------------------------------------------------------------------
// Setup checker
// ---------------------------------------------------------------------------

/**
 * Returns any issues with the local Claude Code installation.
 * Call this to give the user a helpful error before the first real request.
 */
export async function checkClaudeCodeSetup(
  command = "claude",
): Promise<SetupIssue[]> {
  let versionResult: ProcessResult;
  try {
    versionResult = await runProcess(command, ["--version"], null, 5_000);
  } catch {
    return [
      {
        severity: "error",
        message:
          "Claude Code CLI not found on PATH. Install it with:\n" +
          "  npm install -g @anthropic-ai/claude-code\n" +
          "then run: claude login",
      },
    ];
  }

  if (versionResult.exitCode !== 0) {
    return [
      {
        severity: "error",
        message:
          "Claude Code CLI returned a non-zero exit code on --version.\n" +
          "Try reinstalling: npm install -g @anthropic-ai/claude-code",
      },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ClaudeCodeProvider implements LLMProvider {
  name = "Claude Code";
  model: string;

  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.command = options.command ?? "claude";
    this.model = options.model ?? "claude-sonnet-4-6";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Sends messages to Claude via `claude --print --model <model>`.
   * The full conversation is piped to stdin; Claude Code's own auth
   * handles authentication — no ANTHROPIC_API_KEY required.
   */
  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const prompt = buildClaudePrompt(messages, systemPrompt);

    const args = [
      "--print",
      "--model", this.model,
      "--output-format", "text",
    ];

    let result: ProcessResult;
    try {
      result = await runProcess(this.command, args, prompt, this.timeoutMs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[ClaudeCodeProvider] Failed to spawn '${this.command}'. ` +
        `Make sure Claude Code is installed (npm install -g @anthropic-ai/claude-code) ` +
        `and you are logged in (claude login).\nOriginal error: ${msg}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new Error(
        [
          `[ClaudeCodeProvider] 'claude --print' exited with code ${result.exitCode}.`,
          result.signal ? `Signal: ${result.signal}` : "",
          result.stderr ? `stderr: ${trimForError(result.stderr)}` : "",
          result.stdout ? `stdout: ${trimForError(result.stdout)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    return result.stdout.trimEnd();
  }
}
