import { join } from "path";
import os from "os";
import { readVaultConfig } from "./vault.js";
import { trace } from "../migration/tracer.js";
import { analyze } from "../migration/rewriteTracer.js";
import { loadPlugins, listPlugins } from "../migration/pluginLoader.js";
import * as statusTracker from "../migration/statusTracker.js";
import { loadConfig } from "../llm/index.js";
import {
  routeIntent,
  decisionToSlashCommand,
  formatRouterAck,
  formatRouterClarification,
} from "../migration/intentRouter.js";
import { analyzeDbStatic, runLiveInterrogation, renderStaticDbSection } from "../migration/dbInterrogator.js";
import { promises as fs } from "fs";
import { checkCodexCliSetup } from "../llm/providers/codexCli.js";
import { openInDefaultBrowser } from "../utils/platform.js";

type MigrationRunFolder = {
  name: string;
  path: string;
  modifiedAt: number;
};

// ---------------------------------------------------------------------------
// Resolve the migration output directory.
// Uses the active vault if configured; falls back to ~/.ccs/migration.
// ---------------------------------------------------------------------------

async function getMigrationDir(): Promise<string> {
  try {
    const cfg = await readVaultConfig();
    if (cfg.activeVault) return join(cfg.activeVault, "migration");
  } catch { /* no vault configured */ }
  return join(os.homedir(), ".ccs", "migration");
}

