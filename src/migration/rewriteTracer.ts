import { promises as fs } from "fs";
import { basename, join, resolve } from "path";
import { fetchDefaultBranch, fetchFileContent, fetchFileTree, parseRepoUrl } from "../connectors/github.js";
import { createProvider, createVerifierProvider, type LLMProvider, loadConfig } from "../llm/index.js";
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
} from "./rewriteContextBuilder.js";
import { generateRewriteIntegration } from "./aiIntegration.js";
import { estimateScanCost, formatCostPreview } from "./costEstimator.js";
import {
  buildArchitectureBaselineDoc,
  buildPreflightReadinessReport,
  formatModernizationContextForPrompt,
  loadModernizationContext,
} from "./modernizationContext.js";
import {
  loadPriorReverseEngineeringContext,
  writeReverseEngineeringArtifacts,
} from "./reverseEngineeringArtifacts.js";
import {
  buildVerificationSummary,
  verifyComponent,
  type ComponentVerification,
} from "./rewriteVerifier.js";
import { buildRunLayout, type RunLayout } from "./runLayout.js";
import { writeDashboard } from "./webDashboard.js";
import {
  isSecurityManifest,
  buildDependencyRiskReport,
  enrichDependencyRiskWithOsv,
  writeDependencyRiskArtifacts,
} from "./dependencyRisk.js";
import { writeTestScaffolds } from "./testScaffoldGenerator.js";

