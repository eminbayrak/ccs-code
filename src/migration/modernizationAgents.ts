import type { TargetArchitectureRole } from "./rewriteTypes.js";

export type ModernizationAgentRole =
  | "modernization-intake"
  | "repo-system-design"
  | "legacy-behavior"
  | "business-context"
  | "architecture-baseline"
  | "target-architecture"
  | "risk-validation"
  | "migration-contract"
  | "implementation-handoff";

export type EvidenceBasis = "observed" | "provided_context" | "inferred" | "unknown";

export type TargetLandingZone =
  | TargetArchitectureRole
  | "azure_container_app"
  | "aks_service"
  | "azure_logic_app"
  | "azure_service_bus_flow"
  | "azure_api_management"
  | "azure_blob_storage"
  | "azure_sql"
  | "cosmos_db"
  | "camunda_workflow";

export type ModernizationAgentSpec = {
  role: ModernizationAgentRole;
  displayName: string;
  mission: string;
  primaryInputs: string[];
  primaryOutputs: string[];
  stopConditions: string[];
};

export type ArchitectureContextKind =
  | "current_state_diagram"
  | "target_state_diagram"
  | "modernization_flow"
  | "platform_standard"
  | "architecture_decision_record"
  | "business_process_flow"
  | "integration_contract"
  | "schema_or_data_model"
  | "runbook";

export type ArchitectureContextDocument = {
  path: string;
  title: string;
  kind: ArchitectureContextKind;
  scope: string;
  summary?: string;
  approvedDecisions: string[];
  constraints: string[];
  openQuestions: string[];
};

export type ModernizationBrief = {
  systemName: string;
  businessGoal: string;
  sourceRepositories: string[];
  targetPlatform: string;
  targetLanguage?: string;
  approvedPatterns: string[];
  forbiddenPatterns: string[];
  businessContextPaths: string[];
  architectureContext: ArchitectureContextDocument[];
  validationAssets: string[];
  constraints: string[];
  openQuestions: string[];
};

export type ArchitectureProfile = {
  platform: "azure" | "aws" | "gcp" | "on_prem" | "hybrid" | "unknown";
  preferredLandingZones: TargetLandingZone[];
  integrationStandards: string[];
  dataStandards: string[];
  securityStandards: string[];
  operationalStandards: string[];
  baselineDocuments: ArchitectureContextDocument[];
};

export type TargetArchitectureDecision = {
  capabilityName: string;
  selectedLandingZone: TargetLandingZone;
  candidateLandingZones: TargetLandingZone[];
  rationale: string;
  rejectedOptions: Record<string, string>;
  evidenceBasis: EvidenceBasis;
  architectureContextPaths: string[];
  confidence: "high" | "medium" | "low";
  blockers: string[];
  validationScenarios: string[];
};

export type ModernizationAgentArtifact =
  | "modernization_brief"
  | "architecture_profile"
  | "architecture_baseline"
  | "system_graph"
  | "evidence_ledger"
  | "business_capability_map"
  | "target_decision_matrix"
  | "validation_matrix"
  | "migration_contract"
  | "implementation_handoff";

