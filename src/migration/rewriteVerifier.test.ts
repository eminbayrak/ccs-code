import { describe, expect, test } from "bun:test";
import {
  buildVerificationSummary,
  formatVerificationMarkdown,
  gatedImplementationStatus,
  quoteSourceRange,
  verifyComponent,
  type ComponentVerification,
} from "./rewriteVerifier.js";
import type { LLMProvider, Message } from "../llm/providers/base.js";
import type { ComponentAnalysis } from "./rewriteTypes.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FILE_ROUTER_SOURCE = [
  "Function RouteFile(fileName As String) As String",
  "    If Not IsSupportedExtension(fileName) Then",
  "        Return \"REJECTED:UNSUPPORTED_TYPE\"",
  "    End If",
  "    Dim taskId As String",
  "    taskId = QueueProcessing(fileName)",
  "    Return taskId",
  "End Function",
].join("\n");

const baseAnalysis: ComponentAnalysis = {
  component: {
    name: "FileRouter",
    type: "service",
    filePaths: ["src/FileRouter.bas"],
    dependencies: [],
    description: "Routes inbound files.",
  },
  purpose: "Classifies inbound client files and starts processing.",
  businessRules: [
    "Unsupported file types are rejected",
    "Successful files are queued for processing",
  ],
  evidence: [
    {
      kind: "business_rule",
      statement: "Unsupported file types are rejected",
      basis: "observed",
      confidence: "high",
      sourceFile: "src/FileRouter.bas",
      lineStart: 2,
      lineEnd: 4,
    },
    {
      kind: "business_rule",
      statement: "Successful files are queued for processing",
      basis: "observed",
      confidence: "high",
      sourceFile: "src/FileRouter.bas",
      lineStart: 5,
      lineEnd: 7,
    },
    {
      kind: "data_contract",
      statement: "fileName input parameter",
      basis: "observed",
      confidence: "high",
      sourceFile: "src/FileRouter.bas",
      lineStart: 1,
      lineEnd: 1,
    },
    {
      kind: "data_contract",
      statement: "taskId output value",
      basis: "observed",
      confidence: "high",
      sourceFile: "src/FileRouter.bas",
      lineStart: 5,
      lineEnd: 7,
    },
    {
      kind: "purpose",
      statement: "Classifies inbound client files and starts processing.",
      basis: "observed",
      confidence: "high",
      sourceFile: "src/FileRouter.bas",
      lineStart: 1,
      lineEnd: 8,
    },
  ],
  sourceCoverage: { filesProvided: 1, filesTruncated: [] },
  inputContract: { fileName: "string" },
  outputContract: { taskId: "string" },
  externalDependencies: [],
  targetPattern: "Azure Function triggered by blob upload",
  targetRole: "azure_function",
  targetRoleRationale: "The component reacts to a file-arrival event.",
  targetIntegrationBoundary: "Blob-created event to Service Bus topic",
  targetDependencies: ["@azure/functions"],
  migrationNotes: [],
  migrationRisks: [],
  humanQuestions: [],
  validationScenarios: ["Reject unsupported file types with the same legacy status."],
  complexity: "medium",
  confidence: "high",
  unknownFields: [],
};

const SOURCE_FILES = [{ path: "src/FileRouter.bas", content: FILE_ROUTER_SOURCE }];

class StubProvider implements LLMProvider {
  name = "stub-flash";
  model = "stub-flash";
  public lastSystem: string | undefined;
  public lastUserContent: string | undefined;
  constructor(private readonly response: string | (() => string)) {}
  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    this.lastSystem = systemPrompt;
    this.lastUserContent = messages.map((m) => m.content).join("\n\n");
    return typeof this.response === "function" ? this.response() : this.response;
  }
}

// ---------------------------------------------------------------------------
// quoteSourceRange — pure helper, no LLM
// ---------------------------------------------------------------------------

