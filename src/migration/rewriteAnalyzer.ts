import type { LLMProvider } from "../llm/providers/base.js";
import type {
  ComponentType,
  SourceComponent,
  FrameworkInfo,
  ComponentAnalysis,
} from "./rewriteTypes.js";
import { getFrameworkMapping, formatMappingForPrompt } from "./frameworkMapper.js";

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
    const json = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const parsed = JSON.parse(json) as Partial<FrameworkInfo>;
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
    const json = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const parsed = JSON.parse(json) as { components?: unknown[] };
    if (!Array.isArray(parsed.components)) return [];

    return parsed.components
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
      .map((c) => ({
        name:         typeof c["name"]        === "string" ? c["name"]        : "unknown",
        type:        (typeof c["type"]        === "string" ? c["type"]        : "unknown") as ComponentType,
        filePaths:    Array.isArray(c["filePaths"])    ? (c["filePaths"] as string[]).filter((p) => typeof p === "string")    : [],
        dependencies: Array.isArray(c["dependencies"]) ? (c["dependencies"] as string[]).filter((d) => typeof d === "string") : [],
        description:  typeof c["description"] === "string" ? c["description"] : "",
      }));
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

export async function analyzeComponent(
  component: SourceComponent,
  sourceFiles: Array<{ path: string; content: string }>,
  frameworkInfo: FrameworkInfo,
  provider: LLMProvider
): Promise<ComponentAnalysis> {
  const mapping = getFrameworkMapping(
    frameworkInfo.sourceFramework,
    frameworkInfo.targetFramework
  );
  const mappingSection = mapping
    ? `\nFramework migration reference:\n${formatMappingForPrompt(mapping)}\n`
    : "";

  const fileBundle = sourceFiles
    .map((f) => `=== FILE: ${f.path} ===\n${f.content.slice(0, 6000)}`)
    .join("\n\n");

  const raw = await provider.chat(
    [
      {
        role: "user",
        content: `Analyze this ${frameworkInfo.sourceLanguage} component for migration to ${frameworkInfo.targetLanguage}.

Component: ${component.name} (${component.type})
Description: ${component.description}
Dependencies: ${component.dependencies.join(", ") || "none"}
${mappingSection}
Source files:
${fileBundle}

Respond with ONLY this JSON (use "unknown" for anything you cannot determine):
{
  "purpose": "one sentence — business intent, not code mechanics",
  "businessRules": ["concrete rule extracted from code logic"],
  "inputContract": { "fieldName": "type and constraint" },
  "outputContract": { "fieldName": "type" },
  "externalDependencies": ["NuGet/npm package names used"],
  "targetPattern": "exact pattern to use in ${frameworkInfo.targetLanguage} (e.g. FastAPI APIRouter with Pydantic schemas)",
  "targetDependencies": ["pip/npm package names needed in the rewrite"],
  "migrationNotes": ["specific things to watch out for when rewriting"],
  "complexity": "low | medium | high",
  "confidence": "high | medium | low"
}

Rules:
- businessRules: only rules visible in code (validation, access control, conditional logic, calculations)
- migrationNotes: specific replacements (e.g. "Replace AutoMapper with Pydantic .model_validate()")
- complexity: low = straightforward mapping, medium = non-trivial patterns, high = complex business logic or framework-specific behaviour
- confidence: high = full code visible, medium = partial, low = too complex or incomplete`,
      },
    ],
    ANALYSIS_SYSTEM
  );

  const unknownFields: string[] = [];

  try {
    const json = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const p = JSON.parse(json) as Record<string, unknown>;

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

    return {
      component,
      purpose:              str(p["purpose"], "purpose"),
      businessRules:        strArr(p["businessRules"]),
      inputContract:        strRecord(p["inputContract"]),
      outputContract:       strRecord(p["outputContract"]),
      externalDependencies: strArr(p["externalDependencies"]),
      targetPattern:        str(p["targetPattern"], "targetPattern"),
      targetDependencies:   strArr(p["targetDependencies"]),
      migrationNotes:       strArr(p["migrationNotes"]),
      complexity:           validComplexity,
      confidence:           validConfidence,
      unknownFields,
    };
  } catch {
    return {
      component,
      purpose: "unknown",
      businessRules: [],
      inputContract: {},
      outputContract: {},
      externalDependencies: [],
      targetPattern: "unknown",
      targetDependencies: [],
      migrationNotes: [],
      complexity: "high",
      confidence: "low",
      unknownFields: ["purpose", "targetPattern"],
    };
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
