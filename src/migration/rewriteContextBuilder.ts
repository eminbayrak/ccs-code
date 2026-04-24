import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";
import {
  evidenceSourceLabel,
  findEvidenceForStatement,
  summarizeCoverage,
  type EvidenceItem,
  type SourceCoverage,
} from "./evidence.js";

// ---------------------------------------------------------------------------
// Build a per-component migration context document.
// This doc is pasted into Claude Code / Codex to drive the actual rewrite.
// ---------------------------------------------------------------------------

function formatContract(contract: Record<string, string>): string {
  if (Object.keys(contract).length === 0) return "  unknown";
  return Object.entries(contract)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function sourceUrl(repoBaseUrl: string, ref: string, path: string, evidence?: EvidenceItem): string {
  const anchor = evidence?.lineStart
    ? `#L${evidence.lineStart}${evidence.lineEnd && evidence.lineEnd !== evidence.lineStart ? `-L${evidence.lineEnd}` : ""}`
    : "";
  return `${repoBaseUrl}/blob/${ref}/${path}${anchor}`;
}

function formatEvidenceSource(evidence: EvidenceItem, repoBaseUrl: string, ref: string): string {
  if (!evidence.sourceFile) return evidenceSourceLabel(evidence);
  return `[${evidenceSourceLabel(evidence)}](${sourceUrl(repoBaseUrl, ref, evidence.sourceFile, evidence)})`;
}

function formatCoverageSection(coverage: SourceCoverage): string {
  const lines = summarizeCoverage(coverage).map((line) => `- ${line}`).join("\n");
  const warning = coverage.filesTruncated.length > 0
    ? "\n> Some source was not visible to the analysis model. Uncited or inferred facts must be checked against the full source before migration."
    : "";
  return `${lines}${warning}`;
}

function formatEvidenceLedger(evidence: EvidenceItem[], repoBaseUrl: string, ref: string): string {
  if (evidence.length === 0) {
    return "_No source-level evidence was returned by the analysis model. Treat all extracted facts as requiring manual verification._";
  }

  return [
    "| Kind | Basis | Confidence | Source | Statement |",
    "|------|-------|------------|--------|-----------|",
    ...evidence.map((item) =>
      `| ${escapeTableCell(item.kind)} | ${item.basis} | ${item.confidence} | ${formatEvidenceSource(item, repoBaseUrl, ref)} | ${escapeTableCell(item.statement)} |`
    ),
  ].join("\n");
}

function formatRulesWithEvidence(rules: string[], evidence: EvidenceItem[]): string {
  if (rules.length === 0) return "_No specific business rules extracted — verify manually._";
  return rules.map((rule) => {
    const item = findEvidenceForStatement(evidence, rule, "business_rule");
    const suffix = item
      ? ` _(basis: ${item.basis}, confidence: ${item.confidence}, source: ${evidenceSourceLabel(item)})_`
      : " _(uncited by analysis; verify manually)_";
    return `- ${rule}${suffix}`;
  }).join("\n");
}

function formatList(items: string[], empty: string): string {
  return items.length > 0
    ? items.map((item) => `- ${item}`).join("\n")
    : empty;
}

function implementationGate(analysis: ComponentAnalysis): string {
  const blockedByRole = analysis.targetRole === "human_review" || analysis.targetRole === "unknown";
  const blockedByQuestions = analysis.humanQuestions.length > 0;
  if (!blockedByRole && !blockedByQuestions) {
    return "This component is ready for agent implementation after the source files and evidence ledger are reviewed.";
  }

  return [
    "Do not implement this component yet.",
    blockedByRole ? `The target role is \`${analysis.targetRole}\`, which requires an architecture decision first.` : "",
    blockedByQuestions ? "Resolve the Human Questions section before asking a coding agent to write code." : "",
  ].filter(Boolean).join(" ");
}

export function buildRewriteContextDoc(
  analysis: ComponentAnalysis,
  frameworkInfo: FrameworkInfo,
  repoBaseUrl: string,
  analysisDate: string,
  repoRef = "HEAD"
): string {
  const { component, confidence, unknownFields } = analysis;

  const confidenceWarning =
    confidence === "low"
      ? "\n> ⚠️ **Low confidence** — AI extraction was uncertain. Read the source files carefully before rewriting.\n"
      : confidence === "medium"
      ? "\n> ⚠️ **Medium confidence** — Some sections may be incomplete. Verify business rules before rewriting.\n"
      : "";

  const unknownWarning =
    unknownFields.length > 0
      ? `\n> The following could not be determined from the code and need manual investigation: **${unknownFields.join(", ")}**\n`
      : "";

  const sourceLinks = component.filePaths
    .map((p) => `- [${p}](${sourceUrl(repoBaseUrl, repoRef, p)})`)
    .join("\n");

  const businessRulesSection =
    formatRulesWithEvidence(analysis.businessRules, analysis.evidence);

  const migrationNotesSection =
    analysis.migrationNotes.length > 0
      ? analysis.migrationNotes.map((n) => `- ${n}`).join("\n")
      : "_No specific migration notes — follow the standard concept mapping._";

  const targetDepsSection =
    analysis.targetDependencies.length > 0
      ? analysis.targetDependencies.map((d) => `- \`${d}\``).join("\n")
      : "_None identified._";

  const dependenciesSection =
    component.dependencies.length > 0
      ? component.dependencies.map((d) => `- ${d}`).join("\n")
      : "_No internal dependencies._";

  return `# Migration Context: ${component.name}

**Type:** ${component.type}
**Source repo:** [${repoBaseUrl.split("/").slice(-2).join("/")}](${repoBaseUrl})
**Migration:** ${frameworkInfo.sourceFramework} (${frameworkInfo.sourceLanguage}) → ${frameworkInfo.targetFramework} (${frameworkInfo.targetLanguage})
**Analyzed:** ${analysisDate}
**Confidence:** ${confidence}
**Complexity:** ${analysis.complexity}
${confidenceWarning}${unknownWarning}
---

## What This Component Does

${analysis.purpose}

---

## Target Architecture Disposition

**Recommended role:** \`${analysis.targetRole}\`

**Rationale:** ${analysis.targetRoleRationale}

**Target integration boundary:** ${analysis.targetIntegrationBoundary}

> This is a migration recommendation, not a silent rewrite instruction. If the role is \`human_review\`, \`unknown\`, inferred, or uncited, resolve the questions below before implementation.

**Implementation gate:** ${implementationGate(analysis)}

---

## Business Rules

${businessRulesSection}

> These rules are non-negotiable. Preserve them exactly in the rewrite.

---

## Evidence & Source Coverage

Facts in this document are classified as:
- **observed** — directly supported by visible source lines
- **inferred** — reasoned from visible code but not directly proven
- **unknown** — not supported by visible source and requires manual review

${formatCoverageSection(analysis.sourceCoverage)}

### Evidence Ledger

${formatEvidenceLedger(analysis.evidence, repoBaseUrl, repoRef)}

---

## Data Contract

**Inputs:**
\`\`\`
${formatContract(analysis.inputContract)}
\`\`\`

**Outputs:**
\`\`\`
${formatContract(analysis.outputContract)}
\`\`\`

---

## Dependencies on Other Components

${dependenciesSection}

> Rewrite dependencies before this component. Check the migration order in \`_index.md\`.

---

## Source Packages Used

${analysis.externalDependencies.length > 0 ? analysis.externalDependencies.map((d) => `- \`${d}\``).join("\n") : "_None._"}

