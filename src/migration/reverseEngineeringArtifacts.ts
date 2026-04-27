import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";
import { evidenceSourceLabel } from "./evidence.js";
import {
  buildCodeIntelligenceArtifact,
  writeCodeIntelligenceArtifacts,
  type CodeIntelligenceArtifact,
} from "./codeIntelligence.js";

export type SystemGraphNodeType =
  | "component"
  | "source_file"
  | "symbol"
  | "target_role"
  | "source_package"
  | "target_package";

export type SystemGraphEdgeType =
  | "depends_on"
  | "defined_in"
  | "declares_symbol"
  | "calls"
  | "recommended_role"
  | "uses_source_package"
  | "needs_target_package";

export type SystemGraphNode = {
  id: string;
  label: string;
  type: SystemGraphNodeType;
  metadata?: Record<string, unknown>;
};

export type SystemGraphEdge = {
  source: string;
  target: string;
  type: SystemGraphEdgeType;
  label: string;
  evidence?: string;
};

export type SystemGraphArtifact = {
  schemaVersion: "1.0";
  generatedAt: string;
  repoUrl: string;
  migration: FrameworkInfo;
  stats: {
    components: number;
    sourceFiles: number;
    dependencyEdges: number;
    packages: number;
    symbols?: number;
    callEdges?: number;
  };
  migrationOrder: string[];
  nodes: SystemGraphNode[];
  edges: SystemGraphEdge[];
};

export type BusinessLogicArtifact = {
  schemaVersion: "1.0";
  generatedAt: string;
  repoUrl: string;
  migration: FrameworkInfo;
  components: Array<{
    name: string;
    type: string;
    purpose: string;
    sourceFiles: string[];
    dependencies: string[];
    businessRules: Array<{
      statement: string;
      evidence: Array<{
        basis: string;
        confidence: string;
        source: string;
      }>;
    }>;
    dataContract: {
      input: Record<string, string>;
      output: Record<string, string>;
    };
    targetDisposition: {
      role: string;
      rationale: string;
      integrationBoundary: string;
      pattern: string;
    };
    risks: string[];
    humanQuestions: string[];
    validationScenarios: string[];
    confidence: string;
    complexity: string;
  }>;
};

export type ReverseEngineeringWriteResult = {
  reverseEngineeringDir: string;
  businessLogicPath: string;
  detailsPath: string;
  graphJsonPath: string;
  graphMermaidPath: string;
};

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function nodeId(type: string, value: string): string {
  return `${type}:${value}`;
}

function mermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function mermaidLabel(value: string): string {
  return value.replace(/"/g, "'");
}

function addNode(nodes: Map<string, SystemGraphNode>, node: SystemGraphNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function buildSystemGraphArtifact(input: {
  repoUrl: string;
  generatedAt: string;
  frameworkInfo: FrameworkInfo;
  analyses: ComponentAnalysis[];
  migrationOrder: string[];
  codeIntelligence?: CodeIntelligenceArtifact;
}): SystemGraphArtifact {
  const nodes = new Map<string, SystemGraphNode>();
  const edges: SystemGraphEdge[] = [];
  const componentNames = new Set(input.analyses.map((analysis) => analysis.component.name));

  for (const analysis of input.analyses) {
    const componentId = nodeId("component", analysis.component.name);
    addNode(nodes, {
      id: componentId,
      label: analysis.component.name,
      type: "component",
      metadata: {
        componentType: analysis.component.type,
        targetRole: analysis.targetRole,
        confidence: analysis.confidence,
        complexity: analysis.complexity,
        purpose: analysis.purpose,
      },
    });

    for (const dependency of analysis.component.dependencies) {
      const dependencyId = nodeId("component", dependency);
      addNode(nodes, {
        id: dependencyId,
        label: dependency,
        type: "component",
        metadata: {
          unresolved: !componentNames.has(dependency),
        },
      });
      edges.push({
        source: componentId,
        target: dependencyId,
        type: "depends_on",
        label: "depends on",
      });
    }

    for (const path of analysis.component.filePaths) {
      const fileId = nodeId("source_file", path);
      addNode(nodes, {
        id: fileId,
        label: path,
        type: "source_file",
      });
      edges.push({
        source: componentId,
        target: fileId,
        type: "defined_in",
        label: "defined in",
      });
    }

    const targetRoleId = nodeId("target_role", analysis.targetRole);
    addNode(nodes, {
      id: targetRoleId,
      label: analysis.targetRole,
      type: "target_role",
    });
    edges.push({
      source: componentId,
      target: targetRoleId,
      type: "recommended_role",
      label: "recommended role",
      evidence: analysis.targetRoleRationale,
    });

    for (const dependency of analysis.externalDependencies) {
      const packageId = nodeId("source_package", dependency);
      addNode(nodes, {
        id: packageId,
        label: dependency,
        type: "source_package",
      });
      edges.push({
        source: componentId,
        target: packageId,
        type: "uses_source_package",
        label: "uses",
      });
    }

    for (const dependency of analysis.targetDependencies) {
      const packageId = nodeId("target_package", dependency);
      addNode(nodes, {
        id: packageId,
        label: dependency,
        type: "target_package",
      });
      edges.push({
        source: componentId,
        target: packageId,
        type: "needs_target_package",
        label: "needs",
      });
    }
  }

  if (input.codeIntelligence) {
    const componentByName = new Map(input.analyses.map((analysis) => [analysis.component.name, analysis]));
    for (const symbol of input.codeIntelligence.symbols.slice(0, 600)) {
      addNode(nodes, {
        id: symbol.id,
        label: symbol.name,
        type: "symbol",
        metadata: {
          kind: symbol.kind,
          file: symbol.file,
          lineStart: symbol.lineStart,
          lineEnd: symbol.lineEnd,
          component: symbol.component,
        },
      });
      if (symbol.component && componentByName.has(symbol.component)) {
        edges.push({
          source: nodeId("component", symbol.component),
          target: symbol.id,
          type: "declares_symbol",
          label: "declares",
          evidence: `${symbol.file}:L${symbol.lineStart}`,
        });
      }
    }
    const knownSymbolIds = new Set(input.codeIntelligence.symbols.slice(0, 600).map((symbol) => symbol.id));
    for (const call of input.codeIntelligence.calls.slice(0, 1200)) {
      if (!call.targetSymbolId || !knownSymbolIds.has(call.sourceSymbolId) || !knownSymbolIds.has(call.targetSymbolId)) continue;
      edges.push({
        source: call.sourceSymbolId,
        target: call.targetSymbolId,
        type: "calls",
        label: "calls",
        evidence: `${call.file}:L${call.line}`,
      });
    }
  }

  const sourceFiles = sortedUnique(input.analyses.flatMap((analysis) => analysis.component.filePaths));
  const packages = sortedUnique(input.analyses.flatMap((analysis) => [
    ...analysis.externalDependencies,
    ...analysis.targetDependencies,
  ]));

  return {
    schemaVersion: "1.0",
    generatedAt: input.generatedAt,
    repoUrl: input.repoUrl,
    migration: input.frameworkInfo,
    stats: {
      components: input.analyses.length,
      sourceFiles: sourceFiles.length,
      dependencyEdges: edges.filter((edge) => edge.type === "depends_on").length,
      packages: packages.length,
      symbols: input.codeIntelligence?.stats.symbols,
      callEdges: input.codeIntelligence?.stats.resolvedCalls,
    },
    migrationOrder: input.migrationOrder,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => `${a.source}:${a.type}:${a.target}`.localeCompare(`${b.source}:${b.type}:${b.target}`)),
  };
}

export function buildBusinessLogicArtifact(input: {
  repoUrl: string;
  generatedAt: string;
  frameworkInfo: FrameworkInfo;
  analyses: ComponentAnalysis[];
}): BusinessLogicArtifact {
  return {
    schemaVersion: "1.0",
    generatedAt: input.generatedAt,
    repoUrl: input.repoUrl,
    migration: input.frameworkInfo,
    components: input.analyses.map((analysis) => ({
      name: analysis.component.name,
      type: analysis.component.type,
      purpose: analysis.purpose,
      sourceFiles: analysis.component.filePaths,
      dependencies: analysis.component.dependencies,
      businessRules: analysis.businessRules.map((rule) => ({
        statement: rule,
        evidence: analysis.evidence
          .filter((item) =>
            item.kind === "business_rule" &&
            (item.statement === rule || item.statement.includes(rule) || rule.includes(item.statement))
          )
          .map((item) => ({
            basis: item.basis,
            confidence: item.confidence,
            source: evidenceSourceLabel(item),
          })),
      })),
      dataContract: {
        input: analysis.inputContract,
        output: analysis.outputContract,
      },
      targetDisposition: {
        role: analysis.targetRole,
        rationale: analysis.targetRoleRationale,
        integrationBoundary: analysis.targetIntegrationBoundary,
        pattern: analysis.targetPattern,
      },
      risks: analysis.migrationRisks,
      humanQuestions: analysis.humanQuestions,
      validationScenarios: analysis.validationScenarios,
      confidence: analysis.confidence,
      complexity: analysis.complexity,
    })),
  };
}

export function buildSystemGraphMermaid(graph: SystemGraphArtifact): string {
  const componentNodes = graph.nodes.filter((node) => node.type === "component");
  const componentIds = new Set(componentNodes.map((node) => node.id));
  const dependencyEdges = graph.edges.filter((edge) =>
    edge.type === "depends_on" &&
    componentIds.has(edge.source) &&
    componentIds.has(edge.target)
  );
  const roleEdges = graph.edges.filter((edge) => edge.type === "recommended_role");

  const lines = [
    "flowchart LR",
    "  %% Component dependency graph generated by CCS Code",
    ...componentNodes.map((node) => `  ${mermaidId(node.id)}["${mermaidLabel(node.label)}"]`),
    ...graph.nodes
      .filter((node) => node.type === "target_role")
      .map((node) => `  ${mermaidId(node.id)}(["${mermaidLabel(node.label)}"])`),
    ...dependencyEdges.map((edge) =>
      `  ${mermaidId(edge.source)} -->|depends on| ${mermaidId(edge.target)}`
    ),
    ...roleEdges.map((edge) =>
      `  ${mermaidId(edge.source)} -.->|target| ${mermaidId(edge.target)}`
    ),
  ];

  return `${lines.join("\n")}\n`;
}

export function buildReverseEngineeringDetails(input: {
  repoUrl: string;
  generatedAt: string;
  frameworkInfo: FrameworkInfo;
  analyses: ComponentAnalysis[];
  migrationOrder: string[];
  graph: SystemGraphArtifact;
  codeIntelligence?: CodeIntelligenceArtifact;
}): string {
  const reviewQueue = input.analyses.filter((analysis) =>
    analysis.targetRole === "human_review" ||
    analysis.targetRole === "unknown" ||
    analysis.humanQuestions.length > 0 ||
    analysis.confidence === "low"
  );

  const componentRows = input.analyses.map((analysis) =>
    `| ${escapeMarkdownTable(analysis.component.name)} | ${analysis.component.type} | ${escapeMarkdownTable(analysis.purpose)} | ${analysis.targetRole} | ${analysis.confidence} | ${analysis.complexity} |`
  );

  const businessRules = input.analyses.flatMap((analysis) =>
    analysis.businessRules.map((rule) => {
      const evidence = analysis.evidence.find((item) =>
        item.kind === "business_rule" &&
        (item.statement === rule || item.statement.includes(rule) || rule.includes(item.statement))
      );
      return `- **${analysis.component.name}:** ${rule}${evidence ? ` _(source: ${evidenceSourceLabel(evidence)}, ${evidence.basis}/${evidence.confidence})_` : " _(uncited; verify manually)_"}`;
    })
  );

  const contracts = input.analyses.map((analysis) => [
    `### ${analysis.component.name}`,
    "",
    `**Inputs:** ${Object.keys(analysis.inputContract).length > 0 ? "" : "unknown"}`,
    Object.entries(analysis.inputContract).map(([key, value]) => `- \`${key}\`: ${value}`).join("\n"),
    "",
    `**Outputs:** ${Object.keys(analysis.outputContract).length > 0 ? "" : "unknown"}`,
    Object.entries(analysis.outputContract).map(([key, value]) => `- \`${key}\`: ${value}`).join("\n"),
  ].filter((part) => part !== "").join("\n"));

  return `# Reverse Engineering Details

_Repo: ${input.repoUrl}_
_Generated: ${input.generatedAt}_
_Source: ${input.frameworkInfo.sourceFramework} (${input.frameworkInfo.sourceLanguage})_

This artifact captures the legacy system understanding CCS extracted before implementation. Coding agents should use it as evidence, not as permission to guess.

## Generated Companion Artifacts

- \`business-logic.json\` — machine-readable business rules, contracts, validation scenarios, and target disposition
- \`code-intelligence.json\` — lightweight symbol and call map for impact analysis
- \`code-intelligence.md\` — human-readable summary of symbols and resolved calls
- \`../system-graph.json\` — machine-readable component/file/package/target graph
- \`../system-graph.mmd\` — Mermaid view of component dependencies and target roles

## System Graph Summary

| Metric | Value |
|---|---:|
| Components | ${input.graph.stats.components} |
| Source files | ${input.graph.stats.sourceFiles} |
| Dependency edges | ${input.graph.stats.dependencyEdges} |
| Packages | ${input.graph.stats.packages} |
| Symbols | ${input.graph.stats.symbols ?? 0} |
| Resolved call edges | ${input.graph.stats.callEdges ?? 0} |

## Component Capability Map

| Component | Type | Purpose | Target Role | Confidence | Complexity |
|---|---|---|---|---|---|
${componentRows.join("\n") || "| _none_ |  |  |  |  |  |"}

## Business Rules Extracted

${businessRules.length > 0 ? businessRules.join("\n") : "_No business rules were extracted. Treat this as a confidence gap._"}

## Data Contracts

${contracts.join("\n\n") || "_No component contracts were extracted._"}

## Migration Order From Graph

${input.migrationOrder.length > 0
  ? input.migrationOrder.map((name, index) => `${index + 1}. ${name}`).join("\n")
  : "_No migration order was generated._"}

## Human Review Queue

${reviewQueue.length > 0
  ? reviewQueue.map((analysis) => `- **${analysis.component.name}** — ${analysis.humanQuestions.join("; ") || `target role is ${analysis.targetRole}`}`).join("\n")
  : "_No review items identified._"}

## Agent Use

- Use \`business-logic.json\` for exact rules/contracts.
- Use \`code-intelligence.json\` for symbol-level call evidence where available.
- Use \`system-graph.json\` for dependency impact analysis.
- Use \`system-graph.mmd\` when a human needs a quick architecture view.
- Do not implement a component whose target role or integration boundary is unresolved.
`;
}

export function formatReverseEngineeringContextForPrompt(
  businessLogic: BusinessLogicArtifact,
  maxChars = 12_000,
): string {
  const lines = businessLogic.components.map((component) => [
    `## ${component.name} (${component.type})`,
    `Purpose: ${component.purpose}`,
    `Dependencies: ${component.dependencies.join(", ") || "none"}`,
    `Target role: ${component.targetDisposition.role}`,
    `Business rules: ${component.businessRules.map((rule) => rule.statement).join("; ") || "none extracted"}`,
    `Human questions: ${component.humanQuestions.join("; ") || "none"}`,
  ].join("\n"));
  const content = [
    "# Previously Persisted Reverse Engineering Context",
    `Repo: ${businessLogic.repoUrl}`,
    ...lines,
  ].join("\n\n");
  return content.length > maxChars
    ? `${content.slice(0, maxChars)}\n\n[TRUNCATED: prior reverse engineering context omitted for prompt size]`
    : content;
}

export async function loadPriorReverseEngineeringContext(
  rewriteDir: string,
  repoUrl: string,
): Promise<string> {
  try {
    const raw = await fs.readFile(join(rewriteDir, "reverse-engineering", "business-logic.json"), "utf-8");
    const parsed = JSON.parse(raw) as BusinessLogicArtifact;
    if (parsed.repoUrl !== repoUrl) return "";
    return formatReverseEngineeringContextForPrompt(parsed);
  } catch {
    return "";
  }
}

export async function writeReverseEngineeringArtifacts(input: {
  /** Repo-scoped run directory; the caller passes the resolved path. */
  runDir: string;
  reverseEngineeringDir: string;
  systemGraphJsonPath: string;
  systemGraphMermaidPath: string;
  repoUrl: string;
  generatedAt: string;
  frameworkInfo: FrameworkInfo;
  analyses: ComponentAnalysis[];
  migrationOrder: string[];
  sourceFiles?: Array<{ path: string; content: string }>;
}): Promise<ReverseEngineeringWriteResult> {
  await fs.mkdir(input.reverseEngineeringDir, { recursive: true });

  const codeIntelligence = buildCodeIntelligenceArtifact({
    repoUrl: input.repoUrl,
    generatedAt: input.generatedAt,
    frameworkInfo: input.frameworkInfo,
    analyses: input.analyses,
    sourceFiles: input.sourceFiles ?? [],
  });
  const graph = buildSystemGraphArtifact({ ...input, codeIntelligence });
  const businessLogic = buildBusinessLogicArtifact(input);
  const details = buildReverseEngineeringDetails({ ...input, graph, codeIntelligence });
  const mermaid = buildSystemGraphMermaid(graph);

  const businessLogicPath = join(input.reverseEngineeringDir, "business-logic.json");
  const detailsPath = join(input.reverseEngineeringDir, "reverse-engineering-details.md");

  await fs.writeFile(businessLogicPath, `${JSON.stringify(businessLogic, null, 2)}\n`, "utf-8");
  await writeCodeIntelligenceArtifacts(input.reverseEngineeringDir, codeIntelligence);
  await fs.writeFile(detailsPath, details, "utf-8");
  await fs.writeFile(input.systemGraphJsonPath, `${JSON.stringify(graph, null, 2)}\n`, "utf-8");
  await fs.writeFile(input.systemGraphMermaidPath, mermaid, "utf-8");

  return {
    reverseEngineeringDir: input.reverseEngineeringDir,
    businessLogicPath,
    detailsPath,
    graphJsonPath: input.systemGraphJsonPath,
    graphMermaidPath: input.systemGraphMermaidPath,
  };
}
