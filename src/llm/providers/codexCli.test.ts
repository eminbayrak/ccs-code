import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexCliProvider,
  checkCodexCliSetup,
  runCodexExec,
  serializeMessagesForCodex,
} from "./codexCli.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function makeFakeCodex(options: {
  output?: string;
  stdoutOnly?: boolean;
  execExit?: number;
  execStderr?: string;
  loginExit?: number;
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccs-fake-codex-"));
  tempDirs.push(dir);
  const command = join(dir, "codex");
  const output = options.output ?? "fake codex response";
  const execExit = options.execExit ?? 0;
  const loginExit = options.loginExit ?? 0;

  const execBlock = execExit === 0
    ? options.stdoutOnly
      ? `printf %s ${shellQuote(output)}\nexit 0`
      : `if [ -z "$output_file" ]; then echo "missing output file" >&2; exit 2; fi\nprintf %s ${shellQuote(output)} > "$output_file"\nexit 0`
    : `echo ${shellQuote(options.execStderr ?? "codex failed")} >&2\nexit ${execExit}`;

  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli fake"
  exit 0
fi

if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  if [ ${loginExit} -eq 0 ]; then
    echo "Logged in using ChatGPT"
    exit 0
  fi
  echo "Not logged in" >&2
  exit ${loginExit}
fi

if [ "$1" = "exec" ]; then
  output_file=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--output-last-message" ]; then
      shift
      output_file="$1"
    fi
    shift
  done
  cat >/dev/null
  ${execBlock}
fi

echo "unexpected fake codex args: $@" >&2
exit 2
`;

  await writeFile(command, script, "utf-8");
  await chmod(command, 0o755);
  return command;
}

describe("Codex CLI provider", () => {
  test("serializes chat messages into a Codex exec prompt", () => {
    const prompt = serializeMessagesForCodex(
      [
        { role: "user", content: "Analyze this controller." },
        { role: "assistant", content: "I found one route." },
      ],
      "Return JSON only.",
    );

    expect(prompt).toContain("## System Instructions");
    expect(prompt).toContain("Return JSON only.");
    expect(prompt).toContain("## User Message");
    expect(prompt).toContain("Analyze this controller.");
    expect(prompt).toContain("## Assistant Message");
  });

  test("returns valid JSON written to --output-last-message", async () => {
    const command = await makeFakeCodex({ output: '{"purpose":"Routes files","confidence":"high"}' });
    const provider = new CodexCliProvider({ command, sandbox: "read-only", approval: "never" });

    const response = await provider.chat([{ role: "user", content: "valid json please" }]);

    expect(JSON.parse(response)).toEqual({ purpose: "Routes files", confidence: "high" });
  });

  test("returns markdown-wrapped JSON for callers to repair", async () => {
    const command = await makeFakeCodex({ output: "```json\n{\"ok\":true}\n```" });
    const result = await runCodexExec("markdown json", { command });

    expect(result.content).toContain("```json");
    expect(result.content).toContain("\"ok\":true");
  });

  test("returns malformed output without hiding it", async () => {
    const command = await makeFakeCodex({ output: "{not json" });
    const result = await runCodexExec("malformed", { command });

    expect(result.content).toBe("{not json");
  });

  test("falls back to stdout when the last-message file is empty", async () => {
    const command = await makeFakeCodex({ output: "stdout response", stdoutOnly: true });
    const result = await runCodexExec("stdout fallback", { command });

    expect(result.content).toBe("stdout response");
  });

  test("surfaces codex exec command failures", async () => {
    const command = await makeFakeCodex({ execExit: 23, execStderr: "fallback mode exploded" });

    await expect(runCodexExec("fail", { command })).rejects.toThrow("fallback mode exploded");
  });

  test("validates installed and logged-in Codex CLI", async () => {
    const command = await makeFakeCodex();

    await expect(checkCodexCliSetup(command)).resolves.toEqual([]);
  });

  test("reports login failures without asking for API keys", async () => {
    const command = await makeFakeCodex({ loginExit: 1 });
    const issues = await checkCodexCliSetup(command);

    expect(issues[0]?.message).toContain("Run `codex login`");
    expect(issues[0]?.message).toContain("Sign in with ChatGPT");
    expect(issues[0]?.message).not.toContain("API key");
  });

  test("reports missing Codex CLI", async () => {
    const issues = await checkCodexCliSetup("/definitely/not/codex");

    expect(issues[0]?.message).toContain("not installed");
  });
});
