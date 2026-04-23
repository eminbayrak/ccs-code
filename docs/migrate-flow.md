# /migrate — How It Works

## Overview

`/migrate` scans a legacy codebase on GitHub, traces all external service dependencies recursively, and generates per-service markdown context documents. Those documents are pasted into Claude Code, Copilot, or Codex to drive the actual code rewrite. The tool never writes code — it builds the knowledge base that makes an AI rewrite trustworthy.

---

## Step 1 — Run the scan

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

Without `--yes`, the scan stops after the cost estimate and asks you to re-run with `--yes` to confirm.

---

## Step 2 — Static scan (Tier 0 — free)

The tracer fetches the repo's full file tree from GitHub and runs the scanner plugin locally against every file matching the plugin's declared extensions. No LLM is called at this stage.

The plugin (e.g. `migrate-soap`) reads each file with regex and extracts every service call it recognises:

```ts
constructSoapRequest({
  serviceNamespace: "OrderManager",  // → identifies the external service
  methodName: "GetOrder",            // → the operation being called
  isXmlResponse: true,               // → captured as metadata
})
```

Each match becomes a `ServiceReference`. All references are grouped by `serviceNamespace` — each unique namespace is one external service to investigate.

---

## Step 3 — Resolve each namespace (Tier 1 — Haiku)

For each discovered namespace (e.g. `"OrderManager"`), the resolver searches the GitHub org to find the actual source repo and file.

**Strategy 1 — filename search:**
Searches for `OrderManager.cs`, `OrderManagerService.cs`, `IOrderManager.cs`, `OrderManager.asmx`, etc.

**Strategy 2 — string search fallback:**
If no filename match is found, searches the org for the string `"OrderManager"` in code.

When multiple candidates are found, Haiku ranks them (shortest, cheapest model — just a ranking call). Result:

```json
{
  "repoFullName": "myorg/BackendServices",
  "filePath": "Services/OrderManager.cs",
  "confidence": "exact"
}
```

Services that cannot be resolved are flagged as unresolved and listed in the scan report for manual input.

---

## Step 4 — Analyze each service (Tier 2 — Sonnet 4.6)

For each resolved service, the tracer:

1. Fetches up to 5 relevant source files from the service repo
2. Fetches any `.wsdl` / `.xsd` files and parses them (regex-based, no external library)
3. Bundles everything into one large Sonnet prompt with clear file separators:

```
=== FILE: Services/OrderManager.cs ===
<file content>

=== FILE: Models/Order.cs ===
<file content>

WSDL Contract:
Operation: GetOrder
  Input: orderId (string), includeItems (boolean, optional)
  Output: orderId (string), status (string), total (decimal)
```

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

**Confidence levels:**
- `high` — full flow understood
- `medium` — some parts unclear; verify before rewriting
- `low` — code too complex or incomplete; manual review required

---

## Step 5 — Recursive graph traversal

If Sonnet finds that `OrderManager` internally calls `InventoryManager`, the tracer adds `InventoryManager` to the queue and processes it the same way — resolve → analyze → recurse.

Loop detection (a `visited` set) prevents infinite cycles. The tracer follows the full dependency graph until it reaches leaf nodes (services with no further nested calls).

---

## Step 6 — Checkpoint after every service

After each service is analyzed, the result is written to `migration-status.json` immediately. If the scan crashes or times out halfway through, re-running it skips already-analyzed services and picks up where it left off.

---

## Step 7 — Output files

### Per-service context document
`migration/context/<ServiceName>.md`

```markdown
# Migration Context: OrderManager

**Discovered via:** api.ts:42
**Confidence:** high

## What This Service Does
Retrieves order details including line items and fulfillment status.

## Full Data Flow
caller passes orderId → service queries OrdersDB → returns hydrated Order object

## Business Rules
- Orders older than 7 years require elevated access to retrieve

## Data Contract
Input:  { orderId: string }
Output: { orderId: string, status: string, total: decimal }

## Database Interactions
- `table: Orders — SELECT`
- `proc: sp_GetOrderWithItems — called with orderId`

## Nested Service Calls
- InventoryManager.GetStock

## Rewrite Instructions
You are rewriting OrderManager as a C# REST API.
Read all source files above before writing any code.
Preserve all business rules exactly — they are non-negotiable.
```

### System knowledge base index
`migration/knowledge-base/_index.md`

- **System overview** — plain-language description of what the backend does (LLM-generated)
- **Service map table** — all services with status, confidence, DB tables, and nested calls
- **Shared dependencies** — services called by 2+ others (rewrite these first to unblock everything else)
- **Unresolved services** — namespaces the resolver couldn't find (require manual repo URL input)
- **Low-confidence warnings** — services that need manual review before rewriting

### Scan report
`migration/scan-report.md` — summary of files scanned, call sites found, services analyzed, errors, and next steps.

---

## Step 8 — Developer workflow after the scan

```
/migrate status
```
Shows the full progress table — every service, its status, confidence level, and verification state.

```
/migrate context OrderManager
```
Prints the context doc for a specific service to the chat.

```
/migrate verify OrderManager --by john
```
Human signs off on the context doc accuracy. A service cannot be marked done without verification. Low-confidence services display a warning but can still be verified.

```
/migrate done OrderManager
```
Marks a verified service as fully rewritten. Requires verification first — throws an error otherwise.

```
/migrate rescan OrderManager
```
Instructions to delete a context doc and force re-analysis on the next scan run.

```
/migrate plugin list
```
Lists all installed scanner plugins and where they were found.

---

## Plugin system

The scanner logic lives in plugins, not in the core app. The core provides the intelligence framework (resolver, analyzer, tracer, context builder) — plugins define how to find service references in a specific codebase pattern.

**Search order for plugins:**
1. `.ccs/plugins/` in the current project directory
2. `~/.ccs/plugins/` globally
3. `plugins/` built into the tool (built-in plugins)

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
| Namespace ranking | Haiku | Only when multiple repo candidates found |
| Service analysis | Sonnet 4.6 | Once per unique service namespace |
| System overview | Sonnet 4.6 | Once per scan (index builder) |

A cost estimate is shown before any LLM calls. Use `--yes` to confirm and proceed.