---

## Target Pattern

**${analysis.targetPattern}**

### Install these packages in the rewrite:

${targetDepsSection}

---

## Migration Notes

${migrationNotesSection}

---

## Migration Risks

${formatList(analysis.migrationRisks, "_No specific migration risks identified._")}

---

## Human Questions

${formatList(analysis.humanQuestions, "_No open human questions identified._")}

---

## Validation Scenarios

${formatList(analysis.validationScenarios, "_No critical validation scenarios identified._")}

---

## Source Files

${sourceLinks}

> Open and read all source files above before writing any code.

---

## Rewrite Instructions

You are rewriting **${component.name}** from ${frameworkInfo.sourceLanguage} (${frameworkInfo.sourceFramework}) to ${frameworkInfo.targetLanguage} (${frameworkInfo.targetFramework}).

**Before writing any code:**
1. Read all source files listed above
2. Confirm the business rules section matches what you see in the code
3. Check that all dependencies listed have already been rewritten

**What to produce:**
- A ${frameworkInfo.targetLanguage} implementation of \`${component.name}\` using **${analysis.targetPattern}**
- Install: ${analysis.targetDependencies.join(", ") || "no additional packages"}
- Follow the target project structure from \`_index.md\`

**Business rules are non-negotiable.** Preserve every rule listed above exactly.

---

## Verification Checklist

- [ ] Purpose matches the original behaviour
- [ ] All business rules are implemented
- [ ] Input contract matches (field names, types, validation)
- [ ] Output contract matches (field names, types)
- [ ] All dependencies injected / imported correctly
- [ ] Source packages replaced with target equivalents
- [ ] Tests cover the critical business rules

Reviewed by: _______________  Date: _______________
`;
}

// ---------------------------------------------------------------------------
// Build the master migration index (_index.md)
// ---------------------------------------------------------------------------

