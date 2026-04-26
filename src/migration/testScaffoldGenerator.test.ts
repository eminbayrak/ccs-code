import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunLayout } from "./runLayout.js";
import { writeTestScaffolds } from "./testScaffoldGenerator.js";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";
import type { ComponentVerification } from "./rewriteVerifier.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccs-test-scaffold-"));
  tempDirs.push(root);
  return root;
}

const frameworkInfo: FrameworkInfo = {
  sourceFramework: "express",
  sourceLanguage: "typescript",
  targetFramework: "aspnet-core-web-api",
  targetLanguage: "csharp",
  architecturePattern: "mvc",
  packageManager: "npm",
};

const analysis: ComponentAnalysis = {
  component: {
    name: "ArticleService",
    type: "service",
    filePaths: ["src/app/routes/article/article.service.ts"],
    dependencies: [],
    description: "Manages articles.",
  },
  purpose: "Manages article lifecycle.",
  businessRules: ["Only article authors can update articles."],
  evidence: [],
  sourceCoverage: { filesProvided: 1, filesTruncated: [] },
  inputContract: {},
  outputContract: {},
  externalDependencies: [],
  targetPattern: "ASP.NET Core application service",
  targetRole: "rest_api",
  targetRoleRationale: "Exposes HTTP behavior.",
  targetIntegrationBoundary: "HTTP API",
  targetDependencies: [],
  migrationNotes: [],
  migrationRisks: [],
  humanQuestions: [],
  validationScenarios: ["Reject update attempts from non-authors."],
  complexity: "medium",
  confidence: "high",
  unknownFields: [],
};

const verification: ComponentVerification = {
  component: "ArticleService",
  generatedAt: "2026-04-26T00:00:00.000Z",
  verifierModel: "test",
  trustVerdict: "ready",
  trustReasons: [],
  totals: { claimsChecked: 1, verified: 1, unsupported: 0, inconclusive: 0, noEvidence: 0 },
  claims: [],
};

describe("test scaffold generator", () => {
  test("writes per-component parity scaffolds and an index", async () => {
    const root = await tempRoot();
    const layout = buildRunLayout(root, "https://github.com/gothinkster/node-express-realworld-example-app");
    const summary = await writeTestScaffolds(
      layout,
      [analysis],
      frameworkInfo,
      new Map([[verification.component, verification]]),
    );

    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]?.status).toBe("ready");

    const index = await readFile(join(layout.testScaffoldsDir, "README.md"), "utf-8");
    const scaffold = await readFile(summary.files[0]!.path, "utf-8");

    expect(index).toContain("Parity Test Scaffolds");
    expect(scaffold).toContain("Reject update attempts from non-authors.");
    expect(scaffold).toContain("WebApplicationFactory");
  });
});

