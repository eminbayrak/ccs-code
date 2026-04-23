# Migration Context Builder

### Feature Design Document

_ccs-code · Internal Developer Tool_

---

|          |                          |
| -------- | ------------------------ |
| Status   | Implemented              |
| Version  | 1.0                      |
| Author   | Emin BAYRAK              |
| Audience | Engineering Team         |

---

## Vision

This is a **general-purpose migration intelligence platform**. Any development team doing any kind of legacy-to-modern rewrite can use this tool. Two concrete pipelines are implemented:

1. **Service scan pipeline** (`/migrate scan`) — targets codebases that call external services via known patterns (e.g., Node.js + SOAP)
2. **Rewrite pipeline** (`/migrate rewrite`) — targets full framework-to-framework migrations (e.g., .NET → Python, Spring Boot → FastAPI)

**Three core value propositions:**

1. **Migration Intelligence** — point at any legacy repo, get a full recursive understanding of what the system does, expressed as AI-ready context documents
2. **KB Builder** — structured knowledge base useful for onboarding, documentation, architecture audits, not just migration
3. **AI Tool Wiring** — the KB is automatically connected to Claude Code and Codex the moment the scan finishes

**The app does not rewrite code. It prepares the context that makes AI rewrites accurate.**

---

## Background

This feature supports migrating a legacy backend architecture to a modern cloud-native stack.

| Layer       | Legacy                                       | Target                       |
| ----------- | -------------------------------------------- | ---------------------------- |
| Frontend    | Calls Node.js middleware                     | Calls REST API directly       |
| Middleware  | Node.js servers acting as SOAP clients       | Eliminated                   |
| Backend     | SOAP services on Windows servers             | Eliminated                   |
| New backend | —                                            | RESTful API on cloud (any language) |

The actual code rewriting is done by AI tools (Claude Code, GitHub Copilot, OpenAI Codex). This feature provides those tools with the structured context they need to do the rewrite accurately.

---

## The Problem

AI tools cannot accurately rewrite a service without understanding:

- What the service does in plain language
- The full call chain from the entry point down to the data layer
- Business rules applied along the way
- Data contracts at every step
- How services depend on each other

Without this context, AI rewrites are generic and incomplete. Building it manually across dozens of interconnected services is impractical.

---

## Pipeline 1 — Service Scan (`/migrate scan`)

### Entry Point

```
/migrate scan --repo <nodejs-repo-url> --lang <target> --yes
```

**Pre-flight validation** runs before anything else — checks `CCS_ANTHROPIC_API_KEY` and the GitHub token. If either is missing, the command exits immediately with a clear error.

### Scan Flow

1. **Tier 0 (free):** Run the scanner plugin against all repo files. Extracts `ServiceReference[]` — one per call site.
2. **Group:** All references grouped by `serviceNamespace` — each unique namespace is one service.
3. **Tier 1 (Haiku):** Resolve each namespace to a GitHub repo. Multiple candidates → Haiku ranks them.
4. **Tier 2 (Sonnet 4.6):** Analyze each resolved service — purpose, data flow, business rules, contracts, database interactions, nested calls.
5. **Recurse:** If service A calls service B, add B to the queue and process it the same way.
6. **Checkpoint:** Write to `migration-status.json` after every service.

### How `constructSoapRequest` Is Parsed

The built-in `migrate-soap` plugin looks for this pattern across all Node.js/TypeScript files:

```js
const response = await constructSoapRequest({
  methodName: 'someMethod',
  serviceNamespace: 'SomeServiceManager',   // ← key identifier
  isXmlResponse: true,
  parameters: [
    { isSecurityContext: true },
    { isSomeCriteria: true, value: req.body },
  ],
}, req.session);
```

Extracted fields per call site:
- `serviceNamespace` → used to find the SOAP service repo on GitHub
- `methodName` → the specific operation to analyze
- `isXmlResponse`, boolean parameter flags → stored in `metadata` for context

The plugin correctly handles nested parentheses via `findClosingParen()`. Function name and field names are configurable via `createPlugin({ callerFunctionName, namespaceField, methodField })`.

### Recursive Tracing

