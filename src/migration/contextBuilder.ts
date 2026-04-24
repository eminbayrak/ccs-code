import type { ServiceAnalysis, ServiceMethod } from "./analyzer.js";
import type { ResolvedService } from "./resolver.js";
import type { StaticDbFinding } from "./dbInterrogator.js";
import { renderStaticDbSection } from "./dbInterrogator.js";
import {
  evidenceSourceLabel,
  findEvidenceForStatement,
  summarizeCoverage,
  type EvidenceItem,
  type SourceCoverage,
} from "./evidence.js";

export type ContextBuildInput = {
  analysis: ServiceAnalysis;
  resolved: ResolvedService;
  targetLanguage: string;
  repoBaseUrl: string;
  analysisDate: string;
  dbStaticFinding?: StaticDbFinding;
  entryRef?: string;
  serviceRef?: string;
};

// ---------------------------------------------------------------------------
// Build a GitHub link with optional line anchor
// ---------------------------------------------------------------------------

function ghLink(
  label: string,
  repoBaseUrl: string,
  filePath: string,
  ref = "HEAD",
  startLine?: number,
  endLine?: number
): string {
  const anchor =
    startLine != null
      ? `#L${startLine}${endLine != null ? `-L${endLine}` : ""}`
      : "";
  return `[${label}](${repoBaseUrl}/blob/${ref}/${filePath}${anchor})`;
}

// ---------------------------------------------------------------------------
// Language-specific rewrite conventions
// ---------------------------------------------------------------------------

const LANG_CONVENTIONS: Record<string, string> = {
  csharp: ".NET 8: dependency injection, async/await throughout, ILogger<T>, record types for models",
  typescript: "TypeScript strict mode, async/await, Zod validation on input, no any types",
  java: "Spring Boot 3, @RestController, @Service, constructor injection, CompletableFuture for async",
  python: "FastAPI, Pydantic models for request/response, async def handlers, type hints everywhere",
  go: "Standard library net/http or chi router, interfaces for service layer, explicit error returns",
};

function langConventions(lang: string): string {
  return LANG_CONVENTIONS[lang.toLowerCase()] ?? `${lang} best practices and conventions`;
}

// ---------------------------------------------------------------------------
// Format input/output contract
// ---------------------------------------------------------------------------