export type RewriteTracerConfig = {
  repoUrl: string;
  targetLanguage: string;
  sourceFrameworkHint?: string;   // optional override for auto-detection
  outputDir: string;
  githubConfig: GithubConfig;
  contextPaths?: string[];
  noContext?: boolean;
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

async function fetchSecurityManifestFiles(
  owner: string,
  repo: string,
  tree: string[],
  config: GithubConfig,
): Promise<Array<{ path: string; content: string }>> {
  const manifestPaths = tree
    .filter(isSecurityManifest)
    .filter((path) => !/node_modules|dist|build|coverage|bin|obj/.test(path))
    .slice(0, 40);
  const files: Array<{ path: string; content: string }> = [];
  for (const path of manifestPaths) {
    try {
      const content = await fetchFileContent(owner, repo, path, config.token, config.host);
      files.push({ path, content });
    } catch { /* skip inaccessible manifests */ }
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
  provider: LLMProvider
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

function implementationStatusFor(
  analysis: ComponentAnalysis,
  verification: ComponentVerification | undefined,
): "ready" | "needs_review" | "blocked" {
  if (
    analysis.targetRole === "human_review" ||
    analysis.targetRole === "unknown"
  ) {
    return "blocked";
  }
  if (verification?.trustVerdict === "blocked") return "blocked";
  if (verification?.trustVerdict === "needs_review") return "needs_review";
  if (analysis.humanQuestions.length > 0 || analysis.confidence === "low" || analysis.sourceCoverage.filesTruncated.length > 0) {
    return "needs_review";
  }
  return "ready";
}

function correctionAttemptLimit(): number {
  const raw = Number(process.env.CCS_ANALYZER_CORRECTION_ATTEMPTS ?? "1");
  if (!Number.isFinite(raw)) return 1;
  return Math.max(0, Math.min(2, Math.floor(raw)));
}

function shouldCorrectAnalysis(verification: ComponentVerification): boolean {
  return verification.trustVerdict === "needs_review" && verification.claims.some((claim) =>
    claim.loadBearing && (claim.outcome === "unsupported" || claim.outcome === "no_evidence")
  );
}

function buildCorrectionGuidance(verification: ComponentVerification): string {
  const rejected = verification.claims
    .filter((claim) => claim.loadBearing && (claim.outcome === "unsupported" || claim.outcome === "no_evidence"))
    .slice(0, 8)
    .map((claim, index) => {
      const source = claim.evidence?.sourceFile
        ? `${claim.evidence.sourceFile}:L${claim.evidence.lineStart ?? "?"}-${claim.evidence.lineEnd ?? claim.evidence.lineStart ?? "?"}`
        : "no source citation";
      return [
        `${index + 1}. ${claim.kind}: ${claim.statement}`,
        `   outcome: ${claim.outcome}`,
        `   source: ${source}`,
        `   verifier reason: ${claim.reason}`,
      ].join("\n");
    });

  return [
    "A verifier rejected or could not ground these load-bearing claims:",
    ...rejected,
    "",
    "Revise the component analysis. Prefer removing weak claims over keeping them. Add stronger line-numbered evidence only when the quoted source directly proves the claim.",
  ].join("\n");
}

/**
 * Copy each user-provided --context doc into the run's architecture-context/
 * folder so the run is reproducible without depending on files that may move
 * or be deleted on the developer's machine.
 */
async function copyUserContextDocs(
  contextPaths: string[],
  destDir: string,
): Promise<void> {
  for (const path of contextPaths) {
    try {
      const absolute = resolve(process.cwd(), path);
      const content = await fs.readFile(absolute, "utf-8");
      const safeName = basename(absolute).replace(/[^a-zA-Z0-9._-]+/g, "-");
      const target = join(destDir, safeName);
      await fs.writeFile(target, content, "utf-8");
    } catch {
      // Best-effort copy; the original analysis already consumed the doc, so
      // a copy failure is non-fatal.
    }
  }
}

function buildReadmeDoc(input: {
  repoUrl: string;
  generatedAt: string;
  frameworkInfo: FrameworkInfo;
  analyses: ComponentAnalysis[];
  migrationOrder: string[];
  verifications: ComponentVerification[];
  overview: string;
  errors: string[];
  contextDocCount: number;
}): string {
  const verificationByName = new Map(input.verifications.map((v) => [v.component, v]));
  const statuses = input.analyses.map((analysis) => ({
    name: analysis.component.name,
    status: implementationStatusFor(analysis, verificationByName.get(analysis.component.name)),
    questions: analysis.humanQuestions.length,
    verified: verificationByName.get(analysis.component.name)?.totals.verified ?? 0,
    checked: verificationByName.get(analysis.component.name)?.totals.claimsChecked ?? 0,
  }));
  const ready = statuses.filter((s) => s.status === "ready").length;
  const needsReview = statuses.filter((s) => s.status === "needs_review").length;
  const blocked = statuses.filter((s) => s.status === "blocked").length;
  const nextReady = input.migrationOrder.find((name) =>
    statuses.find((s) => s.name === name)?.status === "ready"
  );

  const componentRows = input.migrationOrder.map((name) => {
    const status = statuses.find((s) => s.name === name);
    if (!status) return `| ${name} | unknown | — | — |`;
    const gate = status.status === "ready"
      ? "ready"
      : status.status === "needs_review"
        ? "needs_review"
        : "blocked";
    return `| ${name} | ${gate} | ${status.verified}/${status.checked} | ${status.questions} |`;
  });

  return [
    `# ${input.repoUrl.split("/").slice(-2).join("/")} — Migration Analysis`,
    "",
    `**Repo:** ${input.repoUrl}`,
    `**Generated:** ${input.generatedAt}`,
    `**Migration:** ${input.frameworkInfo.sourceFramework} (${input.frameworkInfo.sourceLanguage}) → ${input.frameworkInfo.targetFramework} (${input.frameworkInfo.targetLanguage})`,
    `**Architecture context loaded:** ${input.contextDocCount} doc(s)`,
    "",
    "## Executive Summary",
    "",
    input.overview,
    "",
    `**Implementation posture:** ${ready} ready · ${needsReview} needs_review · ${blocked} blocked`,
    input.errors.length > 0 ? `**Pipeline errors:** ${input.errors.length}` : "**Pipeline errors:** 0",
    "",
    "## What To Open First",
    "",
    "1. `verification-summary.md` — trust gate: what is ready, needs review, or blocked.",
    "2. `human-questions.md` — decisions an architect or product owner must answer before coding.",
    "3. `migration-contract.json` — machine-readable contract for Codex, Claude Code, MCP tools, and validation.",
    "4. `reverse-engineering/reverse-engineering-details.md` — business rules, data contracts, and use-case understanding.",
    "5. `system-graph.mmd` — quick architecture graph for human review.",
    "6. `test-scaffolds/README.md` — parity test starting points generated from validation scenarios.",
    "7. `dependency-risk-report.md` — deterministic package inventory and migration/security planning notes.",
    "",
    "Treat this file as the table of contents. You do not need to read everything.",
    "",
    "## Component Gate",
    "",
    "| Component | Gate | Verified claims | Human questions |",
    "|-----------|------|-----------------|-----------------|",
    ...componentRows,
    "",
    "## Agent Handoff",
    "",
    nextReady
      ? `First ready component: \`${nextReady}\`. Hand off the run folder to Codex or Claude Code; tell them to read \`AGENTS.md\`, \`migration-contract.json\`, and \`components/${nextReady}.md\` before writing any code.`
      : "No component is ready for coding yet. Resolve `human-questions.md` and review `verification-summary.md` first.",
    "",
    "For MCP setup, run `/setup` in CCS. Agents call `ccs_list_ready_components`, `ccs_get_component_context`, `ccs_get_verification_report`, `ccs_get_dependency_impact`, and `ccs_search_artifacts` before implementation.",
    "",
    "## Workflow",
    "",
    "1. Skim this README.",
    "2. Open `verification-summary.md` and `human-questions.md` — accept, rewrite, or reject any flagged claim.",
    "3. Pick the first `ready` component from the table above.",
    "4. Run the agent (`codex` or Claude Code) with `AGENTS.md` as the entry instruction.",
    "5. After implementation, validate the new code against `validationScenarios` in `migration-contract.json`.",
    "6. Move on to the next `ready` component in `migrationOrder`.",
    "",
    "## Folder Map",
    "",
    "| Need | Where |",
    "|------|-------|",
    "| Human entry point | `README.md` (this file) |",
    "| Agent entry point | `AGENTS.md` |",
    "| Machine-readable contract | `migration-contract.json` |",
    "| Trust gate | `verification-summary.md` |",
    "| Dependency/security planning | `dependency-risk-report.md`, `dependency-risk-report.json` |",
    "| Parity test starting points | `test-scaffolds/` |",
    "| Per-component analysis | `components/<Name>.md` |",
    "| Reverse-engineered behavior | `reverse-engineering/` |",
    "| Symbol/call intelligence | `reverse-engineering/code-intelligence.md`, `reverse-engineering/code-intelligence.json` |",
    "| Dependency graph | `system-graph.json`, `system-graph.mmd` |",
    "| Architecture baseline | `architecture-baseline.md` |",
    "| Open decisions | `human-questions.md` |",
    "| Target landing zones | `component-disposition-matrix.md` |",
    "| User-provided context (copies) | `architecture-context/` |",
    "| Claude Code slash commands | `claude-commands/` |",
    "| Run logs | `logs/` |",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function analyze(config: RewriteTracerConfig): Promise<RewriteResult> {
  const { repoUrl, targetLanguage, outputDir, githubConfig } = config;

  const haiku = await createProvider("flash");
  const sonnet = await createProvider("pro");
  const verifierProvider = await createVerifierProvider("flash");

  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error(`Invalid repo URL: ${repoUrl}`);

  const { owner, repo, host } = parsed;
  if (host !== "github.com") githubConfig.host = host;

  const repoBaseUrl = `https://${host}/${owner}/${repo}`;
  const analysisDate = new Date().toISOString().slice(0, 10);
  const generatedAt = new Date().toISOString();

  // Build the repo-scoped run layout. Every artifact for THIS analysis lives
  // under one folder named after the repo, with clear subdirectories.
  const layout = buildRunLayout(outputDir, repoUrl);
  await fs.mkdir(layout.runDir, { recursive: true });
  await fs.mkdir(layout.componentsDir, { recursive: true });
  await fs.mkdir(layout.architectureContextDir, { recursive: true });
  await fs.mkdir(layout.testScaffoldsDir, { recursive: true });
  await fs.mkdir(layout.logsDir, { recursive: true });

  const modernizationContext = config.noContext
    ? await loadModernizationContext([], { includeWellKnown: false })
    : await loadModernizationContext(config.contextPaths);
  // Copy each user-provided --context doc into architecture-context/ so the
  // run folder is self-contained and reproducible.
  if (!config.noContext) {
    await copyUserContextDocs(config.contextPaths ?? [], layout.architectureContextDir);
  }

  const priorReverseEngineeringContext = await loadPriorReverseEngineeringContext(layout.runDir, repoUrl);
  const modernizationPromptContext = [
    formatModernizationContextForPrompt(modernizationContext),
    priorReverseEngineeringContext,
  ].filter(Boolean).join("\n\n---\n\n");
  await fs.writeFile(
    layout.architectureBaselinePath,
    buildArchitectureBaselineDoc(modernizationContext, repoUrl, targetLanguage, generatedAt),
    "utf-8"
  );
  log(
    config,
    modernizationContext.docs.length > 0
      ? `Loaded ${modernizationContext.docs.length} modernization context doc(s).`
      : "No modernization context docs found; using the default architecture profile."
  );

  let defaultBranch = "HEAD";
  try {
    defaultBranch = await fetchDefaultBranch(owner, repo, githubConfig.token, githubConfig.host);
  } catch {
    defaultBranch = "HEAD";
  }

  // --- Fetch file tree ---
  log(config, `Fetching file tree from ${repoUrl}...`);
  let tree: string[] = [];
  try {
    tree = await fetchFileTree(owner, repo, githubConfig.token, githubConfig.host, defaultBranch);
  } catch (e) {
    throw new Error(`Could not fetch repo tree: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(config, `Found ${tree.length} files in repo.`);

  // --- Detect framework (Haiku, or use hint if provided) ---
  log(config, "Detecting source framework...");
  const keyFiles = await fetchKeyFiles(owner, repo, tree, githubConfig);
  const securityManifestFiles = await fetchSecurityManifestFiles(owner, repo, tree, githubConfig);
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

  await fs.writeFile(
    layout.preflightReadinessPath,
    buildPreflightReadinessReport({
      repoUrl,
      generatedAt,
      tree,
      keyFiles,
      frameworkInfo,
      components: nonTestComponents,
      context: modernizationContext,
    }),
    "utf-8"
  );

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
    const configData = await loadConfig();
    const estimate = estimateScanCost(nonTestComponents.length, keyFiles, 2, configData.provider);
    const preview = formatCostPreview(estimate);
    const confirmed = await config.onCostPreview(preview);
    if (!confirmed) {
      log(config, "Analysis cancelled.");
      return { frameworkInfo, components: [], migrationOrder: [], unanalyzed: [], errors: [], indexPath: null, reportPath: null };
    }
  }

  // --- Analyze each component (Sonnet) ---
  const analyzed: ComponentAnalysis[] = [];
  const verifications: ComponentVerification[] = [];
  const unanalyzed: string[] = [];
  const errors: string[] = [];
  const sourceFilesByPath = new Map<string, { path: string; content: string }>();

  for (const component of nonTestComponents) {
    log(config, `Analyzing ${component.name} (${component.type})...`);
    try {
      const sourceFiles = await fetchFiles(owner, repo, component.filePaths, githubConfig);
      for (const file of sourceFiles) sourceFilesByPath.set(file.path, file);
      let analysis = await analyzeComponent(
        component,
        sourceFiles,
        frameworkInfo,
        sonnet,
        modernizationPromptContext
      );

      // Verification pass: re-read every cited source range and confirm each
      // load-bearing claim before we tell Codex/Claude this component is ready.
      log(config, `Verifying claims for ${component.name}...`);
      let verification: ComponentVerification;
      try {
        verification = await verifyComponent(analysis, sourceFiles, verifierProvider, { generatedAt });
      } catch (verifyError) {
        const msg = verifyError instanceof Error ? verifyError.message : String(verifyError);
        verification = {
          component: component.name,
          generatedAt,
          verifierModel: verifierProvider.name,
          trustVerdict: "needs_review",
          trustReasons: [`Verifier crashed: ${msg}`],
          totals: { claimsChecked: 0, verified: 0, unsupported: 0, inconclusive: 0, noEvidence: 0 },
          claims: [],
          error: msg,
        };
      }

      for (let attempt = 1; attempt <= correctionAttemptLimit() && shouldCorrectAnalysis(verification); attempt++) {
        log(config, `Revising ${component.name} analysis from verifier feedback (attempt ${attempt})...`);
        try {
          const revised = await analyzeComponent(
            component,
            sourceFiles,
            frameworkInfo,
            sonnet,
            modernizationPromptContext,
            buildCorrectionGuidance(verification),
          );
          log(config, `Re-verifying revised claims for ${component.name}...`);
          const revisedVerification = await verifyComponent(revised, sourceFiles, verifierProvider, { generatedAt });
          analysis = revised;
          verification = {
            ...revisedVerification,
            trustReasons: [
              ...revisedVerification.trustReasons,
              `Analyzer self-correction pass ran after verifier feedback (attempt ${attempt}).`,
            ],
          };
        } catch (correctionError) {
          const msg = correctionError instanceof Error ? correctionError.message : String(correctionError);
          verification = {
            ...verification,
            trustVerdict: verification.trustVerdict === "ready" ? "needs_review" : verification.trustVerdict,
            trustReasons: [
              ...verification.trustReasons,
              `Analyzer self-correction failed: ${msg}`,
            ],
          };
          break;
        }
      }

      analyzed.push(analysis);
      verifications.push(verification);

      // Per-component doc with verification rendered inline. We no longer
      // write a separate verification/<Name>.md — the context doc carries the
      // full verification block, so the duplicate file was pure noise.
      const doc = buildRewriteContextDoc(
        analysis,
        frameworkInfo,
        repoBaseUrl,
        analysisDate,
        defaultBranch,
        modernizationContext,
        verification,
      );
      await fs.writeFile(join(layout.componentsDir, `${component.name}.md`), doc, "utf-8");

      const verdictIcon =
        verification.trustVerdict === "ready" ? "✓"
        : verification.trustVerdict === "needs_review" ? "⚠"
        : "✗";
      log(
        config,
        `${verdictIcon} ${component.name} (${analysis.complexity} complexity, ${analysis.confidence} confidence, ${verification.totals.verified}/${verification.totals.claimsChecked} verified, verdict=${verification.trustVerdict})`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${component.name}: ${msg}`);
      unanalyzed.push(component.name);
      log(config, `✗ Failed to analyze ${component.name}: ${msg}`);
    }
  }

  // Persist the verification summary so reviewers can scan trust state in one place.
  if (verifications.length > 0) {
    await fs.writeFile(
      layout.verificationSummaryPath,
      buildVerificationSummary(verifications, { repoUrl, generatedAt }),
      "utf-8"
    );
  }
  const verificationByName = new Map(verifications.map((v) => [v.component, v]));

  try {
    const scaffolds = await writeTestScaffolds(layout, analyzed, frameworkInfo, verificationByName);
    log(config, `✓ parity test scaffolds written (${scaffolds.files.length} components)`);
  } catch (e) {
    errors.push(`test-scaffolds: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const dependencyRiskReport = await enrichDependencyRiskWithOsv(buildDependencyRiskReport({
      manifestFiles: securityManifestFiles,
      analyses: analyzed,
      frameworkInfo,
      generatedAt,
    }));
    await writeDependencyRiskArtifacts(layout, dependencyRiskReport);
    log(config, `✓ dependency risk report written (${dependencyRiskReport.dependencies.length} dependencies, ${dependencyRiskReport.findings.length} findings)`);
  } catch (e) {
    errors.push(`dependency-risk: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- Topological sort ---
  const migrationOrder = sortByDependency(nonTestComponents).filter(
    (name) => !unanalyzed.includes(name)
  );

  // --- System overview + README (single human entry point) ---
  log(config, "Generating migration knowledge base index...");
  const overview = await generateSystemOverview(analyzed, frameworkInfo, sonnet);
  const reverseEngineeringArtifacts = await writeReverseEngineeringArtifacts({
    runDir: layout.runDir,
    reverseEngineeringDir: layout.reverseEngineeringDir,
    systemGraphJsonPath: layout.systemGraphJsonPath,
    systemGraphMermaidPath: layout.systemGraphMermaidPath,
    repoUrl,
    generatedAt,
    frameworkInfo,
    analyses: analyzed,
    migrationOrder,
    sourceFiles: [...sourceFilesByPath.values()],
  });

  await fs.writeFile(
    layout.readmePath,
    buildReadmeDoc({
      repoUrl,
      generatedAt,
      frameworkInfo,
      analyses: analyzed,
      migrationOrder,
      verifications,
      overview,
      errors,
      contextDocCount: modernizationContext.docs.length,
    }),
    "utf-8",
  );

  // --- Scan report (terse, lives in logs/) ---
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
    `Open \`README.md\` for the full guided walkthrough.`,
  ].join("\n");

  await fs.writeFile(layout.reportPath, report, "utf-8");

  // Generate Claude Code slash commands + AGENTS.md
  log(config, "Generating AI tool integration files...");
  try {
    await generateRewriteIntegration(layout, analyzed, frameworkInfo, migrationOrder, repoUrl, {
      modernizationContext,
      verifications: verificationByName,
    });
    log(config, `✓ migration-contract.json, AGENTS.md, claude-commands/ written`);
    log(config, `✓ reverse-engineering written to ${basename(reverseEngineeringArtifacts.reverseEngineeringDir)}/`);
  } catch (e) {
    errors.push(`ai-integration: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const { dashboardPath } = await writeDashboard({
      layout,
      repoUrl,
      generatedAt,
      frameworkInfo,
      analyses: analyzed,
      verifications,
      migrationOrder,
      errors,
    });
    log(config, `✓ dashboard.html written to ${basename(dashboardPath)}`);
  } catch (e) {
    errors.push(`dashboard: ${e instanceof Error ? e.message : String(e)}`);
  }

  log(config, `\nAnalysis complete. ${analyzed.length} components documented, ${unanalyzed.length} failed.`);
  log(config, `Output: ${layout.runDir}`);

  return { frameworkInfo, components: analyzed, migrationOrder, unanalyzed, errors, indexPath: layout.readmePath, reportPath: layout.reportPath };
}
