import { promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import type { FrameworkInfo, SourceComponent } from "./rewriteTypes.js";

export type ModernizationContextDoc = {
  path: string;
  title: string;
  content: string;
  originalChars: number;
  truncated: boolean;
};

export type ModernizationContext = {
  docs: ModernizationContextDoc[];
  warnings: string[];
  defaultArchitectureProfile: string;
};

const WELL_KNOWN_CONTEXT_PATHS = [
  ".ccs/architecture-profile.md",
  ".ccs/modernization-profile.md",
  "architecture-baseline.md",
  "docs/modern-use-case.md",
  "docs/agentic-modernization-architecture.md",
];

const MAX_DOC_CHARS = 12_000;

export const DEFAULT_ARCHITECTURE_PROFILE = `# Default Modernization Architecture Profile

This profile is used when no company-specific architecture profile is provided. Treat it as a decision guide, not as proof that a component belongs in a landing zone.

## Landing Zone Decision Rules

| Target Role | Use When The Legacy Component... | Do Not Use When... | Validation Focus |
|---|---|---|---|
| workflow | coordinates multi-step work, state transitions, retries, approvals, or long-running orchestration | it is a simple stateless request handler | state progression, retry behavior, completion signals |
| azure_function | reacts to one event such as file arrival, message arrival, timer, or narrow API trigger | it needs long-lived in-memory state or broad service ownership | trigger contract, idempotency, retry/dead-letter behavior |
| azure_logic_app | mainly connects systems through SaaS/API connectors and simple branching | it contains complex domain logic | connector contracts, error handling, replay behavior |
| azure_service_bus_flow | publishes/consumes async domain events or decouples services | synchronous request/response semantics are mandatory | message schema, ordering, duplicate handling |
| rest_api | exposes request/response business operations | work is batch/event-driven only | route contract, status codes, validation |
| microservice | owns a bounded business capability and its APIs/data access | it is only a helper or shared library | service boundary, data ownership, operational ownership |
| azure_container_app | needs a long-running service/runtime but not full AKS operational complexity | it is a tiny event handler | startup config, scaling, health probes |
| aks_service | needs Kubernetes-level control, sidecars, custom networking, or high operational complexity | a managed app/container platform is enough | deployment topology, resiliency, observability |
| databricks_job | performs batch analytics, ETL, large data transforms, or reconciliation | it is online transaction logic | input/output datasets, schema drift, reconciliation |
| rules_engine | primarily evaluates changeable business rules/decision tables | rules are simple and stable inside one service | rule parity, versioning, auditability |
| common_library | provides reusable pure functions, models, helpers, or adapters | it owns runtime state or business workflow | API surface, package ownership, compatibility |
| integration_adapter | wraps an external system, vendor API, database, file transfer, or protocol boundary | it owns core business decisions | external contract, timeout/retry mapping |
| human_review | target placement depends on product, architecture, data ownership, compliance, or operational decisions not visible in source | evidence clearly proves a safe landing zone | decision owner, answered question, documented rationale |

## Required Context For High Confidence

- Source files must include the code that owns the trigger, data contract, and completion/error path.
- Architecture notes should define approved landing zones and any forbidden target patterns.
- Business context should define why the system exists and which outcomes matter.
- Validation context should include sample inputs/outputs, database schema, event/file contracts, or legacy parity expectations when available.
`;

function titleFromContent(path: string, content: string): string {
  const heading = content.split("\n").find((line) => line.trim().startsWith("# "));
  return heading?.replace(/^#+\s*/, "").trim() || basename(path);
}

async function readContextDoc(path: string): Promise<ModernizationContextDoc | null> {
  try {
    const resolved = resolve(process.cwd(), path);
    const raw = await fs.readFile(resolved, "utf-8");
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return {
      path,
      title: titleFromContent(path, trimmed),
      content: trimmed.length > MAX_DOC_CHARS
        ? `${trimmed.slice(0, MAX_DOC_CHARS)}\n\n[TRUNCATED: ${trimmed.length - MAX_DOC_CHARS} chars omitted from context document]`
        : trimmed,
      originalChars: trimmed.length,
      truncated: trimmed.length > MAX_DOC_CHARS,
    };
  } catch {
    return null;
  }
}

export async function loadModernizationContext(
  explicitPaths: string[] = [],
  options: { includeWellKnown?: boolean } = {},
): Promise<ModernizationContext> {
  const includeWellKnown = options.includeWellKnown ?? true;
  const pathsByResolvedPath = new Map<string, string>();
  for (const path of [
    ...explicitPaths.filter(Boolean),
    ...(includeWellKnown ? WELL_KNOWN_CONTEXT_PATHS : []),
  ]) {
    if (!pathsByResolvedPath.has(resolve(process.cwd(), path))) {
      pathsByResolvedPath.set(resolve(process.cwd(), path), path);
    }
  }
  const paths = [...pathsByResolvedPath.values()];

  const docs = (await Promise.all(paths.map(readContextDoc)))
    .filter((doc): doc is ModernizationContextDoc => doc !== null);

  const warnings: string[] = [];
  if (docs.length === 0) {
    warnings.push(
      "No modernization context docs were found. Add --context <file> or create .ccs/architecture-profile.md to improve target architecture decisions.",
    );
  }

  return {
    docs,
    warnings,
    defaultArchitectureProfile: DEFAULT_ARCHITECTURE_PROFILE,
  };
}

export function formatModernizationContextForPrompt(context: ModernizationContext): string {
  const docSection = context.docs.length > 0
    ? context.docs
        .map((doc) => `=== ${doc.title} (${doc.path}) ===\n${doc.content}`)
        .join("\n\n")
    : "No company/business context document was provided. Ask human questions when target architecture decisions depend on business intent.";

  return [
    context.defaultArchitectureProfile,
    "",
    "# Business And Architecture Context Documents",
    docSection,
    "",
    "# How To Use This Context",
    "- Prefer explicit company/business context over generic framework mapping.",
    "- If context and source code disagree, mark the decision for human review.",
    "- Do not choose a target role only because of the source file type; choose it from trigger, state, data ownership, and operational responsibility.",
  ].join("\n");
}

export function buildArchitectureBaselineDoc(
  context: ModernizationContext,
  repoUrl: string,
  targetLanguage: string,
  generatedAt: string,
): string {
  const docs = context.docs.length > 0
    ? context.docs.map((doc) => [
        `## ${doc.title}`,
        "",
        `Source: \`${doc.path}\`${doc.truncated ? " (truncated for prompt use)" : ""}`,
        "",
        doc.content,
      ].join("\n")).join("\n\n---\n\n")
    : "_No business or company architecture docs were loaded for this run._";

  return `# Architecture Baseline

_Repo: ${repoUrl}_
_Target language: ${targetLanguage}_
_Generated: ${generatedAt}_

This file is the baseline CCS used to guide target-role decisions. Coding agents should read it before implementing migration components.

---

${context.defaultArchitectureProfile}

---

# Loaded Context Documents

${docs}
`;
}

export function buildPreflightReadinessReport(input: {
  repoUrl: string;
  generatedAt: string;
  tree: string[];
  keyFiles: Array<{ path: string; content: string }>;
  frameworkInfo: FrameworkInfo;
  components: SourceComponent[];
  context: ModernizationContext;
}): string {
  const { repoUrl, generatedAt, tree, keyFiles, frameworkInfo, components, context } = input;
  const hasSource = tree.some((path) => /\.(cs|java|js|ts|py|go|vb|bas|frm|cls|cbl|cob|cpy|pas|dpr)$/i.test(path));
  const hasDbArtifacts = tree.some((path) => /\.(sql|dbml)$/i.test(path) || /schema|migration|database/i.test(path));
  const hasSamples = tree.some((path) => /sample|fixture|testdata|golden|expected/i.test(path));
  const hasDocs = tree.some((path) => /\.(md|rst|txt)$/i.test(path));
  const knownFramework = frameworkInfo.sourceFramework !== "unknown" && frameworkInfo.targetFramework !== "unknown";
  const hasContext = context.docs.length > 0;
  const componentCount = components.filter((component) => component.type !== "test").length;

  const gateRows = [
    ["Source repo reachable", "pass", `${tree.length} files discovered.`],
    ["Source code present", hasSource ? "pass" : "warn", hasSource ? "Source files were found." : "No recognized source files were found."],
    ["Framework detected", knownFramework ? "pass" : "warn", `${frameworkInfo.sourceFramework} -> ${frameworkInfo.targetFramework}`],
    ["Architecture/business context loaded", hasContext ? "pass" : "warn", hasContext ? context.docs.map((doc) => doc.path).join(", ") : "No context docs loaded."],
    ["Components discovered", componentCount > 0 ? "pass" : "warn", `${componentCount} non-test components discovered.`],
    ["Validation samples present", hasSamples ? "pass" : "warn", hasSamples ? "Sample/test data paths found." : "No obvious sample input/output or golden files found."],
    ["Database/schema artifacts present", hasDbArtifacts ? "pass" : "info", hasDbArtifacts ? "Database/schema artifacts found." : "No obvious database/schema artifacts found."],
    ["Repository docs present", hasDocs ? "pass" : "info", hasDocs ? "Repository documentation found." : "No repository documentation files found."],
  ] as const;

  return `# Migration Preflight Readiness

_Repo: ${repoUrl}_
_Generated: ${generatedAt}_

This report tells agents and humans how much migration context existed before component analysis started.

| Gate | Status | Evidence |
|---|---|---|
${gateRows.map(([gate, status, evidence]) => `| ${gate} | ${formatStatus(status)} | ${evidence.replace(/\|/g, "\\|")} |`).join("\n")}

## Context Documents Loaded

${context.docs.length > 0
  ? context.docs.map((doc) => `- \`${doc.path}\` — ${doc.title}${doc.truncated ? " (truncated for prompt use)" : ""}`).join("\n")
  : "- None. Add a business/use-case or architecture profile document for better target decisions."}

## Key Files Used For Framework Detection

${keyFiles.length > 0
  ? keyFiles.map((file) => `- \`${file.path}\``).join("\n")
  : "- None found."}

## Missing Inputs That Would Improve Confidence

${[
  hasContext ? "" : "- Business goal and approved target architecture baseline.",
  hasSamples ? "" : "- Sample inputs/outputs, golden files, or legacy parity examples.",
  hasDbArtifacts ? "" : "- Database schema, stored procedures, or data ownership notes if this system touches persistent data.",
  "- Runtime/deployment notes: triggers, queues, schedules, file locations, environment variables, and production dependencies.",
].filter(Boolean).join("\n")}

## Agent Guidance

- Treat \`pass\` gates as available context, not proof of correctness.
- Treat \`warn\` gates as reasons to ask human questions or lower confidence.
- Do not implement blocked components until architecture and validation gaps are resolved.
`;
}

function formatStatus(status: "pass" | "warn" | "info"): string {
  if (status === "pass") return "pass";
  if (status === "warn") return "warn";
  return "info";
}
