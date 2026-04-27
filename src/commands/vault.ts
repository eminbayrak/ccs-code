import { promises as fs } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
export { initVault } from "../vault/init.js";
import { rebuildMasterIndex } from "../vault/masterIndex.js";
import { syncRepo, type GitHubSyncConfig } from "../connectors/github.js";
import { generateGraphHtml } from "../vault/graphBuilder.js";
import { ingestAll } from "../vault/ingestor.js";
import { enrichWiki, type EnrichProgress } from "../vault/enricher.js";
import { askWiki } from "../vault/wikiAsk.js";
import { openInDefaultBrowser } from "../utils/platform.js";
import { createProvider } from "../llm/index.js";
import yaml from "js-yaml";
import { formatErrorDump } from "../utils/errorFormatter.js";
import { initVault } from "../vault/init.js";
import { readdir, stat, readFile } from "fs/promises";

// ---------------------------------------------------------------------------
// Global vault config — remembers active vault across sessions
// ---------------------------------------------------------------------------

const LOCAL_CONFIG_PATH = join(process.cwd(), "ccsconfig.json");

export type VaultConfig = { activeVault?: string };

export async function readVaultConfig(): Promise<VaultConfig> {
  try {
    const raw = await fs.readFile(LOCAL_CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveVaultConfig(cfg: VaultConfig): Promise<void> {
  const json = JSON.stringify(cfg, null, 2);
  await fs.writeFile(LOCAL_CONFIG_PATH, json, "utf-8").catch(() => { });
}

// ---------------------------------------------------------------------------
// Vault path resolution — checks (in order):
//   1. ccs.yaml in cwd
//   2. Global ~/.ccs/config.json active vault
//   3. Falls back to <cwd>/vault
// ---------------------------------------------------------------------------

type SourceConfig =
  | { type: "github"; repos: string[]; include?: string[]; token_env?: string }
  | { type: "folder"; path: string };

type CcsConfig = {
  vault?: { path?: string };
  sources?: SourceConfig[];
};

async function loadCcsConfig(vaultPath: string): Promise<CcsConfig> {
  const possiblePaths = [join(vaultPath, "ccs.yaml"), join(vaultPath, "kforge.yaml")];
  for (const configPath of possiblePaths) {
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      return yaml.load(raw) as CcsConfig;
    } catch {
      continue;
    }
  }
  return {};
}

async function resolveVaultPath(cwd: string): Promise<string> {
  // 1. ccs.yaml or kforge.yaml in cwd
  const possibleRoots = [join(cwd, "ccs.yaml"), join(cwd, "kforge.yaml")];
  for (const rootPath of possibleRoots) {
    try {
      const raw = await fs.readFile(rootPath, "utf-8");
      const cfg = yaml.load(raw) as CcsConfig;
      if (cfg.vault?.path) return resolve(cwd, cfg.vault.path);
    } catch { }
  }

  // 2. Local/Global active vault (ccsconfig.json)
  const config = await readVaultConfig();
  if (config.activeVault) return config.activeVault;

  // 3. Default
  return join(cwd, "vault");
}

// parseSimpleYaml removed in favor of js-yaml

// ---------------------------------------------------------------------------
// /vault command handler
// ---------------------------------------------------------------------------

export async function handleVaultCommand(args: string[], cwd: string): Promise<string> {
  const subcommand = args[0];

  switch (subcommand) {
    case "init": {
      const rawArg = args[1]?.replace(/^['"]|['"]$/g, "") ?? null;
      const vaultPath = rawArg ? resolve(cwd, rawArg) : join(cwd, "vault");
      try {
        const created = await initVault(vaultPath);

        // Save as active vault so all other commands find it
        await saveVaultConfig({ activeVault: vaultPath });

        if (created.length === 0) {
          const wikiFiles = await fs.readdir(join(vaultPath, "wiki")).catch(() => []);
          const rawFiles = await walkIngestable(join(vaultPath, "raw"));
          const skillDirs = await fs.readdir(join(vaultPath, "skills")).catch(() => []);
          return [
            `## ✓ Vault Active`,
            `**Location:** \`${vaultPath}\``,
            "",
            "### Current Status",
            `- **Wiki pages:** ${wikiFiles.length}`,
            `- **Raw files:**  ${rawFiles.length} ready to ingest`,
            `- **Skills:**     ${skillDirs.length} loaded`,
            "",
            "### How to use your vault",
            "1. Drop files into `vault/raw/uploads/`",
            "2. Run `/ingest` to process them into wiki pages",
            "3. Run `/sync` if you added repos to `ccs.yaml`",
            "4. Run `/graph` to see your knowledge graph",
            "",
            "**Commands:** `/ingest`, `/sync`, `/graph`, `/lint`, `/migrate`"
          ].join("\n");
        }
        return [
          `## ✓ Vault Initialized`,
          `**Location:** \`${vaultPath}\``,
          `${created.length} default files and folders created.`,
          "",
          "### 📥 Raw Inbox",
          `**Uploads:** \`${join(vaultPath, "raw", "uploads")}\``,
          "Drop any file here and run `/ingest` to process it.",
          "",
          "### 📄 Formats",
          "`.md`  `.txt`  `.html`  `.json`  `.csv`  `.pdf`",
          "",
          "### 🚀 Next Steps",
          "1. Copy your files into `raw/uploads/`",
          "2. Run `/ingest` — convert files → wiki pages",
          "3. Run `/enrich` — add AI summaries + links",
          "4. Run `/graph` — open visual knowledge graph",
          "*(or /sync first if you have GitHub repos in ccs.yaml)*"
        ].join("\n");
      } catch (e) {
        return `Error initializing vault: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    case "status": {
      const vaultPath = await resolveVaultPath(cwd);
      const rawFiles = await walkIngestable(join(vaultPath, "raw"));
      const wikiCount = await countMarkdownFiles(join(vaultPath, "wiki")).catch(() => 0);
      const skillDirs = await fs.readdir(join(vaultPath, "skills")).catch(() => []);

      return [
        `## 🏰 Vault Status`,
        `**Path:** \`${vaultPath}\``,
        "",
        `- **wiki pages** — ${wikiCount}`,
        `- **raw files**  — ${rawFiles.length} ready to ingest`,
        `- **skills**     — ${skillDirs.length}`,
      ].join("\n");
    }

    case "audit": {
      const vaultPath = await resolveVaultPath(cwd);
      return await runVaultAudit(vaultPath);
    }

    default:
      return [
        "Usage: /vault <subcommand>",
        "  /vault init [path]   create or point to a vault",
        "  /vault status        show active vault",
      ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// /sync command handler
// ---------------------------------------------------------------------------

export async function handleSyncCommand(args: string[], cwd: string): Promise<string> {
  const vaultPath = await resolveVaultPath(cwd);
  const config = await loadCcsConfig(vaultPath);
  const rawDir = join(vaultPath, "raw");

  const sources = Array.isArray(config.sources) ? config.sources : [];
  if (sources.length === 0) {
    return [
      `## 🔄 Sync Sources`,
      `**Vault:** \`${vaultPath}\``,
      "",
      "⚠ **No sources configured.** Edit `ccs.yaml` to add sources:",
      "```yaml",
      "sources:",
      "  - type: github",
      "    repos: [my-org/my-service]",
      "    include: [commits, prs, issues, readme]",
      "    token_env: GITHUB_PRIVATE_TOKEN",
      "```",
    ].join("\n");
  }

  const results: string[] = [`## 🔄 Syncing Sources`, `**Target:** \`${rawDir}\``, ""];

  try {
    for (const source of sources) {
      if (source.type === "github") {
        const token = source.token_env ? process.env[source.token_env] : undefined;
        const include = (source.include ?? ["commits", "prs", "issues", "readme"]) as GitHubSyncConfig["include"];
        for (const repo of source.repos) {
          try {
            const written = await syncRepo(repo, rawDir, { repos: [repo], include, token });
            results.push(`- **github:${repo}** — ✓ ${written.length} file(s) written`);
          } catch (e) {
            results.push(`- **github:${repo}** — ✗ ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else if (source.type === "folder") {
        results.push(`  ⚠ folder sources: drop files into raw/uploads/ manually`);
      }
    }
    return results.join("\n");
  } catch (e) {
    return formatErrorDump(e, "Sync failed");
  }
}

// ---------------------------------------------------------------------------
// /ingest command handler
// ---------------------------------------------------------------------------

export async function handleIngestCommand(args: string[], cwd: string): Promise<string> {
  const vaultPath = await resolveVaultPath(cwd);
  const rawDir = join(vaultPath, "raw");

  const rawFiles = await walkIngestable(rawDir);
  const nonReadme = rawFiles.filter(f => !f.endsWith("README.md"));

  if (nonReadme.length === 0) {
    return [
      `## 📥 Ingesting Files`,
      `**Vault:** \`${vaultPath}\``,
      "",
      "No files found in `raw/`.",
      "Drop files into `raw/uploads/` or run `/sync` to pull from GitHub.",
    ].join("\n");
  }

  let result;
  try {
    result = await ingestAll(vaultPath);
  } catch (e) {
    return formatErrorDump(e, "Ingest failed");
  }
  const { written, updated, skipped, errors } = result;

  const lines = [`## 📥 Ingest Results`, `**Vault:** \`${vaultPath}\``, ""];

  if (written.length > 0) {
    lines.push(`### ✓ Created ${written.length} new wiki page(s):`);
    for (const f of written.slice(0, 8)) lines.push(`- \`${f}\``);
    if (written.length > 8) lines.push(`- ... and ${written.length - 8} more`);
  }

  if (updated.length > 0) {
    lines.push(`### ↻ Updated ${updated.length} existing page(s)`);
  }

  if (skipped.length > 0) {
    lines.push(`- **Skipped:** ${skipped.length} file(s) (unsupported format)`);
  }

  if (errors.length > 0) {
    lines.push("", "### ✗ Errors:");
    for (const e of errors) lines.push(`- \`${e}\``);
  }

  if (written.length === 0 && updated.length === 0 && errors.length === 0) {
    lines.push("Wiki is already up to date — no new content found.");
  } else {
    lines.push("", "---", "Run `/enrich` to add AI summaries and links, then `/graph` to visualize.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// /lint command handler
// ---------------------------------------------------------------------------

export async function handleLintCommand(args: string[], cwd: string): Promise<string> {
  const vaultPath = await resolveVaultPath(cwd);
  const lintScript = join(vaultPath, "skills", "wiki-lint", "scripts", "lint_wiki.py");

  try {
    await fs.access(lintScript);
  } catch {
    return `Vault not found at: ${vaultPath}\nRun /vault init <path> first.`;
  }

  return [
    `Vault: ${vaultPath}`,
    "",
    "Run the wiki health check:",
    `  python3 ${lintScript} --vault ${vaultPath}`,
    "",
    "Or say: 'lint the wiki'",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /graph command handler
// ---------------------------------------------------------------------------

export async function handleGraphCommand(args: string[], cwd: string): Promise<string> {
  const vaultPath = await resolveVaultPath(cwd);
  const wikiDir = join(vaultPath, "wiki");
  const outputPath = join(vaultPath, "output", "graph.html");

  try {
    await fs.access(wikiDir);
  } catch {
    return `Vault not found at: ${vaultPath}\nRun /vault init <path> first.`;
  }

  try {
    const { nodeCount, edgeCount } = await generateGraphHtml(wikiDir, outputPath);

    if (nodeCount === 0) {
      return [
        `Vault: ${vaultPath}`,
        "",
        "Wiki is empty — no pages to graph yet.",
        "Run /ingest first to process files into wiki pages.",
      ].join("\n");
    }

    let browserOpened = true;
    try {
      await openInDefaultBrowser(outputPath);
    } catch {
      browserOpened = false;
    }

    return [
      `## 🕸️ Knowledge Graph Built`,
      `**Nodes:** ${nodeCount} (pages)`,
      `**Edges:** ${edgeCount} (links)`,
      "",
      `✓ Saved to: \`output/graph.html\``,
      "",
      browserOpened ? "Opening in browser…" : `Open this file in your browser: \`${outputPath}\``,
    ].join("\n");
  } catch (e) {
    return `Error building graph: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------------------------------------------------------------------------
// /rewrite command handler
// ---------------------------------------------------------------------------

export async function handleRewriteCommand(args: string[], cwd: string): Promise<string> {
  const vaultPath = await resolveVaultPath(cwd);
  const service = args.slice(1).join(" ").trim();
  const rewriteScript = join(vaultPath, "skills", "rewrite-plan", "scripts", "analyze_rewrite.py");

  try {
    await fs.access(rewriteScript);
  } catch {
    return `Vault not found at: ${vaultPath}\nRun /vault init <path> first.`;
  }

  if (!service) {
    return [
      "Usage: /rewrite <service-name>",
      "       /rewrite order",
      "",
      "Example: /rewrite payment-svc",
    ].join("\n");
  }

  if (service === "order") {
    return [
      `Vault: ${vaultPath}`,
      "",
      `  python3 ${rewriteScript} --vault ${vaultPath} --order`,
    ].join("\n");
  }

  return [
    `Vault: ${vaultPath}`,
    "",
    `  python3 ${rewriteScript} --vault ${vaultPath} --service ${service}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /index command handler
// ---------------------------------------------------------------------------

export async function handleIndexCommand(args: string[], cwd: string): Promise<string> {
  const vaultPath = await resolveVaultPath(cwd);
  const wikiDir = join(vaultPath, "wiki");

  try {
    const entries = await rebuildMasterIndex(wikiDir);
    return `Master index rebuilt: ${entries.length} pages indexed\nWritten to: ${wikiDir}/_master-index.md`;
  } catch (e) {
    return `Error rebuilding index: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INGESTABLE_EXTS = new Set([".md", ".html", ".txt", ".json", ".pdf", ".csv"]);

async function walkIngestable(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        await walk(join(d, e.name));
      } else {
        const ext = e.name.slice(e.name.lastIndexOf(".")).toLowerCase();
        if (INGESTABLE_EXTS.has(ext)) out.push(join(d, e.name));
      }
    }
  }
  await walk(dir);
  return out;
}

async function countMarkdownFiles(dir: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) count += await countMarkdownFiles(join(dir, e.name));
    else if (e.name.endsWith(".md")) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// /enrich command handler
// ---------------------------------------------------------------------------

export async function handleEnrichCommand(
  args: string[],
  cwd: string,
  onProgress?: (p: EnrichProgress) => void,
): Promise<string> {
  const vaultPath = await resolveVaultPath(cwd);
  const wikiDir = join(vaultPath, "wiki");

  try {
    await fs.access(wikiDir);
  } catch {
    return `Vault not found at: ${vaultPath}\nRun /vault init <path> first.`;
  }

  let provider;
  try {
    provider = await createProvider();
  } catch (e) {
    return `No LLM provider configured.\nError: ${e instanceof Error ? e.message : String(e)}`;
  }

  const { enriched, errors } = await enrichWiki(vaultPath, provider, onProgress);

  if (enriched === 0 && errors === 0) {
    return [
      `## ✨ AI Enrichment`,
      `**Provider:** ${provider.name}`,
      "",
      "All wiki pages are already enriched. 🚀",
      "Run `/graph` to rebuild the knowledge graph with semantic links.",
    ].join("\n");
  }

  return [
    `## ✨ Enrichment Complete`,
    `**Provider:** ${provider.name}`,
    "",
    `- Enriched **${enriched}** page(s) with summaries, tags, and [[wikilinks]]`,
    errors > 0 ? `- ✗ **${errors} error(s)** — some pages were skipped` : "",
    "",
    "---",
    "Run `/graph` to rebuild the knowledge graph.",
  ].filter(l => l !== "").join("\n");
}

// ---------------------------------------------------------------------------
// /ask command handler — RAG over wiki
// ---------------------------------------------------------------------------

export async function handleAskCommand(question: string, cwd: string): Promise<string> {
  if (!question.trim()) {
    return "Usage: /ask <question>\nExample: /ask what did I discuss about React hooks?";
  }

  const vaultPath = await resolveVaultPath(cwd);

  let provider;
  try {
    provider = await createProvider();
  } catch (e) {
    return `No LLM provider configured.\nError: ${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    const { answer, sources, wikiPageCount } = await askWiki(vaultPath, question, provider);

    const header = wikiPageCount > 0
      ? `*Searching wiki… found ${wikiPageCount} relevant page(s)*\n\n`
      : `*No relevant wiki pages found — answering from model knowledge*\n\n`;

    return header + answer;
  } catch (e) {
    return formatErrorDump(e, "Ask failed");
  }
}

// ---------------------------------------------------------------------------
// /guide command handler
// ---------------------------------------------------------------------------

export async function handleGuideCommand(): Promise<string> {
  return `# CCS Code Guide

CCS has two surfaces:

1. **Migration intelligence** — analyze a legacy repo, produce a verified migration contract, graph, dashboard, and agent handoff files.
2. **Knowledge vault** — ingest docs/repos into a local wiki and ask questions over it.

## Fastest Migration Path

Use plain English:

\`\`\`text
migrate https://github.com/org/repo to csharp
\`\`\`

Or use the explicit command:

\`\`\`text
/migrate rewrite --repo https://github.com/org/repo --to csharp --context docs/modern-use-case.md --yes
\`\`\`

After the run:

\`\`\`text
/migrate open --dashboard
/migrate open
\`\`\`

## Slash Autocomplete

Type \`/m\` to see every migration command. Type more to narrow:

\`\`\`text
/migrate r
/migrate rewrite --r
\`\`\`

Use arrow keys to move, Enter or Tab to accept, Esc to close.

## Migration Commands And Flags

| Command | Flags | Purpose |
|---|---|---|
| \`/migrate rewrite\` | \`--repo <url>\`, \`--to <lang>\`, \`--from <framework>\`, \`--context <path>\` repeatable, \`--no-context\`, \`--yes\` | Full analysis: scan, reverse-engineer, verify, write contract, dashboard, agent files |
| \`/migrate reverse-eng\` | \`--repo <url>\`, \`--to <lang>\`, \`--context <path>\`, \`--no-context\`, \`--yes\` | Reverse-engineering artifacts and graph only |
| \`/migrate scan\` | \`--repo <url>\`, \`--lang <lang>\`, \`--org <org>\`, \`--plugin <name>\`, \`--yes\` | Legacy service/SOAP scan path |
| \`/migrate dashboard\` | \`<run-folder-or-repo-url>\`, \`--open\` | Regenerate \`dashboard.html\` for an existing run |
| \`/migrate open\` | \`<run-folder-or-repo-url>\`, \`--dashboard\`, \`--folder\` | Open the latest or selected result folder/dashboard |
| \`/migrate clean\` | \`<slug>\`, \`--all\`, \`--yes\` | Remove generated migration run folders |
| \`/migrate status\` | none | Show legacy service scan status |
| \`/migrate context\` | \`<ServiceName>\` | Print a service context doc |
| \`/migrate verify\` | \`<ServiceName>\`, \`--by <name>\` | Mark a legacy service as human-verified |
| \`/migrate done\` | \`<ServiceName>\` | Mark a service as fully rewritten |
| \`/migrate rescan\` | \`<ServiceName>\` | Show rescan instructions |
| \`/migrate db\` | \`--service <name>\`, \`--yes\` | Read-only database schema extraction, with approval |
| \`/migrate plugin list\` | none | List installed migration scanner plugins |

## Regenerate Dashboard

For a brand-new scan, run rewrite again. It creates a fresh \`dashboard.html\`:

\`\`\`text
/migrate rewrite --repo https://github.com/gothinkster/node-express-realworld-example-app --to csharp --context docs/realworld-benchmark-design.md --yes
\`\`\`

For an existing run, regenerate and open only the dashboard:

\`\`\`text
/migrate dashboard gothinkster-node-express-realworld-example-app --open
\`\`\`

For your smaller test repo:

\`\`\`text
/migrate rewrite --repo https://github.com/eminbayrak/node-orders-api --to csharp --yes
/migrate dashboard eminbayrak-node-orders-api --open
\`\`\`

## What The Graph Is For

The system graph is a structured map of the repo and migration plan:

- **Nodes:** components, source files, source packages, target roles, target packages.
- **Edges:** dependency, definition, package usage, and target-role recommendation links.

It is useful in three ways:

1. Humans can see migration shape faster than reading every markdown file.
2. The migration contract uses dependency edges to produce implementation order.
3. Agents can query dependency impact through MCP, for example \`ccs_get_dependency_impact\`.

Important: today this is a lightweight graph, not full Neo4j-style memory. It supports useful dependency impact and visualization, but not deep BFS/DFS call-chain analysis yet.

## Parser Coverage

CCS uses a three-tier parser stack. No manual installs are needed — tree-sitter grammars
are listed as \`optionalDependencies\` in \`package.json\` and are installed automatically
by \`bun install\` / \`npm install\`. If native compilation fails on a restricted machine,
CCS falls back to regex silently.

| Language | Extensions | Method |
|---|---|---|
| TypeScript / JavaScript | \`.ts .tsx .js .jsx .mjs .cjs\` | TypeScript compiler AST — always available |
| Python | \`.py\` | Tree-sitter (auto-installed) → regex fallback |
| Java | \`.java\` | Tree-sitter (auto-installed) → regex fallback |
| C# | \`.cs\` | Tree-sitter (auto-installed) → regex fallback |
| Go | \`.go\` | Tree-sitter (auto-installed) → regex fallback |
| C | \`.c .h\` | Tree-sitter (auto-installed) → regex fallback |
| C++ | \`.cpp .cc .cxx .hpp .hh\` | Tree-sitter (auto-installed) → regex fallback |
| Pascal / Delphi | \`.pas .dpr .inc .pp\` | Tree-sitter (auto-installed) → regex fallback |
| VB6 / VBA | \`.bas .cls .frm .vb\` | Regex (no tree-sitter grammar exists) |

Each run of \`/migrate rewrite\` or \`/migrate reverse-eng\` reports which method was
used in \`reverse-engineering/code-intelligence.json\` under \`analysisMethod\`.

If tree-sitter fails to build on your machine (restricted network, missing compiler),
run this once to force a rebuild after installing the required toolchain:

\`\`\`text
npm rebuild tree-sitter
\`\`\`

## MCP Setup

\`\`\`text
/setup
ccs-code mcp
codex mcp add ccs -- ccs-code mcp
\`\`\`

Claude Code can use the same server through \`.mcp.json\`.

## Knowledge Vault Commands

| Command | Purpose |
|---|---|
| \`/vault init [path]\` | Create/select the local vault |
| \`/vault status\` | Show vault counts |
| \`/vault audit\` | Health check harvested and ingested content |
| \`/sync\` | Pull configured sources |
| \`/harvest\` | Mine local AI chat histories |
| \`/ingest\` | Convert raw files to wiki pages |
| \`/enrich\` | Add AI summaries, tags, and links |
| \`/graph\` | Build/open the vault graph |
| \`/index\` | Rebuild the wiki master index |
| \`/ask <question>\` | Ask a question over the wiki |
| \`/lint\` | Check wiki health |

## Runtime Commands

| Command | Purpose |
|---|---|
| \`/clear\` | Clear conversation history |
| \`/skills\` | List loaded skills |
| \`/model\` | Show active model and permission mode |
| \`/mode <default|plan|permissive>\` | Change permission mode |
| \`/approvals\`, \`/approve <id>\`, \`/reject <id>\` | Review pending approvals |
| \`/tasks\` | List background agent tasks |
| \`/hooks <list|enable|disable|clear>\` | Manage hooks |
| \`/help\` or \`?\` | Keyboard shortcuts |
| \`/exit\` | Exit CCS |
`;
}



/**
 * Runs a comprehensive health check on the vault.
 */
async function runVaultAudit(vaultPath: string): Promise<string> {
  const reports: string[] = [`Vault Audit Report for: ${vaultPath}\n`];
  
  try {
    const memoriesPath = join(vaultPath, "raw", "memories");
    const wikiPath = join(vaultPath, "wiki");
    
    // 1. Check Harvested Memories
    const tools = ["claude", "vscode", "cursor", "antigravity", "windsurf"];
    let totalMemories = 0;
    const toolCounts: Record<string, number> = {};
    
    for (const tool of tools) {
      const toolDir = join(memoriesPath, tool);
      const files = await walkRecursive(toolDir);
      const mdFiles = files.filter(f => f.endsWith(".md"));
      toolCounts[tool] = mdFiles.length;
      totalMemories += mdFiles.length;
    }
    
    reports.push(`## 📂 Raw Memories`);
    reports.push(`**Total Harvested:** ${totalMemories}`);
    for (const [tool, count] of Object.entries(toolCounts)) {
      reports.push(`- **${tool}**: ${count}`);
    }
    reports.push("");
    
    // 2. Check Wiki Ingestion
    const wikiMarkdownFiles = await walkRecursive(wikiPath);
    const totalWiki = wikiMarkdownFiles.filter(f => f.endsWith(".md")).length;
    reports.push(`## 📚 Wiki State`);
    reports.push(`**Total Wiki Pages:** ${totalWiki}`);
    reports.push("");
    
    // Simple heuristic: If wiki count is much lower than memories, something is wrong
    if (totalWiki < totalMemories && totalMemories > 0) {
      reports.push(`⚠ **WARNING:** Some memories might be missing from the wiki.`);
      reports.push(`Memories: ${totalMemories}, Wiki: ${totalWiki}`);
    } else {
      reports.push(`✓ Knowledge base coverage looks good.`);
    }
    
    return reports.join("\n");
  } catch (e: any) {
    return `Audit failed: ${e.message}`;
  }
}

/**
 * Helper for recursive file listing
 */
async function walkRecursive(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const list = await readdir(dir, { withFileTypes: true });
    for (const file of list) {
      const res = join(dir, file.name);
      if (file.isDirectory()) {
        results.push(...(await walkRecursive(res)));
      } else {
        results.push(res);
      }
    }
  } catch (e) {}
  return results;
}
