import { promises as fs } from "fs";
import { join } from "path";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";
import type { ServiceAnalysis } from "./analyzer.js";
import { compressSourceFile, formatCompressionStats } from "./sourceCompressor.js";

// ---------------------------------------------------------------------------
// Generate AI tool integration files from migration KB.
//
// Outputs:
//   CLAUDE.md                           → Auto-read by Claude Code (project context)
//   .claude/commands/rewrite-<Name>.md  → Slash command with embedded source code
//   AGENTS.md                           → Codex agent instructions
// ---------------------------------------------------------------------------

const PLACEHOLDER_NS = new Set(["unknown", "none", "n/a", "null", "undefined"]);

// ---------------------------------------------------------------------------
// Remove files from a previous run that are no longer valid
// (stale service names from an aborted scan, "unknown.md", etc.)
// ---------------------------------------------------------------------------

async function cleanupStaleFiles(
  outputDir: string,
  validNamespaces: Set<string>,
): Promise<void> {
  const contextDir = join(outputDir, "context");
  const commandsDir = join(outputDir, ".claude", "commands");

  for (const dir of [contextDir, commandsDir]) {
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const raw = f.replace(/^rewrite-/, "").replace(/\.md$/, "");
        if (!validNamespaces.has(raw)) {
          await fs.rm(join(dir, f)).catch(() => {});
        }
      }
    } catch { /* dir may not exist on first run */ }
  }
}

// ---------------------------------------------------------------------------
// Read source files embedded in local clones — zero network calls
// ---------------------------------------------------------------------------

