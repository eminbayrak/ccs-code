#!/usr/bin/env bun
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import gradient from "gradient-string";
import { App } from "./components/App";
import { installPasteInterceptor } from "./hooks/pasteInterceptor.js";
import { getGlobalHookEngine } from "./hooks/engine.js";
import { loadHooksFromProject } from "./hooks/loader.js";
import { resolve, join } from "path";
import {
  handleVaultCommand,
  handleSyncCommand,
  handleIngestCommand,
  handleLintCommand,
  handleGraphCommand,
  handleRewriteCommand,
  handleIndexCommand,
} from "./commands/vault.js";

const program = new Command();

program
  .name("my-cli")
  .description("A custom AI CLI assistant inspired by Claude Code")
  .version("0.1.0");

// ---------------------------------------------------------------------------
// Default: interactive chat mode
// ---------------------------------------------------------------------------

program
  .command("chat", { isDefault: true })
  .description("Start the interactive CCS Code chat (default)")
  .option("-p, --prompt <prompt>", "Initial prompt to start the session")
  .option("--compact", "Use a compact startup banner")
  .action((options) => {
    // Must run before render() — wraps Ink's stdin listeners before they're registered
    installPasteInterceptor();

    const hookEngine = getGlobalHookEngine();
    const projectRoot = resolve(process.cwd());
    loadHooksFromProject(projectRoot, hookEngine);

    console.clear();
    render(<App initialPrompt={options.prompt} />);
  });

// ---------------------------------------------------------------------------
// ccs-code init
// ---------------------------------------------------------------------------

program
  .command("init")
  .description("Initialize a new knowledge base vault")
  .argument("[path]", "Path for the vault (default: ./vault)")
  .action(async (vaultArg?: string) => {
    console.log(gradient.atlas("CCS CODE") + " — initializing vault...\n");
    const args = vaultArg ? ["init", vaultArg] : ["init"];
    const output = await handleVaultCommand(args, process.cwd());
    console.log(output);
  });

// ---------------------------------------------------------------------------
// ccs-code sync
// ---------------------------------------------------------------------------

program
  .command("sync")
  .description("Sync configured sources into vault raw/")
  .action(async () => {
    console.log(gradient.atlas("CCS CODE") + " — syncing sources...\n");
    const output = await handleSyncCommand([], process.cwd());
    console.log(output);
  });

// ---------------------------------------------------------------------------
// ccs-code index
// ---------------------------------------------------------------------------

program
  .command("index")
  .description("Rebuild wiki/_master-index.md")
  .action(async () => {
    const output = await handleIndexCommand([], process.cwd());
    console.log(output);
  });

// ---------------------------------------------------------------------------
// ccs-code graph
// ---------------------------------------------------------------------------

const graphCmd = program.command("graph").description("Knowledge graph commands");

graphCmd
  .command("build")
  .description("Build the interactive pyvis graph")
  .action(async () => {
    const output = await handleGraphCommand(["build"], process.cwd());
    console.log(output);
  });

graphCmd
  .command("analyze")
  .description("Analyze graph (PageRank, cycles, rewrite order)")
  .action(async () => {
    const output = await handleRewriteCommand(["rewrite", "order"], process.cwd());
    console.log(output);
  });

// ---------------------------------------------------------------------------
// ccs-code lint
// ---------------------------------------------------------------------------

program
  .command("lint")
  .description("Run wiki health checks")
  .action(async () => {
    const output = await handleLintCommand([], process.cwd());
    console.log(output);
  });

// ---------------------------------------------------------------------------
// ccs-code rewrite
// ---------------------------------------------------------------------------

const rewriteCmd = program.command("rewrite").description("Rewrite planning commands");

rewriteCmd
  .command("plan")
  .description("Generate rewrite brief for a service")
  .option("--service <name>", "Service slug (e.g. payment-svc)")
  .action(async (opts: { service?: string }) => {
    const svc = opts.service ?? "";
    const output = await handleRewriteCommand(["rewrite", svc], process.cwd());
    console.log(output);
  });

rewriteCmd
  .command("order")
  .description("Show optimal rewrite order for all services")
  .action(async () => {
    const output = await handleRewriteCommand(["rewrite", "order"], process.cwd());
    console.log(output);
  });

// ---------------------------------------------------------------------------
// ccs-code ask
// ---------------------------------------------------------------------------

program
  .command("ask <question...>")
  .description("Ask a question about your knowledge base (non-interactive)")
  .action((questionParts: string[]) => {
    const question = questionParts.join(" ");
    installPasteInterceptor();
    const hookEngine = getGlobalHookEngine();
    loadHooksFromProject(resolve(process.cwd()), hookEngine);
    console.clear();
    render(<App initialPrompt={question} />);
  });

// ---------------------------------------------------------------------------
// ccs-code skills
// ---------------------------------------------------------------------------

program
  .command("skills")
  .description("List all discovered skills")
  .action(async () => {
    const { loadSkills } = await import("./utils/configLoader.js");
    const skills = await loadSkills(process.cwd());
    if (skills.length === 0) {
      console.log("No skills found. Run: bun start init");
    } else {
      console.log(`Skills (${skills.length}):`);
      for (const s of skills) {
        console.log(`  • ${s.name}`);
      }
    }
  });

// ---------------------------------------------------------------------------
// ccs-code mcp
// ---------------------------------------------------------------------------

program
  .command("mcp")
  .description("Start the CCS MCP server for Codex and Claude Code")
  .action(async () => {
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer();
  });

program.parse();
