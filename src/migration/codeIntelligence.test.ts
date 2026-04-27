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
    expect(artifact.analysisMethod).toBe("ast");
    expect(artifact.symbols.map((symbol) => symbol.name)).toContain("validateOrder");
    expect(artifact.calls.some((call) => call.sourceName === "createOrder" && call.targetName === "validateOrder" && call.targetSymbolId)).toBe(true);
    expect(artifact.components[0]?.outgoingCalls).toBeGreaterThan(0);
    expect(artifact.symbols.find((symbol) => symbol.name === "createOrder")?.complexity).toBeGreaterThanOrEqual(2);
  });

  test("extracts route handlers and class methods from the AST path", () => {
    const artifact = buildCodeIntelligenceArtifact({
      repoUrl: "https://github.com/acme/orders",
      generatedAt: "2026-04-27T00:00:00.000Z",
      frameworkInfo,
      analyses: [baseAnalysis],
      sourceFiles: [{
        path: "src/routes/orders.ts",
        content: `
class OrderService {
  validate(input) {
    return Boolean(input.id);
  }
}

const service = new OrderService();
router.post("/orders", async (req, res) => {
  if (!service.validate(req.body)) return res.status(400).send();
  return res.json({ ok: true });
});
`,
      }],
    });

    expect(artifact.symbols.map((symbol) => symbol.name)).toContain("OrderService");
    expect(artifact.symbols.map((symbol) => symbol.name)).toContain("validate");
    expect(artifact.symbols.map((symbol) => symbol.name)).toContain("POST /orders");
    expect(artifact.calls.some((call) => call.sourceName === "POST /orders" && call.targetName === "validate" && call.targetSymbolId)).toBe(true);
  });

  test("keeps non-JS languages safe when Tree-sitter is unavailable", () => {
    const artifact = buildCodeIntelligenceArtifact({
      repoUrl: "https://github.com/acme/orders",
      generatedAt: "2026-04-27T00:00:00.000Z",
      frameworkInfo: { ...frameworkInfo, sourceFramework: "flask", sourceLanguage: "python", packageManager: "pip" },
      analyses: [{
        ...baseAnalysis,
        component: { ...baseAnalysis.component, name: "OrdersPy", filePaths: ["app/orders.py"] },
      }],
      sourceFiles: [{
        path: "app/orders.py",
        content: `
def validate_order(input):
    return bool(input)

def create_order(input):
    if validate_order(input):
        return True
    return False
`,
      }],
    });

    expect(artifact.stats.symbols).toBeGreaterThanOrEqual(2);
    expect(artifact.stats.typeScriptAstFiles ?? 0).toBe(0);
    expect((artifact.stats.treeSitterFiles ?? 0) + (artifact.stats.regexFiles ?? 0)).toBe(1);
    expect(["ast", "hybrid", "regex"]).toContain(artifact.analysisMethod);
    expect(artifact.calls.some((call) => call.sourceName === "create_order" && call.targetName === "validate_order" && call.targetSymbolId)).toBe(true);
  });
});
