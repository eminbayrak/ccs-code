import { describe, expect, test } from "bun:test";
import { buildRewriteContextDoc } from "./rewriteContextBuilder.js";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";

describe("buildRewriteContextDoc", () => {
  const frameworkInfo: FrameworkInfo = {
    sourceFramework: "aspnet-core",
    sourceLanguage: "csharp",
    targetFramework: "fastapi",
    targetLanguage: "python",
    architecturePattern: "layered",
    packageManager: "nuget",
  };

  const analysis: ComponentAnalysis = {
    component: {
      name: "OrderService",
      type: "service",
      filePaths: ["Services/OrderService.cs"],
      dependencies: ["OrderRepository"],
      description: "Handles order logic.",
    },
    purpose: "Handles order lifecycle rules.",
    businessRules: ["Cancelled orders cannot be fulfilled"],
    evidence: [{
      kind: "business_rule",
      statement: "Cancelled orders cannot be fulfilled",
      basis: "observed",
      confidence: "high",
      sourceFile: "Services/OrderService.cs",
      lineStart: 88,
      lineEnd: 90,
    }],
    sourceCoverage: {
      filesProvided: 1,
      filesTruncated: [],
    },
    inputContract: {},
    outputContract: {},
    externalDependencies: [],
    targetPattern: "FastAPI service class",
    targetRole: "microservice",
    targetRoleRationale: "OrderService owns order lifecycle behaviour.",
    targetIntegrationBoundary: "REST API and service method boundary",
    targetDependencies: ["fastapi"],
    migrationNotes: [],
    migrationRisks: ["Cancellation logic can regress if status mapping changes."],
    humanQuestions: [],
    validationScenarios: ["Cancelled orders remain impossible to fulfill."],
    complexity: "medium",
    confidence: "high",
    unknownFields: [],
  };

  test("uses repo default branch in source and evidence links", () => {
    const doc = buildRewriteContextDoc(
      analysis,
      frameworkInfo,
      "https://github.com/acme/orders",
      "2026-04-24",
      "trunk",
    );

    expect(doc).toContain("https://github.com/acme/orders/blob/trunk/Services/OrderService.cs");
    expect(doc).toContain("Services/OrderService.cs:L88-L90");
    expect(doc).not.toContain("/blob/main/");
  });

  test("renders target disposition and implementation gate", () => {
    const doc = buildRewriteContextDoc(
      analysis,
      frameworkInfo,
      "https://github.com/acme/orders",
      "2026-04-24",
      "trunk",
    );

    expect(doc).toContain("Target Architecture Disposition");
    expect(doc).toContain("Modernization Baseline");
    expect(doc).toContain("../architecture-baseline.md");
    expect(doc).toContain("**Recommended role:** `microservice`");
    expect(doc).toContain("Implementation gate:");
    expect(doc).toContain("Cancelled orders remain impossible to fulfill.");
  });
});
