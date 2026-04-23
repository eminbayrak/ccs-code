import { promises as fs } from "fs";
import { join } from "path";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";
import type { ServiceAnalysis } from "./analyzer.js";

// ---------------------------------------------------------------------------
// Generate AI tool integration files from migration KB.
//
// Outputs:
//   .claude/commands/rewrite-<Name>.md  → Claude Code custom slash command
//   AGENTS.md                           → Codex agent context file
//   run-migration.md                    → Step-by-step guide for any AI tool
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Claude Code slash command — one per component / service
// Placed in .claude/commands/ so dev runs /project:rewrite-<Name> in Claude Code
// ---------------------------------------------------------------------------

function buildSlashCommand(
  name: string,
  contextDocContent: string,
  targetFile: string,
  description: string
): string {
  return `${contextDocContent}

---

## Your Task

Read every source file linked above before writing any code.

Implement the complete **${name}** rewrite following all instructions in this document.

Place the output at: \`${targetFile}\`

After writing the code:
1. Check that every business rule listed above is implemented
2. Verify the input/output contract matches exactly
3. Run the tests if any exist
`;
}

// ---------------------------------------------------------------------------
// AGENTS.md — read automatically by Codex when run in the migration directory
// ---------------------------------------------------------------------------

function buildAgentsMd(
  repoUrl: string,
  frameworkInfo: FrameworkInfo,
  migrationOrder: string[],
  analyses: ComponentAnalysis[]
): string {
  const componentSummary = migrationOrder
    .map((name, i) => {
      const a = analyses.find((x) => x.component.name === name);
      if (!a) return `${i + 1}. ${name}`;
      const file = inferTargetFilePath(name, a.component.type, frameworkInfo.targetLanguage);
      return `${i + 1}. **${name}** (${a.component.type}) → \`${file}\``;
    })
    .join("\n");

  const allDeps = [...new Set(analyses.flatMap((a) => a.targetDependencies))];

  return `# Migration Agent Context

> This file is read automatically by Codex. For Claude Code, use the slash commands in \`.claude/commands/\`.

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

Each component has a full migration context doc in \`context/\`:

${analyses.map((a) => `- [\`${a.component.name}\`](context/${a.component.name}.md) — ${a.purpose}`).join("\n")}

## How to Use

**With Codex:**
\`\`\`
codex "Read context/${migrationOrder[0] ?? "first-component"}.md and implement it"
\`\`\`

**With Claude Code:**
Open Claude Code in your target project directory, then run:
\`\`\`
/project:rewrite-${migrationOrder[0] ?? "ComponentName"}
\`\`\`
(Copy \`.claude/\` from this directory into your target project first)

**Manual:**
Open each context doc, read it, paste into your AI tool of choice.
`;
}

// ---------------------------------------------------------------------------
// Same for service-level scan results
// ---------------------------------------------------------------------------

function buildServiceAgentsMd(
  entryRepo: string,
  targetLanguage: string,
  analyses: ServiceAnalysis[]
): string {
  const ordered = [...analyses].sort((a, b) => {
    // Leaf nodes (no nested calls) first
    return a.nestedServiceCalls.length - b.nestedServiceCalls.length;
  });

  const summary = ordered
    .map((a, i) => `${i + 1}. **${a.namespace}** → \`${a.namespace.replace(/Manager$/, "Service")}.${targetLanguage === "csharp" ? "cs" : targetLanguage === "java" ? "java" : targetLanguage === "go" ? "go" : "py"}\``)
    .join("\n");

  return `# Service Migration Agent Context

> This file is read automatically by Codex. For Claude Code, use the slash commands in \`.claude/commands/\`.

## What You Are Doing

Rewriting external SOAP service calls from **${entryRepo.split("/").slice(-1)[0]}** to native **${targetLanguage}** implementations.

## Rules

1. Read the context doc for each service before writing any code
2. Rewrite leaf services first (those with no nested calls), then their callers
3. Preserve every business rule exactly — they are non-negotiable
4. Replace all SOAP calls with direct database or API calls
5. Do not wrap the old SOAP endpoint — implement the logic natively

## Rewrite Order (leaf services first)

${summary}

## Context Docs

${ordered.map((a) => `- [\`${a.namespace}\`](context/${a.namespace}.md) — ${a.purpose}`).join("\n")}

## How to Use