async function listRunFolders(migrationDir: string): Promise<MigrationRunFolder[]> {
  const { repoSlug } = await import("../migration/runLayout.js");
  let entries: string[] = [];
  try { entries = await fs.readdir(migrationDir); } catch { return []; }

  const runs: MigrationRunFolder[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const path = join(migrationDir, name);
    let stat;
    try { stat = await fs.stat(path); } catch { continue; }
    if (!stat.isDirectory()) continue;

    let isRun = false;
    try {
      await fs.stat(join(path, "migration-contract.json"));
      isRun = true;
    } catch { /* try legacy */ }

    if (!isRun) {
      try {
        await fs.stat(join(path, "rewrite", "migration-contract.json"));
        isRun = true;
      } catch { /* not a run */ }
    }

    if (isRun) {
      runs.push({
        name: repoSlug(name),
        path,
        modifiedAt: stat.mtimeMs,
      });
    }
  }

  return runs.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

async function resolveRunFolder(target?: string): Promise<MigrationRunFolder | null> {
  const { basename, resolve } = await import("path");
  const { repoSlug } = await import("../migration/runLayout.js");
  const migrationDir = await getMigrationDir();
  const runs = await listRunFolders(migrationDir);

  if (!target?.trim()) {
    return runs[0] ?? null;
  }

  const explicit = resolve(process.cwd(), target);
  try {
    const stat = await fs.stat(explicit);
    if (stat.isDirectory()) {
      try {
        await fs.stat(join(explicit, "migration-contract.json"));
        return { name: repoSlug(target), path: explicit, modifiedAt: stat.mtimeMs };
      } catch { /* not direct run */ }
    }
  } catch { /* try migration root */ }

  const slug = repoSlug(target);
  return runs.find((run) =>
    run.name === target ||
    run.name === slug ||
    basename(run.path) === target ||
    basename(run.path) === slug
  ) ?? null;
}

// ---------------------------------------------------------------------------
// Pre-flight validation — surface missing credentials before starting a scan
// ---------------------------------------------------------------------------

export type SetupIssue = { severity: "error" | "warn"; message: string };

async function validateProviderConfig(
  provider: string | undefined,
  codexCommand: string | undefined,
  label = "LLM provider",
): Promise<SetupIssue[]> {
  const issues: SetupIssue[] = [];
  if (provider === "codex_cli") {
    const setupIssues = await checkCodexCliSetup(codexCommand);
    issues.push(...setupIssues.map((issue) => ({
      ...issue,
      message: `${label}: ${issue.message}`,
    })));
  } else if (provider === "anthropic" && !process.env.CCS_ANTHROPIC_API_KEY) {
    issues.push({
      severity: "error",
      message: `${label}: CCS_ANTHROPIC_API_KEY is not set. Get a key at https://console.anthropic.com/`,
    });
  } else if (provider === "openai" && !process.env.CCS_OPENAI_API_KEY) {
    issues.push({
      severity: "error",
      message: `${label}: CCS_OPENAI_API_KEY is not set. Get a key at https://platform.openai.com/`,
    });
  } else if (provider === "gemini" && !process.env.CCS_GEMINI_API_KEY) {
    issues.push({
      severity: "error",
      message: `${label}: CCS_GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/`,
    });
  } else if (provider === "enterprise") {
    const missing = [
      ["CCS_ENTERPRISE_CLIENT_ID", process.env.CCS_ENTERPRISE_CLIENT_ID],
      ["CCS_ENTERPRISE_CLIENT_SECRET", process.env.CCS_ENTERPRISE_CLIENT_SECRET],
      ["CCS_ENTERPRISE_AUTH_URL", process.env.CCS_ENTERPRISE_AUTH_URL],
      ["CCS_ENTERPRISE_SCOPE", process.env.CCS_ENTERPRISE_SCOPE],
      ["CCS_ENTERPRISE_API_BASE", process.env.CCS_ENTERPRISE_API_BASE],
    ].filter(([, value]) => !value).map(([name]) => name);

    if (missing.length > 0) {
      issues.push({
        severity: "error",
        message: `${label}: enterprise provider configuration is incomplete. Missing: ${missing.join(", ")}.`,
      });
    }
  }
  return issues;
}

export async function validateSetup(requireGithub: boolean): Promise<SetupIssue[]> {
  const issues: SetupIssue[] = [];
  const config = await loadConfig();

  issues.push(...await validateProviderConfig(config.provider, config.codexCommand, "Analyzer provider"));
  if (config.verifier_provider) {
    issues.push(...await validateProviderConfig(
      config.verifier_provider,
      config.verifier_codexCommand ?? config.codexCommand,
      "Verifier provider",
    ));
  }

  if (requireGithub) {
    const hasGithubToken =
      process.env.CCS_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GITHUB_PRIVATE_TOKEN;

    if (!hasGithubToken) {
      issues.push({
        severity: "error",
        message: "No GitHub token found. Set CCS_GITHUB_TOKEN in your environment.",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// /migrate scan --repo <url> --lang <language> [--org <org>] [--plugin <name>] [--yes]
// ---------------------------------------------------------------------------

async function handleScan(args: string[], onProgress?: (msg: string) => void): Promise<string> {
  let repoUrl = "";
  let lang = "csharp";
  let org = "";
  let pluginName = "";
  let autoConfirm = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--repo"   || a === "-r") && args[i + 1]) repoUrl    = args[++i] ?? "";
    if ((a === "--lang"   || a === "-l") && args[i + 1]) lang        = args[++i] ?? lang;
    if ((a === "--org"    || a === "-o") && args[i + 1]) org         = args[++i] ?? "";
    if ((a === "--plugin" || a === "-p") && args[i + 1]) pluginName  = args[++i] ?? "";
    if (a === "--yes" || a === "-y") autoConfirm = true;
  }

  const setupIssues = await validateSetup(true);
  if (setupIssues.length > 0) {
    return [
      "### Setup Required",
      "",
      ...setupIssues.map((i) => `${i.severity === "error" ? "✗" : "⚠"} ${i.message}`),
    ].join("\n");
  }

  if (!repoUrl) {
    return [
      "Usage: /migrate scan --repo <github-url> --lang <language> [options]",
      "",
      "Options:",
      "  --org <name>     GitHub org to search for service repos (default: inferred from URL)",
      "  --plugin <name>  Plugin to use for scanning (default: first installed)",
      "  --yes            Skip cost preview confirmation and proceed immediately",
      "",
      "Examples:",
      "  /migrate scan --repo https://github.com/myorg/NodeBackend --lang csharp",
      "  /migrate scan --repo https://github.com/myorg/NodeBackend --lang csharp --yes",
      "",
      "Supported languages: csharp, typescript, java, python, go",
    ].join("\n");
  }

  // Infer org from repo URL if not provided
  if (!org) {
    const parts = repoUrl.replace(/https?:\/\/[^/]+\//, "").split("/");
    org = parts[0] ?? "";
  }

  const migrationDir = await getMigrationDir();
  const logs: string[] = [];

  // Select plugin
  const allPlugins = await loadPlugins(process.cwd());
  if (allPlugins.length === 0) {
    return [
      "No scanner plugin found.",
      "",
      "To see installed plugins, run: `/migrate plugin list`",
      "",
      "Install new plugins into:",
      "  · `.ccs/plugins/<name>/` (project-level)",
      "  · `~/.ccs/plugins/<name>/` (global)",
      "",
      "Each folder needs a `ccs-plugin.json` manifest and a compiled `index.js`.",
    ].join("\n");
  }

  const plugin = pluginName
    ? (allPlugins.find((p) => p.name === pluginName) ?? allPlugins[0]!)
    : allPlugins[0]!;

  logs.push(`Using plugin: ${plugin.name} v${plugin.version}`);

  try {
    const result = await trace({
      entryRepoUrl: repoUrl,
      targetLanguage: lang,
      migrationDir,
      plugin,
      githubConfig: {
        org,
        token: process.env.CCS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PRIVATE_TOKEN,
      },
      onProgress: (msg) => {
        logs.push(msg);
        onProgress?.(msg);
      },
      onCostPreview: async (preview) => {
        logs.push(preview);
        if (autoConfirm) {
          logs.push("Auto-confirmed (--yes flag).");
          return true;
        }
        // Cannot do interactive stdin prompts inside the Ink UI.
        // Show the estimate and ask the user to re-run with --yes.
        return false;
      },
    });

    // If scan was aborted by cost preview, result will have empty arrays
    if (!result.analyzed.length && !result.unresolved.length && !result.errors.length && !result.scanReportPath) {
      return [
        "### Cost Estimate",
        "",
        ...logs,
        "",
        "Add `--yes` to proceed with the scan:",
        `  /migrate scan --repo ${repoUrl} --lang ${lang}${org ? ` --org ${org}` : ""} --yes`,
      ].join("\n");
    }

    // ── Zero SOAP services found — auto-fallback to general code analysis ──
    if (result.analyzed.length === 0 && result.unresolved.length === 0) {
      onProgress?.("No SOAP services detected. Switching to general code analysis...");
      const rewriteArgs = [
        "--repo", repoUrl,
        "--to", lang,
        ...(org ? ["--org", org] : []),
        ...(autoConfirm ? ["--yes"] : []),
      ];
      const rewriteResult = await handleRewrite(rewriteArgs, onProgress);
      return [
        "ℹ No SOAP/WCF services detected in this repo.",
        "",
        "Switched to **general code analysis** mode, which works with any architecture.",
        "",
        rewriteResult,
      ].join("\n");
    }

    const summary = [
      `## ✓ Scan Complete`,
      "",
      `| Metric | Count |`,
      `|---|---|`,
      `| Services analyzed | ${result.analyzed.length} |`,
      `| Unresolved | ${result.unresolved.length} |`,
      `| Errors | ${result.errors.length} |`,
    ];

    if (result.indexPath) {
      summary.push(``, `**System index:** \`${result.indexPath}\``);
    }
    if (result.scanReportPath) {
      summary.push(``, `**Scan report:** \`${result.scanReportPath}\``);
    }
    if (result.unresolved.length > 0) {
      summary.push(``, `⚠ **Unresolved:** ${result.unresolved.join(", ")}`);
    }

    summary.push(``, `Run \`/migrate status\` to see full progress.`);
    return summary.join("\n");
  } catch (e) {
    return `### Scan Failed\n\n${e instanceof Error ? e.message : String(e)}\n\nLogs:\n${logs.join("\n")}`;
  }
}

// ---------------------------------------------------------------------------
// /migrate status
// ---------------------------------------------------------------------------

async function handleStatus(): Promise<string> {
  try {
    const migrationDir = await getMigrationDir();
    return await statusTracker.formatProgressTable(migrationDir);
  } catch (e) {
    return `Error reading migration status: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------------------------------------------------------------------------
// /migrate context <ServiceName>
// ---------------------------------------------------------------------------

async function handleContext(args: string[]): Promise<string> {
  const name = args[0];
  if (!name) return "Usage: /migrate context <ServiceName>";

  try {
    const migrationDir = await getMigrationDir();
    const { promises: fs } = await import("fs");
    const { join } = await import("path");

    // Try exact name first, then with Service suffix
    const candidates = [
      join(migrationDir, "context", `${name}.md`),
      join(migrationDir, "context", `${name}Manager.md`),
    ];

    for (const path of candidates) {
      try {
        return await fs.readFile(path, "utf-8");
      } catch {
        // try next
      }
    }

    return `No context doc found for "${name}". Run /migrate status to see available services.`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------------------------------------------------------------------------
// /migrate verify <ServiceName>
// ---------------------------------------------------------------------------

async function handleVerify(args: string[]): Promise<string> {
  const name = args[0];
  if (!name) return "Usage: /migrate verify <ServiceName>";

  const migrationDir = await getMigrationDir();
  const current = await statusTracker.load(migrationDir);

  if (!current) return "No migration status found. Run /migrate scan first.";

  const svc = current.services.find(
    (s) => s.name === name || s.namespace === name || s.namespace === `${name}Manager`
  );

  if (!svc) return `Service "${name}" not found. Run /migrate status to see available services.`;
  if (svc.status === "discovered") return `⚠ "${name}" has not been analyzed yet. Run /migrate scan first.`;
  if (svc.verified) return `"${name}" is already verified by ${svc.verifiedBy} on ${svc.verifiedAt?.slice(0, 10)}.`;

  const checklist = [
    `### Verify: ${svc.name}`,
    ``,
    `Before marking this service as verified, confirm:`,
    ``,
    `  1. The purpose description is accurate`,
    `  2. The data flow matches what the code actually does`,
    `  3. All business rules are complete`,
    `  4. Input/output contracts are correct`,
    `  5. All database interactions are accounted for`,
    `  6. No nested service calls are missing`,
    ``,
    `Confidence level: ${svc.confidence}`,
  ].join("\n");

  const verifiedBy = args.find((_, i) => args[i - 1] === "--by") ?? "";

  if (!verifiedBy) {
    const lowNote = svc.confidence === "low"
      ? [``, `⚠ LOW confidence — review the context doc before verifying: ${svc.contextDoc}`]
      : [];
    return [
      checklist,
      ...lowNote,
      ``,
      `To confirm verification, run:`,
      `  /migrate verify ${name} --by <your-name>`,
    ].join("\n");
  }

  const ok = await statusTracker.markVerified(migrationDir, svc.namespace, verifiedBy);
  if (ok) {
    const lowWarn = svc.confidence === "low" ? " ⚠ Low confidence — double-check this doc before rewriting." : "";
    return `✓ ${svc.name} verified by ${verifiedBy}. Status updated to in-progress.${lowWarn}`;
  }
  return `Failed to update verification status.`;
}

// ---------------------------------------------------------------------------
// /migrate done <ServiceName>
// ---------------------------------------------------------------------------

async function handleDone(args: string[]): Promise<string> {
  const name = args[0];
  if (!name) return "Usage: /migrate done <ServiceName>";

  const migrationDir = await getMigrationDir();
  const current = await statusTracker.load(migrationDir);
  if (!current) return "No migration status found. Run /migrate scan first.";

  const svc = current.services.find(
    (s) => s.name === name || s.namespace === name || s.namespace === `${name}Manager`
  );
  if (!svc) return `Service "${name}" not found. Run /migrate status to see available services.`;

  try {
    const ok = await statusTracker.markDone(migrationDir, svc.namespace);
    return ok
      ? `✓ ${svc.name} marked as done. Rewrite complete.`
      : `Failed to update status.`;
  } catch (e) {
    return `Cannot mark done: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------------------------------------------------------------------------
// /migrate rewrite --repo <url> --to <language> [--from <framework>] [--yes]
// ---------------------------------------------------------------------------

async function handleRewrite(args: string[], onProgress?: (msg: string) => void): Promise<string> {
  const setupIssues = await validateSetup(true);
  if (setupIssues.length > 0) {
    return [
      "### Setup Required",
      "",
      ...setupIssues.map((i) => `${i.severity === "error" ? "✗" : "⚠"} ${i.message}`),
    ].join("\n");
  }

  let repoUrl = "";
  let targetLanguage = "python";
  let sourceFrameworkHint = "";
  const contextPaths: string[] = [];
  let noContext = false;
  let autoConfirm = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--repo"   || a === "-r") && args[i + 1]) repoUrl             = args[++i] ?? "";
    if ((a === "--to"     || a === "-t") && args[i + 1]) targetLanguage       = args[++i] ?? targetLanguage;
    if ((a === "--from"   || a === "-f") && args[i + 1]) sourceFrameworkHint  = args[++i] ?? "";
    if ((a === "--context" || a === "--context-doc" || a === "--profile" || a === "--architecture-profile") && args[i + 1]) {
      contextPaths.push(args[++i] ?? "");
    }
    if (a === "--no-context") noContext = true;
    if (a === "--yes" || a === "-y") autoConfirm = true;
  }

  if (!repoUrl) {
    return [
      "Usage: /migrate rewrite --repo <github-url> --to <language> [options]",
      "",
      "Analyzes a full codebase and generates per-component migration context docs.",
      "Outputs Claude Code slash commands and an AGENTS.md for Codex — ready to use.",
      "",
      "Options:",
      "  --to <language>     Target language: python, go, typescript, java (default: python)",
      "  --from <framework>  Override auto-detected source framework: aspnet-core, spring-boot, express",
      "  --context <path>    Load a business/use-case or architecture context doc (repeatable)",
      "  --no-context        Disable all context docs, including auto-discovered workspace docs",
      "  --yes               Skip cost confirmation and proceed immediately",
      "",
      "Examples:",
      "  /migrate rewrite --repo https://github.com/myorg/DotNetApi --to python --yes",
      "  /migrate rewrite --repo https://github.com/myorg/SpringApp --to typescript --from spring-boot --context docs/modern-use-case.md --yes",
      "",
      "Output (under migration/<repo-name>/):",
      "  README.md                 — start here",
      "  dashboard.html            — static web UI for the run",
      "  migration-contract.json   — machine-readable migration contract for agents",
      "  components/<Component>.md — per-component context docs",
      "  architecture-context/     — copied --context documents, when provided",
      "  claude-commands/          — optional Claude Code commands",
      "  AGENTS.md                 — Codex/Claude agent context",
    ].join("\n");
  }

  const migrationDir = await getMigrationDir();
  const logs: string[] = [];

  try {
    const result = await analyze({
      repoUrl,
      targetLanguage,
      sourceFrameworkHint: sourceFrameworkHint || undefined,
      contextPaths: noContext ? [] : contextPaths,
      noContext,
      outputDir: migrationDir,
      githubConfig: {
        org: repoUrl.replace(/https?:\/\/[^/]+\//, "").split("/")[0] ?? "",
        token: process.env.CCS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PRIVATE_TOKEN,
      },
      onProgress: (msg) => {
        logs.push(msg);
        onProgress?.(msg);
      },
      onCostPreview: async (preview) => {
        logs.push(preview);
        if (autoConfirm) { logs.push("Auto-confirmed (--yes)."); return true; }
        return false;
      },
    });

    // Cost-preview abort
    if (!result.indexPath && !result.reportPath && result.components.length === 0 && result.errors.length === 0) {
      const contextReplay = noContext ? " --no-context" : contextPaths.map((path) => ` --context ${path}`).join("");
      return [
        "### Cost Estimate",
        "",
        ...logs,
        "",
        `Add \`--yes\` to proceed:`,
        `  /migrate rewrite --repo ${repoUrl} --to ${targetLanguage}${contextReplay} --yes`,
      ].join("\n");
    }

    const { repoSlug } = await import("../migration/runLayout.js");
    const slug = repoSlug(repoUrl);
    const firstComponent = result.migrationOrder[0] ?? result.components[0]?.component.name ?? "—";

    const summary = [
      `## ✓ Analysis Complete`,
      "",
      `| | |`,
      `|---|---|`,
      `| **Source** | ${result.frameworkInfo.sourceFramework} (${result.frameworkInfo.sourceLanguage}) |`,
      `| **Target** | ${result.frameworkInfo.targetFramework} (${result.frameworkInfo.targetLanguage}) |`,
      `| **Components** | ${result.components.length} |`,
      `| **Start with** | \`${firstComponent}\` |`,
      `| **Output** | \`${slug}/\` |`,
    ];

    if (result.unanalyzed.length > 0) {
      summary.push(``, `⚠ **Could not analyze:** ${result.unanalyzed.join(", ")}`);
    }

    if (result.migrationOrder.length > 1) {
      summary.push(``, `**Migration order:** ${result.migrationOrder.slice(0, 6).join(" → ")}${result.migrationOrder.length > 6 ? ` +${result.migrationOrder.length - 6} more` : ""}`);
    }

    summary.push(
      ``,
      `**Open the dashboard:**`,
      `\`\`\``,
      `/migrate open ${slug} --dashboard`,
      `\`\`\``,
      ``,
      `**Key files to review:**`,
      `- \`README.md\` — start here, trust posture overview`,
      `- \`verification-summary.md\` — which components are ready to implement`,
      `- \`human-questions.md\` — open decisions that need your input`,
      `- \`migration-contract.json\` — machine-readable contract for AI agents`,
      ``,
      `Run \`/migrate status\` for a component-by-component view.`,
    );

    return summary.join("\n");
  } catch (e) {
    return `### Rewrite Analysis Failed\n\n${e instanceof Error ? e.message : String(e)}\n\nLogs:\n${logs.join("\n")}`;
  }
}

// ---------------------------------------------------------------------------
// /migrate reverse-eng --repo <url> [--to <language>] [--context <file>] [--yes]
// Generates persisted reverse-engineering artifacts for agents and humans.
// ---------------------------------------------------------------------------

async function handleReverseEng(args: string[], onProgress?: (msg: string) => void): Promise<string> {
  const setupIssues = await validateSetup(true);
  if (setupIssues.length > 0) {
    return [
      "### Setup Required",
      "",
      ...setupIssues.map((i) => `${i.severity === "error" ? "✗" : "⚠"} ${i.message}`),
    ].join("\n");
  }

  let repoUrl = "";
  let targetLanguage = "csharp";
  let sourceFrameworkHint = "";
  const contextPaths: string[] = [];
  let noContext = false;
  let autoConfirm = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--repo" || a === "-r") && args[i + 1]) repoUrl = args[++i] ?? "";
    if ((a === "--to" || a === "-t") && args[i + 1]) targetLanguage = args[++i] ?? targetLanguage;
    if ((a === "--from" || a === "-f") && args[i + 1]) sourceFrameworkHint = args[++i] ?? "";
    if ((a === "--context" || a === "--context-doc" || a === "--profile" || a === "--architecture-profile") && args[i + 1]) {
      contextPaths.push(args[++i] ?? "");
    }
    if (a === "--no-context") noContext = true;
    if (a === "--yes" || a === "-y") autoConfirm = true;
  }

  if (!repoUrl) {
    return [
      "Usage: /migrate reverse-eng --repo <github-url> [options]",
      "",
      "Reverse-engineers a legacy codebase into reusable business logic and system graph artifacts.",
      "This does not write target application code.",
      "",
      "Options:",
      "  --to <language>     Target language/platform hint for architecture decisions (default: csharp)",
      "  --from <framework>  Override auto-detected source framework",
      "  --context <path>    Load a business/use-case or architecture context doc (repeatable)",
      "  --no-context        Disable all context docs, including auto-discovered workspace docs",
      "  --yes               Skip cost confirmation and proceed immediately",
      "",
      "Examples:",
      "  /migrate reverse-eng --repo https://github.com/myorg/LegacyApp --to csharp --context docs/modern-use-case.md --yes",
      "  /migrate reverse-eng --repo https://github.com/gothinkster/node-express-realworld-example-app --to csharp --no-context --yes",
      "",
      "Output (under migration/<repo-name>/):",
      "  reverse-engineering/reverse-engineering-details.md — human-readable reverse-engineering report",
      "  reverse-engineering/business-logic.json            — machine-readable business rules and contracts",
      "  system-graph.json                                  — machine-readable component dependency graph",
      "  system-graph.mmd                                   — Mermaid dependency diagram",
    ].join("\n");
  }

  const migrationDir = await getMigrationDir();
  const logs: string[] = [];

  try {
    const result = await analyze({
      repoUrl,
      targetLanguage,
      sourceFrameworkHint: sourceFrameworkHint || undefined,
      contextPaths: noContext ? [] : contextPaths,
      noContext,
      outputDir: migrationDir,
      githubConfig: {
        org: repoUrl.replace(/https?:\/\/[^/]+\//, "").split("/")[0] ?? "",
        token: process.env.CCS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PRIVATE_TOKEN,
      },
      onProgress: (msg) => {
        logs.push(msg);
        onProgress?.(msg);
      },
      onCostPreview: async (preview) => {
        logs.push(preview);
        if (autoConfirm) { logs.push("Auto-confirmed (--yes)."); return true; }
        return false;
      },
    });

    if (!result.indexPath && !result.reportPath && result.components.length === 0 && result.errors.length === 0) {
      const contextReplay = noContext ? " --no-context" : contextPaths.map((path) => ` --context ${path}`).join("");
      return [
        "### Cost Estimate",
        "",
        ...logs,
        "",
        `Add \`--yes\` to proceed:`,
        `  /migrate reverse-eng --repo ${repoUrl} --to ${targetLanguage}${contextReplay} --yes`,
      ].join("\n");
    }

    const { repoSlug } = await import("../migration/runLayout.js");
    const slug = repoSlug(repoUrl);
    const summary = [
      "## ✓ Reverse Engineering Complete",
      "",
      `**Framework:** ${result.frameworkInfo.sourceFramework} (${result.frameworkInfo.sourceLanguage})`,
      `**Components analyzed:** ${result.components.length}`,
      `**Graph order:** ${result.migrationOrder.join(" → ") || "none"}`,
      "",
      `**Output folder:** \`${slug}/\` (under your migration root)`,
      "",
      "### Open quickly",
      `- Open dashboard: \`/migrate open ${slug} --dashboard\``,
      `- Open result folder: \`/migrate open ${slug}\``,
      "",
      "### What's inside",
      "- `README.md` — start here",
      "- `reverse-engineering/reverse-engineering-details.md` — extracted behavior",
      "- `reverse-engineering/business-logic.json` — machine-readable rules and contracts",
      "- `system-graph.mmd` — dependency diagram",
      "- `system-graph.json` — graph data",
      "",
      "### Next Steps",
      "1. Open `README.md` for a guided walkthrough",
      "2. Review `system-graph.mmd` for dependency shape",
      "3. Ask Codex or Claude Code via MCP for graph impact and business logic lookup",
    ];

    if (result.unanalyzed.length > 0) {
      summary.splice(5, 0, "", `⚠ **Failed:** ${result.unanalyzed.join(", ")}`);
    }

    return summary.join("\n");
  } catch (e) {
    return `### Reverse Engineering Failed\n\n${e instanceof Error ? e.message : String(e)}\n\nLogs:\n${logs.join("\n")}`;
  }
}

// ---------------------------------------------------------------------------
// /migrate plugin list
// ---------------------------------------------------------------------------

async function handlePlugin(args: string[]): Promise<string> {
  const sub = args[0];
  if (!sub || sub === "list") {
    const plugins = await listPlugins(process.cwd());
    if (plugins.length === 0) {
      return [
        "No plugins installed.",
        "",
        "Built-in plugins live in `plugins/` in the ccs repo.",
        "Run `npm run build:plugins` to compile them.",
        "Or place a compiled plugin in `.ccs/plugins/<name>/` in your project.",
      ].join("\n");
    }
    const rows = plugins.map((p) => `  ${p.name}@${p.version}  →  ${p.dir}`).join("\n");
    return `Installed plugins:\n\n${rows}`;
  }
  return `Unknown plugin subcommand: ${sub}. Usage: /migrate plugin list`;
}

// ---------------------------------------------------------------------------
// /migrate rescan <ServiceName>
// ---------------------------------------------------------------------------

async function handleRescan(args: string[]): Promise<string> {
  const name = args[0];
  if (!name) return "Usage: /migrate rescan <ServiceName>";

  return [
    `To rescan "${name}":`,
    `1. Delete its context doc from the migration/context/ folder`,
    `2. Run /migrate scan with the same repo URL`,
    ``,
    `The scan skips already-analyzed services by default.`,
    `Deleting the context doc forces re-analysis on the next scan run.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /migrate db --service <name> [--yes]
// Phase 2 of the DB interrogation workflow: live schema extraction.
// Requires explicit user approval and read-only credentials.
// ---------------------------------------------------------------------------

async function handleDb(args: string[], onProgress?: (msg: string) => void): Promise<string> {
  let serviceName = "";
  let autoApprove = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--service" || a === "-s") && args[i + 1]) serviceName = args[++i] ?? "";
    if (a === "--yes" || a === "-y") autoApprove = true;
  }

  if (!serviceName) {
    return [
      "Usage: /migrate db --service <ServiceName> [--yes]",
      "",
      "Performs live database schema extraction for a scanned service.",
      "Requires explicit approval and READ-ONLY database credentials.",
      "",
      "What this does:",
      "  1. Shows static DB analysis findings from the scan",
      "  2. Asks for your approval before connecting",
      "  3. Prompts for read-only credentials (input is masked)",
      "  4. Connects and extracts table/column definitions only",
      "  5. Writes db-schema.md to the service context folder",
      "",
      "Safety guarantees:",
      "  • Never auto-connects using connection strings found in source code",
      "  • Never reads actual table data — schema metadata only",
      "  • Credentials are never stored or logged",
      "",
      "Supported databases: PostgreSQL, MySQL/MariaDB, MS SQL Server",
    ].join("\n");
  }

  const migrationDir = await getMigrationDir();
  const current = await statusTracker.load(migrationDir);

  if (!current) {
    return "No migration scan found. Run `/migrate scan` first.";
  }

  const svc = current.services.find(
    (s) => s.name === serviceName || s.namespace === serviceName || s.namespace === `${serviceName}Manager`
  );

  if (!svc) {
    return `Service "${serviceName}" not found. Run \`/migrate status\` to see available services.`;
  }

  if (!svc.contextDoc) {
    return `No context doc for "${serviceName}" — run \`/migrate scan\` to analyze it first.`;
  }

  // Read the existing context doc to show static findings
  let contextContent = "";
  try {
    contextContent = await fs.readFile(svc.contextDoc, "utf-8");
  } catch {
    contextContent = "";
  }

  // Check if there's already a db-schema.md next to the context doc
  const contextDir = join(migrationDir, "context");
  const schemaPath = join(contextDir, "db-schema.md");
  try {
    await fs.access(schemaPath);
    if (!autoApprove) {
      return [
        `DB schema already extracted for ${serviceName}.`,
        `Schema file: \`${schemaPath}\``,
        ``,
        `To re-extract, delete the file and run this command again.`,
      ].join("\n");
    }
  } catch { /* no existing schema — proceed */ }

  // Show what we found statically
  const dbSection = contextContent.match(/## Database Analysis \(Static\)([\s\S]*?)(?=\n---\n|\n## )/)?.[0] ?? "";

  if (!autoApprove) {
    return [
      `## DB Interrogation — ${serviceName}`,
      ``,
      dbSection || "No static DB analysis found in context doc.",
      ``,
      `---`,
      ``,
      `⚠️  IMPORTANT: Use READ-ONLY credentials only.`,
      ``,
      `To proceed with live schema extraction:`,
      `  /migrate db --service ${serviceName} --yes`,
      ``,
      `This will prompt for masked credentials in the terminal.`,
    ].join("\n");
  }

  // Phase 2: live interrogation
  // We need service files to redo the static analysis for dialect detection
  // Use what we know from the context doc
  const dialectMatch = contextContent.match(/\*\*Dialect detected:\*\* (\w+)/);
  const rawDialect = dialectMatch?.[1] ?? "unknown";
  const validDialects = ["mssql", "postgresql", "mysql", "oracle", "sqlite", "unknown"] as const;
  type DbDialect = typeof validDialects[number];
  const dialectHint: DbDialect = (validDialects as readonly string[]).includes(rawDialect)
    ? rawDialect as DbDialect
    : "unknown";

  const staticFinding: import("../migration/dbInterrogator.js").StaticDbFinding = {
    dialect: dialectHint,
    tables: [],
    queries: [],
    ormHints: [],
    connectionPatterns: [],
    confidence: "medium",
  };

  // Extract table names from context doc if available
  const tableMatches = contextContent.matchAll(/^- `([^`]+)`$/gm);
  for (const m of tableMatches) {
    if (m[1] && !m[1].includes(" ")) staticFinding.tables.push(m[1]);
  }

  onProgress?.(`Starting live DB interrogation for ${serviceName}...`);

  try {
    const result = await runLiveInterrogation(staticFinding, contextDir, onProgress);
    if (!result) {
      return "DB interrogation cancelled or failed.";
    }

    return [
      `## ✓ DB Schema Extracted — ${serviceName}`,
      ``,
      `**Tables:** ${result.tables.length}`,
      `**Schema file:** \`${result.outputPath}\``,
      ``,
      `To include this schema in your rewrite context:`,
      `1. The schema is already referenced in the context doc`,
      `2. Open \`${result.outputPath}\` to review column definitions`,
      `3. Cross-reference with the queries in the static analysis section`,
    ].join("\n");
  } catch (e) {
    return `DB interrogation failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------------------------------------------------------------------------
// /migrate clean [<slug> | --all] [--yes]
// Removes generated run folders so the user can start fresh after we changed
// the output layout, or just to keep the migration root tidy.
// ---------------------------------------------------------------------------

async function handleClean(args: string[]): Promise<string> {
  const { promises: fs } = await import("fs");
  const { join } = await import("path");
  const { repoSlug } = await import("../migration/runLayout.js");

  const all = args.includes("--all");
  const yes = args.includes("--yes") || args.includes("-y");
  const target = args.find((a) => !a.startsWith("--") && a !== "-y");

  const migrationDir = await getMigrationDir();
  let entries: string[] = [];
  try { entries = await fs.readdir(migrationDir); } catch { /* dir missing */ }

  // A "run folder" is anything inside migration/ that contains
  // migration-contract.json or the legacy "rewrite" subdir.
  const runs: Array<{ name: string; path: string; legacy: boolean }> = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const path = join(migrationDir, name);
    let isDir = false;
    try { isDir = (await fs.stat(path)).isDirectory(); } catch { /* skip */ }
    if (!isDir) continue;
    let exists = false;
    try { await fs.stat(join(path, "migration-contract.json")); exists = true; } catch { /* none */ }
    if (exists) { runs.push({ name, path, legacy: name === "rewrite" }); continue; }
    // Legacy <migDir>/rewrite/migration-contract.json
    let legacyExists = false;
    try { await fs.stat(join(path, "rewrite", "migration-contract.json")); legacyExists = true; } catch { /* none */ }
    if (legacyExists) runs.push({ name, path, legacy: true });
  }

  if (runs.length === 0) {
    return `Migration root \`${migrationDir}\` has no rewrite output folders. Nothing to clean.`;
  }

  // List mode: no target, no --all, no --yes
  if (!target && !all) {
    const lines = [
      `### Run folders under \`${migrationDir}\``,
      "",
      ...runs.map((r) => `- \`${r.name}\`${r.legacy ? " _(legacy layout)_" : ""}`),
      "",
      "Remove one with `/migrate clean <name> --yes`, or all of them with `/migrate clean --all --yes`.",
    ];
    return lines.join("\n");
  }

  // Resolve which folder(s) to remove.
  let toRemove: typeof runs = [];
  if (all) {
    toRemove = runs;
  } else if (target) {
    const slug = repoSlug(target);
    const match = runs.find((r) => r.name === target || r.name === slug);
    if (!match) {
      return `No run folder named \`${target}\`. Run \`/migrate clean\` to list available folders.`;
    }
    toRemove = [match];
  }

  if (!yes) {
    return [
      "### Confirm deletion",
      "",
      `This will permanently remove ${toRemove.length} folder(s):`,
      ...toRemove.map((r) => `- \`${r.path}\``),
      "",
      "Re-run with `--yes` to actually delete.",
    ].join("\n");
  }

  const removed: string[] = [];
  const failures: string[] = [];
  for (const r of toRemove) {
    try {
      await fs.rm(r.path, { recursive: true, force: true });
      removed.push(r.name);
    } catch (e) {
      failures.push(`${r.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return [
    "### Clean complete",
    "",
    removed.length > 0 ? `**Removed:** ${removed.map((n) => `\`${n}\``).join(", ")}` : "**Removed:** none",
    failures.length > 0 ? `**Failed:**\n${failures.map((f) => `- ${f}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// /migrate dashboard [<run-folder-or-repo-url>] [--open]
// Regenerates dashboard.html for an existing repo-scoped run folder.
// ---------------------------------------------------------------------------

async function handleDashboard(args: string[]): Promise<string> {
  const { writeDashboardFromRunDir } = await import("../migration/webDashboard.js");

  const shouldOpen = args.includes("--open") || args.includes("-o");
  const target = args.find((a) => !a.startsWith("-"));
  const run = await resolveRunFolder(target);
  if (!run) {
    return target
      ? `No migration run found for \`${target}\`. Run \`/migrate clean\` to list existing run folders.`
      : "No migration run found. Run `/migrate rewrite ... --yes` first.";
  }

  const { dashboardPath } = await writeDashboardFromRunDir(run.path);
  if (shouldOpen) {
    try {
      await openInDefaultBrowser(dashboardPath);
    } catch {
      // Opening is a convenience only; still return the path.
    }
  }

  return [
    "## ✓ Dashboard Ready",
    "",
    `**Run folder:** \`${run.path}\``,
    `**Dashboard:** \`${dashboardPath}\``,
    "",
    shouldOpen
      ? "Opened in your default browser."
      : "Open `dashboard.html` in your browser, or run `/migrate open --dashboard`.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /migrate open [<run-folder-or-repo-url>] [--dashboard|--folder]
// Opens the latest or selected migration run in Finder/Explorer, or opens its
// generated dashboard.html in the default browser.
// ---------------------------------------------------------------------------

async function handleOpen(args: string[]): Promise<string> {
  const { writeDashboardFromRunDir } = await import("../migration/webDashboard.js");
  const target = args.find((a) => !a.startsWith("-"));
  const dashboard = args.includes("--dashboard") || args.includes("--html") || args.includes("-d");
  const folder = args.includes("--folder") || args.includes("-f") || !dashboard;
  const migrationDir = await getMigrationDir();
  const run = await resolveRunFolder(target);

  if (!run) {
    const runs = await listRunFolders(migrationDir);
    return [
      "### No migration run found",
      "",
      target
        ? `I could not find a run for \`${target}\`.`
        : `I could not find any run folder under \`${migrationDir}\`.`,
      "",
      runs.length > 0
        ? `Available runs: ${runs.map((r) => `\`${r.name}\``).join(", ")}`
        : "Run `/migrate rewrite ... --yes` first.",
      "",
      "Examples:",
      "  `/migrate open`",
      "  `/migrate open --dashboard`",
      "  `/migrate open <repo-slug>`",
      "  `/migrate open <repo-slug> --dashboard`",
    ].join("\n");
  }

  if (dashboard) {
    const { dashboardPath } = await writeDashboardFromRunDir(run.path);
    try {
      await openInDefaultBrowser(dashboardPath);
    } catch {
      return [
        "## Dashboard ready",
        "",
        `I generated it, but could not open the browser automatically.`,
        `Dashboard: \`${dashboardPath}\``,
        `Run folder: \`${run.path}\``,
      ].join("\n");
    }
    return [
      "## Opened dashboard",
      "",
      `**Run:** \`${run.name}\``,
      `**Dashboard:** \`${dashboardPath}\``,
      "",
      `To open the folder instead: \`/migrate open ${run.name}\``,
    ].join("\n");
  }

  if (folder) {
    try {
      await openInDefaultBrowser(run.path);
    } catch {
      return [
        "## Result folder ready",
        "",
        `I found it, but could not open the folder automatically.`,
        `Folder: \`${run.path}\``,
        `Dashboard: \`${join(run.path, "dashboard.html")}\``,
      ].join("\n");
    }
  }

  return [
    "## Opened result folder",
    "",
    `**Run:** \`${run.name}\``,
    `**Folder:** \`${run.path}\``,
    "",
    `To open the dashboard: \`/migrate open ${run.name} --dashboard\``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main command handler — exported for App.tsx
// ---------------------------------------------------------------------------

export async function handleMigrateCommand(
  args: string[],
  _cwd: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "scan":    return handleScan(rest, onProgress);
    case "rewrite": return handleRewrite(rest, onProgress);
    case "reverse-eng":
    case "reverse":
      return handleReverseEng(rest, onProgress);
    case "status":  return handleStatus();
    case "context": return handleContext(rest);
    case "verify":  return handleVerify(rest);
    case "done":    return handleDone(rest);
    case "rescan":  return handleRescan(rest);
    case "plugin":  return handlePlugin(rest);
    case "db":      return handleDb(rest, onProgress);
    case "clean":   return handleClean(rest);
    case "dashboard":
    case "ui":
      return handleDashboard(rest);
    case "open":
    case "folder":
    case "results":
      return handleOpen(rest);
    default: {
      // Feature 1: Semantic intent routing — detect natural language migration
      // requests. When the router has enough info we run the underlying
      // handler directly so the user never has to re-type the command. When
      // it's partial we surface a single clarifying question.
      const fullInput = [subcommand, ...rest].filter(Boolean).join(" ");
      if (fullInput.trim()) {
        try {
          const decision = await routeIntent(fullInput);
          if (decision) {
            const command = decisionToSlashCommand(decision);
            if (command) {
              const ack = formatRouterAck(decision);
              if (onProgress) onProgress(ack);
              const inferredArgs = command.split(/\s+/).slice(1); // drop the leading "migrate"
              const inferredSub = inferredArgs.shift() ?? "rewrite";
              const handler = inferredSub === "scan" ? handleScan : handleRewrite;
              const result = await handler(inferredArgs, onProgress);
              return `${ack}\n\n${result}`;
            }
            return formatRouterClarification(decision);
          }
        } catch { /* routing is best-effort — fall through to help text */ }
      }

      return [
        "## Migration",
        "",
        "Create a verified migration run, then open the dashboard or result folder.",
        "",
        "### Common actions",
        "",
        "| Action | Command |",
        "| --- | --- |",
        "| Analyze a repo | `/migrate rewrite --repo <url> --to csharp --context <file> --yes` |",
        "| Open latest dashboard | `/migrate open --dashboard` |",
        "| Open latest folder | `/migrate open` |",
        "| Clean old runs | `/migrate clean` |",
        "| Agent setup | `/setup` |",
        "",
        "### Plain English also works",
        "",
        "`migrate https://github.com/org/repo to csharp`",
        "",
        "### More commands",
        "",
        "`/migrate reverse-eng` · `/migrate status` · `/migrate verify` · `/migrate db` · `/migrate plugin list`",
        "",
        "Run `/guide` for the full walkthrough.",
      ].join("\n");
    }
  }
}
