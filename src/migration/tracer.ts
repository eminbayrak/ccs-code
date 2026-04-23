import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import { execSync } from "child_process";
import {
  fetchFileContent,
  fetchFileTree,
  parseRepoUrl,
  hasGhCliAvailable,
  checkRateLimit,
} from "../connectors/github.js";
import { createProvider, loadConfig } from "../llm/index.js";
import { runPluginScan, groupByNamespace } from "./scanner.js";
import type { MigratePlugin, ServiceReference } from "./types.js";
import { resolveNamespace, findWsdlFiles } from "./resolver.js";
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

async function cloneAndReadFiles(
  repoUrl: string,
  extensions: string[],
  token?: string,
  onLog?: (msg: string) => void
): Promise<{ files: Array<{ path: string; content: string }>; tmpDir: string }> {
  const tmpDir = join(os.tmpdir(), `ccs-scan-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  const parsed = parseRepoUrl(repoUrl);
  const slug   = parsed ? `${parsed.owner}/${parsed.repo}` : repoUrl;
  const cloneUrl = buildCloneUrl(repoUrl, token);

  onLog?.(`Cloning ${slug} via HTTPS...`);
  execSync(
    `git clone --depth 1 --single-branch --quiet '${cloneUrl}' '${tmpDir}'`,
    { env: GIT_ENV, stdio: ["ignore", "ignore", "ignore"], timeout: 120_000 }
  );

  const extSet = new Set(extensions);
  const files: Array<{ path: string; content: string }> = [];
  await walkDir(tmpDir, extSet, tmpDir, files);
  return { files, tmpDir };
}

async function fetchRepoFiles(
  owner: string,
  repo: string,
  config: GithubConfig,
  extensions: string[],
  repoUrl?: string,
  onLog?: (msg: string) => void
): Promise<{ files: Array<{ path: string; content: string }>; tmpDir: string | null }> {
  // Prefer git clone — no API rate limits, no SSH prompts
  if (repoUrl) {
    try {
      return await cloneAndReadFiles(repoUrl, extensions, config.token, onLog);
    } catch (e) {
      onLog?.(`Clone failed (${e instanceof Error ? e.message : String(e)}), trying API...`);
    }
  }

  // API fallback
  const tree = await fetchFileTree(owner, repo, config.token, config.host);
  const extSet = new Set(extensions);
  const matching = tree.filter((p) => {
    const dot = p.lastIndexOf(".");
    return dot !== -1 && extSet.has(p.slice(dot));
  });
  const results = await Promise.all(
    matching.map(async (filePath) => {
      try {
        const content = await fetchFileContent(owner, repo, filePath, config.token, config.host);
        return { path: filePath, content };
      } catch {
        return null;
      }
    })
  );
  return {
    files: results.filter((r): r is { path: string; content: string } => r !== null),
    tmpDir: null,
  };
}

async function fetchServiceFiles(
  repoFullName: string,
  namespace: string,
  config: GithubConfig
): Promise<Array<{ path: string; content: string }>> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return [];

  const nsLower = namespace.toLowerCase();
  const baseName = nsLower.replace("manager", "").replace("service", "");
  const implExtensions = /\.(cs|vb|cls|bas|java|py|asmx)$/;

  // Filter function applied to a list of file paths
  function pickFiles(tree: string[]): string[] {
    const exact = tree.filter((p) => {
      const fileName = p.split("/").pop() ?? "";
      const fileLower = fileName.toLowerCase();
      if (/^i[A-Z]/.test(fileName)) return false;
      if (/test|mock|spec|stub/i.test(p)) return false;
      return fileLower === `${nsLower}.cs` || fileLower === `${nsLower}.vb` ||
        fileLower === `${nsLower}.cls` || fileLower === `${nsLower}.java` ||
        fileLower === `${nsLower}.py` || fileLower === `${nsLower}.bas` ||
        fileLower === `${nsLower}.asmx.cs`;
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
    return [...exact, ...supplementary].slice(0, 6);
  }

  // Clone via HTTPS to avoid SSH passphrase prompts and API rate limits
  const host = config.host ?? "github.com";
  const repoUrl = `https://${host}/${repoFullName}`;
  try {
    const tmpDir = join(os.tmpdir(), `ccs-svc-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const cloneUrl = buildCloneUrl(repoUrl, config.token);
    execSync(`git clone --depth 1 --single-branch --quiet '${cloneUrl}' '${tmpDir}'`, {
      env: GIT_ENV, stdio: ["ignore", "ignore", "ignore"], timeout: 90_000,
    });

    // Build a tree from local filesystem
    const localFiles: string[] = [];
    async function collectPaths(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await collectPaths(full);
        else localFiles.push(full.slice(tmpDir.length + 1));
      }
    }
    await collectPaths(tmpDir);

    const toRead = pickFiles(localFiles);
    const result: Array<{ path: string; content: string }> = [];
    for (const p of toRead) {
      try {
        const content = await fs.readFile(join(tmpDir, p), "utf-8");
        result.push({ path: p, content });
      } catch { /* skip */ }
    }
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return result;
  } catch {
    // Fall back to API
  }

  // API fallback
  try {
    const tree = await fetchFileTree(owner, repo, config.token, config.host);
    const toFetch = pickFiles(tree);
    const files: Array<{ path: string; content: string }> = [];
    for (const filePath of toFetch) {
      try {
        const content = await fetchFileContent(owner, repo, filePath, config.token, config.host);
        files.push({ path: filePath, content });
      } catch { /* skip */ }
    }
    return files;
  } catch {
    return [];
  }
}

async function fetchWsdl(
  repoFullName: string,
  config: GithubConfig
): Promise<WsdlParseResult | null> {
  const wsdlFiles = await findWsdlFiles(repoFullName, config);
  if (wsdlFiles.length === 0) return null;

  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;

  try {
    const content = await fetchFileContent(owner, repo, wsdlFiles[0] ?? "", config.token, config.host);
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

  let clonedTmpDir: string | null = null;
  let entryFiles: Array<{ path: string; content: string }>;

  try {
    const result = await fetchRepoFiles(
      owner, repo, githubConfig, config.plugin.fileExtensions,
      entryRepoUrl, (msg) => log(config, msg)
    );
    entryFiles = result.files;
    clonedTmpDir = result.tmpDir;
  } catch (e) {
    throw new Error(`Failed to fetch repo files: ${e instanceof Error ? e.message : String(e)}`);
  }

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

  // Clean up clone after scan phase is done
  if (clonedTmpDir) {
    fs.rm(clonedTmpDir, { recursive: true, force: true }).catch(() => {});
    clonedTmpDir = null;
  }

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

    // Heartbeat — emit a dot every 10s so the UI doesn't look frozen
    let heartbeatSecs = 0;
    const heartbeat = setInterval(() => {
      heartbeatSecs += 10;
      log(config, `  Searching GitHub for ${ns}... (${heartbeatSecs}s)`);
    }, 10_000);

    // Hard timeout — never hang more than 60s per service
    const RESOLVE_TIMEOUT_MS = 60_000;
    let resolved: Awaited<ReturnType<typeof resolveNamespace>>;
    try {
      const timeoutPromise = new Promise<null>((res) =>
        setTimeout(() => res(null), RESOLVE_TIMEOUT_MS)
      );
      resolved = await Promise.race([
        resolveNamespace(
          ns, githubConfig, haiku, entryRepoUrl, methodName,
          (toolMsg) => log(config, `  ${toolMsg}`),
        ),
        timeoutPromise,
      ]);
    } finally {
      clearInterval(heartbeat);
    }

    if (!resolved) {
      log(config, `✗ Could not find ${ns} — timed out or not found in org`);
      unresolved.push(ns);
      return;
    }

    log(config, `  → ${resolved.repoFullName} / ${resolved.filePath} (${resolved.confidence})`);
    log(config, `AI Analysis: Reading ${ns} implementation...`);

    try {
      const callSites = grouped.get(ns) ?? [];
      const primary = callSites[0];
      if (!primary) { errors.push(`${ns}: no call site found`); return; }

      const [serviceFiles, wsdl] = await Promise.all([
        fetchServiceFiles(resolved.repoFullName, ns, githubConfig),
        fetchWsdl(resolved.repoFullName, githubConfig),
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
      const analysis = await analyzeService(primary, serviceFiles, wsdl, sonnet);
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

      // Recurse into nested services
      for (const nested of analysis.nestedServiceCalls) {
        const nestedNs = nested.split(".")[0];
        if (nestedNs && !visited.has(nestedNs)) {
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
      log(config, `✗ Failed to analyze ${ns}: ${msg}`);
    }
  }

  for (const ns of uniqueNamespaces) {
    await processNamespace(ns);
  }

  // Load final status for index builder
  const finalStatusOrNull = await status.load(migrationDir);
  if (!finalStatusOrNull) throw new Error("Migration status file missing after scan — this is a bug.");
  const finalStatus: MigrationStatus = finalStatusOrNull;

  // Build system index
  let indexPath: string | null = null;
  if (analyzed.length > 0) {
    try {
      indexPath = await buildIndex(migrationDir, analyzed, finalStatus, unresolved, sonnet);
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

  log(config, `Scan complete. ${analyzed.length} services analyzed, ${unresolved.length} unresolved.`);

  return { analyzed, unresolved, errors, indexPath, scanReportPath: reportPath };
}
