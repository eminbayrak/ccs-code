import type { ServiceAnalysis } from "./analyzer.js";
import type { ResolvedService } from "./resolver.js";

export type ContextBuildInput = {
  analysis: ServiceAnalysis;
  resolved: ResolvedService;
  targetLanguage: string;
  repoBaseUrl: string;
  analysisDate: string;
};

// ---------------------------------------------------------------------------
// Build a GitHub link with optional line anchor
// ---------------------------------------------------------------------------

function ghLink(
  label: string,
  repoBaseUrl: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): string {
  const anchor =
    startLine != null
      ? `#L${startLine}${endLine != null ? `-L${endLine}` : ""}`
      : "";
  return `[${label}](${repoBaseUrl}/blob/main/${filePath}${anchor})`;
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

// ---------------------------------------------------------------------------
// Build the per-service context document
// ---------------------------------------------------------------------------

export function buildContextDoc(input: ContextBuildInput): string {
  const { analysis, resolved, targetLanguage, repoBaseUrl, analysisDate } = input;

  const confidenceNote =
    analysis.confidence === "low"
      ? "\n> ⚠️ **Low confidence** — AI extraction was uncertain. Verify all sections manually before rewriting."
      : analysis.confidence === "medium"
      ? "\n> ⚠️ **Medium confidence** — Some sections may be incomplete. Verify business rules before rewriting."
      : "";

  const unknownWarning =
    analysis.unknownFields.length > 0
      ? `\n> The following fields could not be determined from the code and require manual investigation: ${analysis.unknownFields.join(", ")}\n`
      : "";

  const businessRulesSection =
    analysis.businessRules.length > 0
      ? analysis.businessRules
          .map((r) => `- ${r}`)
          .join("\n")
      : "_No specific business rules extracted — verify manually._";

  const dbSection =
    analysis.databaseInteractions.length > 0
      ? analysis.databaseInteractions.map((d) => `- \`${d}\``).join("\n")
      : "_No direct database interactions found in this layer._";

  const nestedSection =
    analysis.nestedServiceCalls.length > 0
      ? analysis.nestedServiceCalls.map((s) => `- ${s}`).join("\n")
      : "_No nested service calls found._";

  const rewriteTargets = [
    `Controller.${targetLanguage === "csharp" ? "cs" : "ts"}`,
    `${analysis.namespace.replace("Manager", "Service")}.${targetLanguage === "csharp" ? "cs" : "ts"}`,
    `Models/${analysis.namespace.replace("Manager", "")}.${targetLanguage === "csharp" ? "cs" : "ts"}`,
  ];

  const callerLink = ghLink(
    analysis.callerFile.split("/").pop() ?? analysis.callerFile,
    repoBaseUrl,
    analysis.callerFile,
    analysis.callerLine
  );

  const serviceFileLinks = analysis.rawFiles
    .map((f) => {
      const label = f.split("/").pop() ?? f;
      return `| ${ghLink(label, resolved.htmlUrl.split("/blob")[0] ?? resolved.htmlUrl, f)} | Service implementation |`;
    })
    .join("\n");

  return `# Migration Context: ${analysis.namespace}

**Discovered via:** ${callerLink} → \`constructSoapRequest\`
**Service namespace:** \`${analysis.namespace}\`
**Method:** \`${analysis.methodName}\`
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

## Business Rules

${businessRulesSection}

> These rules are non-negotiable. Preserve them exactly in the rewrite.

---

## Data Contract

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

> DB analysis is documented here for reference. Connect directly to the database in the rewrite.

---

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

**Before writing any code, open and read all source files listed above.**

**Produce the following files:**
${rewriteTargets.map((t, i) => `${i + 1}. \`${t}\``).join("\n")}

**Preserve these business rules exactly — they are non-negotiable:**
${analysis.businessRules.length > 0 ? analysis.businessRules.map((r) => `- ${r}`).join("\n") : "- Verify business rules manually (low extraction confidence)"}

**Architecture:**
- No legacy SOAP calls — connect to the data layer directly
- ${langConventions(targetLanguage)}
- All business rules listed above must be preserved exactly

---

## Before You Rewrite — Verify These

- [ ] The purpose description accurately reflects what this service does
- [ ] The data flow matches what the code actually does
- [ ] All business rules are complete and accurate
- [ ] The input and output contracts are correct
- [ ] All database interactions are accounted for
- [ ] No nested service calls are missing

Reviewed by: _______________  Date: _______________
`;
}