describe("quoteSourceRange", () => {
  test("quotes a contiguous line range with line-number gutters", () => {
    const map = new Map([["src/FileRouter.bas", FILE_ROUTER_SOURCE]]);
    const quoted = quoteSourceRange(map, "src/FileRouter.bas", 2, 4);
    expect(quoted).not.toBeNull();
    expect(quoted!.split("\n")).toHaveLength(3);
    expect(quoted!.includes("Not IsSupportedExtension")).toBe(true);
    expect(quoted!.startsWith("2 |")).toBe(true);
  });

  test("returns null when no source file is named", () => {
    const map = new Map([["src/FileRouter.bas", FILE_ROUTER_SOURCE]]);
    expect(quoteSourceRange(map, null, 1, 5)).toBeNull();
  });

  test("returns null when the file is not in the map", () => {
    const map = new Map<string, string>();
    expect(quoteSourceRange(map, "src/FileRouter.bas", 1, 5)).toBeNull();
  });

  test("clamps line ranges past the end of file", () => {
    const map = new Map([["src/FileRouter.bas", FILE_ROUTER_SOURCE]]);
    const quoted = quoteSourceRange(map, "src/FileRouter.bas", 5, 999);
    expect(quoted).not.toBeNull();
    expect(quoted!.includes("End Function")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyComponent — main behavior under a stub LLM
// ---------------------------------------------------------------------------

describe("verifyComponent", () => {
  test("marks claims verified when the stub LLM confirms each one", async () => {
    const provider = new StubProvider(JSON.stringify({
      results: [
        { id: "c1", outcome: "verified", reason: "purpose lines describe routing" },
        { id: "c2", outcome: "verified", reason: "rejection branch present" },
        { id: "c3", outcome: "verified", reason: "queue branch present" },
        { id: "c4", outcome: "verified", reason: "fileName parameter declared" },
        { id: "c5", outcome: "verified", reason: "taskId returned" },
        { id: "c6", outcome: "verified", reason: "function dispatches on file event" },
      ],
    }));
    const result = await verifyComponent(baseAnalysis, SOURCE_FILES, provider, {
      generatedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(result.trustVerdict).toBe("ready");
    expect(result.totals.unsupported).toBe(0);
    expect(result.totals.noEvidence).toBe(0);
    expect(result.totals.verified).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
    // Prompt should include the stub source quote.
    expect(provider.lastUserContent).toContain("Not IsSupportedExtension");
  });

  test("downgrades to needs_review when a load-bearing business rule is unsupported", async () => {
    const provider = new StubProvider(JSON.stringify({
      results: [
        { id: "c1", outcome: "verified", reason: "ok" },
        { id: "c2", outcome: "unsupported", reason: "rejection branch was hallucinated" },
        { id: "c3", outcome: "verified", reason: "ok" },
        { id: "c4", outcome: "verified", reason: "ok" },
        { id: "c5", outcome: "verified", reason: "ok" },
        { id: "c6", outcome: "verified", reason: "ok" },
      ],
    }));
    const result = await verifyComponent(baseAnalysis, SOURCE_FILES, provider);
    expect(result.trustVerdict).toBe("needs_review");
    expect(result.trustReasons.some((r) => r.includes("not supported"))).toBe(true);
  });

  test("does not block solely because target role evidence is architectural", async () => {
    const provider = new StubProvider(JSON.stringify({
      results: [
        { id: "c1", outcome: "verified", reason: "ok" },
        { id: "c2", outcome: "verified", reason: "ok" },
        { id: "c3", outcome: "verified", reason: "ok" },
        { id: "c4", outcome: "verified", reason: "ok" },
        { id: "c5", outcome: "verified", reason: "ok" },
        { id: "c6", outcome: "unsupported", reason: "no event trigger present in code" },
      ],
    }));
    const result = await verifyComponent(baseAnalysis, SOURCE_FILES, provider);
    expect(result.trustVerdict).toBe("ready");
    expect(result.claims.find((claim) => claim.kind === "target_role")?.loadBearing).toBe(false);
  });

  test("flags claims as no_evidence when the analyzer produced no citation", async () => {
    const provider = new StubProvider(JSON.stringify({ results: [] }));
    const noEvidenceAnalysis: ComponentAnalysis = {
      ...baseAnalysis,
      businessRules: ["Files are routed in the order they arrive"],
      evidence: [], // strip every citation
      inputContract: {},
      outputContract: {},
    };
    const result = await verifyComponent(noEvidenceAnalysis, SOURCE_FILES, provider);
    expect(result.totals.noEvidence).toBeGreaterThan(0);
    expect(result.claims.every((c) => c.outcome === "no_evidence")).toBe(true);
    // No load-bearing business rule with no_evidence should still flag a verdict.
    expect(["needs_review", "ready"]).toContain(result.trustVerdict);
  });

  test("uses source text as fallback evidence for uncited contract fields", async () => {
    const provider = new StubProvider(JSON.stringify({
      results: [
        { id: "c1", outcome: "verified", reason: "purpose lines describe routing" },
        { id: "c2", outcome: "verified", reason: "rejection branch present" },
        { id: "c3", outcome: "verified", reason: "queue branch present" },
        { id: "c4", outcome: "verified", reason: "fileName appears in the function signature" },
        { id: "c5", outcome: "verified", reason: "taskId appears in the return path" },
        { id: "c6", outcome: "verified", reason: "ok" },
      ],
    }));
    const missingContractEvidence: ComponentAnalysis = {
      ...baseAnalysis,
      evidence: baseAnalysis.evidence.filter((item) => item.kind !== "data_contract"),
    };

    const result = await verifyComponent(missingContractEvidence, SOURCE_FILES, provider);
    const contractClaims = result.claims.filter((claim) =>
      claim.kind === "input_contract" || claim.kind === "output_contract"
    );

    expect(contractClaims).toHaveLength(2);
    expect(contractClaims.every((claim) => claim.evidence?.kind === "data_contract")).toBe(true);
    expect(contractClaims.every((claim) => claim.outcome === "verified")).toBe(true);
  });

  test("survives a verifier crash and returns needs_review with the error", async () => {
    const provider = new StubProvider(() => {
      throw new Error("network exploded");
    });
    const result = await verifyComponent(baseAnalysis, SOURCE_FILES, provider);
    expect(result.trustVerdict).toBe("needs_review");
    expect(result.error).toContain("network exploded");
    expect(result.trustReasons.some((r) => r.includes("network exploded"))).toBe(true);
    expect(result.claims.every((c) => c.outcome === "inconclusive" || c.outcome === "no_evidence")).toBe(true);
  });

  test("survives malformed JSON output from the verifier model", async () => {
    const provider = new StubProvider("the model went off-script");
    const result = await verifyComponent(baseAnalysis, SOURCE_FILES, provider);
    expect(result.trustVerdict).toBe("needs_review");
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Markdown output + status gating
// ---------------------------------------------------------------------------

const sampleVerification: ComponentVerification = {
  component: "FileRouter",
  generatedAt: "2026-04-25T00:00:00.000Z",
  verifierModel: "stub-flash",
  trustVerdict: "needs_review",
  trustReasons: ["1 load-bearing claim(s) are not supported"],
  totals: { claimsChecked: 6, verified: 5, unsupported: 1, inconclusive: 0, noEvidence: 0 },
  claims: [
    {
      id: "c1",
      kind: "business_rule",
      statement: "Unsupported file types are rejected",
      loadBearing: true,
      evidence: {
        kind: "business_rule",
        statement: "Unsupported file types are rejected",
        basis: "observed",
        confidence: "high",
        sourceFile: "src/FileRouter.bas",
        lineStart: 2,
        lineEnd: 4,
      },
      quotedSource: "2 | If Not IsSupportedExtension(fileName) Then",
      outcome: "unsupported",
      reason: "rejection branch is missing in the cited lines",
    },
  ],
};

describe("formatVerificationMarkdown", () => {
  test("renders verdict, totals, and a per-claim table", () => {
    const md = formatVerificationMarkdown(sampleVerification);
    expect(md).toContain("Trust verdict");
    expect(md).toContain("needs_review");
    expect(md).toContain("Unsupported file types are rejected");
    expect(md).toContain("src/FileRouter.bas:L2-L4");
    expect(md).toContain("rejection branch is missing");
  });
});

describe("buildVerificationSummary", () => {
  test("summarizes verdict counts across components", () => {
    const md = buildVerificationSummary([sampleVerification], {
      repoUrl: "https://github.com/acme/legacy",
      generatedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(md).toContain("Verification Summary");
    expect(md).toContain("0 ready · 1 needs_review · 0 blocked");
    expect(md).toContain("FileRouter");
  });
});

describe("gatedImplementationStatus", () => {
  test("keeps blocked components blocked regardless of verification", () => {
    expect(gatedImplementationStatus("blocked", undefined)).toBe("blocked");
    expect(gatedImplementationStatus("blocked", { ...sampleVerification, trustVerdict: "ready" })).toBe("blocked");
  });

  test("demotes ready to needs_review when verification flagged a load-bearing claim", () => {
    expect(gatedImplementationStatus("ready", sampleVerification)).toBe("needs_review");
  });

  test("preserves ready when verification is also ready or absent", () => {
    expect(gatedImplementationStatus("ready", undefined)).toBe("ready");
    expect(
      gatedImplementationStatus("ready", { ...sampleVerification, trustVerdict: "ready", trustReasons: [] }),
    ).toBe("ready");
  });
});
