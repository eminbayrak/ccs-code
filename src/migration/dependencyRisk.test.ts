import { describe, expect, test } from "bun:test";
import {
  buildDependencyRiskReport,
  formatDependencyRiskMarkdown,
  isSecurityManifest,
  parseDependenciesFromManifests,
} from "./dependencyRisk.js";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";

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
    name: "AuthService",
    type: "service",
    filePaths: ["src/app/routes/auth/auth.service.ts"],
    dependencies: [],
    description: "Handles auth.",
  },
  purpose: "Registers and authenticates users.",
  businessRules: ["Passwords are hashed before storage."],
  evidence: [],
  sourceCoverage: { filesProvided: 1, filesTruncated: [] },
  inputContract: {},
  outputContract: {},
  externalDependencies: ["bcryptjs", "missing-runtime"],
  targetPattern: "ASP.NET Core service",
  targetRole: "rest_api",
  targetRoleRationale: "HTTP API behavior.",
  targetIntegrationBoundary: "HTTP API",
  targetDependencies: [],
  migrationNotes: [],
  migrationRisks: [],
  humanQuestions: [],
  validationScenarios: ["Register and login a user."],
  complexity: "medium",
  confidence: "high",
  unknownFields: [],
};

describe("dependency risk", () => {
  test("recognizes supported dependency manifests", () => {
    expect(isSecurityManifest("package.json")).toBe(true);
    expect(isSecurityManifest("src/api/api.csproj")).toBe(true);
    expect(isSecurityManifest("README.md")).toBe(false);
  });

  test("parses npm dependencies from package.json", () => {
    const deps = parseDependenciesFromManifests([{
      path: "package.json",
      content: JSON.stringify({
        dependencies: { express: "~4.18.1", jsonwebtoken: "^9.0.2" },
        devDependencies: { typescript: "~5.2.2" },
      }),
    }]);

    expect(deps.map((dep) => dep.name)).toEqual(["express", "jsonwebtoken", "typescript"]);
    expect(deps.find((dep) => dep.name === "typescript")?.scope).toBe("development");
  });

  test("builds deterministic findings for lockfiles, broad versions, and security-sensitive packages", () => {
    const report = buildDependencyRiskReport({
      manifestFiles: [{
        path: "package.json",
        content: JSON.stringify({
          dependencies: { express: "~4.18.1", jsonwebtoken: "^9.0.2", bcryptjs: "*" },
        }),
      }],
      analyses: [analysis],
      frameworkInfo,
      generatedAt: "2026-04-26T00:00:00.000Z",
    });

    expect(report.dependencies).toHaveLength(3);
    expect(report.findings.some((finding) => finding.category === "lockfile")).toBe(true);
    expect(report.findings.some((finding) => finding.packageName === "bcryptjs" && finding.severity === "high")).toBe(true);
    expect(report.findings.some((finding) => finding.packageName === "jsonwebtoken" && finding.category === "security_sensitive")).toBe(true);
    expect(report.findings.some((finding) => finding.packageName === "missing-runtime" && finding.category === "inventory")).toBe(true);

    const markdown = formatDependencyRiskMarkdown(report);
    expect(markdown).toContain("Dependency Risk Report");
    expect(markdown).toContain("bcryptjs");
  });
});
