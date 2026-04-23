import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";

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

export function buildRewriteContextDoc(
  analysis: ComponentAnalysis,
  frameworkInfo: FrameworkInfo,
  repoBaseUrl: string,
  analysisDate: string
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
    .map((p) => `- [${p}](${repoBaseUrl}/blob/main/${p})`)
    .join("\n");

  const businessRulesSection =
    analysis.businessRules.length > 0
      ? analysis.businessRules.map((r) => `- ${r}`).join("\n")
      : "_No specific business rules extracted — verify manually._";

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

## Business Rules

${businessRulesSection}

> These rules are non-negotiable. Preserve them exactly in the rewrite.

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
      return `| ${a.component.name} | ${a.component.type} | ${a.complexity} | ${a.confidence} | ${deps} | ${pkgs} |`;
    })
    .filter(Boolean)
    .join("\n");

  const allTargetDeps = [
    ...new Set(analyses.flatMap((a) => a.targetDependencies)),
  ];

  const lowConfidence = analyses.filter((a) => a.confidence === "low");
  const highComplexity = analyses.filter((a) => a.complexity === "high");

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

| Component | Type | Complexity | Confidence | Depends On | Target Packages |
|-----------|------|------------|------------|------------|-----------------|
${componentRows}

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