```
Node.js route handler
  └─► constructSoapRequest({ serviceNamespace: 'FooManager', methodName: 'getItems' })
        └─► FooManager.getItems()
              ├─► SQL: SELECT * FROM items WHERE ...
              └─► AnotherService.logAccess()
                    └─► SQL: INSERT INTO audit_log ...
```

Leaf nodes (SQL, stored procs, file I/O, external HTTP) are documented but not recursed into. Loop detection via a `visited` set prevents infinite cycles.

---

## Pipeline 2 — Rewrite Analysis (`/migrate rewrite`)

### Entry Point

```
/migrate rewrite --repo <full-codebase-url> --to python --from aspnet-core --yes
```

### Rewrite Flow

1. **Fetch file tree** from GitHub (free).
2. **Detect framework** (Haiku) — fetches key files (`.csproj`, `pom.xml`, `Program.cs`, etc.) and identifies source/target framework pair.
3. **Discover components** (Haiku) — returns `SourceComponent[]` with name, type, and file paths. Types: `controller`, `service`, `repository`, `model`, `dto`, `middleware`, `config`, `utility`. Test files excluded.
4. **Cost preview** — shown before any Sonnet calls.
5. **Analyze each component** (Sonnet 4.6) — fetches source files, uses framework mapping table (e.g., `ControllerBase` → `APIRouter`, `DbContext` → `SQLAlchemy Session`), extracts purpose, business rules, target dependencies, complexity, confidence.
6. **Topological sort** — orders components so leaf nodes (models, repositories) come before their callers (services, controllers).
7. **Generate context docs** — one markdown file per component.
8. **Generate AI integration** — Claude Code slash commands + Codex AGENTS.md + HOW-TO-MIGRATE.md.

### Framework Mapping

Static concept mapping tables in `frameworkMapper.ts` cover:
- `aspnet-core → fastapi`
- `aspnet-core → django`
- `spring-boot → fastapi`
- `express → fastapi`

Each entry maps a source concept to a target concept + package + migration notes. The mapping is embedded in the Sonnet prompt so the AI understands not just what to analyze but how the concepts translate.

---

## AI Tool Wiring (both pipelines)

This is the key output. The KB is not just markdown files — it is automatically wired to the developer's AI tool of choice.

### Claude Code — custom slash commands

Generated at: `.claude/commands/rewrite-<Name>.md` (scan) or `rewrite/.claude/commands/rewrite-<Name>.md` (rewrite)

Each file embeds the full context doc, so the developer types `/project:rewrite-OrderController` in Claude Code and the AI has everything — source file links, business rules, data contracts, migration checklist — immediately.

### Codex — AGENTS.md

Generated at: `AGENTS.md` (scan) or `rewrite/AGENTS.md` (rewrite)

Read automatically by Codex. Contains migration order, component summaries, install instructions for target dependencies, context doc locations.

### Human guide — HOW-TO-MIGRATE.md

Generated at: `rewrite/HOW-TO-MIGRATE.md`

Numbered steps — one per component — with context doc path, output file path, Claude Code command, Codex command, and the 3 most critical business rules per component.

---

## Analysis: What the LLM Extracts

For every discovered service or component, Sonnet extracts:

- **Purpose** — plain language, business intent not code mechanics
- **Data flow** — what comes in, what goes out, what transforms along the way
- **Business rules** — validation, masking, access control, conditional logic
- **Database interactions** — tables, query patterns, stored procedures
- **Downstream calls** — other services called, order of operations
- **Contract** — input/output shape at the SOAP or API boundary
- **Confidence** — `high | medium | low`

---

## Output Structure

### Service Scan (`/migrate scan`)

```
migration/
  context/
    OrderManager.md     ← per-service context doc
    FooService.md
  knowledge-base/
    _index.md           ← system map
  scan-report.md        ← scan summary
  migration-status.json ← checkpoint file
  .claude/
    commands/
      rewrite-OrderManager.md   ← Claude Code slash command
      rewrite-FooService.md
  AGENTS.md             ← Codex context file
```

### Rewrite Analysis (`/migrate rewrite`)

