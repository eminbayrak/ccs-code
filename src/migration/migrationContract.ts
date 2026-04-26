import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";
import type { ComponentVerification } from "./rewriteVerifier.js";

export type MigrationContractInput = {
  repoUrl: string;
  frameworkInfo: FrameworkInfo;
  analyses: ComponentAnalysis[];
  migrationOrder: string[];
  generatedAt: string;
  /** Optional per-component verification reports keyed by component name. */
  verifications?: Map<string, ComponentVerification>;
};

export type ComponentGateStatus = "ready" | "needs_review" | "blocked";

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function targetFileFor(name: string, language: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const ext = language === "python" ? "py"
    : language === "go" ? "go"
    : language === "java" ? "java"
    : language === "csharp" ? "cs"
    : "ts";
  return `${snake}.${ext}`;
}

function baseImplementationStatus(analysis: ComponentAnalysis): ComponentGateStatus {
  if (analysis.targetRole === "human_review" || analysis.targetRole === "unknown") {
    return "blocked";
  }
  if (analysis.humanQuestions.length > 0 || analysis.confidence === "low" || analysis.sourceCoverage.filesTruncated.length > 0) {
    return "needs_review";
  }
  return "ready";
}

function implementationStatus(
  analysis: ComponentAnalysis,
  verification?: ComponentVerification,
): ComponentGateStatus {
  const base = baseImplementationStatus(analysis);
  if (base === "blocked") return "blocked";
  if (!verification) return base;
  if (verification.trustVerdict === "blocked") return "blocked";
  if (verification.trustVerdict === "needs_review") return "needs_review";
  return base;
}

function reviewReason(
  analysis: ComponentAnalysis,
  verification?: ComponentVerification,
): string[] {
  const reasons: string[] = [];
  if (analysis.targetRole === "human_review" || analysis.targetRole === "unknown") {
    reasons.push(`target role is ${analysis.targetRole}`);
  }
  if (analysis.humanQuestions.length > 0) {
    reasons.push("human questions require review");
  }
  if (analysis.confidence === "low") {
    reasons.push("analysis confidence is low");
  }
  if (analysis.sourceCoverage.filesTruncated.length > 0) {
    reasons.push("source coverage was truncated");
  }
  if (verification && verification.trustVerdict !== "ready") {
    for (const reason of verification.trustReasons) {
      reasons.push(`verification: ${reason}`);
    }
  }
  return reasons;
}

export function buildMigrationContract(input: MigrationContractInput): string {
  const { repoUrl, frameworkInfo, analyses, migrationOrder, generatedAt, verifications } = input;
  const byName = new Map(analyses.map((a) => [a.component.name, a]));
  const verifyOf = (name: string) => verifications?.get(name);

  const contract = {
    schemaVersion: "1.0",
    generatedAt,
    repoUrl,
    migration: {
      sourceFramework: frameworkInfo.sourceFramework,
      sourceLanguage: frameworkInfo.sourceLanguage,
      targetFramework: frameworkInfo.targetFramework,
      targetLanguage: frameworkInfo.targetLanguage,
      architecturePattern: frameworkInfo.architecturePattern,
      packageManager: frameworkInfo.packageManager,
    },
    globalGuardrails: [
      "Read preflight-readiness.md and architecture-baseline.md before implementation.",
      "Do not perform a one-for-one rewrite without target architecture classification.",
      "Preserve business behaviour, not legacy control flow.",
      "Classify every important fact as observed, inferred, or unknown.",
      "Resolve human questions before implementing components marked human_review or unknown.",
      "Use source evidence and context docs before changing code.",
    ],
    migrationOrder,
    components: migrationOrder.flatMap((name) => {
      const analysis = byName.get(name);
      if (!analysis) return [];
      const verification = verifyOf(name);
      return [{
        name: analysis.component.name,
        type: analysis.component.type,
        implementationStatus: implementationStatus(analysis, verification),
        requiredReviewBeforeImplementation: reviewReason(analysis, verification),
        sourceFiles: analysis.component.filePaths,
        dependencies: analysis.component.dependencies,
        purpose: analysis.purpose,
        target: {
          role: analysis.targetRole,
          rationale: analysis.targetRoleRationale,
          integrationBoundary: analysis.targetIntegrationBoundary,
          implementationPattern: analysis.targetPattern,
          targetFileHint: targetFileFor(analysis.component.name, frameworkInfo.targetLanguage),
          dependencies: analysis.targetDependencies,
        },
        risk: {
          complexity: analysis.complexity,
          confidence: analysis.confidence,
          migrationRisks: analysis.migrationRisks,
          unknownFields: analysis.unknownFields,
          sourceCoverage: analysis.sourceCoverage,
        },
        businessRules: analysis.businessRules.map((rule) => ({
          statement: rule,
          evidence: analysis.evidence.filter((e) =>
            e.kind === "business_rule" &&
            (e.statement === rule || e.statement.includes(rule) || rule.includes(e.statement))
          ),
        })),
        contracts: {
          input: analysis.inputContract,
          output: analysis.outputContract,
        },
        humanQuestions: analysis.humanQuestions,
        validationScenarios: analysis.validationScenarios,
        acceptanceCriteria: [
          ...analysis.businessRules.map((rule) => `Preserve observed business rule: ${rule}`),
          ...analysis.validationScenarios,
        ],
        evidence: analysis.evidence,
        verification: verification ? {
          trustVerdict: verification.trustVerdict,
          trustReasons: verification.trustReasons,
          verifierModel: verification.verifierModel,
          generatedAt: verification.generatedAt,
          totals: verification.totals,
          claims: verification.claims.map((claim) => ({
            id: claim.id,
            kind: claim.kind,
            statement: claim.statement,
            loadBearing: claim.loadBearing,
            outcome: claim.outcome,
            reason: claim.reason,
            evidence: claim.evidence,
          })),
          ...(verification.error ? { error: verification.error } : {}),
        } : null,
      }];
    }),
  };

  return `${JSON.stringify(contract, null, 2)}\n`;
}

