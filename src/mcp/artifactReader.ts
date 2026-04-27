import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { GraphStore } from "../migration/graphStore.js";

export type MigrationContractComponent = {
  name: string;
  type?: string;
  implementationStatus?: "ready" | "needs_review" | "blocked" | string;
  requiredReviewBeforeImplementation?: string[];
  sourceFiles?: string[];
  dependencies?: string[];
  purpose?: string;
  target?: {
    role?: string;
    rationale?: string;
    integrationBoundary?: string;
    implementationPattern?: string;
    targetFileHint?: string;
    dependencies?: string[];
  };
  risk?: {
    complexity?: string;
    confidence?: string;
    migrationRisks?: string[];
    unknownFields?: string[];
  };
  businessRules?: Array<{ statement?: string; evidence?: unknown[] }>;
  contracts?: { input?: Record<string, unknown>; output?: Record<string, unknown> };
  humanQuestions?: string[];
  validationScenarios?: string[];
  acceptanceCriteria?: string[];
  verification?: {
    trustVerdict?: "ready" | "needs_review" | "blocked" | string;
    trustReasons?: string[];
    verifierModel?: string;
    generatedAt?: string;
    totals?: {
      claimsChecked?: number;
      verified?: number;
      unsupported?: number;
      inconclusive?: number;
      noEvidence?: number;
    };
    claims?: Array<{
      id?: string;
      kind?: string;
      statement?: string;
      loadBearing?: boolean;
      outcome?: string;
      reason?: string;
      evidence?: unknown;
    }>;
    error?: string;
  } | null;
};

export type MigrationContract = {
  schemaVersion?: string;
  generatedAt?: string;
  repoUrl?: string;
  migration?: Record<string, unknown>;
  globalGuardrails?: string[];
  migrationOrder?: string[];
  components?: MigrationContractComponent[];
};

type LocalVaultConfig = { activeVault?: string };

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readLocalVaultConfig(): Promise<LocalVaultConfig> {
  try {
    const raw = await fs.readFile(join(process.cwd(), "ccsconfig.json"), "utf-8");
    return JSON.parse(raw) as LocalVaultConfig;
  } catch {
    return {};
  }
}

/**
 * Search the given directory for any first-level subdirectory that looks like
 * a CCS run (contains migration-contract.json). Used to discover repo-scoped
 * run folders under the migration root, e.g.:
 *   migration/eminbayrak-node-orders-api/migration-contract.json
 */
async function findRunDirIn(directory: string): Promise<string | null> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const subdir = join(directory, name);
    let isDir = false;
    try { isDir = (await fs.stat(subdir)).isDirectory(); } catch { /* skip */ }
    if (!isDir) continue;
    if (await exists(join(subdir, "migration-contract.json"))) return subdir;
  }
  return null;
}

export async function resolveRewriteDir(migrationDir?: string): Promise<string> {
  const candidates: string[] = [];

  if (migrationDir?.trim()) {
    const explicit = resolve(process.cwd(), migrationDir);
    // Try the dir as-is (user may have pointed at the repo run folder),
    // then any first-level subdir that looks like a run, then the legacy
    // <migrationDir>/rewrite/ layout.
    candidates.push(explicit);
    const found = await findRunDirIn(explicit);
    if (found) candidates.push(found);
    candidates.push(join(explicit, "rewrite"));
  }

  // Current working directory could itself be a run folder.
  candidates.push(process.cwd());
  const cwdRun = await findRunDirIn(process.cwd());
  if (cwdRun) candidates.push(cwdRun);
  candidates.push(join(process.cwd(), "rewrite"));

  const localConfig = await readLocalVaultConfig();
  if (localConfig.activeVault) {
    const vaultMigrationDir = join(localConfig.activeVault, "migration");
    candidates.push(vaultMigrationDir);
    const vaultRun = await findRunDirIn(vaultMigrationDir);
    if (vaultRun) candidates.push(vaultRun);
    candidates.push(join(vaultMigrationDir, "rewrite"));
  }

  const homeMigrationDir = join(homedir(), ".ccs", "migration");
  candidates.push(homeMigrationDir);
  const homeRun = await findRunDirIn(homeMigrationDir);
  if (homeRun) candidates.push(homeRun);
  candidates.push(join(homeMigrationDir, "rewrite"));

  for (const candidate of candidates) {
    if (await exists(join(candidate, "migration-contract.json"))) {
      return candidate;
    }
  }

  return candidates[0] ?? join(homedir(), ".ccs", "migration");
}