export const MODERNIZATION_AGENT_SPECS: readonly ModernizationAgentSpec[] = [
  {
    role: "modernization-intake",
    displayName: "Intake And Context Agent",
    mission: "Collect business goals, target standards, known decisions, and missing context before code analysis starts.",
    primaryInputs: ["user request", "business documents", "architecture diagrams", "schemas", "sample inputs and outputs"],
    primaryOutputs: ["modernization brief", "architecture profile", "initial open questions"],
    stopConditions: ["No source repository is available", "Target platform constraints are unknown for a decision-heavy migration"],
  },
  {
    role: "repo-system-design",
    displayName: "Repository System Design Agent",
    mission: "Build a system view of entry points, dependencies, runtime flows, and component boundaries from the repository.",
    primaryInputs: ["source repository", "configuration files", "package manifests", "existing migration brief"],
    primaryOutputs: ["system graph", "component inventory", "runtime topology", "evidence ledger"],
    stopConditions: ["Repository cannot be read", "Primary language or framework cannot be detected"],
  },
  {
    role: "legacy-behavior",
    displayName: "Legacy Behavior Agent",
    mission: "Explain business behavior, data contracts, operational rules, and side effects that must be preserved.",
    primaryInputs: ["system graph", "source files", "business context", "database and file schemas"],
    primaryOutputs: ["business capability map", "business rules with evidence", "data contracts", "behavior risks"],
    stopConditions: ["Critical source files are missing", "Behavior cannot be tied to evidence"],
  },
  {
    role: "business-context",
    displayName: "Business Context Agent",
    mission: "Connect observed source behavior to business goals and identify decisions that require product or architect input.",
    primaryInputs: ["modernization brief", "legacy behavior report", "domain notes", "acceptance criteria"],
    primaryOutputs: ["business alignment notes", "resolved decisions", "human review queue"],
    stopConditions: ["Business goal conflicts with observed system behavior"],
  },
  {
    role: "architecture-baseline",
    displayName: "Architecture Baseline Agent",
    mission: "Normalize target diagrams, platform standards, and architect-provided flows into constraints the decision agent can use.",
    primaryInputs: ["target architecture diagrams", "modernization flows", "platform standards", "architecture decision records"],
    primaryOutputs: ["architecture baseline", "approved landing zones", "integration boundaries", "open architecture decisions"],
    stopConditions: ["Target flow contradicts platform standards", "Diagram semantics are ambiguous enough to affect target landing zone decisions"],
  },
  {
    role: "target-architecture",
    displayName: "Target Architecture Decision Agent",
    mission: "Recommend target landing zones by capability and explain selected and rejected options.",
    primaryInputs: ["architecture baseline", "architecture profile", "system graph", "business capability map", "constraints"],
    primaryOutputs: ["target decision matrix", "architecture rationale", "blocked decisions"],
    stopConditions: ["Candidate target services cannot be compared with available context"],
  },
  {
    role: "risk-validation",
    displayName: "Risk And Validation Agent",
    mission: "Turn modernization decisions into validation scenarios, proof obligations, and readiness gates.",
    primaryInputs: ["business rules", "target decisions", "sample data", "known acceptance criteria"],
    primaryOutputs: ["validation matrix", "risk register", "test data needs", "readiness gates"],
    stopConditions: ["No validation path exists for a high-risk capability"],
  },
  {
    role: "migration-contract",
    displayName: "Migration Contract Agent",
    mission: "Merge evidence, behavior, target decisions, risks, and validation into an implementation-ready contract.",
    primaryInputs: ["evidence ledger", "system graph", "target decision matrix", "validation matrix"],
    primaryOutputs: ["migration contract", "component context docs", "implementation gates"],
    stopConditions: ["Required decisions are unresolved for a component marked ready"],
  },
  {
    role: "implementation-handoff",
    displayName: "Implementation Handoff Agent",
    mission: "Prepare coding-agent tasks with source evidence, target decisions, acceptance criteria, and blocked-item separation.",
    primaryInputs: ["migration contract", "component context docs", "validation matrix"],
    primaryOutputs: ["implementation task plan", "agent instructions", "test plan"],
    stopConditions: ["A task depends on unresolved human review"],
  },
] as const;

export function listModernizationAgents(): readonly ModernizationAgentSpec[] {
  return MODERNIZATION_AGENT_SPECS;
}

export function getModernizationAgentSpec(role: ModernizationAgentRole): ModernizationAgentSpec {
  const spec = MODERNIZATION_AGENT_SPECS.find((agent) => agent.role === role);
  if (!spec) {
    throw new Error(`Unknown modernization agent role: ${role}`);
  }
  return spec;
}

export function buildModernizationAgentSystemPrompt(role: ModernizationAgentRole): string {
  const spec = getModernizationAgentSpec(role);
  return [
    `You are the ${spec.displayName} in CCS Code's agentic modernization pipeline.`,
    spec.mission,
    "Work from evidence first. Mark each important claim as observed, provided_context, inferred, or unknown.",
    "Do not turn unresolved architecture or business decisions into implementation instructions.",
    "Prefer capability-led modernization over one-for-one rewrites.",
    `Expected outputs: ${spec.primaryOutputs.join(", ")}.`,
  ].join("\n");
}
