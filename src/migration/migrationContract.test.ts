import { describe, expect, test } from "bun:test";
import {
  buildAgentIntegrationGuide,
  buildDispositionMatrix,
  buildHowToMigrate,
  buildHumanQuestionsDoc,
  buildMigrationContract,
  type MigrationContractInput,
} from "./migrationContract.js";

const input: MigrationContractInput = {
  repoUrl: "https://github.com/acme/legacy",
  generatedAt: "2026-04-24T00:00:00.000Z",
  migrationOrder: ["FileRouter", "AddressCorrector"],
  frameworkInfo: {
    sourceFramework: "vb6",
    sourceLanguage: "unknown",
    targetFramework: "azure-functions",
    targetLanguage: "typescript",
    architecturePattern: "event-driven",
    packageManager: "unknown",
  },
  analyses: [
    {
      component: {
        name: "FileRouter",
        type: "service",
        filePaths: ["src/FileRouter.bas"],
        dependencies: [],
        description: "Routes inbound files.",
      },
      purpose: "Classifies inbound client files and starts processing.",
      businessRules: ["Unsupported file types are rejected"],
      evidence: [{
        kind: "business_rule",
        statement: "Unsupported file types are rejected",
        basis: "observed",
        confidence: "high",
        sourceFile: "src/FileRouter.bas",
        lineStart: 12,
        lineEnd: 20,
      }],
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
      migrationRisks: ["Incorrect event metadata can route files to the wrong parser."],
      humanQuestions: [],
      validationScenarios: ["Reject unsupported file types with the same legacy status."],
      complexity: "medium",
      confidence: "high",
      unknownFields: [],
    },
    {
      component: {
        name: "AddressCorrector",
        type: "utility",
        filePaths: ["src/AddressCorrector.bas"],
        dependencies: ["FileRouter"],
        description: "Corrects mailing addresses.",
      },
      purpose: "Normalizes addresses before downstream delivery.",
      businessRules: [],
      evidence: [],
      sourceCoverage: {
        filesProvided: 1,
        filesTruncated: [{
          path: "src/AddressCorrector.bas",
          originalChars: 10000,
          providedChars: 6000,
          originalLines: 400,
          providedLines: 240,
          truncated: true,
        }],
      },
      inputContract: {},
      outputContract: {},
      externalDependencies: [],
      targetPattern: "unknown",
      targetRole: "human_review",
      targetRoleRationale: "Target ownership depends on address vendor decision.",
      targetIntegrationBoundary: "unknown",
      targetDependencies: [],
      migrationNotes: [],
      migrationRisks: [],
      humanQuestions: ["Should address correction call First Logic or an internal service?"],
      validationScenarios: ["Verify corrected address output against legacy samples."],
      complexity: "high",
      confidence: "low",
      unknownFields: ["targetIntegrationBoundary"],
    },
  ],
};

describe("migration contract artifacts", () => {
  test("builds machine-readable implementation gates", () => {
    const contract = JSON.parse(buildMigrationContract(input));

    expect(contract.components[0].implementationStatus).toBe("ready");
    expect(contract.components[0].target.role).toBe("azure_function");
    expect(contract.components[0].acceptanceCriteria).toContain("Preserve observed business rule: Unsupported file types are rejected");
    expect(contract.components[1].implementationStatus).toBe("blocked");
    expect(contract.components[1].requiredReviewBeforeImplementation).toContain("target role is human_review");
  });

  test("treats human questions as needs_review when target role is known", () => {
    const withQuestion: MigrationContractInput = {
      ...input,
      migrationOrder: ["FileRouter"],
      analyses: [{
        ...input.analyses[0]!,
        humanQuestions: ["Should this stay one API or split by bounded context?"],
      }],
    };
    const contract = JSON.parse(buildMigrationContract(withQuestion));

    expect(contract.components[0].implementationStatus).toBe("needs_review");
    expect(contract.components[0].requiredReviewBeforeImplementation).toContain("human questions require review");
  });

  test("builds human and agent-facing guidance", () => {
    const matrix = buildDispositionMatrix(input);
    const questions = buildHumanQuestionsDoc(input);
    const howTo = buildHowToMigrate(input);
    const integration = buildAgentIntegrationGuide(input);

    expect(matrix).toContain("Component Disposition Matrix");
    expect(matrix).toContain("| FileRouter | service | azure_function | ready |");
    expect(questions).toContain("Should address correction call First Logic");
    expect(howTo).toContain("Gate: `blocked`");
    expect(howTo).toContain("/project:rewrite-FileRouter");
    expect(integration).toContain("Use CCS Code as a migration contract generator");
    expect(integration).toContain("ccs_get_ready_work");
  });
});
