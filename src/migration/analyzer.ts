import type { LLMProvider } from "../llm/providers/base.js";
import type { ServiceReference } from "./types.js";
import type { WsdlParseResult } from "./wsdlParser.js";
import { wsdlToPromptText } from "./wsdlParser.js";
import {
  buildNumberedSourceExcerpt,
  buildSourceCoverage,
  emptySourceCoverage,
  normalizeEvidenceItems,
  type EvidenceItem,
  type SourceCoverage,
} from "./evidence.js";

export type ServiceMethod = {
  name: string;
  purpose: string;
  input: Record<string, string>;
  output: Record<string, string>;
  businessRules: string[];
};

export type ServiceAnalysis = {
  namespace: string;
  methodName: string;
  callerFile: string;
  callerLine: number;
  purpose: string;
  dataFlow: string;
  allMethods: ServiceMethod[];
  businessRules: string[];
  evidence: EvidenceItem[];
  sourceCoverage: SourceCoverage;
  errorHandling: string[];
  statusValues: string[];
  databaseInteractions: string[];
  nestedServiceCalls: string[];
  inputContract: Record<string, string>;
  outputContract: Record<string, string>;
  confidence: "high" | "medium" | "low";
  unknownFields: string[];
  rawFiles: string[];
};

export type AnalyzeProgress = {
  total: number;
  done: number;
  current: string;
  errors: number;
};

const SYSTEM_PROMPT = `You are a code analyst documenting a legacy system for migration.
Extract every business rule, data contract, and database interaction visible in the code.
A developer who has never seen this codebase must be able to rewrite the service from your output alone — with no ambiguity.
If you cannot determine a field from the provided code, use exactly the string "unknown".
Respond only with valid JSON matching the exact schema requested.`;

// ---------------------------------------------------------------------------
// Build the analysis prompt for one service
// ---------------------------------------------------------------------------

