import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";
import type { ModernizationContext } from "./modernizationContext.js";
import {
  evidenceSourceLabel,
  findEvidenceForStatement,
  summarizeCoverage,
  type EvidenceItem,
  type SourceCoverage,
} from "./evidence.js";
import {
  formatVerificationMarkdown,
  type ComponentVerification,
} from "./rewriteVerifier.js";

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

function isImplementationReady(analysis: ComponentAnalysis): boolean {
  return analysis.targetRole !== "human_review" &&
    analysis.targetRole !== "unknown";
}

function implementationGate(analysis: ComponentAnalysis): string {
  const blockedByRole = analysis.targetRole === "human_review" || analysis.targetRole === "unknown";
  if (!blockedByRole && analysis.humanQuestions.length === 0) {
    return "This component is ready for agent implementation after the source files and evidence ledger are reviewed.";
  }

  return [
    blockedByRole ? "Do not implement this component yet." : "Review this component before implementation.",
    blockedByRole ? `The target role is \`${analysis.targetRole}\`, which requires an architecture decision first.` : "",
    analysis.humanQuestions.length > 0 ? "The Human Questions section contains architecture or product decisions that should be accepted, answered, or downgraded before coding." : "",
  ].filter(Boolean).join(" ");
}

function agentReadinessSummary(
  analysis: ComponentAnalysis,
  verification?: ComponentVerification,
): string {
  const baseReady = isImplementationReady(analysis);
  const reasons: string[] = [];

  if (analysis.targetRole === "human_review" || analysis.targetRole === "unknown") {
    reasons.push(`target role is \`${analysis.targetRole}\``);
  }
  if (analysis.humanQuestions.length > 0) {
    reasons.push("human questions require review");
  }
  if (analysis.confidence === "low") {
    reasons.push("analysis confidence is low");
  }
  if (analysis.unknownFields.length > 0) {
    reasons.push(`unknown fields: ${analysis.unknownFields.join(", ")}`);
  }

  // Verification can demote a base-ready component to needs_review or blocked.
  let status: "ready" | "needs_review" | "blocked";
  if (analysis.targetRole === "human_review" || analysis.targetRole === "unknown") {
    status = "blocked";
  } else if (!baseReady || analysis.humanQuestions.length > 0 || analysis.confidence === "low" || analysis.sourceCoverage.filesTruncated.length > 0) {
    status = "needs_review";
  } else if (!verification) {
    status = "ready";
  } else if (verification.trustVerdict === "blocked") {
    status = "blocked";
  } else if (verification.trustVerdict === "needs_review") {
    status = "needs_review";
  } else {
    status = "ready";
  }

  if (verification) {
    if (verification.trustVerdict !== "ready") {
      reasons.push(...verification.trustReasons);
    }
    reasons.push(
      `verification: ${verification.totals.verified}/${verification.totals.claimsChecked} claims verified by ${verification.verifierModel}`,
    );
  } else {
    reasons.push("verification: not run for this component");
  }

  const safeAction =
    status === "ready"
      ? "A coding agent may implement this component after reading the source files, evidence ledger, and validation scenarios."
      : status === "needs_review"
        ? "A reviewer must confirm or rewrite the flagged claims before a coding agent implements this component."
        : "Do not ask a coding agent to implement this component until the blockers below are resolved.";

  const blockerText = reasons.length > 0
    ? reasons.map((reason) => `- ${reason}`).join("\n")
    : "- none";

  return `**Status:** \`${status}\`

**Safe action:** ${safeAction}

**Why this matters:** This report is useful only if it tells the coding agent what is proven, what to preserve, where the component belongs in the target architecture, and when to stop. The verification pass below shows which load-bearing claims were confirmed against the cited source.

**Current blockers or review notes:**
${blockerText}`;
}

function formatModernizationBaseline(
  modernizationContext?: ModernizationContext,
  linkPrefix = "",
): string {
  const docs = modernizationContext?.docs ?? [];
  const contextList = docs.length > 0
    ? docs.map((doc) => `- \`${doc.path}\` — ${doc.title}${doc.truncated ? " (truncated for prompt use)" : ""}`).join("\n")
    : "- No business or company architecture document was loaded; CCS used the default modernization profile only.";

  return `Read \`${linkPrefix}architecture-baseline.md\` and \`${linkPrefix}preflight-readiness.md\` before implementation. They explain the business/architecture baseline, missing context, and target-role decision rules used by this analysis.

**Loaded context documents:**
${contextList}`;
}

export function buildRewriteContextDoc(
  analysis: ComponentAnalysis,
  frameworkInfo: FrameworkInfo,
  repoBaseUrl: string,
  analysisDate: string,
  repoRef = "HEAD",
  modernizationContext?: ModernizationContext,
  verification?: ComponentVerification,
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

## Agent Readiness Summary

${agentReadinessSummary(analysis, verification)}

---

${verification ? `${formatVerificationMarkdown(verification)}

> Implementation status is gated on the trust verdict above. \`needs_review\` and \`blocked\` components must be reviewed before a coding agent picks them up.

---

` : ""}## Modernization Baseline

${formatModernizationBaseline(modernizationContext, "../")}

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

> Rewrite dependencies before this component. Check the migration order in \`README.md\`.

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
- Follow the target project structure from \`README.md\` and \`AGENTS.md\`

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
  repoBaseUrl: string,
  modernizationContext?: ModernizationContext,
  verifications?: Map<string, ComponentVerification>,
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

  // Effective gate: base readiness AND verification trust verdict.
  const effectiveGate = (a: ComponentAnalysis): "ready" | "needs_review" | "blocked" => {
    if (a.targetRole === "human_review" || a.targetRole === "unknown") return "blocked";
    if (!isImplementationReady(a) || a.humanQuestions.length > 0 || a.confidence === "low" || a.sourceCoverage.filesTruncated.length > 0) return "needs_review";
    const v = verifications?.get(a.component.name);
    if (!v) return "ready";
    if (v.trustVerdict === "blocked") return "blocked";
    if (v.trustVerdict === "needs_review") return "needs_review";
    return "ready";
  };
  const ready = analyses.filter((a) => effectiveGate(a) === "ready");
  const needsReview = analyses.filter((a) => effectiveGate(a) === "needs_review");
  const blocked = analyses.filter((a) => effectiveGate(a) === "blocked");
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

## Modernization Baseline

${formatModernizationBaseline(modernizationContext)}

---

## Agent Readiness

This KB is useful for Codex or Claude Code only when a component has a clear target role, source-backed behavior, and no unresolved implementation-shaping questions.

- Ready for implementation: **${ready.length}**
- Needs review: **${needsReview.length}**
- Blocked pending target-role or architecture review: **${blocked.length}**

${needsReview.length > 0
  ? `**Needs review:**\n${needsReview.map((a) => {
      const v = verifications?.get(a.component.name);
      const reason = v?.trustReasons.join("; ") || "verification flagged claims";
      return `- **${a.component.name}** — ${reason} (see \`components/${a.component.name}.md\`)`;
    }).join("\n")}\n`
  : ""}
${blocked.length > 0
  ? `**Blocked:**\n${blocked.map((a) => `- **${a.component.name}** — ${implementationGate(a)}`).join("\n")}`
  : "_No blocked components identified._"}

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

See individual context docs in \`components/\` for per-component mapping details.

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

_Read individual context docs in \`components/\` for full rewrite instructions per component._
_Paste each context doc into Claude Code / Codex with: "Rewrite this component following the instructions above."_
`;
}
