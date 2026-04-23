import { promises as fs } from "fs";
import { join } from "path";
import {
  fetchFileContent,
  fetchFileTree,
  parseRepoUrl,
} from "../connectors/github.js";
import { AnthropicProvider } from "../llm/providers/anthropic.js";
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

async function fetchRepoFiles(
  owner: string,
  repo: string,
  config: GithubConfig,
  extensions: string[]
): Promise<Array<{ path: string; content: string }>> {
  const tree = await fetchFileTree(owner, repo, config.token, config.host);
  const extSet = new Set(extensions);
  const jsFiles = tree.filter((p) => {
    const ext = p.slice(p.lastIndexOf("."));
    return extSet.has(ext);
  });

  const files: Array<{ path: string; content: string }> = [];
  for (const filePath of jsFiles) {
    try {
      const content = await fetchFileContent(owner, repo, filePath, config.token, config.host);
      files.push({ path: filePath, content });
    } catch {
      // skip unreadable files
    }
  }
  return files;
}

async function fetchServiceFiles(
  repoFullName: string,
  namespace: string,
  config: GithubConfig
): Promise<Array<{ path: string; content: string }>> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return [];

  const tree = await fetchFileTree(owner, repo, config.token, config.host);

  // Find files that likely belong to this namespace
  const nsLower = namespace.toLowerCase();
  const relevant = tree.filter((p) => {
    const name = p.split("/").pop()?.toLowerCase() ?? "";
    return (
      name.includes(nsLower.replace("manager", "")) ||
      name.includes(nsLower) ||
      /\.(cs|asmx|java|vb|py)$/.test(p)
    );
  });

  // Cap at 5 files to stay within token budget
  const toFetch = relevant.slice(0, 5);
  const files: Array<{ path: string; content: string }> = [];

  for (const filePath of toFetch) {
    try {
      const content = await fetchFileContent(owner, repo, filePath, config.token, config.host);
      files.push({ path: `${repoFullName}/${filePath}`, content });
    } catch {
      // skip
    }
  }
  return files;
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

  const haiku = new AnthropicProvider("claude-haiku-4-5-20251001");
  const sonnet = new AnthropicProvider("claude-sonnet-4-6");

  const parsed = parseRepoUrl(entryRepoUrl);
  if (!parsed) throw new Error(`Invalid repo URL: ${entryRepoUrl}`);

  const { owner, repo, host } = parsed;
  if (host !== "github.com") githubConfig.host = host;

  // Init status
  const migStatus = await status.init(migrationDir, entryRepoUrl, targetLanguage);

  log(config, `Fetching file tree from ${entryRepoUrl}...`);
  const entryFiles = await fetchRepoFiles(owner, repo, githubConfig, config.plugin.fileExtensions);
  log(config, `Found ${entryFiles.length} files. Scanning with plugin: ${config.plugin.name}...`);

  // Tier 0 — static scan via plugin
  const scanResult = runPluginScan(entryFiles, config.plugin);
  const allCallSites: ServiceReference[] = scanResult.references;
  const grouped = groupByNamespace(allCallSites);
  const uniqueNamespaces = [...grouped.keys()];

  log(config, `Found ${allCallSites.length} SOAP call sites across ${uniqueNamespaces.length} unique services.`);

  if (uniqueNamespaces.length === 0) {
    const report = await writeScanReport(migrationDir, entryRepoUrl, entryFiles.length, 0, [], [], []);
    return { analyzed: [], unresolved: [], errors: [], indexPath: null, scanReportPath: report };
  }

  // Cost preview
  if (config.onCostPreview) {
    const estimate = estimateScanCost(
      uniqueNamespaces.length,
      entryFiles.slice(0, 5),
      2
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

    log(config, `Resolving ${ns}...`);
    const resolved = await resolveNamespace(ns, githubConfig, haiku);

    if (!resolved) {
      log(config, `⚠ Could not resolve ${ns} — flagging as unresolved.`);
      unresolved.push(ns);
      return;
    }

    log(config, `Analyzing ${ns} from ${resolved.repoFullName}...`);

    try {
      const callSites = grouped.get(ns) ?? [];
      const primary = callSites[0];
      if (!primary) { errors.push(`${ns}: no call site found`); return; }

      const [serviceFiles, wsdl] = await Promise.all([
        fetchServiceFiles(resolved.repoFullName, ns, githubConfig),
        fetchWsdl(resolved.repoFullName, githubConfig),
      ]);

      const analysis = await analyzeService(primary, serviceFiles, wsdl, sonnet);
      analyzed.push(analysis);

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
          // Create a synthetic reference for the nested service
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
      indexPath = await buildIndex(migrationDir, analyzed, finalStatus, unresolved);
      log(config, `✓ System index written to ${indexPath}`);
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
      log(config, `✓ Claude Code commands written to .claude/commands/`);
      log(config, `✓ AGENTS.md written for Codex`);
    } catch (e) {
      errors.push(`ai-integration: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log(config, `\nScan complete. ${analyzed.length} services analyzed, ${unresolved.length} unresolved.`);

  return { analyzed, unresolved, errors, indexPath, scanReportPath: reportPath };
}
