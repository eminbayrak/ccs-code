import type { LLMProvider } from "../llm/providers/base.js";
import { basename } from "node:path";
import type {
  ComponentType,
  SourceComponent,
  FrameworkInfo,
  ComponentAnalysis,
  TargetArchitectureRole,
} from "./rewriteTypes.js";
import { getFrameworkMapping, formatMappingForPrompt } from "./frameworkMapper.js";
import {
  buildNumberedSourceExcerpt,
  buildSourceCoverage,
  normalizeEvidenceItems,
  summarizeCoverage,
} from "./evidence.js";

function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced?.[1] ?? raw).trim();
  const first = text.indexOf("{");
  if (first === -1) throw new Error("No JSON object found in model response.");

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = first; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(first, i + 1);
    }
  }

  throw new Error("Model response contained an unterminated JSON object.");
}

function parseJsonObject(raw: string): Record<string, unknown> {
  return JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
}

function normalizeComponentAlias(value: string): string {
  return value
    .replace(/\.[^.\\/]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase();
}

function dependencyAliasesFor(component: SourceComponent): string[] {
  const aliases = [component.name];
  for (const path of component.filePaths) {
    aliases.push(basename(path));
    aliases.push(basename(path).replace(/\.[^.]+$/, ""));
  }
  return aliases.map(normalizeComponentAlias).filter(Boolean);
}

function normalizeComponentDependencies(components: SourceComponent[]): SourceComponent[] {
  const aliasToName = new Map<string, string>();
  for (const component of components) {
    for (const alias of dependencyAliasesFor(component)) {
      if (!aliasToName.has(alias)) aliasToName.set(alias, component.name);
    }
  }

  return components.map((component) => ({
    ...component,
    dependencies: [...new Set(component.dependencies.map((dependency) => {
      const normalized = normalizeComponentAlias(dependency);
      return aliasToName.get(normalized) ?? dependency;
    }).filter((dependency) => dependency && dependency !== component.name))],
  }));
}

// ---------------------------------------------------------------------------
// Step 1 — Detect source framework from file tree + key file contents
// ---------------------------------------------------------------------------

export async function detectFramework(
  filePaths: string[],
  keyFileContents: Array<{ path: string; content: string }>,
  targetLanguage: string,
  provider: LLMProvider
): Promise<FrameworkInfo> {
  const tree = filePaths.slice(0, 200).join("\n");
  const samples = keyFileContents
    .slice(0, 3)
    .map((f) => `=== ${f.path} ===\n${f.content.slice(0, 2000)}`)
    .join("\n\n");

  const raw = await provider.chat(
    [
      {
        role: "user",
        content: `Detect the framework and architecture of this codebase.

File tree (first 200 paths):
${tree}

Key file samples:
${samples}

Target language for migration: ${targetLanguage}

Respond with ONLY this JSON:
{
  "sourceFramework": "aspnet-core | spring-boot | express | laravel | rails | django | flask | unknown",
  "sourceLanguage": "csharp | java | typescript | javascript | php | ruby | python | unknown",
  "targetFramework": "best framework for ${targetLanguage} given the source (e.g. fastapi for python, gin for go, express for nodejs)",
  "targetLanguage": "${targetLanguage}",
  "architecturePattern": "layered | mvc | ddd | hexagonal | monolith | microservice | unknown",
  "packageManager": "nuget | maven | gradle | npm | pip | composer | bundler | unknown"
}`,
      },
    ],
    "You detect software frameworks and architecture patterns. Respond with valid JSON only."
  );

  try {
    const parsed = parseJsonObject(raw) as Partial<FrameworkInfo>;
    return {
      sourceFramework:    parsed.sourceFramework    ?? "unknown",
      sourceLanguage:     parsed.sourceLanguage     ?? "unknown",
      targetFramework:    parsed.targetFramework    ?? "unknown",
      targetLanguage:     parsed.targetLanguage     ?? targetLanguage,
      architecturePattern: parsed.architecturePattern ?? "unknown",
      packageManager:     parsed.packageManager     ?? "unknown",
    };
  } catch {
    return {
      sourceFramework: "unknown",
      sourceLanguage: "unknown",
      targetFramework: "unknown",
      targetLanguage,
      architecturePattern: "unknown",
      packageManager: "unknown",
    };
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Discover all components from the file tree
// ---------------------------------------------------------------------------

export async function discoverComponents(
  filePaths: string[],
  frameworkInfo: FrameworkInfo,
  provider: LLMProvider
): Promise<SourceComponent[]> {
  const tree = filePaths.join("\n");

  const raw = await provider.chat(
    [
      {
        role: "user",
        content: `List all meaningful components in this ${frameworkInfo.sourceFramework} codebase.

File tree:
${tree}

Framework: ${frameworkInfo.sourceFramework} (${frameworkInfo.sourceLanguage})
Architecture: ${frameworkInfo.architecturePattern}

Identify components by role. Skip test files, migrations, auto-generated code, and config-only files.

Respond with ONLY this JSON:
{
  "components": [
    {
      "name": "OrderController",
      "type": "controller | service | repository | model | dto | middleware | config | utility | unknown",
      "filePaths": ["Controllers/OrderController.cs"],
      "dependencies": ["OrderService"],
      "description": "one sentence — what this component does"
    }
  ]
}`,
      },
    ],
    "You identify software components from file trees. Respond with valid JSON only."
  );

  try {
    const parsed = parseJsonObject(raw) as { components?: unknown[] };
    if (!Array.isArray(parsed.components)) return [];

    const components = parsed.components
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
      .map((c) => ({
        name:         typeof c["name"]        === "string" ? c["name"]        : "unknown",
        type:        (typeof c["type"]        === "string" ? c["type"]        : "unknown") as ComponentType,
        filePaths:    Array.isArray(c["filePaths"])    ? (c["filePaths"] as string[]).filter((p) => typeof p === "string")    : [],
        dependencies: Array.isArray(c["dependencies"]) ? (c["dependencies"] as string[]).filter((d) => typeof d === "string") : [],
        description:  typeof c["description"] === "string" ? c["description"] : "",
      }));
    return normalizeComponentDependencies(components);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Deep-analyze one component (Sonnet)
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM = `You are a senior software architect documenting a legacy codebase for migration.
Extract accurate, complete information. Use "unknown" for anything you cannot determine from the code.
Respond only with valid JSON.`;

const TARGET_ROLES = [
  "workflow",
  "azure_function",
  "azure_container_app",
  "aks_service",
  "azure_logic_app",
  "azure_service_bus_flow",
  "azure_api_management",
  "azure_blob_storage",
  "azure_sql",
  "cosmos_db",
  "camunda_workflow",
  "databricks_job",
  "rest_api",
  "microservice",
  "common_library",
  "rules_engine",
  "data_model",
  "integration_adapter",
  "human_review",
  "unknown",
] as const satisfies readonly TargetArchitectureRole[];

function normalizeTargetRole(value: unknown): TargetArchitectureRole {
  return TARGET_ROLES.includes(value as TargetArchitectureRole)
    ? value as TargetArchitectureRole
    : "unknown";
}

export async function analyzeComponent(
  component: SourceComponent,
  sourceFiles: Array<{ path: string; content: string }>,
  frameworkInfo: FrameworkInfo,
  provider: LLMProvider,
  modernizationGuidance = "",
): Promise<ComponentAnalysis> {
  const mapping = getFrameworkMapping(
    frameworkInfo.sourceFramework,
    frameworkInfo.targetFramework
  );
  const mappingSection = mapping
    ? `\nFramework migration reference:\n${formatMappingForPrompt(mapping)}\n`
    : "";

  const maxCharsPerFile = sourceFiles.length <= 1
    ? 24_000
    : sourceFiles.length <= 3
      ? 16_000
      : 10_000;
  const excerpts = sourceFiles.map((f) =>
    buildNumberedSourceExcerpt(f.path, f.content, maxCharsPerFile)
  );
  const sourceCoverage = buildSourceCoverage(excerpts);
  const fileBundle = excerpts
    .map((f) => `=== FILE: ${f.path} ===\n${f.content}`)
    .join("\n\n");
  const modernizationSection = modernizationGuidance.trim()
    ? `\nModernization context and target architecture baseline:\n${modernizationGuidance.trim()}\n`
    : "";
  const coverageNote = sourceCoverage.filesTruncated.length > 0
    ? `\nIMPORTANT SOURCE COVERAGE LIMITATION:\n${summarizeCoverage(sourceCoverage).map((line) => `- ${line}`).join("\n")}\nIf a business rule, dependency, or contract could live outside the visible lines, mark the related field as inferred or unknown and do not use high confidence for it.\n`
    : "";

  const raw = await provider.chat(
    [
      {
        role: "user",
        content: `Analyze this ${frameworkInfo.sourceLanguage} component for migration to ${frameworkInfo.targetLanguage}.

Component: ${component.name} (${component.type})
Description: ${component.description}
Dependencies: ${component.dependencies.join(", ") || "none"}
${mappingSection}
${modernizationSection}
${coverageNote}
Source files with line numbers:
${fileBundle}

Respond with ONLY this JSON (use "unknown" for anything you cannot determine):
{
  "purpose": "one sentence — business intent, not code mechanics",
  "businessRules": ["concrete rule extracted from code logic"],
  "evidence": [
    {
      "kind": "business_rule | data_contract | dependency | external_dependency | migration_note | purpose",
      "statement": "same wording as the extracted fact this supports",
      "basis": "observed | inferred | unknown",
      "sourceFile": "relative/path/to/file.cs or null",
      "lineStart": 42,
      "lineEnd": 45,
      "confidence": "high | medium | low"
    }
  ],
  "inputContract": { "fieldName": "type and constraint" },
  "outputContract": { "fieldName": "type" },
  "externalDependencies": ["NuGet/npm package names used"],
  "targetPattern": "exact pattern to use in ${frameworkInfo.targetLanguage} (e.g. FastAPI APIRouter with Pydantic schemas)",
  "targetRole": "workflow | azure_function | azure_container_app | aks_service | azure_logic_app | azure_service_bus_flow | azure_api_management | azure_blob_storage | azure_sql | cosmos_db | camunda_workflow | databricks_job | rest_api | microservice | common_library | rules_engine | data_model | integration_adapter | human_review | unknown",
  "targetRoleRationale": "why this component should land in that target architecture role; cite evidence when possible",
  "targetIntegrationBoundary": "event/topic/API/database/file boundary this component should expose or consume in the target architecture, or unknown",
  "targetDependencies": ["pip/npm package names needed in the rewrite"],
  "migrationNotes": ["specific things to watch out for when rewriting"],
  "migrationRisks": ["specific risk that could break behaviour during migration"],
  "humanQuestions": ["question an architect/product owner must answer before implementation"],
  "validationScenarios": ["critical scenario QA should test to prove behaviour matches legacy"],
  "complexity": "low | medium | high",
  "confidence": "high | medium | low"
}

Rules:
- businessRules: only rules visible in code (validation, access control, conditional logic, calculations)
- evidence: include one evidence item for every business rule and every important contract/dependency/migration note; use observed only when line-numbered source directly supports it
- targetRole: classify the component by target architecture responsibility or landing zone, not just target language; if the right landing zone depends on business/architecture decisions, use "human_review"
- targetRole: use the modernization context and architecture baseline when available; prefer company-specific context over generic framework mapping
- targetRole: do not choose a role only because of the legacy file type; base it on trigger, state, data ownership, integration boundary, and operational responsibility
- humanQuestions: include questions for unknown trigger semantics, completion signals, data ownership, retry policy, and target integration boundaries
- validationScenarios: include high-value behaviour tests, not just unit-level cases
- migrationNotes: specific replacements (e.g. "Replace AutoMapper with Pydantic .model_validate()")
- complexity: low = straightforward mapping, medium = non-trivial patterns, high = complex business logic or framework-specific behaviour
- confidence: high = full code visible, medium = partial, low = too complex or incomplete`,
      },
    ],
    ANALYSIS_SYSTEM
  );

  const unknownFields: string[] = [];

  try {
    const p = parseJsonObject(raw);

    const str = (v: unknown, field: string): string => {
      if (typeof v === "string" && v !== "unknown") return v;
      unknownFields.push(field);
      return "unknown";
    };

    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

    const strRecord = (v: unknown): Record<string, string> => {
      if (typeof v !== "object" || v === null) return {};
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => typeof val === "string")
          .map(([k, val]) => [k, val as string])
      );
    };

    const validComplexity = (["low", "medium", "high"] as const).includes(
      p["complexity"] as "low" | "medium" | "high"
    )
      ? (p["complexity"] as "low" | "medium" | "high")
      : "medium";

    const validConfidence = (["high", "medium", "low"] as const).includes(
      p["confidence"] as "high" | "medium" | "low"
    )
      ? (p["confidence"] as "high" | "medium" | "low")
      : "low";

    const confidence = sourceCoverage.filesTruncated.length > 0 && validConfidence === "high"
      ? "medium"
      : validConfidence;

    const purpose = str(p["purpose"], "purpose");
    const businessRules = strArr(p["businessRules"]);
    const targetRole = normalizeTargetRole(p["targetRole"]);
    if (targetRole === "unknown" && !unknownFields.includes("targetRole")) {
      unknownFields.push("targetRole");
    }

    const targetRoleRationale = str(p["targetRoleRationale"], "targetRoleRationale");
    const targetIntegrationBoundary = str(p["targetIntegrationBoundary"], "targetIntegrationBoundary");
    const migrationRisks = strArr(p["migrationRisks"]);
    const humanQuestions = strArr(p["humanQuestions"]);
    const validationScenarios = strArr(p["validationScenarios"]);

    if ((targetRole === "human_review" || targetRole === "unknown") && humanQuestions.length === 0) {
      humanQuestions.push(
        `Decide the target landing zone for ${component.name}; the source evidence was not enough to safely classify it.`
      );
    }

    if (targetIntegrationBoundary === "unknown") {
      humanQuestions.push(
        `Define the target integration boundary for ${component.name}: API, event/topic, workflow state, batch job, database, or file contract.`
      );
    }

    if (sourceCoverage.filesTruncated.length > 0) {
      migrationRisks.push(
        `Analysis only saw truncated source for ${sourceCoverage.filesTruncated.map((f) => f.path).join(", ")}; verify uncited rules against the full files before implementation.`
      );
    }

    if (validationScenarios.length === 0) {
      if (businessRules.length > 0) {
        validationScenarios.push(...businessRules.map((rule) => `Prove parity for rule: ${rule}`));
      } else {
        validationScenarios.push(
          `Run a representative legacy-vs-target parity test for ${component.name} using the documented input and output contract.`
        );
      }
    }

    return {
      component,
      purpose,
      businessRules,
      evidence:             normalizeEvidenceItems(p["evidence"]),
      sourceCoverage,
      inputContract:        strRecord(p["inputContract"]),
      outputContract:       strRecord(p["outputContract"]),
      externalDependencies: strArr(p["externalDependencies"]),
      targetPattern:        str(p["targetPattern"], "targetPattern"),
      targetRole,
      targetRoleRationale,
      targetIntegrationBoundary,
      targetDependencies:   strArr(p["targetDependencies"]),
      migrationNotes:       strArr(p["migrationNotes"]),
      migrationRisks,
      humanQuestions,
      validationScenarios,
      complexity:           validComplexity,
      confidence,
      unknownFields,
    };
  } catch (e) {
    throw new Error(
      `Could not parse component analysis JSON for ${component.name}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Topological sort — returns component names in dependency order (leaves first)
// ---------------------------------------------------------------------------

export function sortByDependency(components: SourceComponent[]): string[] {
  const names = new Set(components.map((c) => c.name));
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(name: string) {
    if (visited.has(name)) return;
    visited.add(name);
    const component = components.find((c) => c.name === name);
    for (const dep of component?.dependencies ?? []) {
      if (names.has(dep)) visit(dep);
    }
    order.push(name);
  }

  for (const c of components) visit(c.name);
  return order;
}
