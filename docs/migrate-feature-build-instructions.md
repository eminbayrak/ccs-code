# Build Instructions: `/migrate` Feature

This document captures everything needed to implement the `/migrate` command from scratch.
Written so any developer or AI coding tool can read it cold and start building immediately.

**Status as of 2026-04-22:** All core implementation tasks are complete.

---

## What We Are Building

A `/migrate` command that:

1. Accepts a single repo URL — any legacy codebase, any language
2. Automatically scans the codebase to find all external service references
3. Searches the GitHub org to resolve those services to their own repos — no user input
4. Recursively traces the full call chain: entry layer → service layer → data layer
5. Uses an LLM to deeply understand the business logic at every layer
6. Outputs a structured knowledge base and per-service migration context documents
7. **Automatically wires the KB to Claude Code and Codex** — generates slash commands and AGENTS.md
8. Also supports full codebase rewriting: analyzes an entire framework (e.g., .NET) and generates component-level migration context documents

**The app does not rewrite code. It prepares the context that makes AI rewrites accurate.**

---

## Security Rule — Read Before Writing Any Code

This repo is **public on GitHub**. Never write the following anywhere in source files, comments, strings, or docs:

- Real company or org names
- Real service names, class names, or method names from the target system
- Real hostnames, IP addresses, or internal URLs
- Anything that identifies the employer or the production system being migrated

Use generic placeholders everywhere: `FooService`, `SomeManager`, `example-org`, `your-org`.
Config values (tokens, hostnames) live in `.ccs/config.json` which is gitignored — never hardcoded.

---

## Existing Codebase — What to Build On

### LLM Layer (`src/llm/`) — do not change

```ts
import { createProvider } from '../llm/index.js'
const provider = await createProvider()        // reads .ccs/config.json
await provider.chat(messages, systemPrompt)   // returns string
```

For two-tier usage (Haiku + Sonnet), instantiate providers directly:
```ts
import { AnthropicProvider } from '../llm/providers/anthropic.js'
const haiku  = new AnthropicProvider('claude-haiku-4-5-20251001')
const sonnet = new AnthropicProvider('claude-sonnet-4-6')
```

### GitHub Connector (`src/connectors/github.ts`) — already extended

Implemented functions (all complete):
- `fetchFileContent(owner, repo, path, token?, host?)` — fetch raw file content from GitHub
- `fetchFileTree(owner, repo, token?, host?)` — full recursive file tree as string array
- `parseRepoUrl(url)` — returns `{ owner, repo, host }` from any GitHub or GHE URL
- Enterprise host support via `host` param (defaults to `github.com`)

---

## Implementation Order

Build in this sequence — each step unblocks the next. Status noted for each.

### ✅ 1. Update `AnthropicProvider` default model
Updated to `claude-sonnet-4-6` (200K context window needed for large files).

### ✅ 2. Extend `src/connectors/github.ts`
`fetchFileContent`, `fetchFileTree`, `parseRepoUrl`, Enterprise host support — all implemented.

### ✅ 3. `src/migration/types.ts`
Core type definitions: `ServiceReference`, `MigratePlugin`, `ScanResult`, `ServiceGroup`.

### ✅ 4. `src/migration/scanner.ts`
Generic plugin runner. Exports:
- `runPluginScan(files, plugin)` — runs plugin against files, returns `ScanResult`
- `groupByNamespace(references)` — groups `ServiceReference[]` by `serviceNamespace`
- `scanDirectory(rootDir, plugin)` — for local directory scanning

No SOAP-specific logic in core — all pattern matching lives in plugins.

### ✅ 5. `src/migration/wsdlParser.ts`
Parses WSDL/XML. Exports:
- `parseWsdl(content)` — returns `WsdlParseResult` (service name, namespace, operations, messages)
- `wsdlToPromptText(result)` — formats WSDL data for LLM prompts

### ✅ 6. `src/migration/statusTracker.ts`
Reads/writes `migration-status.json`. Exports: `init()`, `load()`, `save()`, `upsertService()`, `getProgress()`, `isAnalyzed()`, `markDone()`.

### ✅ 7. `src/migration/resolver.ts`
Resolves service namespaces to GitHub repos. Exports: `resolveNamespace(ns, githubConfig, provider)`, `findWsdlFiles(repoFullName, config)`.

### ✅ 8. `src/migration/costEstimator.ts`
Shows cost preview before any LLM call. Exports: `estimateScanCost(count, keyFiles, tier)`, `formatCostPreview(estimate)`.

