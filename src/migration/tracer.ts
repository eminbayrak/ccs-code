import { promises as fs } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import {
  parseRepoUrl,
  checkRateLimit,
} from "../connectors/github.js";
import { createProvider, loadConfig } from "../llm/index.js";
import { runPluginScan, groupByNamespace } from "./scanner.js";
import type { MigratePlugin, ServiceReference } from "./types.js";
import { resolveNamespace } from "./resolver.js";
import type { GithubConfig } from "./resolver.js";
import { analyzeService } from "./analyzer.js";
import type { ServiceAnalysis } from "./analyzer.js";
import { parseWsdl } from "./wsdlParser.js";
import type { WsdlParseResult } from "./wsdlParser.js";
import { buildContextDoc } from "./contextBuilder.js";
import { buildIndex } from "./indexBuilder.js";
import * as status from "./statusTracker.js";
import type { ServiceRecord, MigrationStatus } from "./statusTracker.js";
import { estimateScanCost, formatCostPreview } from "./costEstimator.js";
import { generateScanIntegration } from "./aiIntegration.js";

export type TracerConfig = {
  entryRepoUrl: string;
  targetLanguage: string;
  migrationDir: string;
  githubConfig: GithubConfig;
  plugin: MigratePlugin;
  onProgress?: (msg: string) => void;
  onCostPreview?: (preview: string) => Promise<boolean>;
};

export type TraceResult = {
  analyzed: ServiceAnalysis[];
  unresolved: string[];
  errors: string[];
  indexPath: string | null;
  scanReportPath: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(config: TracerConfig, msg: string) {
  config.onProgress?.(msg);
}

// ---------------------------------------------------------------------------
// Git clone approach — no API rate limits, works for public repos without token
// ---------------------------------------------------------------------------

async function walkDir(
  dir: string,
  extSet: Set<string>,
  base: string,
  out: Array<{ path: string; content: string }>
) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(full, extSet, base, out);
      } else {
        const dot = entry.name.lastIndexOf(".");
        if (dot === -1) return;
        const ext = entry.name.slice(dot);
        if (!extSet.has(ext)) return;
        try {
          const content = await fs.readFile(full, "utf-8");
          out.push({ path: full.slice(base.length + 1), content });
        } catch { /* skip unreadable files */ }
      }
    })
  );
}

// Build an HTTPS clone URL, embedding the token so git never needs to prompt.
// GIT_TERMINAL_PROMPT=0 ensures git fails immediately if credentials are wrong
// rather than hanging waiting for interactive input.
function buildCloneUrl(repoUrl: string, token?: string): string {
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== "https:") {
      // Convert SSH (git@github.com:owner/repo.git) → HTTPS
      const m = repoUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);
      if (m) return token
        ? `https://oauth2:${token}@${m[1]}/${m[2]}.git`
        : `https://${m[1]}/${m[2]}.git`;
    }
    if (token) {
      u.username = "oauth2";
      u.password = token;
    }
    return u.toString();
  } catch {
    return repoUrl;
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",      // never prompt for credentials
  GIT_SSH_COMMAND: "false",       // refuse SSH — force HTTPS
};