function safePath(root: string, ...parts: string[]): string {
  const target = resolve(root, ...parts);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes migration directory: ${parts.join("/")}`);
  }
  return target;
}

function findComponent(contract: MigrationContract, componentName: string): MigrationContractComponent {
  const component = contract.components?.find((c) =>
    c.name === componentName || c.name.toLowerCase() === componentName.toLowerCase()
  );
  if (!component) {
    const names = contract.components?.map((c) => c.name).join(", ") || "none";
    throw new Error(`Component "${componentName}" was not found. Available components: ${names}`);
  }
  return component;
}

export async function readMigrationContract(migrationDir?: string): Promise<{
  rewriteDir: string;
  contract: MigrationContract;
}> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  const contractPath = safePath(rewriteDir, "migration-contract.json");
  const raw = await fs.readFile(contractPath, "utf-8");
  return { rewriteDir, contract: JSON.parse(raw) as MigrationContract };
}

export async function listReadyComponents(migrationDir?: string): Promise<string> {
  const { rewriteDir, contract } = await readMigrationContract(migrationDir);
  const components = contract.components ?? [];
  const ready = components
    .filter((component) => component.implementationStatus === "ready")
    .map((component) => ({
      name: component.name,
      type: component.type ?? "unknown",
      targetRole: component.target?.role ?? "unknown",
      targetFileHint: component.target?.targetFileHint ?? "unknown",
      dependencies: component.dependencies ?? [],
      validationScenarios: component.validationScenarios ?? [],
      verificationVerdict: component.verification?.trustVerdict ?? "not_run",
    }));

  const needsReview = components
    .filter((component) => component.implementationStatus === "needs_review")
    .map((component) => ({
      name: component.name,
      reasons: component.verification?.trustReasons ?? component.requiredReviewBeforeImplementation ?? [],
    }));

  return JSON.stringify({
    rewriteDir,
    repoUrl: contract.repoUrl,
    migration: contract.migration,
    ready,
    needsReview,
    needsReviewCount: needsReview.length,
    blockedCount: components.filter((c) => c.implementationStatus === "blocked").length,
  }, null, 2);
}

export async function getVerificationReport(
  migrationDir: string | undefined,
  componentName?: string,
): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);

  if (componentName?.trim()) {
    const safeName = basename(componentName);
    const perComponentPath = safePath(rewriteDir, "verification", `${safeName}.md`);
    if (await exists(perComponentPath)) {
      return fs.readFile(perComponentPath, "utf-8");
    }
    // Fallback: pull verification info from migration-contract.json.
    const { contract } = await readMigrationContract(rewriteDir);
    const component = findComponent(contract, componentName);
    return JSON.stringify({
      rewriteDir,
      component: component.name,
      implementationStatus: component.implementationStatus,
      verification: component.verification ?? null,
      note: component.verification
        ? "Per-component verification markdown was not found; returning the contract's verification entry."
        : "No verification was run for this component.",
    }, null, 2);
  }

  // No component specified — return the summary doc, or a derived summary.
  const summaryPath = safePath(rewriteDir, "verification-summary.md");
  if (await exists(summaryPath)) {
    return fs.readFile(summaryPath, "utf-8");
  }

  const { contract } = await readMigrationContract(rewriteDir);
  const components = contract.components ?? [];
  return JSON.stringify({
    rewriteDir,
    repoUrl: contract.repoUrl,
    note: "No verification-summary.md artifact was found. This migration may have been generated by an older CCS version.",
    componentVerdicts: components.map((component) => ({
      name: component.name,
      implementationStatus: component.implementationStatus,
      verification: component.verification ?? null,
    })),
  }, null, 2);
}

export async function getComponentContext(
  migrationDir: string | undefined,
  componentName: string,
): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  const safeName = basename(componentName);
  const componentPath = safePath(rewriteDir, "components", `${safeName}.md`);
  if (await exists(componentPath)) {
    return fs.readFile(componentPath, "utf-8");
  }
  const legacyContextPath = safePath(rewriteDir, "context", `${safeName}.md`);
  return fs.readFile(legacyContextPath, "utf-8");
}

export async function getDependencyRiskReport(migrationDir?: string): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  const reportPath = safePath(rewriteDir, "dependency-risk-report.md");
  if (await exists(reportPath)) {
    return fs.readFile(reportPath, "utf-8");
  }
  const jsonPath = safePath(rewriteDir, "dependency-risk-report.json");
  if (await exists(jsonPath)) {
    return fs.readFile(jsonPath, "utf-8");
  }
  return JSON.stringify({
    rewriteDir,
    note: "No dependency-risk-report artifact was found. This migration may have been generated by an older CCS version.",
  }, null, 2);
}

export async function getCodeIntelligence(migrationDir?: string): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  const markdownPath = safePath(rewriteDir, "reverse-engineering", "code-intelligence.md");
  if (await exists(markdownPath)) {
    return fs.readFile(markdownPath, "utf-8");
  }
  const jsonPath = safePath(rewriteDir, "reverse-engineering", "code-intelligence.json");
  if (await exists(jsonPath)) {
    return fs.readFile(jsonPath, "utf-8");
  }
  return JSON.stringify({
    rewriteDir,
    note: "No code-intelligence artifact was found. Re-run /migrate rewrite to generate symbol and call-map data.",
  }, null, 2);
}

export async function getTestScaffolds(
  migrationDir: string | undefined,
  componentName?: string,
): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  if (componentName?.trim()) {
    const safeName = basename(componentName)
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const scaffoldPath = safePath(rewriteDir, "test-scaffolds", `${safeName}.parity.md`);
    if (await exists(scaffoldPath)) {
      return fs.readFile(scaffoldPath, "utf-8");
    }
  }
  const indexPath = safePath(rewriteDir, "test-scaffolds", "README.md");
  if (await exists(indexPath)) {
    return fs.readFile(indexPath, "utf-8");
  }
  return JSON.stringify({
    rewriteDir,
    note: "No test-scaffolds artifact was found. This migration may have been generated by an older CCS version.",
  }, null, 2);
}

export async function getHumanQuestions(migrationDir?: string): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  const questionsPath = safePath(rewriteDir, "human-questions.md");
  if (await exists(questionsPath)) {
    return fs.readFile(questionsPath, "utf-8");
  }

  const { contract } = await readMigrationContract(rewriteDir);
  const questions = (contract.components ?? []).flatMap((component) =>
    (component.humanQuestions ?? []).map((question) => ({
      component: component.name,
      targetRole: component.target?.role ?? "unknown",
      confidence: component.risk?.confidence ?? "unknown",
      question,
    }))
  );

  return JSON.stringify({ rewriteDir, questions }, null, 2);
}

export async function getValidationContract(
  migrationDir: string | undefined,
  componentName: string,
): Promise<string> {
  const { rewriteDir, contract } = await readMigrationContract(migrationDir);
  const component = findComponent(contract, componentName);
  return JSON.stringify({
    rewriteDir,
    component: component.name,
    implementationStatus: component.implementationStatus,
    requiredReviewBeforeImplementation: component.requiredReviewBeforeImplementation ?? [],
    target: component.target ?? {},
    risk: component.risk ?? {},
    sourceFiles: component.sourceFiles ?? [],
    businessRules: component.businessRules ?? [],
    contracts: component.contracts ?? {},
    humanQuestions: component.humanQuestions ?? [],
    validationScenarios: component.validationScenarios ?? [],
    acceptanceCriteria: component.acceptanceCriteria ?? [],
  }, null, 2);
}

export async function getArchitectureBaseline(migrationDir?: string): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  const baselinePath = safePath(rewriteDir, "architecture-baseline.md");
  if (await exists(baselinePath)) {
    return fs.readFile(baselinePath, "utf-8");
  }

  const matrixPath = safePath(rewriteDir, "component-disposition-matrix.md");
  if (await exists(matrixPath)) {
    return fs.readFile(matrixPath, "utf-8");
  }

  const { contract } = await readMigrationContract(rewriteDir);
  return JSON.stringify({
    rewriteDir,
    repoUrl: contract.repoUrl,
    migration: contract.migration,
    globalGuardrails: contract.globalGuardrails ?? [],
    targetDisposition: (contract.components ?? []).map((component) => ({
      name: component.name,
      type: component.type,
      targetRole: component.target?.role,
      rationale: component.target?.rationale,
      integrationBoundary: component.target?.integrationBoundary,
      implementationStatus: component.implementationStatus,
    })),
  }, null, 2);
}

export async function getPreflightReadiness(migrationDir?: string): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  const preflightPath = safePath(rewriteDir, "preflight-readiness.md");
  if (await exists(preflightPath)) {
    return fs.readFile(preflightPath, "utf-8");
  }

  const { contract } = await readMigrationContract(rewriteDir);
  return JSON.stringify({
    rewriteDir,
    repoUrl: contract.repoUrl,
    generatedAt: contract.generatedAt,
    note: "No preflight-readiness.md artifact was found. This migration may have been generated by an older CCS version.",
    componentCount: contract.components?.length ?? 0,
    blockedCount: (contract.components ?? []).filter((component) => component.implementationStatus !== "ready").length,
  }, null, 2);
}

export async function getSystemGraph(migrationDir?: string): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  const graphPath = safePath(rewriteDir, "system-graph.json");
  if (await exists(graphPath)) {
    return fs.readFile(graphPath, "utf-8");
  }

  const { contract } = await readMigrationContract(rewriteDir);
  const nodes = (contract.components ?? []).map((component) => ({
    id: `component:${component.name}`,
    label: component.name,
    type: "component",
    metadata: {
      componentType: component.type,
      targetRole: component.target?.role,
      confidence: component.risk?.confidence,
    },
  }));
  const edges = (contract.components ?? []).flatMap((component) =>
    (component.dependencies ?? []).map((dependency) => ({
      source: `component:${component.name}`,
      target: `component:${dependency}`,
      type: "depends_on",
      label: "depends on",
    }))
  );

  return JSON.stringify({
    rewriteDir,
    schemaVersion: "fallback",
    repoUrl: contract.repoUrl,
    migration: contract.migration,
    migrationOrder: contract.migrationOrder ?? [],
    nodes,
    edges,
  }, null, 2);
}

export async function getBusinessLogic(migrationDir?: string): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  const businessPath = safePath(rewriteDir, "reverse-engineering", "business-logic.json");
  if (await exists(businessPath)) {
    return fs.readFile(businessPath, "utf-8");
  }

  const { contract } = await readMigrationContract(rewriteDir);
  return JSON.stringify({
    rewriteDir,
    schemaVersion: "fallback",
    repoUrl: contract.repoUrl,
    migration: contract.migration,
    components: (contract.components ?? []).map((component) => ({
      name: component.name,
      type: component.type,
      purpose: component.purpose,
      sourceFiles: component.sourceFiles ?? [],
      dependencies: component.dependencies ?? [],
      businessRules: component.businessRules ?? [],
      contracts: component.contracts ?? {},
      targetDisposition: component.target ?? {},
      risks: component.risk?.migrationRisks ?? [],
      humanQuestions: component.humanQuestions ?? [],
      validationScenarios: component.validationScenarios ?? [],
      confidence: component.risk?.confidence,
      complexity: component.risk?.complexity,
    })),
  }, null, 2);
}

export async function getDependencyImpact(
  migrationDir: string | undefined,
  nodeName: string,
  depth = 3,
): Promise<string> {
  const graphJson = JSON.parse(await getSystemGraph(migrationDir)) as {
    rewriteDir?: string;
    repoUrl?: string;
    nodes?: Array<{ id?: string; label?: string; type?: string; metadata?: Record<string, unknown> }>;
    edges?: Array<{ source?: string; target?: string; type?: string; label?: string; evidence?: string }>;
  };

  // ── Load into GraphStore for indexed BFS traversal ───────────────────────
  const store = GraphStore.fromSystemGraph(graphJson);

  const normalized = nodeName.toLowerCase();
  const allNodes = store.getNodes();
  const node = allNodes.find(
    (candidate) =>
      candidate.id.toLowerCase() === normalized ||
      candidate.label.toLowerCase() === normalized ||
      candidate.id.toLowerCase() === `component:${normalized}`,
  );

  if (!node?.id) {
    const names = store.getNodes("component")
      .map((n) => n.label)
      .filter(Boolean)
      .join(", ") || "none";
    throw new Error(`Graph node "${nodeName}" was not found. Available components: ${names}`);
  }

  const maxDepth = Math.max(1, Math.min(6, Math.floor(depth || 3)));

  // ── Direct relationships via indexed edge lookup (O(1) per hop) ───────────
  const directDependencies = store.getEdges({ source: node.id, type: "depends_on" })
    .map((e) => store.getNode(e.target)?.label ?? e.target);

  const dependents = store.getEdges({ target: node.id, type: "depends_on" })
    .map((e) => store.getNode(e.source)?.label ?? e.source);

  const sourceFiles = store.getEdges({ source: node.id, type: "defined_in" })
    .map((e) => store.getNode(e.target)?.label ?? e.target);

  const targetRoles = store.getEdges({ source: node.id, type: "recommended_role" })
    .map((e) => ({
      role: store.getNode(e.target)?.label ?? e.target,
      rationale: e.evidence ?? "",
    }));

  const packages = store.getEdges({ source: node.id })
    .filter((e) => /package$/.test(e.type))
    .map((e) => ({
      package: store.getNode(e.target)?.label ?? e.target,
      relationship: e.type,
    }));

  const declaredSymbols = store.getEdges({ source: node.id, type: "declares_symbol" })
    .map((e) => store.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => Boolean(n));

  const declaredSymbolIds = new Set(declaredSymbols.map((s) => s.id));

  const componentIdForSymbol = (symbolId: string): string | undefined =>
    store.getEdges({ target: symbolId, type: "declares_symbol" })[0]?.source;

  const outgoingCalls = declaredSymbols.flatMap((sym) =>
    store.getEdges({ source: sym.id, type: "calls" }).map((e) => ({
      from: sym.label,
      to: store.getNode(e.target)?.label ?? e.target,
      targetComponent: store.getNode(componentIdForSymbol(e.target) ?? "")?.label ?? null,
      evidence: e.evidence ?? "",
    }))
  );

  const incomingCalls = declaredSymbols.flatMap((sym) =>
    store.getEdges({ target: sym.id, type: "calls" }).map((e) => ({
      from: store.getNode(e.source)?.label ?? e.source,
      sourceComponent: store.getNode(componentIdForSymbol(e.source) ?? "")?.label ?? null,
      to: sym.label,
      evidence: e.evidence ?? "",
    }))
  );

  // ── Multi-hop BFS traversal via GraphStore ─────────────────────────────────
  const transitiveDependencies = store.bfs([node.id], "out", ["depends_on"], maxDepth)
    .map((item) => item.label);

  const transitiveDependents = store.bfs([node.id], "in", ["depends_on"], maxDepth)
    .map((item) => item.label);

  // ── Transitive call impact (symbols that would break if this changes) ──────
  const transitiveCallDependents = store.bfs(
    [...declaredSymbolIds],
    "in",
    ["calls"],
    Math.min(maxDepth, 4),
  ).map((item) => ({
    symbol: item.label,
    component: store.getNode(componentIdForSymbol(item.id) ?? "")?.label ?? null,
    distance: item.distance,
  }));

  // ── Data access (reads/writes tables) ─────────────────────────────────────
  const dataAccess = store.dataAccess(node.id);
  const dataAccessSummary = {
    readsFromTables: dataAccess.reads.map((n) => n.label),
    writesToTables: dataAccess.writes.map((n) => n.label),
    rawQueryCount: dataAccess.queries.length,
    note: dataAccess.reads.length + dataAccess.writes.length + dataAccess.queries.length === 0
      ? "No data access edges found. Run /migrate with data-access extraction to populate this."
      : undefined,
  };

  // ── Interface implementations (type-flow) ─────────────────────────────────
  const implementations = declaredSymbols
    .filter((s) => s.type === "interface")
    .flatMap((iface) =>
      store.implementations(iface.id).map((impl) => ({
        interface: iface.label,
        implementedBy: impl.label,
        file: impl.metadata?.file,
      }))
    );

  store.close();

  return JSON.stringify({
    rewriteDir: graphJson.rewriteDir,
    repoUrl: graphJson.repoUrl,
    node: {
      id: node.id,
      label: node.label,
      type: node.type,
      metadata: node.metadata ?? {},
    },
    directDependencies,
    dependents,
    sourceFiles,
    targetRoles,
    packages,
    declaredSymbols: declaredSymbols.map((symbol) => ({
      name: symbol.label,
      kind: symbol.metadata?.kind,
      file: symbol.metadata?.file,
      lineStart: symbol.metadata?.lineStart,
    })),
    outgoingCalls,
    incomingCalls,
    dataAccess: dataAccessSummary,
    typeFlow: implementations.length > 0 ? implementations : undefined,
    implementationImpact: {
      implementBeforeThis: directDependencies,
      componentsToRetestAfterChange: dependents,
      transitiveDependencies,
      transitiveDependents,
      transitiveCallDependents: transitiveCallDependents.slice(0, 30),
      blastRadius: [
        ...new Set([
          ...dependents,
          ...transitiveDependents,
          ...incomingCalls.map((call) => call.sourceComponent).filter(Boolean),
        ]),
      ],
      depth: maxDepth,
      graphBackend: "GraphStore (SQLite indexed BFS)",
    },
  }, null, 2);
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_.$/-]+/g) ?? [];
}

function excerptFor(content: string, terms: string[], maxChars = 420): string {
  const lower = content.toLowerCase();
  const index = terms
    .map((term) => lower.indexOf(term))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, index - 140);
  const end = Math.min(content.length, start + maxChars);
  return `${start > 0 ? "..." : ""}${content.slice(start, end).replace(/\s+/g, " ").trim()}${end < content.length ? "..." : ""}`;
}

async function artifactSearchFiles(rewriteDir: string): Promise<Array<{ path: string; content: string }>> {
  const files = [
    "README.md",
    "AGENTS.md",
    "architecture-baseline.md",
    "preflight-readiness.md",
    "component-disposition-matrix.md",
    "human-questions.md",
    "verification-summary.md",
    "dependency-risk-report.md",
    "migration-contract.json",
    "system-graph.json",
    "reverse-engineering/business-logic.json",
    "reverse-engineering/code-intelligence.json",
    "reverse-engineering/code-intelligence.md",
    "reverse-engineering/reverse-engineering-details.md",
    "test-scaffolds/README.md",
  ];
  const componentDir = safePath(rewriteDir, "components");
  try {
    for (const name of await fs.readdir(componentDir)) {
      if (name.endsWith(".md")) files.push(`components/${name}`);
    }
  } catch { /* no components dir */ }

  const out: Array<{ path: string; content: string }> = [];
  for (const path of files) {
    const fullPath = safePath(rewriteDir, path);
    if (await exists(fullPath)) out.push({ path, content: await fs.readFile(fullPath, "utf-8") });
  }
  return out;
}

export async function searchArtifacts(
  migrationDir: string | undefined,
  query: string,
  limit = 8,
): Promise<string> {
  const rewriteDir = await resolveRewriteDir(migrationDir);
  const terms = tokenize(query).filter((term) => term.length > 1);
  if (terms.length === 0) throw new Error("query is required.");
  const files = await artifactSearchFiles(rewriteDir);
  const documentFrequency = new Map<string, number>();
  const tokenized = files.map((file) => {
    const tokens = tokenize(`${file.path} ${file.content}`);
    const unique = new Set(tokens);
    for (const term of terms) if (unique.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    return { ...file, tokens };
  });

  const results = tokenized.map((file) => {
    let score = 0;
    for (const term of terms) {
      const tf = file.tokens.filter((token) => token === term || token.includes(term)).length;
      if (tf === 0) continue;
      const df = documentFrequency.get(term) ?? 1;
      const idf = Math.log((files.length + 1) / (df + 0.5));
      score += (1 + Math.log(tf)) * Math.max(0.2, idf);
      if (file.path.toLowerCase().includes(term)) score += 2;
    }
    return { path: file.path, score, excerpt: excerptFor(file.content, terms) };
  })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(25, Math.floor(limit || 8))));

  return JSON.stringify({
    rewriteDir,
    query,
    results,
    searchedFiles: files.length,
    note: "Lexical BM25-style artifact search over CCS markdown and JSON outputs. It is not vector search yet.",
  }, null, 2);
}