### ✅ 9. `src/migration/analyzer.ts`
Tier 2: Sonnet analysis per service. Uses `ServiceReference` (not `SoapCallSite` — that type no longer exists). Exports: `analyzeService(callSite, sourceFiles, wsdl, provider)`.

### ✅ 10. `src/migration/contextBuilder.ts`
Pure function: `buildContextDoc({ analysis, resolved, targetLanguage, repoBaseUrl, analysisDate })` → markdown string.

### ✅ 11. `src/migration/indexBuilder.ts`
Assembles `_index.md`. Exports: `buildIndex(migrationDir, analyzed, finalStatus, unresolved)`.

### ✅ 12. `src/migration/tracer.ts`
Orchestrates the full scan pipeline: fetch tree → run plugin → resolve namespaces → analyze services → write context docs → write index → call `generateScanIntegration()`. Checkpoint written after every service. Null-safe status load (explicit error instead of force-cast).

### ✅ 13. `src/migration/pluginLoader.ts` (new)
Three-tier plugin discovery: `.ccs/plugins/` → `~/.ccs/plugins/` → built-in `plugins/`.
Built-in dir detected via `process.argv` — works in both dev (ts script) and binary mode.
See `docs/plugin-architecture.md` for full details.

### ✅ 14. `plugins/migrate-soap/` (new)
Built-in SOAP scanner plugin. Exports `createPlugin(config?)` factory and a default plugin instance.
`index.js` compiled and committed — works without a build step.

### ✅ 15. `src/migration/rewriteTypes.ts` (new)
Types for the rewrite pipeline: `ComponentType`, `SourceComponent`, `FrameworkInfo`, `ComponentAnalysis`, `Complexity`, `RewriteResult`.

### ✅ 16. `src/migration/frameworkMapper.ts` (new)
Static concept mapping tables for supported framework pairs:
- `aspnet-core → fastapi`
- `aspnet-core → django`
- `spring-boot → fastapi`
- `express → fastapi`

Each entry maps source concept → target concept + package + migration notes. Exports:
`getFrameworkMapping(source, target)`, `formatMappingForPrompt(mapping)`, `supportedSourceFrameworks()`, `targetsFor(source)`.

### ✅ 17. `src/migration/rewriteAnalyzer.ts` (new)
Three functions:
- `detectFramework(filePaths, keyFiles, targetLang, provider)` — Haiku, returns `FrameworkInfo`
- `discoverComponents(filePaths, frameworkInfo, provider)` — Haiku, returns `SourceComponent[]`
- `analyzeComponent(component, sourceFiles, frameworkInfo, provider)` — Sonnet, returns `ComponentAnalysis`
- `sortByDependency(components)` — topological sort (leaf nodes first)

### ✅ 18. `src/migration/rewriteContextBuilder.ts` (new)
- `buildRewriteContextDoc(analysis, frameworkInfo, repoBaseUrl, date)` — per-component markdown with framework mapping table
- `buildRewriteIndex(analyses, frameworkInfo, order, unanalyzed, overview, date, repoBaseUrl)` — master index

### ✅ 19. `src/migration/rewriteTracer.ts` (new)
Orchestrator for the rewrite pipeline: fetch tree → detect framework → discover components → analyze each → write context docs → generate AI integration files. Writes to `outputDir/rewrite/`.

### ✅ 20. `src/migration/aiIntegration.ts` (new)
Generates Claude Code slash commands and Codex agent context automatically after any scan or rewrite. Exports:
- `generateRewriteIntegration(outputDir, analyses, frameworkInfo, migrationOrder, repoUrl)` — writes `rewrite/.claude/commands/`, `rewrite/AGENTS.md`, `rewrite/HOW-TO-MIGRATE.md`
- `generateScanIntegration(outputDir, analyses, targetLanguage, entryRepo)` — writes `.claude/commands/`, `AGENTS.md`
- `inferTargetFilePath(name, type, targetLanguage)` — maps component name+type → output file path

### ✅ 21. `src/commands/migrate.ts` (complete)
Full subcommand routing: `scan`, `rewrite`, `status`, `context`, `verify`, `done`, `rescan`, `plugin`.
- `validateSetup(requireGithub)` — pre-flight: checks API key and GitHub token; returns `SetupIssue[]` with severity and actionable messages
- `getMigrationDir()` — falls back to `~/.ccs/migration` if no vault configured (no longer throws)
- `handleScan` — `--yes` flag, `--plugin` flag, pre-flight validation
- `handleRewrite` — new handler for `/migrate rewrite --repo --to --from --yes`; shows output file paths on completion
- `handleVerify` — fixed: checks `verifiedBy` first; low-confidence warning is advisory, not blocking
- `handleDone` — marks verified service as done; throws if not verified first
- `handlePlugin` — lists installed plugins