// Clone a repo once to a persistent path under migrationDir/repos/.
// On subsequent calls for the same repo, the existing clone is reused — no re-cloning.
async function cloneRepoOnce(
  repoFullName: string,
  config: GithubConfig,
  migrationDir: string,
  onLog?: (msg: string) => void,
): Promise<string | null> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;

  const repoDir = join(migrationDir, "repos", owner, repo);

  // Already cloned — reuse without any network call
  try {
    await fs.access(join(repoDir, ".git"));
    onLog?.(`  Reusing cached clone: ${owner}/${repo}`);
    return repoDir;
  } catch { /* not yet cloned */ }

  await fs.mkdir(repoDir, { recursive: true });
  const host = config.host ?? "github.com";
  const cloneUrl = buildCloneUrl(`https://${host}/${repoFullName}`, config.token);

  onLog?.(`  Cloning ${repoFullName}...`);
  try {
    execSync(`git clone --depth 1 --single-branch --quiet '${cloneUrl}' '${repoDir}'`, {
      env: GIT_ENV,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 120_000,
    });
    return repoDir;
  } catch (e) {
    onLog?.(`  Clone failed: ${e instanceof Error ? e.message : String(e)}`);
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

// Read service implementation files from a pre-cloned repo directory.
// Selects the primary implementation file + closely related files (contracts, models, WSDL).
// Reads full file content from disk — no size limits, no API calls.
async function readServiceFilesFromClone(
  repoDir: string,
  namespace: string,
): Promise<Array<{ path: string; content: string }>> {
  const nsLower = namespace.toLowerCase();
  const baseName = nsLower.replace("manager", "").replace("service", "");
  const implExtensions = /\.(cs|vb|cls|bas|java|py|asmx)$/;

  function pickFiles(tree: string[]): string[] {
    const exact = tree.filter((p) => {
      const fileName = p.split("/").pop() ?? "";
      const fileLower = fileName.toLowerCase();
      if (/^i[A-Z]/.test(fileName)) return false;
      if (/test|mock|spec|stub/i.test(p)) return false;
      return (
        fileLower === `${nsLower}.cs` || fileLower === `${nsLower}.vb` ||
        fileLower === `${nsLower}.cls` || fileLower === `${nsLower}.java` ||
        fileLower === `${nsLower}.py` || fileLower === `${nsLower}.bas` ||
        fileLower === `${nsLower}.asmx.cs`
      );
    });
    const supplementary = tree.filter((p) => {
      const fileName = p.split("/").pop() ?? "";
      const fileLower = fileName.toLowerCase();
      if (/^i[A-Z]/.test(fileName)) return false;
      if (/test|mock|spec|stub/i.test(p)) return false;
      if (exact.includes(p)) return false;
      return (
        p.endsWith(".wsdl") || p.endsWith(".wsml") ||
        (implExtensions.test(p) && (fileLower.includes(baseName) || fileLower.includes(nsLower)))
      );
    });
    return [...exact, ...supplementary].slice(0, 8);
  }

  const allPaths: string[] = [];
  async function collectPaths(dir: string) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await collectPaths(full);
      else allPaths.push(full.slice(repoDir.length + 1));
    }
  }
  await collectPaths(repoDir);

  const toRead = pickFiles(allPaths);
  const result: Array<{ path: string; content: string }> = [];
  for (const p of toRead) {
    try {
      const content = await fs.readFile(join(repoDir, p), "utf-8");
      result.push({ path: p, content });
    } catch { /* skip unreadable */ }
  }
  return result;
}

