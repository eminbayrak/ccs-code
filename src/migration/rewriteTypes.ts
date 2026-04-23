// ---------------------------------------------------------------------------
// Types for the /migrate rewrite KB-gathering pipeline.
// This pipeline analyzes a full codebase and generates migration context docs.
// The actual rewriting is done by Claude Code / Codex using those docs.
// ---------------------------------------------------------------------------

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
  inputContract: Record<string, string>;
  outputContract: Record<string, string>;
  externalDependencies: string[];   // source-lang packages this component uses
  targetPattern: string;            // e.g. "FastAPI APIRouter with Pydantic schemas"
  targetDependencies: string[];     // pip/npm packages needed in the rewrite
  migrationNotes: string[];         // specific gotchas, replacements, warnings
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