export function buildDispositionMatrix(input: MigrationContractInput): string {
  const { repoUrl, frameworkInfo, analyses, migrationOrder, generatedAt, verifications } = input;
  const byName = new Map(analyses.map((a) => [a.component.name, a]));

  const rows = migrationOrder.flatMap((name) => {
    const a = byName.get(name);
    if (!a) return [];
    const v = verifications?.get(name);
    return `| ${escapeTable(a.component.name)} | ${a.component.type} | ${a.targetRole} | ${implementationStatus(a, v)} | ${escapeTable(a.targetIntegrationBoundary)} | ${a.confidence} | ${a.complexity} | ${escapeTable(a.targetRoleRationale)} |`;
  });

  return `# Component Disposition Matrix

_Repo: ${repoUrl}_
_Generated: ${generatedAt}_
_Migration: ${frameworkInfo.sourceFramework} (${frameworkInfo.sourceLanguage}) -> ${frameworkInfo.targetFramework} (${frameworkInfo.targetLanguage})_

This matrix answers the meeting question: which pieces should become workflow, functions, jobs, APIs, common libraries, rules modules, or human-review decisions?

| Component | Current Type | Recommended Target Role | Status | Integration Boundary | Confidence | Complexity | Rationale |
|-----------|--------------|-------------------------|--------|----------------------|------------|------------|-----------|
${rows.join("\n") || "| _none_ |  |  |  |  |  |  |  |"}

## Review Rules

- Anything marked \`human_review\` or \`unknown\` must be resolved before implementation.
- \`workflow\` candidates should be reviewed for trigger, state, retry, and completion semantics.
- \`azure_function\` candidates should be reviewed for event contracts, idempotency, and operational ownership.
- \`databricks_job\` candidates should be reviewed for data volume, partitioning, schema contracts, and reconciliation strategy.
- \`common_library\` candidates should be reviewed for reuse boundaries and package ownership.
`;
}

export function buildHumanQuestionsDoc(input: MigrationContractInput): string {
  const { repoUrl, analyses, generatedAt } = input;
  const questions = analyses.flatMap((a) =>
    a.humanQuestions.map((question) => ({
      component: a.component.name,
      role: a.targetRole,
      confidence: a.confidence,
      question,
    }))
  );

  const rows = questions.map((q) =>
    `| ${escapeTable(q.component)} | ${q.role} | ${q.confidence} | ${escapeTable(q.question)} |`
  );

  return `# Human Questions

_Repo: ${repoUrl}_
_Generated: ${generatedAt}_

These are the decisions CCS Code could not safely make from source evidence alone. Resolve these before asking a coding agent to implement the affected component.

| Component | Target Role | Confidence | Question |
|-----------|-------------|------------|----------|
${rows.join("\n") || "| _none_ |  |  | _No open human questions identified._ |"}
`;
}

export function buildHowToMigrate(input: MigrationContractInput): string {
  const { analyses, migrationOrder, verifications } = input;
  const byName = new Map(analyses.map((a) => [a.component.name, a]));

  const steps = migrationOrder.flatMap((name, index) => {
    const a = byName.get(name);
    if (!a) return [];
    const v = verifications?.get(name);
    const targetFile = targetFileFor(a.component.name, input.frameworkInfo.targetLanguage);
    const status = implementationStatus(a, v);
    return `${index + 1}. **${a.component.name}** -> \`${a.targetRole}\`
   Context: \`components/${a.component.name}.md\`
   Verification: \`components/${a.component.name}.md\`
   Target file hint: \`${targetFile}\`
   Gate: \`${status}\`${status !== "ready" ? ` (${reviewReason(a, v).join("; ")})` : ""}
   Codex prompt: \`Read AGENTS.md, preflight-readiness.md, architecture-baseline.md, migration-contract.json, and components/${a.component.name}.md, then implement only ${a.component.name} if its gate is ready.\`
   Claude Code command: \`/project:rewrite-${a.component.name}\`
   Contract role: ${a.targetRoleRationale}
   Human questions: ${a.humanQuestions.length > 0 ? a.humanQuestions.join("; ") : "none"}
   Validation: ${a.validationScenarios.length > 0 ? a.validationScenarios.slice(0, 3).join("; ") : "derive from context doc"}`;
  });

  return `# How To Migrate

Use this guide with \`preflight-readiness.md\`, \`architecture-baseline.md\`, \`migration-contract.json\`, \`component-disposition-matrix.md\`, and the per-component context docs.

## Execution Rules

- Start by reading \`preflight-readiness.md\` to understand missing context and readiness gaps.
- Use \`architecture-baseline.md\` for target landing-zone decisions.
- Start with components whose contract status is \`ready\`.
- Do not implement components marked \`human_review\` or \`unknown\` until the questions are answered.
- Preserve observed business rules exactly.
- Treat inferred or uncited facts as review items.
- After implementation, validate against the scenarios listed for each component.

## Migration Steps

${steps.join("\n\n") || "_No migration steps generated._"}
`;
}

