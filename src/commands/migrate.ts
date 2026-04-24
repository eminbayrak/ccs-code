import { join } from "path";
import os from "os";
import { readVaultConfig } from "./vault.js";
import { trace } from "../migration/tracer.js";
import { analyze } from "../migration/rewriteTracer.js";
import { loadPlugins, listPlugins } from "../migration/pluginLoader.js";
import * as statusTracker from "../migration/statusTracker.js";
import { loadConfig } from "../llm/index.js";
import { routeIntent, formatRouterConfirmation } from "../migration/intentRouter.js";
import { analyzeDbStatic, runLiveInterrogation, renderStaticDbSection } from "../migration/dbInterrogator.js";
import { promises as fs } from "fs";

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

async function validateSetup(requireGithub: boolean): Promise<SetupIssue[]> {
  const issues: SetupIssue[] = [];
  const config = await loadConfig();

  // Check Provider-specific keys
  if (config.provider === "anthropic" && !process.env.CCS_ANTHROPIC_API_KEY) {
    issues.push({
      severity: "error",
      message: "CCS_ANTHROPIC_API_KEY is not set. Get a key at https://console.anthropic.com/",
    });
  } else if (config.provider === "openai" && !process.env.CCS_OPENAI_API_KEY) {
    issues.push({
      severity: "error",
      message: "CCS_OPENAI_API_KEY is not set. Get a key at https://platform.openai.com/",
    });
  } else if (config.provider === "gemini" && !process.env.CCS_GEMINI_API_KEY) {
    issues.push({
      severity: "error",
      message: "CCS_GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/",
    });
  } else if (config.provider === "enterprise") {
     if (!process.env.CCS_ENTERPRISE_CLIENT_ID || !process.env.CCS_ENTERPRISE_CLIENT_SECRET) {
        issues.push({
          severity: "error",
          message: "Enterprise credentials (ID/Secret) are missing in .env.",
        });
     }
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

    const summary = [
      `## ✓ Scan Complete`,
      "",
      `**Results:**`,
      `- **Services analyzed:** ${result.analyzed.length}`,
      `- **Unresolved:** ${result.unresolved.length}`,
      `- **Errors:**     ${result.errors.length}`,
    ];

    if (result.indexPath) {
      summary.push(``, `**System index:** \`${result.indexPath}\``);
    }
    if (result.scanReportPath) {
      summary.push(`**Scan report:** \`${result.scanReportPath}\``);
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
      "  migration-contract.json   — machine-readable migration contract for agents",
      "  component-disposition-matrix.md — target architecture landing-zone decisions",
      "  human-questions.md        — decisions to resolve before agent implementation",
      "  .claude/commands/        — Claude Code slash commands (copy to your new project)",
      "  AGENTS.md                — Codex agent context file",
      "  AGENT-INTEGRATION.md     — Codex/Claude/MCP integration guide",
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
      `## ✓ Rewrite KB Complete`,
      "",
      `**Framework:** ${result.frameworkInfo.sourceFramework} (${result.frameworkInfo.sourceLanguage}) → ${result.frameworkInfo.targetFramework} (${result.frameworkInfo.targetLanguage})`,
      `**Components analyzed:** ${result.components.length}`,
      `**Migration order:** ${result.migrationOrder.join(" → ")}`,
    ];

    if (result.unanalyzed.length > 0) {
      summary.push(``, `⚠ **Failed:** ${result.unanalyzed.join(", ")}`);
    }

    const migDir = await getMigrationDir();
    summary.push(
      ``,
      `### Generated Files`,
      `- **Context docs:**      \`${migDir}/rewrite/context/\``,
      `- **Migration contract:** \`${migDir}/rewrite/migration-contract.json\``,
      `- **Disposition matrix:** \`${migDir}/rewrite/component-disposition-matrix.md\``,
      `- **Human questions:**   \`${migDir}/rewrite/human-questions.md\``,
      `- **Claude Code cmds:**  \`${migDir}/rewrite/.claude/commands/\``,
      `- **Codex context:**     \`${migDir}/rewrite/AGENTS.md\``,
      `- **Agent integration:** \`${migDir}/rewrite/AGENT-INTEGRATION.md\``,
      `- **Execution guide:**   \`${migDir}/rewrite/HOW-TO-MIGRATE.md\``,
      `- **Knowledge base:**    \`${migDir}/rewrite/_index.md\``,
      ``,
      `### Next Steps`,
      `1. Review \`rewrite/migration-contract.json\` and \`rewrite/human-questions.md\``,
      `2. Scaffold your new **${result.frameworkInfo.targetFramework}** project`,
      `3. Copy \`rewrite/.claude/\` into your new project root`,
      `4. Run: \`/project:rewrite-${result.migrationOrder[0] ?? "FirstComponent"}\``,
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
    case "db":      return handleDb(rest, onProgress);
    default: {
      // Feature 1: Semantic intent routing — detect natural language migration requests
      const fullInput = [subcommand, ...rest].filter(Boolean).join(" ");
      if (fullInput.trim()) {
        try {
          const decision = await routeIntent(fullInput);
          if (decision) {
            return formatRouterConfirmation(decision);
          }
        } catch { /* routing is best-effort — fall through to help text */ }
      }

      return [
        "### /migrate — Migration Intelligence Platform",
        "",
        "Analyzes legacy codebases and generates AI rewrite context documents.",
        "Actual rewriting is done by Claude Code / Codex using those docs.",
        "",
        "**Tip:** Describe your migration in plain English and the tool will auto-detect your intent.",
        "  e.g. `/migrate I need to convert this .NET repo to Python: https://github.com/org/repo`",
        "",
        "**Subcommands:**",
        "  `/migrate scan --repo <url> --lang <language> [--yes]`       — scan external SOAP services called by a Node.js repo",
        "  `/migrate rewrite --repo <url> --to <language> [--yes]`      — analyze a full codebase for framework-to-framework migration",
        "  `/migrate db --service <name> [--yes]`                       — live database schema extraction (read-only, user-approved)",
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
        "  `/migrate db --service OrderManager --yes`",
      ].join("\n");
    }
  }
}
