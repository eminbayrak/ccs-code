import { promises as fs } from "fs";
import { join } from "path";
import { fetchFileContent, fetchFileTree, parseRepoUrl } from "../connectors/github.js";
import { AnthropicProvider } from "../llm/providers/anthropic.js";
import type { GithubConfig } from "./resolver.js";
import type { ComponentAnalysis, FrameworkInfo, RewriteResult } from "./rewriteTypes.js";
import {
  detectFramework,
  discoverComponents,
  analyzeComponent,
  sortByDependency,
} from "./rewriteAnalyzer.js";
import {
  buildRewriteContextDoc,
  buildRewriteIndex,
} from "./rewriteContextBuilder.js";
import { generateRewriteIntegration } from "./aiIntegration.js";
import { estimateScanCost, formatCostPreview } from "./costEstimator.js";

export type RewriteTracerConfig = {
  repoUrl: string;
  targetLanguage: string;
  sourceFrameworkHint?: string;   // optional override for auto-detection
  outputDir: string;
  githubConfig: GithubConfig;
  onProgress?: (msg: string) => void;
  onCostPreview?: (preview: string) => Promise<boolean>;
};

function log(config: RewriteTracerConfig, msg: string) {
  config.onProgress?.(msg);
}

// ---------------------------------------------------------------------------
// Fetch key files used for framework detection
// (project manifests, entry points, first controller/service found)
// ---------------------------------------------------------------------------

const KEY_FILE_PATTERNS = [
  /\.(csproj|sln)$/,
  /Program\.cs$/i,
  /Startup\.cs$/i,
  /pom\.xml$/,
  /build\.gradle$/,
  /package\.json$/,
  /application\.properties$/,
  /appsettings\.json$/i,
];

function isKeyFile(path: string): boolean {
  return KEY_FILE_PATTERNS.some((p) => p.test(path));
}

