// ---------------------------------------------------------------------------
// Types for the /migrate rewrite KB-gathering pipeline.
// This pipeline analyzes a full codebase and generates migration context docs.
// The actual rewriting is done by Claude Code / Codex using those docs.
// ---------------------------------------------------------------------------

import type { EvidenceItem, SourceCoverage } from "./evidence.js";

export type ComponentType =
  | "controller"
  | "service"
  | "repository"
  | "model"
  | "dto"
  | "middleware"
  | "config"
  | "utility"
  | "test"
  | "unknown";

export type Complexity = "low" | "medium" | "high";

export type TargetArchitectureRole =
  | "workflow"
  | "azure_function"
  | "databricks_job"
  | "rest_api"
  | "microservice"
  | "common_library"
  | "rules_engine"
  | "data_model"
  | "integration_adapter"
  | "human_review"
  | "unknown";

/** A component identified in the source codebase */
export type SourceComponent = {
  name: string;
  type: ComponentType;
  filePaths: string[];
  dependencies: string[];    // names of other SourceComponents this depends on
  description: string;
};

/** Framework/language info detected from the repo */
export type FrameworkInfo = {
  sourceFramework: string;    // e.g. "aspnet-core", "spring-boot", "express"
  sourceLanguage: string;     // e.g. "csharp", "java", "typescript"
  targetFramework: string;    // e.g. "fastapi", "django", "flask"
  targetLanguage: string;     // e.g. "python", "go", "typescript"
  architecturePattern: string; // e.g. "layered", "ddd", "hexagonal", "mvc"
  packageManager: string;     // e.g. "nuget", "maven", "npm"
};

/** Deep analysis of one component — produced by Sonnet */
export type ComponentAnalysis = {
  component: SourceComponent;
  purpose: string;
  businessRules: string[];
  evidence: EvidenceItem[];
  sourceCoverage: SourceCoverage;
  inputContract: Record<string, string>;
  outputContract: Record<string, string>;
  externalDependencies: string[];   // source-lang packages this component uses
  targetPattern: string;            // e.g. "FastAPI APIRouter with Pydantic schemas"
  targetRole: TargetArchitectureRole;
  targetRoleRationale: string;
  targetIntegrationBoundary: string;
  targetDependencies: string[];     // pip/npm packages needed in the rewrite
  migrationNotes: string[];         // specific gotchas, replacements, warnings
  migrationRisks: string[];
  humanQuestions: string[];
  validationScenarios: string[];
  complexity: Complexity;
  confidence: "high" | "medium" | "low";
  unknownFields: string[];
};

/** Full result returned from rewriteTracer.analyze() */
export type RewriteResult = {
  frameworkInfo: FrameworkInfo;
  components: ComponentAnalysis[];
  migrationOrder: string[];   // component names sorted by dependency (leaf-first)
  unanalyzed: string[];       // components that failed analysis
  errors: string[];
  indexPath: string | null;
  reportPath: string | null;
};
