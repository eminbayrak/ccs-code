import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getArchitectureBaseline,
  getBusinessLogic,
  getComponentContext,
  getDependencyImpact,
  getHumanQuestions,
  getPreflightReadiness,
  getSystemGraph,
  getValidationContract,
  getVerificationReport,
  listReadyComponents,
  resolveRewriteDir,
} from "./artifactReader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRewriteFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccs-mcp-artifacts-"));
  tempDirs.push(root);
  const rewriteDir = join(root, "migration", "rewrite");
  await mkdir(join(rewriteDir, "context"), { recursive: true });

  await writeFile(join(rewriteDir, "migration-contract.json"), JSON.stringify({
    schemaVersion: "1.0",
    repoUrl: "https://github.com/acme/legacy",
    migration: {
      sourceFramework: "vb6",
      targetFramework: "azure-functions",
      targetLanguage: "typescript",
    },
    globalGuardrails: ["Preserve business behaviour."],
    migrationOrder: ["FileRouter", "AddressCorrector"],
    components: [
      {
        name: "FileRouter",
        type: "service",
        implementationStatus: "ready",
        sourceFiles: ["src/FileRouter.bas"],
        dependencies: [],
        target: {
          role: "azure_function",
          rationale: "File arrival is event-driven.",
          targetFileHint: "file_router.ts",
        },
        risk: {
          confidence: "high",
          complexity: "medium",
          migrationRisks: ["Route mismatch."],
        },
        businessRules: [{ statement: "Reject unsupported files." }],
        contracts: { input: { fileName: "string" }, output: { taskId: "string" } },
        humanQuestions: [],
        validationScenarios: ["Reject unsupported files with the legacy status."],
        acceptanceCriteria: ["Preserve observed business rule: Reject unsupported files."],
      },
      {
        name: "AddressCorrector",
        type: "utility",
        implementationStatus: "blocked",
        requiredReviewBeforeImplementation: ["human questions are unresolved"],
        target: { role: "human_review" },
        humanQuestions: ["Should address correction call First Logic?"],
        validationScenarios: [],
      },
    ],
  }, null, 2));

  await writeFile(join(rewriteDir, "context", "FileRouter.md"), "# Migration Context: FileRouter\n\nRoutes inbound files.", "utf-8");
  await mkdir(join(rewriteDir, "reverse-engineering"), { recursive: true });
  await writeFile(join(rewriteDir, "reverse-engineering", "business-logic.json"), JSON.stringify({
    schemaVersion: "1.0",
    repoUrl: "https://github.com/acme/legacy",
    components: [{ name: "FileRouter", businessRules: [{ statement: "Reject unsupported files." }] }],
  }, null, 2), "utf-8");
  await writeFile(join(rewriteDir, "system-graph.json"), JSON.stringify({
    schemaVersion: "1.0",
    repoUrl: "https://github.com/acme/legacy",
    nodes: [
      { id: "component:FileRouter", label: "FileRouter", type: "component" },
      { id: "component:AddressCorrector", label: "AddressCorrector", type: "component" },
      { id: "source_file:src/FileRouter.bas", label: "src/FileRouter.bas", type: "source_file" },
      { id: "target_role:azure_function", label: "azure_function", type: "target_role" },
    ],
    edges: [
      { source: "component:FileRouter", target: "component:AddressCorrector", type: "depends_on", label: "depends on" },
      { source: "component:FileRouter", target: "source_file:src/FileRouter.bas", type: "defined_in", label: "defined in" },
      { source: "component:FileRouter", target: "target_role:azure_function", type: "recommended_role", label: "recommended role", evidence: "File arrival is event-driven." },
    ],
  }, null, 2), "utf-8");
  await writeFile(join(rewriteDir, "human-questions.md"), "# Human Questions\n\nShould address correction call First Logic?", "utf-8");
  await writeFile(join(rewriteDir, "preflight-readiness.md"), "# Migration Preflight Readiness\n\n| Gate | Status |", "utf-8");
  await writeFile(join(rewriteDir, "component-disposition-matrix.md"), "# Component Disposition Matrix\n\n| FileRouter | azure_function |", "utf-8");
  await mkdir(join(rewriteDir, "verification"), { recursive: true });
  await writeFile(
    join(rewriteDir, "verification-summary.md"),
    "# Verification Summary\n\n0 ready · 1 needs_review · 0 blocked\n",
    "utf-8",
  );
  await writeFile(
    join(rewriteDir, "verification", "FileRouter.md"),
    "# Verification: FileRouter\n\nTrust verdict: ready. 6 verified.",
    "utf-8",
  );

  return rewriteDir;
}

describe("CCS MCP artifact reader", () => {
  test("resolves a migration directory or its rewrite child", async () => {
    const rewriteDir = await makeRewriteFixture();

    await expect(resolveRewriteDir(rewriteDir)).resolves.toBe(rewriteDir);
    await expect(resolveRewriteDir(join(rewriteDir, ".."))).resolves.toBe(rewriteDir);
  });

  test("lists only implementation-ready components", async () => {
    const rewriteDir = await makeRewriteFixture();
    const result = JSON.parse(await listReadyComponents(rewriteDir));

    expect(result.ready).toHaveLength(1);
    expect(result.ready[0].name).toBe("FileRouter");
    expect(result.ready[0].targetRole).toBe("azure_function");
    expect(result.blockedCount).toBe(1);
  });

  test("reads component context docs", async () => {
    const rewriteDir = await makeRewriteFixture();

    await expect(getComponentContext(rewriteDir, "FileRouter")).resolves.toContain("Routes inbound files");
  });

  test("returns validation contract for one component", async () => {
    const rewriteDir = await makeRewriteFixture();
    const result = JSON.parse(await getValidationContract(rewriteDir, "FileRouter"));

    expect(result.implementationStatus).toBe("ready");
    expect(result.validationScenarios).toContain("Reject unsupported files with the legacy status.");
    expect(result.acceptanceCriteria).toContain("Preserve observed business rule: Reject unsupported files.");
  });

  test("reads human questions and architecture baseline", async () => {
    const rewriteDir = await makeRewriteFixture();

    await expect(getHumanQuestions(rewriteDir)).resolves.toContain("First Logic");
    await expect(getArchitectureBaseline(rewriteDir)).resolves.toContain("Component Disposition Matrix");
    await expect(getPreflightReadiness(rewriteDir)).resolves.toContain("Migration Preflight Readiness");
  });

  test("reads reverse engineering graph, business logic, and dependency impact", async () => {
    const rewriteDir = await makeRewriteFixture();

    await expect(getSystemGraph(rewriteDir)).resolves.toContain("component:FileRouter");
    await expect(getBusinessLogic(rewriteDir)).resolves.toContain("Reject unsupported files.");

    const impact = JSON.parse(await getDependencyImpact(rewriteDir, "FileRouter"));
    expect(impact.directDependencies).toContain("AddressCorrector");
    expect(impact.sourceFiles).toContain("src/FileRouter.bas");
    expect(impact.targetRoles[0].role).toBe("azure_function");
  });

  test("reads verification summary and per-component reports", async () => {
    const rewriteDir = await makeRewriteFixture();

    await expect(getVerificationReport(rewriteDir)).resolves.toContain("Verification Summary");
    await expect(getVerificationReport(rewriteDir, "FileRouter")).resolves.toContain("Verification: FileRouter");
  });
});
