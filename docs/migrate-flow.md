# /migrate — How It Works

## Overview

`/migrate` has two independent pipelines:

1. **`/migrate scan`** — traces external SOAP service dependencies in a Node.js repo and builds a per-service knowledge base
2. **`/migrate rewrite`** — analyzes a full codebase for framework-to-framework migration (e.g., .NET → Python) and builds a per-component migration knowledge base

Both pipelines produce the same class of output: structured markdown context documents, plus Claude Code slash commands and a Codex `AGENTS.md` that wire the KB directly into AI coding tools. The tool never writes code — it prepares the context that makes AI rewrites accurate and complete.

---

## Pipeline 1 — `/migrate scan`

### Run the scan

```
/migrate scan --repo https://github.com/myorg/NodeBackend --lang csharp --yes
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--repo` / `-r` | GitHub URL of the entry repo to scan |
| `--lang` / `-l` | Target rewrite language (`csharp`, `typescript`, `java`, `python`, `go`) |
| `--org` / `-o` | GitHub org to search for service repos (default: inferred from repo URL) |
| `--plugin` / `-p` | Plugin name to use for scanning (default: first installed) |
| `--yes` / `-y` | Skip cost confirmation and proceed immediately |

Without `--yes`, the scan shows the cost estimate and exits. Re-run with `--yes` to proceed.

**Pre-flight validation** runs before anything else — checks `CCS_ANTHROPIC_API_KEY` and the GitHub token. If either is missing, the command prints a clear error with the exact env var to set and exits immediately.

---

### Step 1 — Static scan (Tier 0 — free)

The tracer fetches the repo's full file tree from GitHub and runs the loaded scanner plugin locally against every file matching the plugin's declared extensions. No LLM is called.

The `migrate-soap` plugin reads each file with regex and extracts every service call it recognises:

```ts
constructSoapRequest({
  serviceNamespace: "OrderManager",  // → identifies the external service
  methodName: "GetOrder",            // → the operation being called
  isXmlResponse: true,               // → captured as metadata
})
```

Each match becomes a `ServiceReference`. All references are grouped by `serviceNamespace` — each unique namespace is one external service to investigate.

---

### Step 2 — Resolve each namespace (Tier 1 — Haiku)

For each discovered namespace (e.g. `"OrderManager"`), the resolver searches the GitHub org to find the actual source repo and file.

**Strategy 1 — filename search:** Searches for `OrderManager.cs`, `OrderManagerService.cs`, `IOrderManager.cs`, `OrderManager.asmx`, etc.

**Strategy 2 — string search fallback:** If no filename match is found, searches the org for the string `"OrderManager"` in code.

When multiple candidates are found, Haiku ranks them. Result:

```json
{
  "repoFullName": "myorg/BackendServices",
  "filePath": "Services/OrderManager.cs",
  "confidence": "exact"
}
```

Services that cannot be resolved are flagged as unresolved and listed in the scan report for manual input.

---

### Step 3 — Analyze each service (Tier 2 — Sonnet 4.6)

For each resolved service, the tracer:

1. Fetches up to 5 relevant source files from the service repo
2. Fetches any `.wsdl` / `.xsd` files and parses them (regex-based, no external library)
3. Bundles everything into one Sonnet prompt with clear file separators

Sonnet returns structured JSON:

```json
{
  "purpose": "Retrieves order details including line items and fulfillment status",
  "dataFlow": "caller passes orderId → service queries OrdersDB → returns hydrated Order object",
  "businessRules": ["Orders older than 7 years are archived and require elevated access"],
  "databaseInteractions": ["table: Orders — SELECT", "proc: sp_GetOrderWithItems — called with orderId"],
  "nestedServiceCalls": ["InventoryManager.GetStock"],
  "inputContract": { "orderId": "string" },
  "outputContract": { "orderId": "string", "status": "string", "total": "decimal" },
  "confidence": "high"
}
```

**Confidence levels:** `high` — full flow understood | `medium` — some parts unclear, verify first | `low` — manual review required

