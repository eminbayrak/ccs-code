import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, createVerifierProvider, loadConfig } from "./index.js";
import { validateSetup } from "../commands/migrate.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProjectConfig(config: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccs-config-"));
  tempDirs.push(dir);
  await mkdir(join(dir, ".ccs"), { recursive: true });
  await writeFile(join(dir, ".ccs", "config.json"), JSON.stringify(config, null, 2), "utf-8");
  process.chdir(dir);
  return dir;
}

async function makeFakeCodex(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccs-fake-codex-"));
  tempDirs.push(dir);
  const command = join(dir, "codex");
  await writeFile(command, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli fake"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
exit 2
`, "utf-8");
  await chmod(command, 0o755);
  return command;
}

describe("LLM provider configuration", () => {
  test("loads codex_cli config and creates a Codex CLI provider", async () => {
    const command = await makeFakeCodex();
    await makeProjectConfig({
      provider: "codex_cli",
      model: "default",
      codexCommand: command,
      sandbox: "read-only",
      approval: "never",
    });

    await expect(loadConfig()).resolves.toMatchObject({ provider: "codex_cli", codexCommand: command });
    const provider = await createProvider();

    expect(provider.name).toBe("Codex CLI");
  });

  test("validates codex_cli setup without API key requirements", async () => {
    const command = await makeFakeCodex();
    await makeProjectConfig({
      provider: "codex_cli",
      codexCommand: command,
    });

    const issues = await validateSetup(false);

    expect(issues).toEqual([]);
  });

  test("creates an independent verifier provider when configured", async () => {
    await makeProjectConfig({
      provider: "openai",
      model: "gpt-main",
      verifier_provider: "anthropic",
      verifier_model_flash: "claude-verifier",
    });

    const provider = await createVerifierProvider("flash");

    expect(provider.name).toBe("Anthropic");
  });
});
