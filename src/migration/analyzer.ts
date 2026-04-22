import { AnthropicProvider } from "../llm/providers/anthropic.js";
import type { SoapCallSite } from "./scanner.js";
import type { WsdlParseResult } from "./wsdlParser.js";
import { wsdlToPromptText } from "./wsdlParser.js";

export type ServiceAnalysis = {
  namespace: string;
  methodName: string;
  callerFile: string;
  callerLine: number;
  purpose: string;
  dataFlow: string;
  businessRules: string[];
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
Your job is to extract business logic from service implementation code.
Be precise and accurate. Do not invent or assume details not present in the code.
If you cannot determine a field from the provided code, use exactly the string "unknown".
Respond only with valid JSON matching the exact schema requested.`;

// ---------------------------------------------------------------------------
// Build the analysis prompt for one service
// ---------------------------------------------------------------------------

function buildPrompt(
  callSite: SoapCallSite,
  serviceFiles: Array<{ path: string; content: string }>,
  wsdl: WsdlParseResult | null
): string {
  // Bundle all service files with clear separators
  const fileBundle = serviceFiles
    .map((f) => `=== FILE: ${f.path} ===\n${f.content.slice(0, 8000)}`)
    .join("\n\n");

  const wsdlSection = wsdl
    ? `\nWSDL Contract:\n${wsdlToPromptText(wsdl)}`
    : "";

  return `Analyze this legacy service for migration documentation.

Caller file: ${callSite.callerFile} (line ${callSite.lineNumber})
Service namespace: ${callSite.serviceNamespace}
Method called: ${callSite.methodName}
Parameter flags: ${callSite.parameterFlags.join(", ") || "none"}
${wsdlSection}

Service implementation:
${fileBundle}

Respond ONLY with this JSON (use "unknown" for any field you cannot determine):
{
  "purpose": "one sentence — business intent in plain language, not code mechanics",
  "dataFlow": "what comes in from the caller → what is sent to the service → what transforms → what is returned",
  "businessRules": ["specific rule 1", "specific rule 2"],
  "databaseInteractions": ["table: foo — SELECT", "proc: sp_GetFoo — called with patientId"],
  "nestedServiceCalls": ["AnotherService.methodName"],
  "inputContract": { "fieldName": "type" },
  "outputContract": { "fieldName": "type" },
  "confidence": "high | medium | low"
}

Rules:
- businessRules: only concrete rules visible in the code (validation, masking, access control, conditional logic)
- databaseInteractions: only what you can see — table names, query types, stored proc names
- nestedServiceCalls: only service calls found in the implementation code
- confidence: "high" if you understand the full flow, "medium" if some parts are unclear, "low" if the code is too complex or incomplete
- use "unknown" (string) for any field you cannot determine — never guess`;
}

// ---------------------------------------------------------------------------
// Parse and validate LLM JSON output
// ---------------------------------------------------------------------------

type RawAnalysis = {
  purpose?: unknown;
  dataFlow?: unknown;
  businessRules?: unknown;
  databaseInteractions?: unknown;
  nestedServiceCalls?: unknown;
  inputContract?: unknown;
  outputContract?: unknown;
  confidence?: unknown;
};

function parseAnalysisResponse(
  raw: string,
  callSite: SoapCallSite
): Omit<ServiceAnalysis, "namespace" | "methodName" | "callerFile" | "callerLine" | "rawFiles"> {
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  let parsed: RawAnalysis = {};

  try {
    parsed = JSON.parse(jsonText) as RawAnalysis;
  } catch {
    // JSON parse failed — return minimal analysis
    return {
      purpose: "unknown",
      dataFlow: "unknown",
      businessRules: [],
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

  const confidence = (["high", "medium", "low"] as const).includes(
    parsed.confidence as "high" | "medium" | "low"
  )
    ? (parsed.confidence as "high" | "medium" | "low")
    : "low";

  // Track which fields came back as "unknown"
  const unknownFields: string[] = [];
  if (str(parsed.purpose) === "unknown") unknownFields.push("purpose");
  if (str(parsed.dataFlow) === "unknown") unknownFields.push("dataFlow");

  return {
    purpose: str(parsed.purpose),
    dataFlow: str(parsed.dataFlow),
    businessRules: strArr(parsed.businessRules),
    databaseInteractions: strArr(parsed.databaseInteractions),
    nestedServiceCalls: strArr(parsed.nestedServiceCalls),
    inputContract: strRecord(parsed.inputContract),
    outputContract: strRecord(parsed.outputContract),
    confidence,
    unknownFields,
  };
}

// ---------------------------------------------------------------------------
// Analyze a single service — exported for use by tracer
// ---------------------------------------------------------------------------

export async function analyzeService(
  callSite: SoapCallSite,
  serviceFiles: Array<{ path: string; content: string }>,
  wsdl: WsdlParseResult | null,
  provider: AnthropicProvider
): Promise<ServiceAnalysis> {
  const prompt = buildPrompt(callSite, serviceFiles, wsdl);

  const raw = await provider.chat(
    [{ role: "user", content: prompt }],
    SYSTEM_PROMPT
  );

  const parsed = parseAnalysisResponse(raw, callSite);

  return {
    namespace: callSite.serviceNamespace,
    methodName: callSite.methodName,
    callerFile: callSite.callerFile,
    callerLine: callSite.lineNumber,
    rawFiles: serviceFiles.map((f) => f.path),
    ...parsed,
  };
}

// ---------------------------------------------------------------------------
// Batch analyze multiple services — follows enricher.ts pattern
// ---------------------------------------------------------------------------

export async function analyzeServices(
  callSites: SoapCallSite[],
  getServiceFiles: (
    namespace: string
  ) => Promise<Array<{ path: string; content: string }>>,
  getWsdl: (namespace: string) => Promise<WsdlParseResult | null>,
  onProgress?: (p: AnalyzeProgress) => void,
  batchSize = 3
): Promise<{ results: ServiceAnalysis[]; errors: number }> {
  const sonnet = new AnthropicProvider("claude-sonnet-4-6");
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
          const analysis = await analyzeService(callSite, files, wsdl, sonnet);
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