---

### Step 4 — Recursive graph traversal

If Sonnet finds that `OrderManager` internally calls `InventoryManager`, the tracer adds `InventoryManager` to the queue and processes it the same way — resolve → analyze → recurse.

Loop detection (a `visited` set) prevents infinite cycles. The tracer follows the full dependency graph until it reaches leaf nodes.

---

### Step 5 — Checkpoint after every service

After each service is analyzed, the result is written to `migration-status.json` immediately. If the scan crashes, re-running it skips already-analyzed services and resumes.

---

### Step 6 — Output files

**Per-service context document** — `migration/context/<ServiceName>.md`

One file per discovered service. Contains: purpose, full data flow, business rules, data contract, database interactions, nested service calls, source file links with GitHub line anchors, rewrite instructions.

**System knowledge base index** — `migration/knowledge-base/_index.md`

- System overview (LLM-generated, plain language)
- Service map table — all services with status, confidence, DB tables, nested calls
- Shared dependencies — services called by 2+ others (rewrite these first)
- Unresolved services — namespaces the resolver couldn't find
- Low-confidence warnings

**Scan report** — `migration/scan-report.md`

Summary of files scanned, call sites found, services analyzed, errors, unresolved services, and next steps.

---

### Step 7 — AI tool wiring (automatic)

After the scan completes, the tool automatically generates:

**Claude Code slash commands** — `.claude/commands/rewrite-<ServiceName>.md`

One file per service. Contains the full context doc embedded. Developers type `/project:rewrite-OrderManager` in Claude Code and the AI has full context immediately.

**Codex context file** — `AGENTS.md`

Read automatically by Codex. Contains rewrite order, service summaries, context doc locations, and how to invoke each.

No manual copy-paste needed — the KB is wired to the AI tool the moment the scan finishes.

---

## Pipeline 2 — `/migrate rewrite`

### Run the analysis

```
/migrate rewrite --repo https://github.com/myorg/DotNetBackend --to python --from aspnet-core --yes
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--repo` / `-r` | GitHub URL of the full codebase to analyze |
| `--to` / `-t` | Target language/framework (`python`, `typescript`, `java`, `go`) |
| `--from` / `-f` | Source framework hint (optional — auto-detected if omitted) |
| `--yes` / `-y` | Skip cost confirmation and proceed immediately |

**Pre-flight validation** runs first — same as `/migrate scan`.

---

### Step 1 — Fetch file tree

Full recursive file tree is fetched from GitHub. No LLM at this stage.

---

### Step 2 — Detect source framework (Haiku)

Key project files are fetched (`.csproj`, `pom.xml`, `package.json`, `Program.cs`, `Startup.cs`, `appsettings.json`, etc.) and sent to Haiku, which identifies:

- Source framework (e.g., `ASP.NET Core`)
- Source language (`C#`)
- Target framework (e.g., `FastAPI`)
- Target language (`Python`)

If `--from` is provided, the framework detection result is overridden with the user-supplied value.

---

### Step 3 — Discover components (Haiku)

The file tree plus framework info is sent to Haiku, which returns a list of `SourceComponent` objects:

```json
[
  { "name": "OrderController", "type": "controller", "filePaths": ["Controllers/OrderController.cs"] },
  { "name": "OrderService",    "type": "service",    "filePaths": ["Services/OrderService.cs"] },
  { "name": "OrderRepository", "type": "repository", "filePaths": ["Repositories/OrderRepository.cs"] }
]
```

Component types: `controller`, `service`, `repository`, `model`, `dto`, `middleware`, `config`, `utility`.

Test files are filtered out — they are discovered but excluded from analysis.

---

### Step 4 — Analyze each component (Sonnet 4.6)

For each component, source files are fetched and sent to Sonnet with the framework mapping context (e.g., `ControllerBase` → `APIRouter`, `DbContext` → `SQLAlchemy Session`). Sonnet returns:

