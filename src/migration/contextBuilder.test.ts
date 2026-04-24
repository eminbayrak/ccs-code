import { describe, expect, test } from "bun:test";
import { buildContextDoc } from "./contextBuilder.js";
import type { ServiceAnalysis } from "./analyzer.js";
import type { ResolvedService } from "./resolver.js";

describe("buildContextDoc", () => {
  const analysis: ServiceAnalysis = {
    namespace: "BillingManager",
    methodName: "Calculate",
    callerFile: "src/routes/billing.ts",
    callerLine: 12,
    purpose: "Calculates customer billing totals.",
    dataFlow: "caller sends account id -> service calculates totals",
    allMethods: [],
    businessRules: ["VIP accounts skip the service fee"],
    evidence: [{
      kind: "business_rule",
      statement: "VIP accounts skip the service fee",
      basis: "observed",
      confidence: "high",
      sourceFile: "Services/BillingManager.cs",
      lineStart: 42,
      lineEnd: 45,
    }],
    sourceCoverage: {
      filesProvided: 1,
      filesTruncated: [{
        path: "Services/BillingManager.cs",
        originalChars: 5000,
        providedChars: 1000,
        originalLines: 300,
        providedLines: 60,
        truncated: true,
      }],
    },
    errorHandling: [],
    statusValues: [],
    databaseInteractions: [],
    nestedServiceCalls: [],
    inputContract: {},
    outputContract: {},
    confidence: "medium",
    unknownFields: [],
    rawFiles: ["Services/BillingManager.cs"],
  };

  const resolved: ResolvedService = {
    repoFullName: "acme/billing",
    filePath: "Services/BillingManager.cs",
    htmlUrl: "https://github.com/acme/billing/blob/master/Services/BillingManager.cs",
    confidence: "exact",
  };

  test("uses supplied branch refs for source links", () => {
    const doc = buildContextDoc({
      analysis,
      resolved,
      targetLanguage: "csharp",
      repoBaseUrl: "https://github.com/acme/entry",
      analysisDate: "2026-04-24",
      entryRef: "develop",
      serviceRef: "master",
    });

    expect(doc).toContain("https://github.com/acme/entry/blob/develop/src/routes/billing.ts#L12");
    expect(doc).toContain("https://github.com/acme/billing/blob/master/Services/BillingManager.cs");
    expect(doc).not.toContain("/blob/main/");
  });

  test("renders evidence and avoids hardcoded direct database instructions", () => {
    const doc = buildContextDoc({
      analysis,
      resolved,
      targetLanguage: "csharp",
      repoBaseUrl: "https://github.com/acme/entry",
      analysisDate: "2026-04-24",
      serviceRef: "master",
    });

    expect(doc).toContain("Evidence & Source Coverage");
    expect(doc).toContain("basis: observed");
    expect(doc).toContain("analyzed first 60/300 lines");
    expect(doc).toContain("evidence-backed target integration pattern");
    expect(doc).not.toContain("connect directly to the database");
  });
});