export function buildRewriteIndex(
  analyses: ComponentAnalysis[],
  frameworkInfo: FrameworkInfo,
  migrationOrder: string[],
  unanalyzed: string[],
  systemOverview: string,
  analysisDate: string,
  repoBaseUrl: string
): string {
  const repoName = repoBaseUrl.split("/").slice(-2).join("/");

  const componentRows = migrationOrder
    .map((name) => {
      const a = analyses.find((x) => x.component.name === name);
      if (!a) return null;
      const deps = a.component.dependencies.join(", ") || "—";
      const pkgs = a.targetDependencies.join(", ") || "—";
      return `| ${escapeTableCell(a.component.name)} | ${a.component.type} | ${a.targetRole} | ${a.complexity} | ${a.confidence} | ${escapeTableCell(deps)} | ${escapeTableCell(pkgs)} |`;
    })
    .filter(Boolean)
    .join("\n");

  const allTargetDeps = [
    ...new Set(analyses.flatMap((a) => a.targetDependencies)),
  ];

  const lowConfidence = analyses.filter((a) => a.confidence === "low");
  const highComplexity = analyses.filter((a) => a.complexity === "high");
  const allHumanQuestions = analyses.flatMap((a) =>
    a.humanQuestions.map((q) => `- **${a.component.name}**: ${q}`)
  );

  const unanalyzedSection =
    unanalyzed.length > 0
      ? unanalyzed.map((n) => `- \`${n}\` — analysis failed; review manually`).join("\n")
      : "_All components were analyzed._";

  return `# Migration Knowledge Base

_Repo: [${repoName}](${repoBaseUrl}) | Analyzed: ${analysisDate}_
_Migration: ${frameworkInfo.sourceFramework} (${frameworkInfo.sourceLanguage}) → ${frameworkInfo.targetFramework} (${frameworkInfo.targetLanguage})_
_Components: ${analyses.length} analyzed | ${unanalyzed.length} failed_

---

## System Overview

${systemOverview}

---

## Migration Order

Rewrite components in this order (dependencies first):

${migrationOrder.map((name, i) => {
  const a = analyses.find((x) => x.component.name === name);
  const badge = a?.complexity === "high" ? " 🔴" : a?.complexity === "medium" ? " 🟡" : " 🟢";
  return `${i + 1}. **${name}** (${a?.component.type ?? "?"})${badge}`;
}).join("\n")}

🟢 Low complexity &nbsp; 🟡 Medium &nbsp; 🔴 High

---

## Component Map

| Component | Type | Target Role | Complexity | Confidence | Depends On | Target Packages |
|-----------|------|-------------|------------|------------|------------|-----------------|
${componentRows}

---

## Component Disposition

This is the target-architecture landing-zone view. Review anything marked \`human_review\` or \`unknown\` before asking a coding agent to implement it.

| Component | Recommended Target Role | Integration Boundary | Rationale |
|-----------|-------------------------|----------------------|-----------|
${analyses.map((a) => `| ${escapeTableCell(a.component.name)} | ${a.targetRole} | ${escapeTableCell(a.targetIntegrationBoundary)} | ${escapeTableCell(a.targetRoleRationale)} |`).join("\n")}

---

## Human Questions

${allHumanQuestions.length > 0 ? allHumanQuestions.join("\n") : "_No open human questions identified._"}

---

## All Target Packages Needed

\`\`\`
${allTargetDeps.join("\n") || "none identified"}
\`\`\`

---

## Architecture Mapping

**Source:** ${frameworkInfo.sourceFramework} | **Pattern:** ${frameworkInfo.architecturePattern}
**Target:** ${frameworkInfo.targetFramework} | **Language:** ${frameworkInfo.targetLanguage}

See individual context docs in \`context/\` for per-component mapping details.

---

## Needs Manual Review

${lowConfidence.length > 0
  ? lowConfidence.map((a) => `- **${a.component.name}** — low confidence (${a.unknownFields.join(", ")})`).join("\n")
  : "_All components have medium or high confidence._"}

---

## Discovery Limits

This KB is strongest for source paths the analyzer observed directly. Runtime wiring such as DI registrations, reflection, config-driven handlers, generated code, and production-only settings must be reviewed separately before treating the migration plan as complete.

---

## High Complexity — Budget Extra Time

${highComplexity.length > 0
  ? highComplexity.map((a) => `- **${a.component.name}**: ${a.purpose}`).join("\n")
  : "_No high-complexity components identified._"}

---

## Failed Analysis

${unanalyzedSection}

---

_Read individual context docs in \`context/\` for full rewrite instructions per component._
_Paste each context doc into Claude Code / Codex with: "Rewrite this component following the instructions above."_
`;
}