async function fetchKeyFiles(
  owner: string,
  repo: string,
  tree: string[],
  config: GithubConfig
): Promise<Array<{ path: string; content: string }>> {
  const keyPaths = tree.filter(isKeyFile).slice(0, 6);
  const files: Array<{ path: string; content: string }> = [];
  for (const path of keyPaths) {
    try {
      const content = await fetchFileContent(owner, repo, path, config.token, config.host);
      files.push({ path, content });
    } catch { /* skip */ }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Fetch all source files for a set of file paths
// ---------------------------------------------------------------------------

async function fetchFiles(
  owner: string,
  repo: string,
  paths: string[],
  config: GithubConfig
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const path of paths.slice(0, 8)) {
    try {
      const content = await fetchFileContent(owner, repo, path, config.token, config.host);
      files.push({ path, content });
    } catch { /* skip */ }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Generate a system overview paragraph using Sonnet
// ---------------------------------------------------------------------------

async function generateSystemOverview(
  analyses: ComponentAnalysis[],
  frameworkInfo: FrameworkInfo,
  provider: AnthropicProvider
): Promise<string> {
  if (analyses.length === 0) return "No components analyzed yet.";

  const componentList = analyses
    .map((a) => `- ${a.component.name} (${a.component.type}): ${a.purpose}`)
    .join("\n");

  const response = await provider.chat(
    [
      {
        role: "user",
        content: `Write a 2-3 sentence plain-language overview of this ${frameworkInfo.sourceFramework} system based on its components.
Describe what the system does for the business — not the technology.

Components:
${componentList}

Respond with ONLY the overview paragraph. No headers, no lists.`,
      },
    ],
    "You write clear, concise technical documentation. Respond with plain text only."
  );

  return response.trim();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function analyze(config: RewriteTracerConfig): Promise<RewriteResult> {
  const { repoUrl, targetLanguage, outputDir, githubConfig } = config;

  const haiku  = new AnthropicProvider("claude-haiku-4-5-20251001");
  const sonnet = new AnthropicProvider("claude-sonnet-4-6");

  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error(`Invalid repo URL: ${repoUrl}`);

  const { owner, repo, host } = parsed;
  if (host !== "github.com") githubConfig.host = host;

  const repoBaseUrl = `https://${host}/${owner}/${repo}`;
  const analysisDate = new Date().toISOString().slice(0, 10);

  // --- Fetch file tree ---
  log(config, `Fetching file tree from ${repoUrl}...`);
  let tree: string[] = [];
  try {
    tree = await fetchFileTree(owner, repo, githubConfig.token, githubConfig.host);
  } catch (e) {
    throw new Error(`Could not fetch repo tree: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(config, `Found ${tree.length} files in repo.`);

  // --- Detect framework (Haiku, or use hint if provided) ---
  log(config, "Detecting source framework...");
  const keyFiles = await fetchKeyFiles(owner, repo, tree, githubConfig);
  let frameworkInfo = await detectFramework(tree, keyFiles, targetLanguage, haiku);
  if (config.sourceFrameworkHint) {
    frameworkInfo = { ...frameworkInfo, sourceFramework: config.sourceFrameworkHint };
  }
  log(config, `Detected: ${frameworkInfo.sourceFramework} (${frameworkInfo.sourceLanguage}) → ${frameworkInfo.targetFramework}`);

  // --- Discover components (Haiku) ---
  log(config, "Discovering components...");
  const components = await discoverComponents(tree, frameworkInfo, haiku);
  const nonTestComponents = components.filter((c) => c.type !== "test");
  log(config, `Found ${nonTestComponents.length} components (excluding tests).`);

  if (nonTestComponents.length === 0) {
    return {
      frameworkInfo,
      components: [],
      migrationOrder: [],
      unanalyzed: [],
      errors: ["No components discovered — the repo structure may not match a recognised framework pattern."],
      indexPath: null,
      reportPath: null,
    };
  }

  // --- Cost preview ---
  if (config.onCostPreview) {
    const estimate = estimateScanCost(nonTestComponents.length, keyFiles, 2);
    const preview = formatCostPreview(estimate);
    const confirmed = await config.onCostPreview(preview);
    if (!confirmed) {
      log(config, "Analysis cancelled.");
      return { frameworkInfo, components: [], migrationOrder: [], unanalyzed: [], errors: [], indexPath: null, reportPath: null };
    }
  }

  // --- Analyze each component (Sonnet) ---
  const analyzed: ComponentAnalysis[] = [];
  const unanalyzed: string[] = [];
  const errors: string[] = [];
  const contextDir = join(outputDir, "rewrite", "context");
  await fs.mkdir(contextDir, { recursive: true });

  for (const component of nonTestComponents) {
    log(config, `Analyzing ${component.name} (${component.type})...`);
    try {
      const sourceFiles = await fetchFiles(owner, repo, component.filePaths, githubConfig);
      const analysis = await analyzeComponent(component, sourceFiles, frameworkInfo, sonnet);
      analyzed.push(analysis);

      const doc = buildRewriteContextDoc(analysis, frameworkInfo, repoBaseUrl, analysisDate);
      const docPath = join(contextDir, `${component.name}.md`);
      await fs.writeFile(docPath, doc, "utf-8");

      log(config, `✓ ${component.name} (${analysis.complexity} complexity, ${analysis.confidence} confidence)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${component.name}: ${msg}`);
      unanalyzed.push(component.name);
      log(config, `✗ Failed to analyze ${component.name}: ${msg}`);
    }
  }

  // --- Topological sort ---
  const migrationOrder = sortByDependency(nonTestComponents).filter(
    (name) => !unanalyzed.includes(name)
  );

  // --- System overview + index ---
  log(config, "Generating migration knowledge base index...");
  const overview = await generateSystemOverview(analyzed, frameworkInfo, sonnet);
  const indexContent = buildRewriteIndex(
    analyzed,
    frameworkInfo,
    migrationOrder,
    unanalyzed,
    overview,
    analysisDate,
    repoBaseUrl
  );

  const kbDir = join(outputDir, "rewrite");
  const indexPath = join(kbDir, "_index.md");
  await fs.writeFile(indexPath, indexContent, "utf-8");

  // --- Scan report ---
  const reportPath = join(outputDir, "rewrite", "report.md");
  const report = [
    `# Rewrite Analysis Report`,
    ``,
    `**Repo:** ${repoUrl}`,
    `**Framework:** ${frameworkInfo.sourceFramework} → ${frameworkInfo.targetFramework}`,
    `**Analyzed:** ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Files in repo | ${tree.length} |`,
    `| Components discovered | ${nonTestComponents.length} |`,
    `| Components analyzed | ${analyzed.length} |`,
    `| Failed | ${unanalyzed.length} |`,
    `| Errors | ${errors.length} |`,
    ``,
    errors.length > 0 ? `## Errors\n\n${errors.map((e) => `- ${e}`).join("\n")}\n` : "",
    `## Next Steps`,
    ``,
    `1. Review \`rewrite/_index.md\` for the full migration plan`,
    `2. Rewrite components in the order listed (dependencies first)`,
    `3. For each component, open \`rewrite/context/<ComponentName>.md\` and paste into Claude Code`,
    `4. Verify each rewritten component against the checklist in its context doc`,
  ].join("\n");

  await fs.writeFile(reportPath, report, "utf-8");

  // Generate Claude Code slash commands + AGENTS.md
  log(config, "Generating AI tool integration files...");
  try {
    await generateRewriteIntegration(outputDir, analyzed, frameworkInfo, migrationOrder, repoUrl);
    log(config, `✓ Claude Code commands written to rewrite/.claude/commands/`);
    log(config, `✓ AGENTS.md written for Codex`);
    log(config, `✓ HOW-TO-MIGRATE.md written`);
  } catch (e) {
    errors.push(`ai-integration: ${e instanceof Error ? e.message : String(e)}`);
  }

  log(config, `\nAnalysis complete. ${analyzed.length} components documented, ${unanalyzed.length} failed.`);

  return { frameworkInfo, components: analyzed, migrationOrder, unanalyzed, errors, indexPath, reportPath };
}