function buildPrompt(
  callSite: ServiceReference,
  serviceFiles: Array<{ path: string; content: string }>,
  wsdl: WsdlParseResult | null
): { prompt: string; coverage: SourceCoverage } {
  const excerpts = serviceFiles.map((f) =>
    buildNumberedSourceExcerpt(f.path, f.content, 12000)
  );
  const coverage = buildSourceCoverage(excerpts);
  const fileBundle = excerpts
    .map((f) => `=== FILE: ${f.path} ===\n${f.content}`)
    .join("\n\n");

  const wsdlSection = wsdl
    ? `\nWSDL Contract:\n${wsdlToPromptText(wsdl)}`
    : "";

  const paramFlags = callSite.metadata["parameterFlags"] ?? "none";

  const coverageNote = coverage.filesTruncated.length > 0
    ? `\nIMPORTANT SOURCE COVERAGE LIMITATION:\n${coverage.filesTruncated.map((f) => `- ${f.path}: only lines 1-${f.providedLines} of ${f.originalLines} were visible to you.`).join("\n")}\nIf a business rule, contract, dependency, or error path could exist outside the visible lines, mark the related field as inferred or unknown and do not use high confidence for it.\n`
    : "";

  return {
    coverage,
    prompt: `Analyze this legacy SOAP/COM service for migration. A developer must be able to rewrite it as a REST API using ONLY your output — no access to the original source.

Caller file: ${callSite.callerFile} (line ${callSite.lineNumber})
Service namespace: ${callSite.serviceNamespace}
Primary method called from caller: ${callSite.methodName}
Parameter flags observed: ${paramFlags}
${wsdlSection}
${coverageNote}

Service implementation files with line numbers:
${fileBundle}

Respond ONLY with this JSON (use "unknown" string for anything you cannot determine):
{
  "purpose": "one sentence — what this service does for the business (not code mechanics)",
  "dataFlow": "step-by-step: caller sends X → service validates Y → queries Z table → applies rule A → returns B",
  "allMethods": [
    {
      "name": "MethodName",
      "purpose": "what this specific method does",
      "input": { "paramName": "type" },
      "output": { "fieldName": "type" },
      "businessRules": ["every if/else condition that enforces domain logic for this method"]
    }
  ],
  "businessRules": ["every rule that applies across the whole service — validation, access control, thresholds, routing, masking"],
  "evidence": [
    {
      "kind": "business_rule | data_contract | database | dependency | error_handling | status_value | purpose",
      "statement": "same wording as the extracted fact this supports",
      "basis": "observed | inferred | unknown",
      "sourceFile": "relative/path/to/file.cs or null",
      "lineStart": 42,
      "lineEnd": 45,
      "confidence": "high | medium | low"
    }
  ],
  "databaseInteractions": [
    "table: TableName — SELECT columns: col1, col2, col3",
    "proc: sp_ProcName — params: param1 (type), param2 (type); returns: col1, col2"
  ],
  "nestedServiceCalls": ["ServiceName.MethodName"],
  "inputContract": { "fieldName": "type" },
  "outputContract": { "fieldName": "type" },
  "errorHandling": [
    "condition: X is empty → throws: ArgumentException / SOAP fault: InvalidInput",
    "condition: account is Deactivated → returns: access denied error"
  ],
  "statusValues": [
    "AccountStatus: Active, Deactivated, VIP",
    "OrderStatus: Pending, Shipped, Delivered, Cancelled"
  ],
  "confidence": "high | medium | low"
}

Extraction rules:
- allMethods: document EVERY public method defined in the service, not just the one called from the entry point
- businessRules: extract every concrete condition — numeric thresholds, role checks, status guards, tier exceptions, time limits, domain-specific overrides
- databaseInteractions: include exact table names, column names where visible, stored proc names with their parameters
- evidence: include one evidence item for every business rule and every important contract/dependency/error/database fact; use observed only when line-numbered source directly supports it
- errorHandling: every exception type thrown, every early-return error condition, every SOAP fault
- statusValues: every enum, status string, role name, or tier value referenced in the logic
- confidence: "high" = you can see the full implementation; "medium" = some parts unclear or truncated; "low" = only got interface/partial code`,
  };
}

// ---------------------------------------------------------------------------
// Parse and validate LLM JSON output
// ---------------------------------------------------------------------------

type RawAnalysis = {
  purpose?: unknown;
  dataFlow?: unknown;
  allMethods?: unknown;
  businessRules?: unknown;
  errorHandling?: unknown;
  statusValues?: unknown;
  evidence?: unknown;
  databaseInteractions?: unknown;
  nestedServiceCalls?: unknown;
  inputContract?: unknown;
  outputContract?: unknown;
  confidence?: unknown;
};

