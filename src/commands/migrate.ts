import { join } from "path";
import os from "os";
import { readVaultConfig } from "./vault.js";
import { trace } from "../migration/tracer.js";
import { analyze } from "../migration/rewriteTracer.js";
import { loadPlugins, listPlugins } from "../migration/pluginLoader.js";
import * as statusTracker from "../migration/statusTracker.js";

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

// ---------------------------------------------------------------------------
// Pre-flight validation — surface missing credentials before starting a scan
// ---------------------------------------------------------------------------

type SetupIssue = { severity: "error" | "warn"; message: string };

function validateSetup(requireGithub: boolean): SetupIssue[] {
  const issues: SetupIssue[] = [];

  if (!process.env.CCS_ANTHROPIC_API_KEY) {
    issues.push({
      severity: "error",
      message: "CCS_ANTHROPIC_API_KEY is not set. Add it to your .env file or environment.\n  Get a key at https://console.anthropic.com/",
    });
  }

  if (requireGithub) {
    const hasGithubToken =
      process.env.CCS_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GITHUB_PRIVATE_TOKEN;

    if (!hasGithubToken) {
      issues.push({
        severity: "error",
        message: "No GitHub token found. Set CCS_GITHUB_TOKEN (or GITHUB_TOKEN) in your environment.\n  Generate one at GitHub → Settings → Developer settings → Personal access tokens\n  Required scopes: repo, read:org",
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

  const setupIssues = validateSetup(true);
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

    const summary = [
      `### Scan Complete`,
      ``,
      ...logs,
      ``,
      `**Results:**`,
      `- Services analyzed: ${result.analyzed.length}`,
      `- Unresolved: ${result.unresolved.length}`,
      `- Errors: ${result.errors.length}`,
    ];

    if (result.indexPath) {
      summary.push(``, `System index: \`${result.indexPath}\``);
    }
    if (result.scanReportPath) {
      summary.push(`Scan report: \`${result.scanReportPath}\``);
    }
    if (result.unresolved.length > 0) {
      summary.push(``, `⚠ Unresolved: ${result.unresolved.join(", ")}`);
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
  const setupIssues = validateSetup(true);
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
  let autoConfirm = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--repo"   || a === "-r") && args[i + 1]) repoUrl             = args[++i] ?? "";
    if ((a === "--to"     || a === "-t") && args[i + 1]) targetLanguage       = args[++i] ?? targetLanguage;
    if ((a === "--from"   || a === "-f") && args[i + 1]) sourceFrameworkHint  = args[++i] ?? "";
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
      "  --yes               Skip cost confirmation and proceed immediately",
      "",
      "Examples:",
      "  /migrate rewrite --repo https://github.com/myorg/DotNetApi --to python --yes",
      "  /migrate rewrite --repo https://github.com/myorg/SpringApp --to typescript --from spring-boot --yes",
      "",
      "Output (in migration/rewrite/):",
      "  context/<Component>.md   — per-component migration context docs",
      "  .claude/commands/        — Claude Code slash commands (copy to your new project)",
      "  AGENTS.md                — Codex agent context file",
      "  HOW-TO-MIGRATE.md        — step-by-step execution guide",
      "  _index.md                — full migration knowledge base",
    ].join("\n");
  }

  const migrationDir = await getMigrationDir();
  const logs: string[] = [];

  try {
    const result = await analyze({
      repoUrl,
      targetLanguage,
      sourceFrameworkHint: sourceFrameworkHint || undefined,
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
      return [
        "### Cost Estimate",
        "",
        ...logs,
        "",
        `Add \`--yes\` to proceed:`,
        `  /migrate rewrite --repo ${repoUrl} --to ${targetLanguage} --yes`,
      ].join("\n");
    }

    const summary = [
      `### Rewrite KB Complete`,
      ``,
      ...logs,
      ``,
      `**Framework:** ${result.frameworkInfo.sourceFramework} (${result.frameworkInfo.sourceLanguage}) → ${result.frameworkInfo.targetFramework} (${result.frameworkInfo.targetLanguage})`,
      `**Components analyzed:** ${result.components.length}`,
      `**Migration order:** ${result.migrationOrder.join(" → ")}`,
    ];

    if (result.unanalyzed.length > 0) {
      summary.push(``, `⚠ Failed: ${result.unanalyzed.join(", ")}`);
    }

    const migDir = await getMigrationDir();
    summary.push(
      ``,
      `**Generated files:**`,
      `- Context docs:      \`${migDir}/rewrite/context/\``,
      `- Claude Code cmds:  \`${migDir}/rewrite/.claude/commands/\`  ← copy to your new project`,
      `- Codex context:     \`${migDir}/rewrite/AGENTS.md\``,
      `- Execution guide:   \`${migDir}/rewrite/HOW-TO-MIGRATE.md\``,
      `- Knowledge base:    \`${migDir}/rewrite/_index.md\``,
      ``,
      `**To start rewriting with Claude Code:**`,
      `1. Scaffold your new ${result.frameworkInfo.targetLanguage} project`,
      `2. Copy \`rewrite/.claude/\` into your new project root`,
      `3. Open Claude Code there and run: \`/project:rewrite-${result.migrationOrder[0] ?? "FirstComponent"}\``,
      `4. Continue in order: ${result.migrationOrder.slice(0, 4).join(" → ")}${result.migrationOrder.length > 4 ? "…" : ""}`,
    );

    return summary.join("\n");
  } catch (e) {
    return `### Rewrite Analysis Failed\n\n${e instanceof Error ? e.message : String(e)}\n\nLogs:\n${logs.join("\n")}`;
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
    case "status":  return handleStatus();
    case "context": return handleContext(rest);
    case "verify":  return handleVerify(rest);
    case "done":    return handleDone(rest);
    case "rescan":  return handleRescan(rest);
    case "plugin":  return handlePlugin(rest);
    default:
      return [
        "### /migrate — Migration Intelligence Platform",
        "",
        "Analyzes legacy codebases and generates AI rewrite context documents.",
        "Actual rewriting is done by Claude Code / Codex using those docs.",
        "",
        "**Subcommands:**",
        "  `/migrate scan --repo <url> --lang <language> [--yes]`       — scan external SOAP services called by a Node.js repo",
        "  `/migrate rewrite --repo <url> --to <language> [--yes]`      — analyze a full codebase for framework-to-framework migration",
        "  `/migrate status`                                              — show migration progress table",
        "  `/migrate context <ServiceName>`                               — print a service context doc",
        "  `/migrate verify <ServiceName> --by <name>`                   — mark a service as human-verified",
        "  `/migrate done <ServiceName>`                                  — mark a verified service as fully rewritten",
        "  `/migrate rescan <ServiceName>`                                — instructions to re-analyze a service",
        "  `/migrate plugin list`                                         — list installed scanner plugins",
        "",
        "**Examples:**",
        "  `/migrate scan --repo https://github.com/myorg/NodeBackend --lang csharp --yes`",
        "  `/migrate rewrite --repo https://github.com/myorg/DotNetApi --to python --yes`",
      ].join("\n");
  }
}
