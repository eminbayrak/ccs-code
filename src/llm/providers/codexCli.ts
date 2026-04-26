import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMProvider, Message } from "./base.js";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApproval = "untrusted" | "on-request" | "on-failure" | "never";

export type SetupIssue = { severity: "error" | "warn"; message: string };

export type CodexCliProviderOptions = {
  command?: string;
  model?: string;
  sandbox?: CodexSandbox;
  approval?: CodexApproval;
  outputSchema?: string;
  timeoutMs?: number;
  cwd?: string;
  ephemeral?: boolean;
};

type ProcessResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function trimForError(text: string, maxChars = 2_000): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function runProcess(
  command: string,
  args: string[],
  input: string | null,
  timeoutMs: number,
  cwd?: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
        return;
      }
      resolve({
        exitCode: exitCode ?? -1,
        signal,
        stdout,
        stderr,
      });
    });

    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

export function serializeMessagesForCodex(messages: Message[], systemPrompt?: string): string {
  const sections: string[] = [];

  if (systemPrompt?.trim()) {
    sections.push(`## System Instructions\n${systemPrompt.trim()}`);
  }

  for (const message of messages) {
    const label = message.role === "assistant"
      ? "Assistant Message"
      : message.role === "system"
        ? "System Message"
        : "User Message";
    sections.push(`## ${label}\n${message.content}`);
  }

  return `${sections.join("\n\n").trim()}\n`;
}

export async function runCodexExec(
  prompt: string,
  options: CodexCliProviderOptions = {},
): Promise<{ content: string; stdout: string; stderr: string }> {
  const command = options.command ?? "codex";
  const sandbox = options.sandbox ?? "read-only";
  const approval = options.approval ?? "never";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tempDir = await mkdtemp(join(tmpdir(), "ccs-codex-"));
  const outputPath = join(tempDir, "last-message.txt");

  const args = [
    "exec",
    "--sandbox",
    sandbox,
    "-c",
    `approval_policy="${approval}"`,
    "--output-last-message",
    outputPath,
    "--color",
    "never",
  ];

  if (options.ephemeral !== false) args.push("--ephemeral");
  if (options.cwd) args.push("--cd", options.cwd);
  if (options.model && options.model !== "default") args.push("--model", options.model);
  if (options.outputSchema) args.push("--output-schema", options.outputSchema);
  args.push("-");

  try {
    const result = await runProcess(command, args, prompt, timeoutMs, options.cwd);
    let content = "";
    try {
      content = await readFile(outputPath, "utf-8");
    } catch {
      content = "";
    }
    if (!content.trim()) content = result.stdout;

    if (result.exitCode !== 0) {
      throw new Error([
        `[Codex CLI Provider] codex exec failed with exit code ${result.exitCode}.`,
        result.signal ? `Signal: ${result.signal}` : "",
        result.stderr ? `stderr: ${trimForError(result.stderr)}` : "",
        result.stdout ? `stdout: ${trimForError(result.stdout)}` : "",
      ].filter(Boolean).join("\n"));
    }

    return {
      content: content.trimEnd(),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => { });
  }
}

export async function checkCodexCliSetup(command = "codex"): Promise<SetupIssue[]> {
  const issues: SetupIssue[] = [];

  let version: ProcessResult;
  try {
    version = await runProcess(command, ["--version"], null, 5_000);
  } catch {
    return [{
      severity: "error",
      message: "Codex CLI is not installed or not on PATH. Install Codex CLI/Desktop through your approved company channel, then run `codex login`.",
    }];
  }

  if (version.exitCode !== 0) {
    return [{
      severity: "error",
      message: "Codex CLI is not available. Install Codex CLI/Desktop through your approved company channel, then run `codex login`.",
    }];
  }

  let status: ProcessResult;
  try {
    status = await runProcess(command, ["login", "status"], null, 5_000);
  } catch {
    return [{
      severity: "error",
      message: "Codex CLI login status could not be checked. Run `codex login` and choose Sign in with ChatGPT.",
    }];
  }

  if (status.exitCode !== 0) {
    issues.push({
      severity: "error",
      message: "Codex CLI is not logged in. Run `codex login` and choose Sign in with ChatGPT.",
    });
  }

  return issues;
}

export class CodexCliProvider implements LLMProvider {
  name = "Codex CLI";
  model: string;

  constructor(private readonly options: CodexCliProviderOptions = {}) {
    this.model = options.model ?? "default";
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const prompt = serializeMessagesForCodex(messages, systemPrompt);
    const result = await runCodexExec(prompt, {
      ...this.options,
      model: this.model,
    });
    return result.content;
  }
}
