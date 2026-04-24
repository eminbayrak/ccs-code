import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";

export type MigrationContractInput = {
  repoUrl: string;
  frameworkInfo: FrameworkInfo;
  analyses: ComponentAnalysis[];
  migrationOrder: string[];
  generatedAt: string;
};

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

function implementationStatus(analysis: ComponentAnalysis): "ready" | "blocked" {
  return analysis.targetRole === "human_review" ||
    analysis.targetRole === "unknown" ||
    analysis.humanQuestions.length > 0
    ? "blocked"
    : "ready";
}

function reviewReason(analysis: ComponentAnalysis): string[] {
  const reasons: string[] = [];
  if (analysis.targetRole === "human_review" || analysis.targetRole === "unknown") {
    reasons.push(`target role is ${analysis.targetRole}`);
  }
  if (analysis.humanQuestions.length > 0) {
    reasons.push("human questions are unresolved");
  }
  if (analysis.confidence === "low") {
    reasons.push("analysis confidence is low");
  }
  if (analysis.sourceCoverage.filesTruncated.length > 0) {
    reasons.push("source coverage was truncated");
  }
  return reasons;
}

export function buildMigrationContract(input: MigrationContractInput): string {
  const { repoUrl, frameworkInfo, analyses, migrationOrder, generatedAt } = input;
  const byName = new Map(analyses.map((a) => [a.component.name, a]));

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
      return [{
        name: analysis.component.name,
        type: analysis.component.type,
        implementationStatus: implementationStatus(analysis),
        requiredReviewBeforeImplementation: reviewReason(analysis),
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
      }];
    }),
  };

  return `${JSON.stringify(contract, null, 2)}\n`;
}

export function buildDispositionMatrix(input: MigrationContractInput): string {
  const { repoUrl, frameworkInfo, analyses, migrationOrder, generatedAt } = input;
  const byName = new Map(analyses.map((a) => [a.component.name, a]));

  const rows = migrationOrder.flatMap((name) => {
    const a = byName.get(name);
    if (!a) return [];
    return `| ${escapeTable(a.component.name)} | ${a.component.type} | ${a.targetRole} | ${implementationStatus(a)} | ${escapeTable(a.targetIntegrationBoundary)} | ${a.confidence} | ${a.complexity} | ${escapeTable(a.targetRoleRationale)} |`;
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
  const { analyses, migrationOrder } = input;
  const byName = new Map(analyses.map((a) => [a.component.name, a]));

  const steps = migrationOrder.flatMap((name, index) => {
    const a = byName.get(name);
    if (!a) return [];
    const targetFile = targetFileFor(a.component.name, input.frameworkInfo.targetLanguage);
    const status = implementationStatus(a);
    return `${index + 1}. **${a.component.name}** -> \`${a.targetRole}\`
   Context: \`context/${a.component.name}.md\`
   Target file hint: \`${targetFile}\`
   Gate: \`${status}\`${status === "blocked" ? ` (${reviewReason(a).join("; ")})` : ""}
   Codex prompt: \`Read AGENTS.md, migration-contract.json, and context/${a.component.name}.md, then implement only ${a.component.name} if its gate is ready.\`
   Claude Code command: \`/project:rewrite-${a.component.name}\`
   Contract role: ${a.targetRoleRationale}
   Human questions: ${a.humanQuestions.length > 0 ? a.humanQuestions.join("; ") : "none"}
   Validation: ${a.validationScenarios.length > 0 ? a.validationScenarios.slice(0, 3).join("; ") : "derive from context doc"}`;
  });

  return `# How To Migrate

Use this guide with \`migration-contract.json\`, \`component-disposition-matrix.md\`, and the per-component context docs.

## Execution Rules

- Start with components that have no unresolved human questions.
- Do not implement components marked \`human_review\` or \`unknown\` until the questions are answered.
- Preserve observed business rules exactly.
- Treat inferred or uncited facts as review items.
- After implementation, validate against the scenarios listed for each component.

## Migration Steps

${steps.join("\n\n") || "_No migration steps generated._"}
`;
}

export function buildAgentIntegrationGuide(input: MigrationContractInput): string {
  const ready = input.analyses.filter((a) => implementationStatus(a) === "ready").length;
  const blocked = input.analyses.length - ready;

  return `# Agent Integration Guide

_Repo: ${input.repoUrl}_
_Generated: ${input.generatedAt}_

## Recommended Product Shape

Use CCS Code as a migration contract generator and agent pre-flight tool, not as another autonomous coding agent. Codex and Claude Code are already strong at editing code; CCS Code should make them safer by giving them source-backed context, target architecture disposition, unresolved decisions, and validation gates before they write code.

## Current Integration Mode: Artifact Contract

This mode works today with no custom protocol:

1. Run CCS Code against the legacy repo.
2. Put the generated \`rewrite/\` artifacts beside the target modernization project.
3. Ask Codex or Claude Code to read \`AGENTS.md\`, \`migration-contract.json\`, and the relevant \`context/<Component>.md\`.
4. Only implement components whose contract status is \`ready\`.
5. Resolve \`human-questions.md\` before implementing blocked components.

## Codex Usage

\`\`\`
codex "Read AGENTS.md, migration-contract.json, and HOW-TO-MIGRATE.md. Start with the first ready component and preserve every observed business rule."
\`\`\`

Codex should treat \`migration-contract.json\` as the machine-readable source of truth and the context docs as the source-backed explanation.

## Claude Code Usage

Copy \`rewrite/.claude/\` into the target project and run:

\`\`\`
/project:rewrite-<ComponentName>
\`\`\`

If the component is blocked by human questions, Claude Code should stop and report the required decisions instead of guessing.

## Future Integration Mode: MCP Tool

If this becomes a first-class tool for Codex, expose CCS Code as a queryable contract service rather than a coding agent:

- \`ccs_generate_contract(repo, target)\` creates or refreshes the migration contract.
- \`ccs_get_component_context(name)\` returns the evidence-backed context for one component.
- \`ccs_get_ready_work()\` lists components safe for agent implementation.
- \`ccs_record_human_answer(component, question, answer)\` captures architecture/product decisions.
- \`ccs_validate_component(name, targetPath)\` checks implementation against validation scenarios.

## Pipeline Integration

For a multi-agent remediation pipeline, CCS Code should feed the pre-flight and triage phases:

- Pre-flight: produce the contract, disposition matrix, and human questions.
- Build: Codex/Claude implement only ready components.
- QA: tester agents use validation scenarios and acceptance criteria from the contract.
- Triage: issues route back to either code remediation or human decision, not ad-hoc guessing.

## Current Contract Summary

- Ready components: ${ready}
- Blocked components: ${blocked}
- Contract file: \`migration-contract.json\`
- Human decision file: \`human-questions.md\`
- Disposition file: \`component-disposition-matrix.md\`
`;
}
