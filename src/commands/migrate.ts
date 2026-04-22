import { join } from "path";
import * as readline from "readline";
import { readVaultConfig } from "./vault.js";
import { trace } from "../migration/tracer.js";
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
// Interactive y/n prompt (non-TTY falls back to true for pipeline use)
// ---------------------------------------------------------------------------

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + " [y/n] ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ---------------------------------------------------------------------------
// /migrate scan --repo <url> --lang <language>
// ---------------------------------------------------------------------------

async function handleScan(args: string[]): Promise<string> {
  // Parse --repo and --lang from args
  let repoUrl = "";
  let lang = "csharp";
  let org = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo" && args[i + 1]) repoUrl = args[++i] ?? "";
    if (args[i] === "--lang" && args[i + 1]) lang = args[++i] ?? lang;
    if (args[i] === "--org" && args[i + 1]) org = args[++i] ?? "";
  }

  if (!repoUrl) {
    return [
      "Usage: /migrate scan --repo <github-url> --lang <language> [--org <org-name>]",
      "",
      "Examples:",
      "  /migrate scan --repo https://github.com/myorg/NodeBackend --lang csharp",
      "  /migrate scan --repo https://github.com/myorg/SoapServices --lang typescript",
      "",
      "Languages: csharp, typescript, java, python, go",
    ].join("\n");
  }

  // Infer org from repo URL if not provided
  if (!org) {
    const parts = repoUrl.replace(/https?:\/\/[^/]+\//, "").split("/");
    org = parts[0] ?? "";
  }

  const migrationDir = await getMigrationDir();
  const logs: string[] = [];

  try {
    const result = await trace({
      entryRepoUrl: repoUrl,
      targetLanguage: lang,
      migrationDir,
      githubConfig: {
        org,
        token: process.env.CCS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PRIVATE_TOKEN,
      },
      onProgress: (msg) => logs.push(msg),
      onCostPreview: async (preview) => {
        logs.push(preview);
        return confirm("Proceed with scan?");
      },
    });

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

  if (svc.confidence === "low") {
    return [
      checklist,
      ``,
      `⚠ This service has LOW confidence — review the context doc carefully before verifying.`,
      `Context doc: ${svc.contextDoc}`,
      ``,
      `To verify: /migrate verify ${name} --by <your-name>`,
    ].join("\n");
  }

  const verifiedBy = args.find((_, i) => args[i - 1] === "--by") ?? "unknown";
  if (!args.includes("--by")) {
    return [
      checklist,
      ``,
      `To confirm verification, run:`,
      `  /migrate verify ${name} --by <your-name>`,
    ].join("\n");
  }

  const ok = await statusTracker.markVerified(migrationDir, svc.namespace, verifiedBy);
  if (ok) {
    return `✓ ${svc.name} verified by ${verifiedBy}. Status updated to in-progress.`;
  }
  return `Failed to update verification status.`;
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
    case "rescan":  return handleRescan(rest);
    default:
      return [
        "### /migrate — Migration Context Builder",
        "",
        "Scans a legacy codebase and generates AI rewrite context documents.",
        "",
        "**Subcommands:**",
        "  `/migrate scan --repo <url> --lang <language>`  — scan a repo and build the knowledge base",
        "  `/migrate status`                               — show migration progress table",
        "  `/migrate context <ServiceName>`                — print a service context doc",
        "  `/migrate verify <ServiceName> --by <name>`     — mark a service as human-verified",
        "  `/migrate rescan <ServiceName>`                  — instructions to re-analyze a service",
        "",
        "**Supported languages:** csharp, typescript, java, python, go",
        "",
        "**Example:**",
        "  `/migrate scan --repo https://github.com/myorg/NodeBackend --lang csharp`",
      ].join("\n");
  }
}
