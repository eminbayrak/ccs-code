// ---------------------------------------------------------------------------
// Repo-scoped run layout. One CCS migration analysis run produces a single
// folder named after the repo. Inside it: a clearly-named set of human-facing
// markdown files at the top level, plus a small number of subdirectories for
// per-component, reverse-engineering, architecture-context, agent commands,
// and logs. This module is the single source of truth for those paths so we
// don't end up with 14 hardcoded "rewrite/" strings scattered across the code.
// ---------------------------------------------------------------------------

import { join } from "node:path";

export type RunLayout = {
  /** Absolute path to the repo-scoped run directory. */
  runDir: string;
  /** Human-facing entry points and contracts at the run-dir root. */
  readmePath: string;
  agentsPath: string;
  contractPath: string;
  architectureBaselinePath: string;
  preflightReadinessPath: string;
  dispositionMatrixPath: string;
  humanQuestionsPath: string;
  verificationSummaryPath: string;
  dependencyRiskReportPath: string;
  dependencyRiskJsonPath: string;
  howToMigratePath: string;
  agentIntegrationPath: string;
  systemGraphJsonPath: string;
  systemGraphMermaidPath: string;
  /** Subdirectories. */
  componentsDir: string;
  reverseEngineeringDir: string;
  architectureContextDir: string;
  claudeCommandsDir: string;
  testScaffoldsDir: string;
  logsDir: string;
  reportPath: string;
};

const SLUG_FALLBACK = "unnamed-repo";

/**
 * Derive a filesystem-safe folder name from a repo URL.
 *
 *   https://github.com/eminbayrak/node-orders-api → eminbayrak-node-orders-api
 *   git@github.com:acme/legacy-billing.git        → acme-legacy-billing
 *   https://gitlab.com/team/svc                    → team-svc
 *
 * Falls back to a stable placeholder rather than throwing so a malformed URL
 * never crashes the analysis pipeline.
 */
export function repoSlug(repoUrl: string): string {
  if (!repoUrl) return SLUG_FALLBACK;
  // Strip protocol, user@, hostname, .git suffix, trailing slashes.
  const cleaned = repoUrl
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^git@[^:]+:/i, "")
    .replace(/^[^/]+\//, "")            // drop hostname
    .replace(/\/+$/, "")
    .toLowerCase();

  if (!cleaned) return SLUG_FALLBACK;

  // Replace separators with `-`, drop anything that isn't [a-z0-9-_], collapse.
  const slug = cleaned
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || SLUG_FALLBACK;
}

/**
 * Build the full run layout for a repo URL under a migration root.
 */
export function buildRunLayout(migrationRoot: string, repoUrl: string): RunLayout {
  const runDir = join(migrationRoot, repoSlug(repoUrl));
  return {
    runDir,
    readmePath:                 join(runDir, "README.md"),
    agentsPath:                 join(runDir, "AGENTS.md"),
    contractPath:               join(runDir, "migration-contract.json"),
    architectureBaselinePath:   join(runDir, "architecture-baseline.md"),
    preflightReadinessPath:     join(runDir, "preflight-readiness.md"),
    dispositionMatrixPath:      join(runDir, "component-disposition-matrix.md"),
    humanQuestionsPath:         join(runDir, "human-questions.md"),
    verificationSummaryPath:    join(runDir, "verification-summary.md"),
    dependencyRiskReportPath:   join(runDir, "dependency-risk-report.md"),
    dependencyRiskJsonPath:     join(runDir, "dependency-risk-report.json"),
    howToMigratePath:           join(runDir, "HOW-TO-MIGRATE.md"),
    agentIntegrationPath:       join(runDir, "AGENT-INTEGRATION.md"),
    systemGraphJsonPath:        join(runDir, "system-graph.json"),
    systemGraphMermaidPath:     join(runDir, "system-graph.mmd"),
    componentsDir:              join(runDir, "components"),
    reverseEngineeringDir:      join(runDir, "reverse-engineering"),
    architectureContextDir:     join(runDir, "architecture-context"),
    claudeCommandsDir:          join(runDir, "claude-commands"),
    testScaffoldsDir:           join(runDir, "test-scaffolds"),
    logsDir:                    join(runDir, "logs"),
    reportPath:                 join(runDir, "logs", "report.md"),
  };
}
