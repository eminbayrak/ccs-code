import { join } from "path";
import { readVaultConfig } from "./vault.js";
import { trace } from "../migration/tracer.js";
import { loadPlugins, listPlugins } from "../migration/pluginLoader.js";
import * as statusTracker from "../migration/statusTracker.js";

// ---------------------------------------------------------------------------
// Resolve the migration output directory from vault config
// ---------------------------------------------------------------------------

async function getMigrationDir(): Promise<string> {
  const cfg = await readVaultConfig();
  if (!cfg.activeVault) throw new Error("No active vault. Run /vault init first.");
  return join(cfg.activeVault, "migration");
}

// ---------------------------------------------------------------------------
// /migrate scan --repo <url> --lang <language> [--org <org>] [--plugin <name>] [--yes]
// ---------------------------------------------------------------------------

async function handleScan(args: string[]): Promise<string> {
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
      "Install a plugin into `.ccs/plugins/<name>/` or `~/.ccs/plugins/<name>/`.",
      "Each plugin folder needs a `ccs-plugin.json` manifest and a compiled `index.js`.",
      "Run `/migrate plugin list` to see what is currently installed.",
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
      onProgress: (msg) => logs.push(msg),
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
  _cwd: string
): Promise<string> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "scan":    return handleScan(rest);
    case "status":  return handleStatus();
    case "context": return handleContext(rest);
    case "verify":  return handleVerify(rest);
    case "done":    return handleDone(rest);
    case "rescan":  return handleRescan(rest);
    case "plugin":  return handlePlugin(rest);
    default:
      return [
        "### /migrate — Migration Context Builder",
        "",
        "Scans a legacy codebase and generates AI rewrite context documents.",
        "",
        "**Subcommands:**",
        "  `/migrate scan --repo <url> --lang <language> [--yes]`  — scan a repo and build the knowledge base",
        "  `/migrate status`                               — show migration progress table",
        "  `/migrate context <ServiceName>`                — print a service context doc",
        "  `/migrate verify <ServiceName> --by <name>`     — mark a service as human-verified",
        "  `/migrate done <ServiceName>`                    — mark a verified service as fully rewritten",
        "  `/migrate rescan <ServiceName>`                  — instructions to re-analyze a service",
        "  `/migrate plugin list`                           — list installed scanner plugins",
        "",
        "**Supported languages:** csharp, typescript, java, python, go",
        "",
        "**Example:**",
        "  `/migrate scan --repo https://github.com/myorg/NodeBackend --lang csharp`",
      ].join("\n");
  }
}