function parseAnalysisResponse(
  raw: string,
  callSite: ServiceReference
): Omit<ServiceAnalysis, "namespace" | "methodName" | "callerFile" | "callerLine" | "rawFiles"> {
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  let parsed: RawAnalysis = {};

  try {
    parsed = JSON.parse(jsonText) as RawAnalysis;
  } catch {
    return {
      purpose: "unknown",
      dataFlow: "unknown",
      allMethods: [],
      businessRules: [],
      evidence: [],
      sourceCoverage: emptySourceCoverage(),
      errorHandling: [],
      statusValues: [],
      databaseInteractions: [],
      nestedServiceCalls: [],
      inputContract: {},
      outputContract: {},
      confidence: "low",
      unknownFields: ["purpose", "dataFlow", "inputContract", "outputContract"],
    };
  }

  const str = (v: unknown): string =>
    typeof v === "string" ? v : "unknown";

  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];

  const strRecord = (v: unknown): Record<string, string> => {
    if (typeof v !== "object" || v === null) return {};
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => typeof val === "string")
        .map(([k, val]) => [k, val as string])
    );
  };

  const parseMethods = (v: unknown): ServiceMethod[] => {
    if (!Array.isArray(v)) return [];
    return v.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const m = item as Record<string, unknown>;
      return [{
        name: typeof m["name"] === "string" ? m["name"] : "unknown",
        purpose: typeof m["purpose"] === "string" ? m["purpose"] : "unknown",
        input: strRecord(m["input"]),
        output: strRecord(m["output"]),
        businessRules: Array.isArray(m["businessRules"])
          ? m["businessRules"].filter((x: unknown) => typeof x === "string")
          : [],
      }];
    });
  };

  const confidence = (["high", "medium", "low"] as const).includes(
    parsed.confidence as "high" | "medium" | "low"
  )
    ? (parsed.confidence as "high" | "medium" | "low")
    : "low";

  const unknownFields: string[] = [];
  if (str(parsed.purpose) === "unknown") unknownFields.push("purpose");
  if (str(parsed.dataFlow) === "unknown") unknownFields.push("dataFlow");

  return {
    purpose: str(parsed.purpose),
    dataFlow: str(parsed.dataFlow),
    allMethods: parseMethods(parsed.allMethods),
    businessRules: strArr(parsed.businessRules),
    evidence: normalizeEvidenceItems(parsed.evidence),
    sourceCoverage: emptySourceCoverage(),
    errorHandling: strArr(parsed.errorHandling),
    statusValues: strArr(parsed.statusValues),
    databaseInteractions: strArr(parsed.databaseInteractions),
    nestedServiceCalls: strArr(parsed.nestedServiceCalls),
    inputContract: strRecord(parsed.inputContract),
    outputContract: strRecord(parsed.outputContract),
    confidence,
    unknownFields,
  };
}

// ---------------------------------------------------------------------------
// Analyze a single service
// ---------------------------------------------------------------------------

export async function analyzeService(
  callSite: ServiceReference,
  serviceFiles: Array<{ path: string; content: string }>,
  wsdl: WsdlParseResult | null,
  provider: LLMProvider
): Promise<ServiceAnalysis> {
  const { prompt, coverage } = buildPrompt(callSite, serviceFiles, wsdl);

  const raw = await provider.chat(
    [{ role: "user", content: prompt }],
    SYSTEM_PROMPT
  );

  const parsed = parseAnalysisResponse(raw, callSite);
  const confidence =
    coverage.filesTruncated.length > 0 && parsed.confidence === "high"
      ? "medium"
      : parsed.confidence;

  return {
    namespace: callSite.serviceNamespace,
    methodName: callSite.methodName,
    callerFile: callSite.callerFile,
    callerLine: callSite.lineNumber,
    rawFiles: serviceFiles.map((f) => f.path),
    ...parsed,
    confidence,
    sourceCoverage: coverage,
  };
}

// ---------------------------------------------------------------------------
// Batch analyze — accepts provider so the caller controls which model is used
// ---------------------------------------------------------------------------

export async function analyzeServices(
  callSites: ServiceReference[],
  getServiceFiles: (
    namespace: string
  ) => Promise<Array<{ path: string; content: string }>>,
  getWsdl: (namespace: string) => Promise<WsdlParseResult | null>,
  provider: LLMProvider,
  onProgress?: (p: AnalyzeProgress) => void,
  batchSize = 3
): Promise<{ results: ServiceAnalysis[]; errors: number }> {
  const results: ServiceAnalysis[] = [];
  let errors = 0;

  for (let i = 0; i < callSites.length; i += batchSize) {
    const batch = callSites.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (callSite) => {
        onProgress?.({
          total: callSites.length,
          done: results.length,
          current: callSite.serviceNamespace,
          errors,
        });

        try {
          const [files, wsdl] = await Promise.all([
            getServiceFiles(callSite.serviceNamespace),
            getWsdl(callSite.serviceNamespace),
          ]);
          const analysis = await analyzeService(callSite, files, wsdl, provider);
          results.push(analysis);
        } catch (e) {
          console.error(`[analyzer] Failed to analyze ${callSite.serviceNamespace}:`, e);
          errors++;
        }
      })
    );
  }

  return { results, errors };
}