function formatContract(contract: Record<string, string>): string {
  if (Object.keys(contract).length === 0) return "unknown";
  return (
    "{\n" +
    Object.entries(contract)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n") +
    "\n}"
  );
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatEvidenceSource(
  evidence: EvidenceItem,
  repoBaseUrl: string,
  ref: string,
): string {
  if (!evidence.sourceFile) return evidenceSourceLabel(evidence);
  const anchor = evidence.lineStart
    ? `#L${evidence.lineStart}${evidence.lineEnd && evidence.lineEnd !== evidence.lineStart ? `-L${evidence.lineEnd}` : ""}`
    : "";
  return `[${evidenceSourceLabel(evidence)}](${repoBaseUrl}/blob/${ref}/${evidence.sourceFile}${anchor})`;
}

function formatEvidenceLedger(
  evidence: EvidenceItem[],
  repoBaseUrl: string,
  ref: string,
): string {
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

function formatCoverageSection(coverage: SourceCoverage): string {
  const lines = summarizeCoverage(coverage).map((line) => `- ${line}`).join("\n");
  const warning = coverage.filesTruncated.length > 0
    ? "\n> Some source was not visible to the analysis model. Uncited or inferred facts must be checked against the full source before migration."
    : "";
  return `${lines}${warning}`;
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

// ---------------------------------------------------------------------------
// Format all methods section
// ---------------------------------------------------------------------------

function formatMethodsSection(methods: ServiceMethod[], lang: string): string {
  if (methods.length === 0) return "_No methods extracted — verify manually._";
  const ext = lang === "csharp" ? "cs" : lang === "java" ? "java" : "ts";
  return methods
    .map((m) => {
      const rules =
        m.businessRules.length > 0
          ? m.businessRules.map((r) => `  - ${r}`).join("\n")
          : "  - _no rules extracted_";
      const input = Object.keys(m.input).length > 0
        ? Object.entries(m.input).map(([k, v]) => `  ${k}: ${v}`).join(", ")
        : "unknown";
      const output = Object.keys(m.output).length > 0
        ? Object.entries(m.output).map(([k, v]) => `  ${k}: ${v}`).join(", ")
        : "unknown";
      return `### \`${m.name}\`
_${m.purpose}_

**Input:** \`${input}\`
**Output:** \`${output}\`
**Rules:**
${rules}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Build the per-service context document
// ---------------------------------------------------------------------------

export function buildContextDoc(input: ContextBuildInput): string {
  const {
    analysis,
    resolved,
    targetLanguage,
    repoBaseUrl,
    analysisDate,
    dbStaticFinding,
    entryRef = "HEAD",
    serviceRef = "HEAD",
  } = input;

  const confidenceNote =
    analysis.confidence === "low"
      ? "\n> ⚠️ **Low confidence** — AI extraction was uncertain. Verify all sections manually before rewriting."
      : analysis.confidence === "medium"
      ? "\n> ⚠️ **Medium confidence** — Some sections may be incomplete. Verify business rules before rewriting."
      : "";

  const unknownWarning =
    analysis.unknownFields.length > 0
      ? `\n> The following fields could not be determined: ${analysis.unknownFields.join(", ")}\n`
      : "";

  const businessRulesSection =
    formatRulesWithEvidence(analysis.businessRules, analysis.evidence);

  const dbSection =
    analysis.databaseInteractions.length > 0
      ? analysis.databaseInteractions.map((d) => `- \`${d}\``).join("\n")
      : "_No direct database interactions found in this layer._";

  const nestedSection =
    analysis.nestedServiceCalls.length > 0
      ? analysis.nestedServiceCalls.map((s) => `- ${s}`).join("\n")
      : "_No nested service calls found._";

  const errorSection =
    analysis.errorHandling.length > 0
      ? analysis.errorHandling.map((e) => `- ${e}`).join("\n")
      : "_No error handling patterns extracted._";

  const statusSection =
    analysis.statusValues.length > 0
      ? analysis.statusValues.map((s) => `- \`${s}\``).join("\n")
      : "_No enum/status values extracted._";

  const methodsSection = formatMethodsSection(analysis.allMethods, targetLanguage);

  const fileExt = targetLanguage === "csharp" ? "cs" : targetLanguage === "java" ? "java" : "ts";
  const rewriteTargets = [
    `Controller.${fileExt}`,
    `${analysis.namespace.replace("Manager", "Service")}.${fileExt}`,
    `Models/${analysis.namespace.replace("Manager", "")}.${fileExt}`,
  ];

  const callerLink = ghLink(
    analysis.callerFile.split("/").pop() ?? analysis.callerFile,
    repoBaseUrl,
    analysis.callerFile,
    entryRef,
    analysis.callerLine
  );

  const serviceRepoBase = resolved.htmlUrl.split("/blob")[0] ?? resolved.htmlUrl;
  const serviceFileLinks = analysis.rawFiles
    .map((f) => {
      const label = f.split("/").pop() ?? f;
      return `| ${ghLink(label, serviceRepoBase, f, serviceRef)} | Service implementation |`;
    })
    .join("\n");

  return `# Migration Context: ${analysis.namespace}

**Discovered via:** ${callerLink}
**Service namespace:** \`${analysis.namespace}\`
**Primary method:** \`${analysis.methodName}\`
**Source repo:** ${resolved.repoFullName}
**Target language:** ${targetLanguage}
**Analyzed:** ${analysisDate}
**Confidence:** ${analysis.confidence}
**Status:** todo
${confidenceNote}${unknownWarning}
---

## What This Service Does

${analysis.purpose}

---

## Full Data Flow

\`\`\`
${analysis.dataFlow}
\`\`\`

---

## All Methods

${methodsSection}

---

## Business Rules (Service-Wide)

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

${formatEvidenceLedger(analysis.evidence, serviceRepoBase, serviceRef)}

---

## Error Handling

${errorSection}

---

## Status & Enum Values

${statusSection}

---

## Data Contract (Primary Method: \`${analysis.methodName}\`)

**Input:**
\`\`\`
${formatContract(analysis.inputContract)}
\`\`\`

**Output:**
\`\`\`
${formatContract(analysis.outputContract)}
\`\`\`

---

## Database Interactions

${dbSection}

> Do not preserve legacy SOAP as a blind wrapper. Choose the replacement integration boundary from evidence: direct data-layer access only when the source clearly supports it; otherwise use the target service/API/queue boundary and document the decision.

---

${dbStaticFinding ? renderStaticDbSection(dbStaticFinding) + "\n\n---\n" : ""}

## Nested Service Calls

${nestedSection}

---

## Source Files

| File | Purpose |
|------|---------|
| ${callerLink} | Node.js caller — entry point |
${serviceFileLinks}

---

## Rewrite Instructions

You are rewriting \`${analysis.namespace}\` as a \`${targetLanguage}\` REST API.

**Before writing any code, open and read every source file listed above.**

**Produce the following files:**
${rewriteTargets.map((t, i) => `${i + 1}. \`${t}\``).join("\n")}

**Implement every method listed in the "All Methods" section above.**

**Preserve these business rules exactly — they are non-negotiable:**
${analysis.businessRules.length > 0 ? analysis.businessRules.map((r) => `- ${r}`).join("\n") : "- Verify business rules manually (low extraction confidence)"}

**Error handling:**
${analysis.errorHandling.length > 0 ? analysis.errorHandling.map((e) => `- ${e}`).join("\n") : "- Verify error handling manually"}

**Architecture:**
- No blind SOAP wrapper; replace the legacy boundary with the evidence-backed target integration pattern
- ${langConventions(targetLanguage)}
- Return proper HTTP status codes mapped from the error conditions above

---

## Before You Rewrite — Verify These

- [ ] All methods in the "All Methods" section are complete and accurate
- [ ] Every business rule is present and unambiguous
- [ ] Input/output contracts match the actual WSDL or implementation
- [ ] All database interactions (tables, columns, stored procs) are accounted for
- [ ] Error handling maps correctly to HTTP status codes
- [ ] No nested service calls are missing

Reviewed by: _______________  Date: _______________
`;
}