async function readSourceFiles(
  outputDir: string,
  repoFullName: string,
  rawFiles: string[],
): Promise<Array<{ path: string; content: string }>> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return [];

  const repoDir = join(outputDir, "repos", owner, repo);
  const result: Array<{ path: string; content: string }> = [];

  for (const filePath of rawFiles) {
    try {
      const content = await fs.readFile(join(repoDir, filePath), "utf-8");
      result.push({ path: filePath, content });
    } catch { /* skip unreadable */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLAUDE.md — auto-read by Claude Code on project open.
// Tells Claude Code exactly what this migration workspace is and how to use it.
// ---------------------------------------------------------------------------

function buildClaudeMd(
  entryRepo: string,
  targetLanguage: string,
  analyses: ServiceAnalysis[],
): string {
  const SKIP = PLACEHOLDER_NS;
  const ordered = [...analyses].sort(
    (a, b) => a.nestedServiceCalls.filter(c => !SKIP.has(c.split(".")[0]?.toLowerCase() ?? "")).length
           - b.nestedServiceCalls.filter(c => !SKIP.has(c.split(".")[0]?.toLowerCase() ?? "")).length
  );

  const serviceList = ordered
    .map((a) => {
      const calls = a.nestedServiceCalls
        .filter((c) => !SKIP.has(c.split(".")[0]?.toLowerCase() ?? ""))
        .join(", ");
      const deps = calls ? ` (depends on: ${calls})` : " (no dependencies)";
      return `- **${a.namespace}**${deps} — ${a.purpose === "unknown" ? "purpose unclear, verify manually" : a.purpose}`;
    })
    .join("\n");

  const commandList = ordered
    .map((a) => `- \`/project:rewrite-${a.namespace}\` — rewrites ${a.namespace} as ${targetLanguage}`)
    .join("\n");

  const allDb = [...new Set(analyses.flatMap((a) => a.databaseInteractions))];
  const dbList = allDb.length > 0
    ? allDb.map((d) => `- \`${d}\``).join("\n")
    : "_No DB interactions identified._";

  return `# Migration Workspace

This directory contains the knowledge base for migrating **${entryRepo.split("/").slice(-1)[0]}** to **${targetLanguage}**.

## What This Workspace Contains

| File/Dir | Purpose |
|----------|---------|
| \`context/<Service>.md\` | Full rewrite spec: methods, rules, DB, contracts |
| \`knowledge-base/_index.md\` | System overview, service map, full DB schema |
| \`AGENTS.md\` | Instructions for Codex |
| \`.claude/commands/\` | Slash commands for Claude Code |
| \`repos/\` | Cloned source repos (read-only reference) |

## Services to Rewrite (in this order)

${serviceList}

## Available Commands

${commandList}

## Rules — Never Break These

1. Read the context doc for each service BEFORE writing any code
2. Do not invent logic not present in the original source
3. Preserve every business rule exactly — they are non-negotiable
4. No SOAP wrappers — connect directly to the database
5. Rewrite leaf services first (those with no dependencies)

## All Database Interactions

${dbList}

## How to Start

Open a terminal in your **target project** (where you want the rewritten code), then:

\`\`\`
/project:rewrite-${ordered[0]?.namespace ?? "ServiceName"}
\`\`\`

Claude Code will read the spec, the original source code, and write the implementation.
`;
}

// ---------------------------------------------------------------------------
// Slash command — machine-facing, loaded into Claude Code's context on trigger.
// Embeds the full context doc + actual source code so Claude has everything it
// needs without fetching files externally.
// ---------------------------------------------------------------------------

function buildSlashCommand(
  analysis: ServiceAnalysis,
  contextDocContent: string,
  targetFile: string,
  sourceFiles: Array<{ path: string; content: string }>,
  targetLanguage: string,
): string {
  // Compress source files before embedding: keep method signatures and key logic,
  // omit boilerplate in the middle of long method bodies.
  // The main implementation file (exact namespace name match) is kept UNCOMPRESSED
  // — it contains the business logic Claude must read fully.
  const nsLower = analysis.namespace.toLowerCase();
  const compressedFiles = sourceFiles.map((f) => {
    const fileName = f.path.split("/").pop()?.toLowerCase() ?? "";
    const isMainImpl =
      fileName === `${nsLower}.cs` ||
      fileName === `${nsLower}.java` ||
      fileName === `${nsLower}.py` ||
      fileName === `${nsLower}.go` ||
      fileName === `${nsLower}.ts`;
    if (isMainImpl) return { ...f, compressed: false, savedLines: 0 };
    const result = compressSourceFile(f.content, f.path);
    return { ...f, content: result.content, compressed: result.compressed, savedLines: result.savedLines };
  });

  const compressionNote = (() => {
    const stats = compressedFiles.map(f => ({
      content: f.content,
      originalLines: f.content.split("\n").length + (f.savedLines ?? 0),
      compressedLines: f.content.split("\n").length,
      savedLines: f.savedLines ?? 0,
      compressed: f.compressed ?? false,
    }));
    return formatCompressionStats(stats);
  })();

  const ext = sourceFiles[0]?.path.split(".").pop() ?? "cs";

  const sourceBlock =
    compressedFiles.length > 0
      ? compressedFiles
          .map((f) => {
            const lines = f.content.split("\n").length;
            const note = f.compressed && f.savedLines
              ? ` — compressed, ${f.savedLines} lines omitted`
              : "";
            return `### \`${f.path}\` (${lines} lines${note})\n\`\`\`${ext}\n${f.content}\n\`\`\``;
          })
          .join("\n\n")
      : "_Source files not available locally — refer to the links in the context doc above._";

  const compressionFootnote = compressionNote
    ? `\n> _${compressionNote}. Full source is in \`repos/\` — open it if you need the omitted lines._\n`
    : "";

  return `${contextDocContent}

---

## Embedded Source Code

The original implementation files are included below for reference.
Read these carefully — your rewrite must preserve all logic visible here.
${compressionFootnote}
${sourceBlock}

---

## Your Task

You are rewriting \`${analysis.namespace}\` as a \`${targetLanguage}\` service.

**Step 1** — Read every source file above and the full spec above.
**Step 2** — Implement the complete service at: \`${targetFile}\`
**Step 3** — Self-check against this list before reporting done:

${analysis.allMethods.length > 0
  ? analysis.allMethods.map((m) => `- [ ] \`${m.name}\` — ${m.purpose}`).join("\n")
  : "- [ ] All methods listed in the spec above are implemented"}
${analysis.businessRules.map((r) => `- [ ] Rule: ${r}`).join("\n")}
${analysis.databaseInteractions.length > 0 ? `- [ ] All DB calls connect directly (no SOAP): ${analysis.databaseInteractions.map((d) => d.split("—")[0]?.trim()).join(", ")}` : ""}

Do not report done until every checkbox above is satisfied.
`;
}

// ---------------------------------------------------------------------------
// AGENTS.md — read automatically by Codex when run in the migration directory.
// Richer than a simple list — includes the full DB schema and dependency graph.
// ---------------------------------------------------------------------------

function buildServiceAgentsMd(
  entryRepo: string,
  targetLanguage: string,
  analyses: ServiceAnalysis[],
): string {
  const SKIP = PLACEHOLDER_NS;

  const ordered = [...analyses].sort(
    (a, b) =>
      a.nestedServiceCalls.filter((c) => !SKIP.has(c.split(".")[0]?.toLowerCase() ?? "")).length -
      b.nestedServiceCalls.filter((c) => !SKIP.has(c.split(".")[0]?.toLowerCase() ?? "")).length
  );

  const ext = targetLanguage === "csharp" ? "cs"
    : targetLanguage === "java" ? "java"
    : targetLanguage === "python" ? "py"
    : targetLanguage === "go" ? "go"
    : "ts";

  const summary = ordered
    .map((a, i) => {
      const deps = a.nestedServiceCalls
        .filter((c) => !SKIP.has(c.split(".")[0]?.toLowerCase() ?? ""))
        .join(", ");
      const target = `${a.namespace.replace(/Manager$/, "Service")}.${ext}`;
      return `${i + 1}. **${a.namespace}** → \`${target}\`${deps ? `  _(depends on: ${deps})_` : ""}`;
    })
    .join("\n");

  const allDb = [...new Set(analyses.flatMap((a) => a.databaseInteractions))];
  const dbSection = allDb.length > 0
    ? allDb.map((d) => `  - \`${d}\``).join("\n")
    : "  - None identified";

  const allRules = analyses.flatMap((a) =>
    a.businessRules.map((r) => `  - [${a.namespace}] ${r}`)
  );

  const contextLinks = ordered
    .map((a) => `- [${a.namespace}](context/${a.namespace}.md) — ${a.purpose === "unknown" ? "verify manually" : a.purpose}`)
    .join("\n");

  return `# Service Migration Agent Context

> Auto-read by Codex. For Claude Code, use the slash commands in \`.claude/commands/\`.

## What You Are Doing

Rewriting external SOAP service calls from **${entryRepo.split("/").slice(-1)[0]}** to native **${targetLanguage}** implementations.

## Non-Negotiable Rules

1. Read the context doc for each service BEFORE writing any code
2. Rewrite in the order listed — dependencies must exist before their callers
3. Preserve EVERY business rule listed in each context doc exactly
4. Replace all SOAP calls with direct database calls — no wrappers
5. Do not invent any logic not visible in the original source or context doc
6. After each service, verify the method signatures and contracts match the spec

## Rewrite Order (dependencies first)

${summary}

## All Database Interactions

Every table, column, and stored procedure across all services:

${dbSection}

## All Business Rules Across Services

${allRules.length > 0 ? allRules.join("\n") : "  - See individual context docs"}

## Context Docs

${contextLinks}

## How to Execute

**With Codex** — run in the migration directory:
\`\`\`
codex "Read context/${ordered[0]?.namespace ?? "Service"}.md and implement the ${targetLanguage} replacement"
\`\`\`

**With Claude Code** — open your target project, then:
\`\`\`
/project:rewrite-${ordered[0]?.namespace ?? "ServiceName"}
\`\`\`
(Copy the \`.claude/\` folder from this migration dir into your target project first)
`;
}