```json
{
  "purpose": "Handles HTTP endpoints for order management",
  "businessRules": ["Orders require authorization before retrieval"],
  "targetDependencies": ["fastapi", "pydantic"],
  "dependencies": ["OrderService"],
  "complexity": "medium",
  "confidence": "high"
}
```

A context document is written to `rewrite/context/<ComponentName>.md` after each component — checkpoint behaviour, same as the scan pipeline.

---

### Step 5 — Topological sort (dependency-ordered migration)

After all components are analyzed, they are sorted so leaf nodes (models, repositories) come before their callers (services, controllers). This is the order developers must follow — you cannot rewrite `OrderController` before `OrderService` and `OrderRepository` exist.

---

### Step 6 — Output files

**Per-component context document** — `rewrite/context/<ComponentName>.md`

Each file contains: purpose, business rules, source file links, framework mapping table (what each source concept maps to in the target framework), target dependencies, migration checklist, confidence level.

**System knowledge base index** — `rewrite/_index.md`

- LLM-generated plain-language system overview
- Migration order table (topological sort)
- All components with complexity and confidence
- Unanalyzed components (with errors)
- Required target dependencies

**Rewrite analysis report** — `rewrite/report.md`

Summary of files in repo, components discovered, components analyzed, failures, and next steps.

---

### Step 7 — AI tool wiring (automatic)

**Claude Code slash commands** — `rewrite/.claude/commands/rewrite-<ComponentName>.md`

One per component. Embeds the full context doc so developers type `/project:rewrite-OrderController` and Claude Code has everything it needs.

**Codex context file** — `rewrite/AGENTS.md`

Full migration order, component summaries, install instructions for target dependencies, context doc locations.

**Step-by-step execution guide** — `rewrite/HOW-TO-MIGRATE.md`

Human-readable numbered guide: each step is one component, with its context doc path, output file path, Claude Code command, Codex command, and the 3 most critical business rules.

---

## Subcommand Reference

| Subcommand | Description |
|-----------|-------------|
| `scan` | Trace SOAP service dependencies in a Node.js repo |
| `rewrite` | Analyze a full codebase for framework-to-framework migration |
| `status` | Show migration progress table |
| `context <Name>` | Print the context doc for a specific service |
| `verify <Name> --by <initials>` | Human sign-off on a service context doc |
| `done <Name>` | Mark a verified service as fully rewritten |
| `rescan <Name>` | Force re-analysis of a specific service |
| `plugin list` | List all installed scanner plugins and where they were found |

---

## Plugin system

The scanner logic lives in plugins, not in the core app. The core provides the intelligence framework (resolver, analyzer, tracer, context builder) — plugins define how to find service references in a specific codebase pattern.

**Search order for plugins:**
1. `.ccs/plugins/` in the current project directory
2. `~/.ccs/plugins/` globally
3. `plugins/` built into the tool binary (or repo root in dev mode)

Each plugin directory needs:
- `ccs-plugin.json` — manifest with `name`, `version`, `entry`
- `index.js` — compiled plugin entry (default-exported `MigratePlugin` object)

The built-in `migrate-soap` plugin is configurable:

```ts
import { createPlugin } from "plugins/migrate-soap/index.js";

// Use a different function name in your codebase
const plugin = createPlugin({ callerFunctionName: "callExternalService" });
```

---

## LLM cost breakdown

| Stage | Model | When used |
|-------|-------|-----------|
| Static scan | None | Tier 0 — always free |
| Framework detection | Haiku | Once per `/migrate rewrite` run |
| Component discovery | Haiku | Once per `/migrate rewrite` run |
| Namespace ranking | Haiku | `/migrate scan` — only when multiple repo candidates found |
| Service / component analysis | Sonnet 4.6 | Once per unique service or component |
| System overview | Sonnet 4.6 | Once per scan or rewrite run |

A cost estimate is shown before any LLM calls. Without `--yes`, the command exits after the estimate. With `--yes`, it proceeds immediately.