// Find and parse the first WSDL/XSD in a cloned repo directory — zero API calls.
async function findWsdlInClone(repoDir: string): Promise<WsdlParseResult | null> {
  const wsdlPaths: string[] = [];

  async function findWsdl(dir: string) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await findWsdl(full);
      else if (e.name.endsWith(".wsdl") || e.name.endsWith(".xsd")) wsdlPaths.push(full);
    }
  }

  try {
    await findWsdl(repoDir);
    if (wsdlPaths.length === 0) return null;
    const content = await fs.readFile(wsdlPaths[0]!, "utf-8");
    return parseWsdl(content);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write scan report
// ---------------------------------------------------------------------------

async function writeScanReport(
  migrationDir: string,
  entryRepo: string,
  filesScanned: number,
  callSitesFound: number,
  resolved: ServiceAnalysis[],
  unresolved: string[],
  errors: string[]
): Promise<string> {
  const reportPath = join(migrationDir, "scan-report.md");
  const lines = [
    `# Scan Report`,
    ``,
    `**Entry repo:** ${entryRepo}`,
    `**Scanned:** ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Files scanned | ${filesScanned} |`,
    `| SOAP call sites found | ${callSitesFound} |`,
    `| Unique services discovered | ${resolved.length + unresolved.length} |`,
    `| Fully analyzed | ${resolved.length} |`,
    `| Unresolved (manual input needed) | ${unresolved.length} |`,
    `| Errors during analysis | ${errors.length} |`,
    ``,
  ];

  if (unresolved.length > 0) {
    lines.push(`## Unresolved Services`, ``);
    for (const ns of unresolved) {
      lines.push(`- \`${ns}\` — no matching repo found in org. Provide the repo URL manually.`);
    }
    lines.push(``);
  }

  if (errors.length > 0) {
    lines.push(`## Errors`, ``);
    for (const e of errors) lines.push(`- ${e}`);
    lines.push(``);
  }

  lines.push(
    `## Next Steps`,
    ``,
    `1. Review unresolved services above and provide repo URLs if known`,
    `2. Run \`/migrate verify <ServiceName>\` for each analyzed service before rewriting`,
    `3. Start rewriting shared dependencies first (see \`knowledge-base/_index.md\`)`,
    ``
  );

  await fs.writeFile(reportPath, lines.join("\n"), "utf-8");
  return reportPath;
}

// ---------------------------------------------------------------------------
// Main tracer — entry point
// ---------------------------------------------------------------------------

export async function trace(config: TracerConfig): Promise<TraceResult> {
  const {
    entryRepoUrl,
    targetLanguage,
    migrationDir,
    githubConfig,
  } = config;

  const haiku = await createProvider("flash");
  const sonnet = await createProvider("pro");

  const parsed = parseRepoUrl(entryRepoUrl);
  if (!parsed) throw new Error(`Invalid repo URL: ${entryRepoUrl}`);

  const { owner, repo, host } = parsed;
  if (host !== "github.com") githubConfig.host = host;

  // Init status
  const migStatus = await status.init(migrationDir, entryRepoUrl, targetLanguage);

  // Check GitHub API rate limit up front so the user understands any slowness
  const rl = checkRateLimit();
  if (rl) {
    const d = rl.resetAt;
    const hh   = String(d.getHours()).padStart(2, "0");
    const mm   = String(d.getMinutes()).padStart(2, "0");
    const mo   = String(d.getMonth() + 1).padStart(2, "0");
    const dd   = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    const resetStr = `${hh}:${mm} - ${mo}-${dd}-${yyyy}`;

    if (rl.isExhausted) {
      log(config, `⚠ GitHub API rate limit reached — ${rl.limit - rl.remaining}/${rl.limit} requests used`);
      log(config, `  Resets at ${resetStr} (in ${rl.resetInMinutes} min)`);
      log(config, `  Continuing scan using git clone — no rate limit on file fetching`);
    } else if (rl.remaining < 200) {
      log(config, `⚠ GitHub API low — ${rl.remaining} requests left, resets at ${resetStr}`);
    }
  }

  // Clone entry repo once into the migration workspace — reused on re-runs
  const entryCloneDir = await cloneRepoOnce(
    `${owner}/${repo}`, githubConfig, migrationDir, (msg) => log(config, msg)
  );
  if (!entryCloneDir) throw new Error(`Failed to clone entry repo: ${entryRepoUrl}`);

  const extSet = new Set(config.plugin.fileExtensions);
  const entryFiles: Array<{ path: string; content: string }> = [];
  await walkDir(entryCloneDir, extSet, entryCloneDir, entryFiles);

  log(config, `Found ${entryFiles.length} source files → ${entryFiles.slice(0, 8).map(f => f.path.split("/").pop()).join(", ")}${entryFiles.length > 8 ? "..." : ""}`);
  log(config, `Running plugin: ${config.plugin.name}...`);

  // Tier 0 — static scan via plugin
  const scanResult = runPluginScan(entryFiles, config.plugin);
  const allCallSites: ServiceReference[] = scanResult.references;
  const grouped = groupByNamespace(allCallSites);
  const uniqueNamespaces = [...grouped.keys()];

  for (const [ns, sites] of grouped.entries()) {
    const methods = [...new Set(sites.map(s => s.methodName))].join(", ");
    log(config, `  ◆ ${ns} — ${sites.length} call site${sites.length > 1 ? "s" : ""} (${methods})`);
  }
  log(config, `Found ${allCallSites.length} SOAP call sites across ${uniqueNamespaces.length} services.`);


  if (uniqueNamespaces.length === 0) {
    const report = await writeScanReport(migrationDir, entryRepoUrl, entryFiles.length, 0, [], [], []);
    return { analyzed: [], unresolved: [], errors: [], indexPath: null, scanReportPath: report };
  }

  // Cost preview
  if (config.onCostPreview) {
    const configData = await loadConfig();
    const estimate = estimateScanCost(
      uniqueNamespaces.length,
      entryFiles.slice(0, 5),
      2,
      configData.provider
    );
    const preview = formatCostPreview(estimate);
    const confirmed = await config.onCostPreview(preview);
    if (!confirmed) {
      log(config, "Scan cancelled.");
      return { analyzed: [], unresolved: [], errors: [], indexPath: null, scanReportPath: null };
    }
  }

  // Register all discovered services in status tracker
  for (const ns of uniqueNamespaces) {
    const sites = grouped.get(ns)!;
    const primary = sites[0];
    if (!primary) continue;
    await status.upsertService(migrationDir, {
      name: ns.replace("Manager", "Service"),
      namespace: ns,
      discoveredVia: `${primary.callerFile}:${primary.lineNumber}`,
      sourceRepo: "",
      sourceFile: "",
      contextDoc: "",
      status: "discovered",
      confidence: "unknown",
      analyzedAt: null,
      gitSha: null,
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
      rewrittenAt: null,
      databaseInteractions: [],
      nestedServices: [],
      notes: "",
    });
  }

  // Tier 1 + 2 — resolve and analyze
  const analyzed: ServiceAnalysis[] = [];
  const unresolved: string[] = [];
  const errors: string[] = [];

  const visited = new Set<string>();

  async function processNamespace(ns: string) {
    if (visited.has(ns)) return;
    visited.add(ns);

    // Skip if already analyzed (idempotency)
    if (await status.isAnalyzed(migrationDir, ns)) {
      log(config, `Skipping ${ns} — already analyzed.`);
      return;
    }

    log(config, `AI Research: Resolving ${ns}...`);
    const sites = grouped.get(ns) ?? [];
    const methodName = sites[0]?.methodName;

    let resolved: Awaited<ReturnType<typeof resolveNamespace>>;
    try {
      resolved = await resolveNamespace(
        ns, githubConfig, haiku, entryRepoUrl, methodName,
        (msg) => log(config, `  ${msg}`),
        migrationDir,
        entryCloneDir ?? undefined,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
        if (msg.includes("daily") || msg.includes("quota exceeded") || msg.includes("plan and billing")) {
          log(config, `✗ LLM ranking quota exhausted. Please switch models or try again tomorrow.`);
          unresolved.push(ns);
          return;
        }
        log(config, `⚠ LLM burst limit hit during ranking. Waiting 30s...`);
        await new Promise(r => setTimeout(r, 30_000));
      }
      throw e;
    }

    if (!resolved) {
      log(config, `✗ Could not resolve ${ns} — timed out or not found`);
      unresolved.push(ns);
      return;
    }

    log(config, `  → ${resolved.repoFullName} / ${resolved.filePath} (${resolved.confidence})`);

    try {
      const callSites = grouped.get(ns) ?? [];
      const primary = callSites[0];
      if (!primary) { errors.push(`${ns}: no call site found`); return; }

      // Clone the service repo once — reuses existing clone if already fetched
      log(config, `AI Analysis: Cloning ${resolved.repoFullName}...`);
      const svcCloneDir = await cloneRepoOnce(
        resolved.repoFullName, githubConfig, migrationDir, (m) => log(config, `  ${m}`)
      );

      // Read ALL implementation files from local clone — no size limits, no API calls
      log(config, `AI Analysis: Reading ${ns} implementation...`);
      const [serviceFiles, wsdl] = await Promise.all([
        svcCloneDir ? readServiceFilesFromClone(svcCloneDir, ns) : Promise.resolve([]),
        svcCloneDir ? findWsdlInClone(svcCloneDir) : Promise.resolve(null),
      ]);

      if (serviceFiles.length > 0) {
        for (const f of serviceFiles) {
          const lines = f.content.split("\n").length;
          log(config, `  Read: ${f.path} (${lines} lines)`);
        }
      }
      if (wsdl) {
        log(config, `  Read: WSDL — ${wsdl.operations?.length ?? 0} operations`);
      }

      log(config, `AI Analysis: Analyzing ${ns} with LLM...`);
      let analysis: ServiceAnalysis | null = null;
      try {
        analysis = await analyzeService(primary, serviceFiles, wsdl, sonnet);
      } catch (llmErr) {
        const llmMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
        if (llmMsg.includes("429") || llmMsg.includes("RESOURCE_EXHAUSTED") || llmMsg.includes("quota") || llmMsg.includes("rate_limit_exceeded")) {
          log(config, `  ⚠ Pro model quota exceeded, retrying with Flash...`);
          try {
            analysis = await analyzeService(primary, serviceFiles, wsdl, haiku);
          } catch {
            // Both models quota-exceeded — write stub so user has something
          }
        } else {
          throw llmErr;
        }
      }

      // If LLM quota exhausted on both models, build a stub from raw files
      if (!analysis) {
        log(config, `  ⚠ Both models quota-exceeded — writing partial context for ${ns}`);
        analysis = {
          namespace: ns,
          methodName: primary.methodName,
          callerFile: primary.callerFile,
          callerLine: primary.lineNumber,
          purpose: "unknown — LLM quota exceeded during analysis",
          dataFlow: "unknown",
          allMethods: [],
          businessRules: [],
          errorHandling: [],
          statusValues: [],
          databaseInteractions: [],
          nestedServiceCalls: [],
          inputContract: {},
          outputContract: {},
          confidence: "low",
          unknownFields: ["purpose", "dataFlow", "allMethods", "businessRules"],
          rawFiles: serviceFiles.map((f) => f.path),
        };
      }

      analyzed.push(analysis);

      // Log extracted results inline
      log(config, `  Methods: ${analysis.allMethods.length > 0 ? analysis.allMethods.map(m => m.name).join(", ") : "unknown"}`);
      if (analysis.businessRules.length > 0) {
        log(config, `  Rules: ${analysis.businessRules.length} extracted`);
      }
      if (analysis.databaseInteractions.length > 0) {
        log(config, `  DB: ${analysis.databaseInteractions.map(d => d.split("—")[0]?.trim()).join(" · ")}`);
      }
      if (analysis.nestedServiceCalls.length > 0) {
        log(config, `  Calls: ${analysis.nestedServiceCalls.join(", ")}`);
      }

      // Write context doc
      const contextDir = join(migrationDir, "context");
      await fs.mkdir(contextDir, { recursive: true });

      const repoBaseUrl = `https://${githubConfig.host ?? "github.com"}/${resolved.repoFullName}`;
      const doc = buildContextDoc({
        analysis,
        resolved,
        targetLanguage,
        repoBaseUrl,
        analysisDate: new Date().toISOString().slice(0, 10),
      });

      const docPath = join(contextDir, `${analysis.namespace}.md`);
      await fs.writeFile(docPath, doc, "utf-8");
      log(config, `  Written: context/${analysis.namespace}.md`);

      // Checkpoint
      const svcRecord: ServiceRecord = {
        name: ns.replace("Manager", "Service"),
        namespace: ns,
        discoveredVia: `${primary.callerFile}:${primary.lineNumber}`,
        sourceRepo: resolved.repoFullName,
        sourceFile: resolved.filePath,
        contextDoc: docPath,
        status: "analyzed",
        confidence: analysis.confidence,
        analyzedAt: new Date().toISOString(),
        gitSha: null,
        verified: false,
        verifiedBy: null,
        verifiedAt: null,
        rewrittenAt: null,
        databaseInteractions: analysis.databaseInteractions,
        nestedServices: analysis.nestedServiceCalls,
        notes: analysis.unknownFields.length > 0 ? `Unknown fields: ${analysis.unknownFields.join(", ")}` : "",
      };
      await status.upsertService(migrationDir, svcRecord);

      log(config, `✓ ${ns} analyzed (confidence: ${analysis.confidence})`);

      // Recurse into nested services (skip placeholder values the LLM emits when uncertain)
      const SKIP_NS = new Set(["unknown", "none", "n/a", "null", "undefined"]);
      for (const nested of analysis.nestedServiceCalls) {
        const nestedNs = nested.split(".")[0];
        if (nestedNs && !visited.has(nestedNs) && !SKIP_NS.has(nestedNs.toLowerCase())) {
          const nestedSite: ServiceReference = {
            callerFile: resolved.filePath,
            lineNumber: 0,
            serviceNamespace: nestedNs,
            methodName: nested.split(".")[1] ?? "unknown",
            metadata: {},
          };
          if (!grouped.has(nestedNs)) {
            grouped.set(nestedNs, [nestedSite]);
          }
          await processNamespace(nestedNs);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${ns}: ${msg}`);
      // Log concise error summary for the UI
      let summary = msg;
      if (msg.includes("429")) summary = "LLM Quota Exceeded";
      else if (msg.includes("403")) summary = "GitHub Rate Limit";
      log(config, `✗ Failed: ${ns} (${summary})`);
    }
  }

  for (const ns of uniqueNamespaces) {
    await processNamespace(ns);
  }

  // Load final status for index builder
  const finalStatusOrNull = await status.load(migrationDir);
  if (!finalStatusOrNull) throw new Error("Migration status file missing after scan — this is a bug.");
  const finalStatus: MigrationStatus = finalStatusOrNull;

  // Build system index — try pro model, fall back to flash on quota error
  let indexPath: string | null = null;
  if (analyzed.length > 0) {
    try {
      try {
        indexPath = await buildIndex(migrationDir, analyzed, finalStatus, unresolved, sonnet);
      } catch (indexErr) {
        const indexMsg = indexErr instanceof Error ? indexErr.message : String(indexErr);
        if (indexMsg.includes("429") || indexMsg.includes("RESOURCE_EXHAUSTED") || indexMsg.includes("quota")) {
          log(config, `  ⚠ Pro model quota exceeded for index, retrying with Flash...`);
          indexPath = await buildIndex(migrationDir, analyzed, finalStatus, unresolved, haiku);
        } else {
          throw indexErr;
        }
      }
      log(config, `✓ Written: knowledge-base/_index.md`);
    } catch (e) {
      errors.push(`index: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Write scan report
  const reportPath = await writeScanReport(
    migrationDir,
    entryRepoUrl,
    entryFiles.length,
    allCallSites.length,
    analyzed,
    unresolved,
    errors
  );

  // Generate Claude Code slash commands + AGENTS.md
  if (analyzed.length > 0) {
    try {
      await generateScanIntegration(migrationDir, analyzed, targetLanguage, entryRepoUrl);
      log(config, `✓ Written: .claude/commands/ (Claude Code slash commands)`);
      log(config, `✓ Written: AGENTS.md (Codex instructions)`);
    } catch (e) {
      errors.push(`ai-integration: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const analyzedCount = analyzed.length;
  const errorCount = errors.length;
  const unresolvedCount = unresolved.length;

  // Final completion heartbeat
  log(config, `✓ Scan complete: ${analyzedCount} services analyzed.`);

  return { analyzed, unresolved, errors, indexPath, scanReportPath: reportPath };
}