**With Claude Code** (recommended):
\`\`\`
/project:rewrite-${ordered[0]?.namespace ?? "ServiceName"}
\`\`\`

**With Codex:**
\`\`\`
codex "Read context/${ordered[0]?.namespace ?? "ServiceName"}.md and implement the ${targetLanguage} replacement"
\`\`\`
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
// Write all AI integration files for the rewrite pipeline
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

  // One slash command per component
  for (const analysis of analyses) {
    const { component } = analysis;
    const contextDocPath = join(outputDir, "rewrite", "context", `${component.name}.md`);
    let contextContent = "";
    try {
      contextContent = await fs.readFile(contextDocPath, "utf-8");
    } catch {
      continue; // context doc missing — skip
    }

    const targetFile = inferTargetFilePath(
      component.name,
      component.type,
      frameworkInfo.targetLanguage
    );

    const slashCommand = buildSlashCommand(
      component.name,
      contextContent,
      targetFile,
      analysis.purpose
    );

    await fs.writeFile(
      join(commandsDir, `rewrite-${component.name}.md`),
      slashCommand,
      "utf-8"
    );
  }

  // AGENTS.md for Codex
  const agentsMd = buildAgentsMd(repoUrl, frameworkInfo, migrationOrder, analyses);
  await fs.writeFile(join(outputDir, "rewrite", "AGENTS.md"), agentsMd, "utf-8");

  // Human-readable step-by-step guide
  const steps = migrationOrder.map((name, i) => {
    const a = analyses.find((x) => x.component.name === name);
    const file = a ? inferTargetFilePath(name, a.component.type, frameworkInfo.targetLanguage) : "?";
    return [
      `### Step ${i + 1}: ${name} (${a?.component.type ?? "?"}) — ${a?.complexity ?? "?"} complexity`,
      ``,
      `**Context doc:** \`rewrite/context/${name}.md\``,
      `**Output file:** \`${file}\``,
      `**Claude Code:** \`/project:rewrite-${name}\``,
      `**Codex:** \`codex "Read context/${name}.md and implement it"\``,
      a?.businessRules.length
        ? `\n**Critical rules:**\n${a.businessRules.slice(0, 3).map((r) => `- ${r}`).join("\n")}`
        : "",
    ].join("\n");
  }).join("\n\n");

  const guide = [
    `# Migration Execution Guide`,
    ``,
    `**Repo:** ${repoUrl}`,
    `**Migration:** ${frameworkInfo.sourceFramework} → ${frameworkInfo.targetFramework} (${frameworkInfo.targetLanguage})`,
    ``,
    `## Setup`,
    ``,
    `1. Scaffold your new ${frameworkInfo.targetLanguage} project`,
    `2. Install dependencies listed in \`rewrite/_index.md\``,
    `3. Copy \`rewrite/.claude/\` into your new project root`,
    `4. Open Claude Code in your new project`,
    ``,
    `## Execute (in this order)`,
    ``,
    steps,
    ``,
    `## Verify`,
    ``,
    `After each component:`,
    `- [ ] Input/output contracts match the context doc`,
    `- [ ] All business rules implemented`,
    `- [ ] Tests pass`,
    ``,
    `After all components:`,
    `- [ ] Integration tests pass`,
    `- [ ] All endpoints respond correctly`,
    `- [ ] Business logic verified against the original`,
  ].join("\n");

  await fs.writeFile(join(outputDir, "rewrite", "HOW-TO-MIGRATE.md"), guide, "utf-8");
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
  const commandsDir = join(outputDir, ".claude", "commands");
  await fs.mkdir(commandsDir, { recursive: true });

  for (const analysis of analyses) {
    const contextDocPath = join(outputDir, "context", `${analysis.namespace}.md`);
    let contextContent = "";
    try {
      contextContent = await fs.readFile(contextDocPath, "utf-8");
    } catch {
      continue;
    }

    const ext = targetLanguage === "python" ? "py" : targetLanguage === "go" ? "go" : targetLanguage === "java" ? "java" : "ts";
    const targetFile = `services/${analysis.namespace.replace(/Manager$/, "Service").toLowerCase()}.${ext}`;

    const slashCommand = buildSlashCommand(
      analysis.namespace,
      contextContent,
      targetFile,
      analysis.purpose
    );

    await fs.writeFile(
      join(commandsDir, `rewrite-${analysis.namespace}.md`),
      slashCommand,
      "utf-8"
    );
  }

  // AGENTS.md
  const agentsMd = buildServiceAgentsMd(entryRepo, targetLanguage, analyses);
  await fs.writeFile(join(outputDir, "AGENTS.md"), agentsMd, "utf-8");
}