```
rewrite/
  context/
    OrderController.md  ← per-component context doc
    OrderService.md
    OrderRepository.md
  _index.md             ← migration knowledge base
  report.md             ← analysis summary
  HOW-TO-MIGRATE.md     ← numbered execution guide
  .claude/
    commands/
      rewrite-OrderController.md  ← Claude Code slash command
      rewrite-OrderService.md
  AGENTS.md             ← Codex context file
```

---

## LLM Strategy

| Tier   | Model               | Used For                                          | Why                                     |
| ------ | ------------------- | ------------------------------------------------- | --------------------------------------- |
| Tier 0 | No LLM              | Static scan — plugin extracts `ServiceReference[]` | Zero cost — regex |
| Tier 1 | `claude-haiku-4-5-20251001` | Resolve ambiguous repos, detect framework, discover components | Cheap, fast |
| Tier 2 | `claude-sonnet-4-6` | Service/component analysis, system overview | 200K context, strong code understanding |

Cost estimate is shown before any LLM call. Without `--yes`, the command exits after the estimate. This prevents accidental large token spend.

---

## Migration Status Tracking (`/migrate scan`)

`migration/migration-status.json`:

```json
{
  "scannedAt": "2026-04-22T10:00:00Z",
  "entryRepo": "https://github.com/org/repo",
  "targetLanguage": "csharp",
  "services": [
    {
      "name": "OrderService",
      "namespace": "OrderManager",
      "discoveredVia": "routes/api.ts:42",
      "sourceRepo": "myorg/BackendServices",
      "sourceFile": "Services/OrderManager.cs",
      "contextDoc": "migration/context/OrderManager.md",
      "status": "analyzed",
      "confidence": "high",
      "analyzedAt": "2026-04-22T10:05:00Z",
      "verified": false,
      "verifiedBy": null,
      "verifiedAt": null,
      "rewrittenAt": null,
      "databaseInteractions": ["table: Orders — SELECT"],
      "nestedServices": ["InventoryManager.GetStock"],
      "notes": ""
    }
  ]
}
```

Status lifecycle: `discovered` → `analyzed` → (verified) → `done`

---

## Files Implemented

```
src/
  commands/
    migrate.ts              ← entry point, all subcommand routing
  migration/
    types.ts                ← ServiceReference, MigratePlugin, ScanResult
    scanner.ts              ← runPluginScan(), groupByNamespace()
    pluginLoader.ts         ← three-tier plugin discovery, builtinPluginsDir()
    resolver.ts             ← namespace → GitHub repo resolution
    analyzer.ts             ← Sonnet analysis per service
    wsdlParser.ts           ← WSDL/XML parsing
    contextBuilder.ts       ← per-service markdown assembly
    indexBuilder.ts         ← _index.md assembly
    statusTracker.ts        ← migration-status.json CRUD
    costEstimator.ts        ← token estimate + cost preview
    tracer.ts               ← /migrate scan orchestrator
    rewriteTypes.ts         ← ComponentType, SourceComponent, FrameworkInfo, ComponentAnalysis
    frameworkMapper.ts      ← static source→target concept mapping tables
    rewriteAnalyzer.ts      ← detectFramework, discoverComponents, analyzeComponent
    rewriteContextBuilder.ts ← per-component and index markdown assembly
    rewriteTracer.ts        ← /migrate rewrite orchestrator
    aiIntegration.ts        ← Claude Code slash commands, AGENTS.md, HOW-TO-MIGRATE.md
    scanner.test.ts         ← 22 tests
    wsdlParser.test.ts      ← 6 tests
  connectors/
    github.ts               ← extended with fetchFileContent, fetchFileTree, parseRepoUrl

plugins/
  migrate-soap/
    index.ts                ← TypeScript source
    index.js                ← compiled ESM (committed)
    ccs-plugin.json         ← { name, version, entry }
```

---

## Open Questions (resolved)

- **Clone locally or stream via API?** → Stream via GitHub API. No local clone needed.
- **Feed migration KB into vault?** → Future enhancement, not MVP.
- **`/migrate status` as table or panel?** → Terminal table via the command output string.

---

_ccs-code · Migration Context Builder · v1.0 · 2026-04-22_
