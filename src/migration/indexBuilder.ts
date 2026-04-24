import { promises as fs } from "fs";
import { join } from "path";
import type { LLMProvider } from "../llm/providers/base.js";
import type { ServiceAnalysis } from "./analyzer.js";
import type { MigrationStatus } from "./statusTracker.js";

// ---------------------------------------------------------------------------
// Generate the system overview paragraph
// ---------------------------------------------------------------------------

async function generateSystemOverview(
  analyses: ServiceAnalysis[],
  entryRepo: string,
  provider: LLMProvider
): Promise<string> {
  if (analyses.length === 0) return "No services analyzed yet.";

  const serviceList = analyses
    .map(
      (a) =>
        `- ${a.namespace} (${a.methodName}): ${a.purpose === "unknown" ? "purpose unclear" : a.purpose}`
    )
    .join("\n");

  const response = await provider.chat(
    [
      {
        role: "user",
        content: `Write a 2-3 sentence plain-language overview of this legacy backend system based on its services.
Do not mention technology specifics — describe what the system does for the business.

Entry repo: ${entryRepo}

Services found:
${serviceList}

Respond with ONLY the overview paragraph. No headers, no lists.`,
      },
    ],
    "You write clear, concise technical documentation. Respond with plain text only."
  );

  return response.trim();
}

// ---------------------------------------------------------------------------
// Find shared services — called by 2+ other services
// ---------------------------------------------------------------------------

const PLACEHOLDER_NS = new Set(["unknown", "none", "n/a", "null", "undefined"]);

function findSharedServices(analyses: ServiceAnalysis[]): string[] {
  const calledBy = new Map<string, number>();
  for (const a of analyses) {
    for (const nested of a.nestedServiceCalls) {
      const ns = nested.split(".")[0];
      if (ns && !PLACEHOLDER_NS.has(ns.toLowerCase())) {
        calledBy.set(ns, (calledBy.get(ns) ?? 0) + 1);
      }
    }
  }
  return [...calledBy.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([ns]) => ns);
}

// ---------------------------------------------------------------------------
// Build and write the system index
// ---------------------------------------------------------------------------

export async function buildIndex(
  migrationDir: string,
  analyses: ServiceAnalysis[],
  status: MigrationStatus,
  unresolvedNamespaces: string[],
  provider: LLMProvider
): Promise<string> {
  const overview = await generateSystemOverview(analyses, status.entryRepo, provider);
  const sharedServices = findSharedServices(analyses);

  const allDbInteractions = [
    ...new Set(analyses.flatMap((a) => a.databaseInteractions)),
  ];

  const serviceRows = analyses
    .map((a) => {
      const svcRecord = status.services.find((s) => s.namespace === a.namespace);
      const statusVal = svcRecord?.status ?? "discovered";
      const conf = a.confidence;
      const calls = a.nestedServiceCalls.join(", ") || "—";
      const db = a.databaseInteractions
        .map((d) => (d.split("—")[0] ?? d).replace("table:", "").trim())
        .join(", ") || "—";
      return `| ${a.namespace} | ${a.callerFile.split("/").pop()} | ${calls} | ${db} | ${conf} | ${statusVal} |`;
    })
    .join("\n");

  const sharedSection =
    sharedServices.length > 0
      ? sharedServices
          .map((ns) => {
            const callerCount = analyses.filter((a) =>
              a.nestedServiceCalls.some((c) => c.startsWith(ns))
            ).length;
            return `- **${ns}** — called by ${callerCount} other services. Rewrite this first to unblock others.`;
          })
          .join("\n")
      : "_No shared dependencies identified._";

  const unresolvedSection =
    unresolvedNamespaces.length > 0
      ? unresolvedNamespaces
          .map((ns) => `- \`${ns}\` — searched org, no matching repo found. Requires manual input.`)
          .join("\n")
      : "_All service namespaces were resolved._";

  const lowConfSection = analyses
    .filter((a) => a.confidence === "low")
    .map((a) => `- **${a.namespace}**: ${a.purpose === "unknown" ? "purpose unknown" : a.purpose}`)
    .join("\n");

  const index = `# Migration Knowledge Base

_Scanned: ${status.scannedAt.slice(0, 10)} | Entry: ${status.entryRepo} | Target: ${status.targetLanguage}_
_Services: ${analyses.length} analyzed | ${unresolvedNamespaces.length} unresolved_

---

## System Overview

${overview}

---

## Service Map

| Service | Discovered Via | Calls | DB Tables | Confidence | Status |
|---------|---------------|-------|-----------|------------|--------|
${serviceRows}

---

## Shared Dependencies — Rewrite These First

${sharedSection}

---

## Database Interactions (All Services)

${allDbInteractions.length > 0 ? allDbInteractions.map((d) => `- \`${d}\``).join("\n") : "_None found._"}

---

## Unresolved Services — Needs Manual Input

${unresolvedSection}

---

## Low Confidence — Verify Before Rewriting

${lowConfSection || "_All services have medium or high confidence._"}

---

## Discovery Limits

This KB is strongest for source paths the scanner observed directly. Runtime wiring such as DI registrations, reflection, config-driven handlers, generated code, and production-only settings must be reviewed separately before treating the migration plan as complete.

---

_Read the individual context docs in \`context/\` for full rewrite instructions per service._
`;

  const kbDir = join(migrationDir, "knowledge-base");
  await fs.mkdir(kbDir, { recursive: true });
  const indexPath = join(kbDir, "_index.md");
  await fs.writeFile(indexPath, index, "utf-8");

  return indexPath;
}