### ✅ 22. `src/components/App.tsx`
Added `.catch()` to `handleMigrateCommand` promise. Added start messages for all subcommands including `rewrite`.

### ✅ 23. Tests (28 passing)
- `src/migration/scanner.test.ts` — 22 tests: single call, multiple calls, metadata extraction, configurable names, nested parens, extension filtering, groupByNamespace
- `src/migration/wsdlParser.test.ts` — 6 tests: service name, namespace, operations, messages, empty WSDL, malformed input

### ✅ 24. `package.json`
- `name` updated to `"ccs-code"` (was `"my-cli-app"`)
- Added `"dev": "bun --watch src/main.tsx"` script
- Added `"build:plugins": "bun build ./plugins/migrate-soap/index.ts --outfile ./plugins/migrate-soap/index.js --format esm"`
- Added `"build:all": "bun run build && bun run build:plugins"`

---

## The Node.js + SOAP Pattern (First Implementation)

Every SOAP call in the target Node.js codebase follows this structure:

```js
const config = {
  methodName: 'someMethod',
  serviceNamespace: 'FooManager',
  actionName: 'someMethod',
  isXmlResponse: true,
  parameters: [
    { isSecurityContext: true },
    { isSomeCriteria: true, value: req.body },
  ],
}
const response = await constructSoapRequest(config, req.session)
```

The scanner plugin extracts `serviceNamespace`, `methodName`, `isXmlResponse`, and boolean parameter flags per call site. Each unique `serviceNamespace` becomes one node in the dependency graph.

---

## The Rewrite Pipeline (Full Codebase Migration)

For `/migrate rewrite`, the entry point is a full codebase repo (not a specific service call pattern). The pipeline:

1. Fetches key files for framework detection (`.csproj`, `pom.xml`, `package.json`, `Program.cs`, etc.)
2. Haiku detects source framework → selects target framework mapping
3. Haiku discovers all components from the file tree
4. Sonnet analyzes each component with framework mapping context
5. Topological sort → migration order (leaf nodes first)
6. Context docs written to `rewrite/context/`
7. AI tool integration generated automatically

---

## LLM Usage

### Tier 0 — No LLM (static scan)
Plugin regex/string matching. Zero cost.

### Tier 1 — Haiku
Ambiguous repo ranking (`/migrate scan`), framework detection, component discovery (`/migrate rewrite`). Prompts under 500 tokens. Always parse JSON output. Handle parse failure gracefully.

### Tier 2 — Sonnet 4.6

**System prompt:**
```
You are a code analyst helping document a legacy system for migration.
Extract business logic clearly and accurately.
If you are uncertain about any field, use exactly the string "unknown" — do not guess.
Respond only with valid JSON matching the schema provided.
```

Multi-file services: bundle all files for one namespace into a single Sonnet call. Do not analyze each file separately and merge — a single call produces more accurate cross-file understanding.

---

## Environment Variables

| Variable | Purpose | Read by |
|----------|---------|---------|
| `CCS_ANTHROPIC_API_KEY` | Anthropic API key | `anthropic.ts` |
| `CCS_GITHUB_TOKEN` | GitHub PAT | `github.ts` (also accepts `GITHUB_TOKEN`, `GITHUB_PRIVATE_TOKEN`) |

`validateSetup()` checks both at command start and prints clear error messages if either is missing.

---

## What This Unlocks Beyond the First Use Case

The scanner pattern is general. A different plugin can target different codebases:

| Pattern | Plugin scans for | Resolves to |
|---------|-----------------|-------------|
| Node.js + SOAP | `constructSoapRequest` calls | SOAP service repos |
| Python + gRPC | `stub.MethodName()` calls | `.proto` definitions |
| Java + REST clients | `RestTemplate.getForObject` | OpenAPI specs |
| Any → Any | User-defined patterns | User-defined repos |

Each is a separate plugin. The core infrastructure (tracer, resolver, analyzer, GitHub connector, LLM providers) is shared.

---

_ccs-code · /migrate build instructions · v3 · 2026-04-22_