export function buildAgentIntegrationGuide(input: MigrationContractInput): string {
  const ready = input.analyses.filter(
    (a) => implementationStatus(a, input.verifications?.get(a.component.name)) === "ready",
  ).length;
  const needsReview = input.analyses.filter(
    (a) => implementationStatus(a, input.verifications?.get(a.component.name)) === "needs_review",
  ).length;
  const blocked = input.analyses.length - ready - needsReview;

  return `# Agent Integration Guide

_Repo: ${input.repoUrl}_
_Generated: ${input.generatedAt}_

## Recommended Product Shape

Use CCS Code as a migration contract generator and agent pre-flight tool, not as another autonomous coding agent. Codex and Claude Code are already strong at editing code; CCS Code should make them safer by giving them source-backed context, target architecture disposition, unresolved decisions, and validation gates before they write code.

## Current Integration Mode: Artifact Contract

This mode works today with no custom protocol:

1. Run CCS Code against the legacy repo.
2. Review \`preflight-readiness.md\` and \`architecture-baseline.md\` before trusting target-role decisions.
3. Put the generated run folder beside the target modernization project.
4. Ask Codex or Claude Code to read \`AGENTS.md\`, \`migration-contract.json\`, and the relevant \`components/<Component>.md\`.
5. Only implement components whose contract status is \`ready\`.
6. Review \`human-questions.md\` before implementing needs-review or blocked components.

## Codex Usage

\`\`\`
codex "Read AGENTS.md, preflight-readiness.md, architecture-baseline.md, migration-contract.json, and HOW-TO-MIGRATE.md. Start with the first ready component and preserve every observed business rule."
\`\`\`

Codex should treat \`migration-contract.json\` as the machine-readable source of truth and the context docs as the source-backed explanation.

## Claude Code Usage

Copy \`claude-commands/\` into the target project and run:

\`\`\`
/project:rewrite-<ComponentName>
\`\`\`

If the component is blocked or needs review, Claude Code should stop and report the required decisions instead of guessing.

## Local MCP Integration Mode

CCS Code can also run as a local stdio MCP server, so Codex or Claude Code can query migration artifacts directly:

- \`ccs_get_ready_work(migrationDir)\` lists components safe for agent implementation.
- \`ccs_get_component_context(migrationDir, componentName)\` returns the evidence-backed context for one component.
- \`ccs_get_human_questions(migrationDir)\` returns unresolved architecture or product decisions.
- \`ccs_get_validation_contract(migrationDir, componentName)\` returns gates, risks, scenarios, and acceptance criteria.
- \`ccs_get_architecture_baseline(migrationDir)\` returns the target architecture baseline or disposition matrix.
- \`ccs_get_business_logic(migrationDir)\` returns reverse-engineered rules, contracts, risks, and validation scenarios.
- \`ccs_get_system_graph(migrationDir)\` returns the component/file/package/target-role graph.
- \`ccs_get_dependency_impact(migrationDir, nodeName)\` returns dependencies, dependents, source files, and retest scope for one component.

Codex registration:

\`\`\`
codex mcp add ccs -- ccs-code mcp
\`\`\`

Claude Code can register the same command in its MCP config.

## Pipeline Integration

For a multi-agent remediation pipeline, CCS Code should feed the pre-flight and triage phases:

- Pre-flight: produce the contract, disposition matrix, and human questions.
- Build: Codex/Claude implement only ready components.
- QA: tester agents use validation scenarios and acceptance criteria from the contract.
- Triage: issues route back to either code remediation or human decision, not ad-hoc guessing.

## Current Contract Summary

- Ready components: ${ready}
- Needs-review components: ${needsReview}
- Blocked components: ${blocked}
- Preflight file: \`preflight-readiness.md\`
- Architecture baseline file: \`architecture-baseline.md\`
- Contract file: \`migration-contract.json\`
- Human decision file: \`human-questions.md\`
- Disposition file: \`component-disposition-matrix.md\`
- Verification summary: \`verification-summary.md\`
- Per-component verification: \`components/<Component>.md\`

Components in \`needs_review\` were analyzed but had at least one load-bearing claim that could not be confirmed against the cited source. A reviewer must accept or rewrite those claims before a coding agent picks them up.
`;
}
