import { describe, expect, test } from "bun:test";
import { buildCodeIntelligenceArtifact } from "./codeIntelligence.js";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";

const frameworkInfo: FrameworkInfo = {
  sourceFramework: "express",
  sourceLanguage: "typescript",
  targetFramework: "aspnet-core-web-api",
  targetLanguage: "csharp",
  architecturePattern: "mvc",
  packageManager: "npm",
};

const baseAnalysis: ComponentAnalysis = {
  component: {
    name: "OrderRoutes",
    type: "controller",
    filePaths: ["src/routes/orders.ts"],
    dependencies: [],
    description: "Order routes.",
  },
  purpose: "Handles orders.",
  businessRules: [],
  evidence: [],
  sourceCoverage: { filesProvided: 1, filesTruncated: [] },
  inputContract: {},
  outputContract: {},
  externalDependencies: [],
  targetPattern: "controller",
  targetRole: "rest_api",
  targetRoleRationale: "HTTP routes.",
  targetIntegrationBoundary: "HTTP",
  targetDependencies: [],
  migrationNotes: [],
  migrationRisks: [],
  humanQuestions: [],
  validationScenarios: [],
  complexity: "low",
  confidence: "high",
  unknownFields: [],
};

describe("code intelligence", () => {
  test("extracts lightweight symbols and resolved call edges", () => {
    const artifact = buildCodeIntelligenceArtifact({
      repoUrl: "https://github.com/acme/orders",
      generatedAt: "2026-04-27T00:00:00.000Z",
      frameworkInfo,
      analyses: [baseAnalysis],
      sourceFiles: [{
        path: "src/routes/orders.ts",
        content: `
export function validateOrder(input) {
  return Boolean(input.id);
}

export async function createOrder(req, res) {
  if (!validateOrder(req.body)) return res.status(400).send();
  return res.json({ ok: true });
}
`,
      }],
    });

    expect(artifact.stats.symbols).toBeGreaterThanOrEqual(2);
    expect(artifact.symbols.map((symbol) => symbol.name)).toContain("validateOrder");
    expect(artifact.calls.some((call) => call.sourceName === "createOrder" && call.targetName === "validateOrder" && call.targetSymbolId)).toBe(true);
    expect(artifact.components[0]?.outgoingCalls).toBeGreaterThan(0);
  });
});
