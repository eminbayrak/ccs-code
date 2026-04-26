import { describe, expect, test } from "bun:test";
import {
  buildBusinessLogicArtifact,
  buildReverseEngineeringDetails,
  buildSystemGraphArtifact,
  buildSystemGraphMermaid,
} from "./reverseEngineeringArtifacts.js";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";

const frameworkInfo: FrameworkInfo = {
  sourceFramework: "express",
  sourceLanguage: "javascript",
  targetFramework: "aspnet-core",
  targetLanguage: "csharp",
  architecturePattern: "mvc",
  packageManager: "npm",
};

const analyses: ComponentAnalysis[] = [
  {
    component: {
      name: "FileRouter",
      type: "controller",
      filePaths: ["src/controllers/FileRouter.js"],
      dependencies: ["FileService"],
      description: "Routes inbound files.",
    },
    purpose: "Routes inbound files to downstream processing.",
    businessRules: ["Reject unsupported file extensions"],
    evidence: [{
      kind: "business_rule",
      statement: "Reject unsupported file extensions",
      basis: "observed",
      confidence: "high",
      sourceFile: "src/controllers/FileRouter.js",
      lineStart: 10,
      lineEnd: 12,
    }],
    sourceCoverage: { filesProvided: 1, filesTruncated: [] },
    inputContract: { fileName: "string" },
    outputContract: { accepted: "boolean" },
    externalDependencies: ["express"],
    targetPattern: "ASP.NET Core controller",
    targetRole: "rest_api",
    targetRoleRationale: "Synchronous request/response file routing endpoint.",
    targetIntegrationBoundary: "HTTP route",
    targetDependencies: ["Microsoft.AspNetCore.App"],
    migrationNotes: [],
    migrationRisks: ["Extension mapping can regress."],
    humanQuestions: [],
    validationScenarios: ["Unsupported files are rejected."],
    complexity: "medium",
    confidence: "high",
    unknownFields: [],
  },
  {
    component: {
      name: "FileService",
      type: "service",
      filePaths: ["src/services/FileService.js"],
      dependencies: [],
      description: "Processes files.",
    },
    purpose: "Processes files after routing.",
    businessRules: [],
    evidence: [],
    sourceCoverage: { filesProvided: 1, filesTruncated: [] },
    inputContract: {},
    outputContract: {},
    externalDependencies: [],
    targetPattern: "ASP.NET Core service",
    targetRole: "microservice",
    targetRoleRationale: "Owns file processing capability.",
    targetIntegrationBoundary: "service method",
    targetDependencies: [],
    migrationNotes: [],
    migrationRisks: [],
    humanQuestions: ["Confirm file retention policy."],
    validationScenarios: [],
    complexity: "high",
    confidence: "medium",
    unknownFields: [],
  },
];

describe("reverse engineering artifacts", () => {
  test("builds a graph with components, source files, packages, and target roles", () => {
    const graph = buildSystemGraphArtifact({
      repoUrl: "https://github.com/acme/files",
      generatedAt: "2026-04-25T00:00:00.000Z",
      frameworkInfo,
      analyses,
      migrationOrder: ["FileService", "FileRouter"],
    });

    expect(graph.stats.components).toBe(2);
    expect(graph.nodes.some((node) => node.id === "component:FileRouter")).toBe(true);
    expect(graph.edges).toContainEqual({
      source: "component:FileRouter",
      target: "component:FileService",
      type: "depends_on",
      label: "depends on",
    });
    expect(graph.edges.some((edge) => edge.type === "recommended_role" && edge.target === "target_role:rest_api")).toBe(true);
  });

  test("builds business logic artifact with rules and source evidence", () => {
    const businessLogic = buildBusinessLogicArtifact({
      repoUrl: "https://github.com/acme/files",
      generatedAt: "2026-04-25T00:00:00.000Z",
      frameworkInfo,
      analyses,
    });

    expect(businessLogic.components[0]?.businessRules[0]?.statement).toBe("Reject unsupported file extensions");
    expect(businessLogic.components[0]?.businessRules[0]?.evidence[0]?.source).toBe("src/controllers/FileRouter.js:L10-L12");
    expect(businessLogic.components[1]?.humanQuestions).toContain("Confirm file retention policy.");
  });

  test("renders human-readable report and mermaid graph", () => {
    const graph = buildSystemGraphArtifact({
      repoUrl: "https://github.com/acme/files",
      generatedAt: "2026-04-25T00:00:00.000Z",
      frameworkInfo,
      analyses,
      migrationOrder: ["FileService", "FileRouter"],
    });
    const report = buildReverseEngineeringDetails({
      repoUrl: "https://github.com/acme/files",
      generatedAt: "2026-04-25T00:00:00.000Z",
      frameworkInfo,
      analyses,
      migrationOrder: ["FileService", "FileRouter"],
      graph,
    });
    const mermaid = buildSystemGraphMermaid(graph);

    expect(report).toContain("Reverse Engineering Details");
    expect(report).toContain("Reject unsupported file extensions");
    expect(report).toContain("Confirm file retention policy.");
    expect(mermaid).toContain("flowchart LR");
    expect(mermaid).toContain("depends on");
  });
});