// ---------------------------------------------------------------------------
// Infer a sensible target file path from component name + type + language
// ---------------------------------------------------------------------------

export function inferTargetFilePath(
  name: string,
  type: string,
  targetLanguage: string
): string {
  const ext = targetLanguage === "python" ? "py"
    : targetLanguage === "go" ? "go"
    : targetLanguage === "java" ? "java"
    : "ts";

  const snake = name
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");

  const dirMap: Record<string, string> = {
    controller: "routers",
    service: "services",
    repository: "repositories",
    model: "models",
    dto: "schemas",
    middleware: "middleware",
    config: ".",
    utility: "utils",
    unknown: ".",
  };

  const dir = dirMap[type] ?? ".";
  return `${dir}/${snake}.${ext}`;
}

// ---------------------------------------------------------------------------
// Write AI integration files for the component rewrite pipeline
// ---------------------------------------------------------------------------

export async function generateRewriteIntegration(
  outputDir: string,
  analyses: ComponentAnalysis[],
  frameworkInfo: FrameworkInfo,
  migrationOrder: string[],
  repoUrl: string
): Promise<void> {
  const commandsDir = join(outputDir, "rewrite", ".claude", "commands");
  await fs.mkdir(commandsDir, { recursive: true });

  for (const analysis of analyses) {
    const { component } = analysis;
    const contextDocPath = join(outputDir, "rewrite", "context", `${component.name}.md`);
    let contextContent = "";
    try {
      contextContent = await fs.readFile(contextDocPath, "utf-8");
    } catch {
      continue;
    }

    const targetFile = inferTargetFilePath(
      component.name,
      component.type,
      frameworkInfo.targetLanguage
    );

    const slashCommand = `${contextContent}

---

## Your Task

Read every source file linked above before writing any code.

Implement the complete **${component.name}** rewrite following all instructions in this document.

Place the output at: \`${targetFile}\`

After writing the code:
1. Check that every business rule listed above is implemented
2. Verify the input/output contract matches exactly
3. Run the tests if any exist
`;

    await fs.writeFile(
      join(commandsDir, `rewrite-${component.name}.md`),
      slashCommand,
      "utf-8"
    );
  }

  const componentSummary = migrationOrder
    .map((name, i) => {
      const a = analyses.find((x) => x.component.name === name);
      if (!a) return `${i + 1}. ${name}`;
      const file = inferTargetFilePath(name, a.component.type, frameworkInfo.targetLanguage);
      return `${i + 1}. **${name}** (${a.component.type}) → \`${file}\``;
    })
    .join("\n");

  const allDeps = [...new Set(analyses.flatMap((a) => a.targetDependencies))];

  const agentsMd = `# Migration Agent Context

> Auto-read by Codex. For Claude Code, use the slash commands in \`.claude/commands/\`.

## What You Are Doing

Migrating **${repoUrl.split("/").slice(-2).join("/")}** from **${frameworkInfo.sourceFramework} (${frameworkInfo.sourceLanguage})** to **${frameworkInfo.targetFramework} (${frameworkInfo.targetLanguage})**.

## Rules

1. Read the context doc for each component before writing any code
2. Rewrite components in the order listed below — dependencies must be done first
3. Preserve every business rule exactly — they are non-negotiable
4. Do not invent functionality not present in the original code
5. After each component, verify the input/output contract matches the context doc

## Migration Order

${componentSummary}

## Install These Packages First

\`\`\`
${allDeps.join("\n") || "none identified — check individual context docs"}
\`\`\`

## Context Docs

${analyses.map((a) => `- [\`${a.component.name}\`](context/${a.component.name}.md) — ${a.purpose}`).join("\n")}
`;

  await fs.writeFile(join(outputDir, "rewrite", "AGENTS.md"), agentsMd, "utf-8");
}

// ---------------------------------------------------------------------------
// Write AI integration files for the service-scan pipeline
// ---------------------------------------------------------------------------

export async function generateScanIntegration(
  outputDir: string,
  analyses: ServiceAnalysis[],
  targetLanguage: string,
  entryRepo: string
): Promise<void> {
  const validNamespaces = new Set(analyses.map((a) => a.namespace));
  const commandsDir = join(outputDir, ".claude", "commands");

  // Remove stale files from previous runs before writing anything new
  await cleanupStaleFiles(outputDir, validNamespaces);
  await fs.mkdir(commandsDir, { recursive: true });

  // Load resolution cache to find source repo for each service
  let resolutionCache: Record<string, { repoFullName: string; filePath: string }> = {};
  try {
    const raw = await fs.readFile(join(outputDir, "resolution-cache.json"), "utf-8");
    resolutionCache = JSON.parse(raw);
  } catch { /* first run or no cache */ }

  const ext = targetLanguage === "python" ? "py"
    : targetLanguage === "go" ? "go"
    : targetLanguage === "java" ? "java"
    : targetLanguage === "csharp" ? "cs"
    : "ts";

  for (const analysis of analyses) {
    const contextDocPath = join(outputDir, "context", `${analysis.namespace}.md`);
    let contextContent = "";
    try {
      contextContent = await fs.readFile(contextDocPath, "utf-8");
    } catch {
      continue;
    }

    // Read actual source files from local clone — embed in slash command
    const resolved = resolutionCache[analysis.namespace];
    const sourceFiles = resolved
      ? await readSourceFiles(outputDir, resolved.repoFullName, analysis.rawFiles)
      : [];

    const targetFile = `services/${analysis.namespace.replace(/Manager$/, "Service").toLowerCase()}.${ext}`;

    const slashCommand = buildSlashCommand(
      analysis,
      contextContent,
      targetFile,
      sourceFiles,
      targetLanguage,
    );

    await fs.writeFile(
      join(commandsDir, `rewrite-${analysis.namespace}.md`),
      slashCommand,
      "utf-8"
    );
  }

  // AGENTS.md — rich instructions for Codex
  const agentsMd = buildServiceAgentsMd(entryRepo, targetLanguage, analyses);
  await fs.writeFile(join(outputDir, "AGENTS.md"), agentsMd, "utf-8");

  // CLAUDE.md — auto-read by Claude Code when opened in the migration workspace
  const claudeMd = buildClaudeMd(entryRepo, targetLanguage, analyses);
  await fs.writeFile(join(outputDir, "CLAUDE.md"), claudeMd, "utf-8");
}
