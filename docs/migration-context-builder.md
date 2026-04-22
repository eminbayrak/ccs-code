# Migration Context Builder

### Feature Design Document

_ccs-code · Internal Developer Tool_

---

|          |                          |
| -------- | ------------------------ |
| Status   | Draft                    |
| Version  | 0.4                      |
| Author   | Emin BAYRAK              |
| Audience | Engineering Team         |

---

## Vision

This is a **general-purpose migration intelligence platform**. Any development team
doing any kind of legacy-to-modern rewrite can use this tool. The first implementation
targets a specific Node.js + SOAP → REST pattern, but the architecture is designed so
that each new migration pattern is a plugin — not a rewrite of the tool.

**Two core value propositions:**

1. **Migration Intelligence** — point at any legacy repo, get a full recursive understanding
   of what the system does, expressed as AI-ready context documents that drive accurate rewrites
2. **KB Builder** — point at any codebase, get a structured knowledge base back —
   useful for onboarding, documentation, architecture audits, not just migration

Both use the same infrastructure. The plugin determines what patterns to scan for and
how to interpret what it finds.

---

## Background — First Implementation

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

## The Solution: Recursive System Intelligence

The app accepts **any repo URL as a starting point** — Node.js or SOAP — and automatically traces every connection in the system until it has the complete picture. It then builds a knowledge base and generates migration instructions ready for AI coding tools.

**The user provides one URL. The app discovers everything else.**

---

## Two Entry Points, Same Outcome

### Entry Point A — Node.js Repo

```
/migrate scan --repo <nodejs-repo-url> --lang <target>
```

The app scans the Node.js codebase and finds SOAP calls using the `constructSoapRequest` pattern:

```js
const config = {
  methodName: 'someMethod',
  serviceNamespace: 'SomeServiceManager',
  actionName: 'someMethod',
  isXmlResponse: true,
  parameters: [
    { isSecurityContext: true },
    { isSomeSearchCriteria: true, value: req.body },
  ],
};
const response = await constructSoapRequest(config, req.session);
```

From this, the app extracts:
- **`serviceNamespace`** — identifies which SOAP service to find (`SomeServiceManager`)
- **`methodName`** — the specific operation being called (`someMethod`)
- **`parameters`** — what data flows in

It then **automatically searches the GitHub org** for a repo/class matching `SomeServiceManager`, opens it, and recursively traces what that service does.

### Entry Point B — SOAP Service Repo

```
/migrate scan --repo <soap-repo-url> --lang <target>
```

The app scans the SOAP codebase directly. For each service and method found:
- What does this method do?
- Does it call another service? → find it, trace recursively
- Does it run a database query? → extract the query and schema
- Does it call a stored procedure? → find and read it

**Both entry points produce the same output** — a complete knowledge base with migration instructions per service.

---

## How `constructSoapRequest` Is Parsed

The scanner looks for this pattern across all Node.js files:

```js
// Pattern 1 — inline config object
const response = await constructSoapRequest({
  methodName: '...',
  serviceNamespace: '...',
  ...
}, req.session);

// Pattern 2 — config variable
const config = {
  methodName: '...',
  serviceNamespace: '...',
  ...
};
const response = await constructSoapRequest(config, req.session);
```

Extracted fields per call site:
- `serviceNamespace` → used to find the SOAP service repo on GitHub
- `methodName` → the specific operation to analyze
- `parameters` → input shape passed to the service
- `actionName`, `isXmlResponse`, etc. → metadata for context doc

Each unique `serviceNamespace` becomes one node in the dependency graph.

---

## Recursive Tracing

The app treats the codebase as a graph. Each service is a node; each call to another service, database, or external resource is an edge.

```
Node.js route handler
  └─► constructSoapRequest({ serviceNamespace: 'FooManager', methodName: 'getItems' })
        └─► FooManager.getItems()
              ├─► SQL: SELECT * FROM items WHERE ...
              └─► AnotherService.logAccess()
                    └─► SQL: INSERT INTO audit_log ...
```

**Traversal rules:**
1. Parse entry repo — extract all outbound `serviceNamespace` references
2. For each namespace — search GitHub org for the matching service class/file
3. Open that service — extract its outbound calls (other services, SQL, stored procs)
4. Recurse — repeat until no more unresolved references
5. Loop detection — if a service was already visited, skip it
6. Stop at leaf nodes — SQL queries, stored procedures, file I/O, external HTTP

### Resolving a `serviceNamespace` to a Repo

When the scanner finds `serviceNamespace: 'FooManager'`, it resolves it by:
1. Searching the GitHub org for files/classes named `FooManager`
2. Checking common naming patterns (`FooManager.cs`, `FooManager.asmx`, `FooManagerService.cs`)
3. If multiple matches — Haiku ranks by relevance
4. If no match — flagged in scan report for manual input

---

## Analysis: What the LLM Extracts Per Service

For every discovered service method, Sonnet extracts:

- **Purpose** — plain language, business intent not code mechanics
- **Data flow** — what comes in, what goes out, what transforms along the way
- **Business rules** — validation, masking, access control, conditional logic
- **Database interactions** — tables, query patterns, stored procedures
- **Downstream calls** — other services called, order of operations
- **Contract** — input/output shape at the SOAP or API boundary

---

## Output

### Per-Service Context Document

`migration/context/FooService.md` — paste directly into Claude Code / Copilot / Codex:

```markdown
# Migration Context: FooService

**Entry point:** [repo]/routes/fooRoutes.js → constructSoapRequest
**Service namespace:** FooManager
**Target language:** C# .NET 8
**Status:** todo

## What This Service Does
[LLM-generated plain language description]

## Full Call Chain
```
Client → POST /foo
  → Node.js: fooRoutes.js → constructSoapRequest({ serviceNamespace: 'FooManager' })
    → FooManager.addFoo()
      → SQL: INSERT INTO foo_table ...
      → AuditService.log()
        → SQL: INSERT INTO audit_log ...
```

## Business Rules
- [extracted rule 1]
- [extracted rule 2]

## Source Files
| File | Purpose |
|------|---------|
| [fooRoutes.js](<github-link>) | Node.js route handler |
| [FooManager.cs](<github-link>) | SOAP service implementation |

## SOAP Operation: addFoo
- **Input:** `{ ... }`
- **Output:** `{ ... }`

## Rewrite Instructions
You are rewriting FooService as a C# .NET 8 REST API.
Read all source files listed above before writing any code.

Produce:
- `Controllers/FooController.cs`
- `Services/FooService.cs`
- `Models/FooModel.cs`

Rules:
- No SOAP — call the database directly
- Preserve all business rules above exactly
- .NET 8: dependency injection, async/await, ILogger
```

### System Index

`migration/knowledge-base/_index.md` — full system map for any AI tool to read first:

```markdown
# System Knowledge Base

## Service Map
| Service | Node.js Entry | Calls | DB Tables | Status |
|---------|--------------|-------|-----------|--------|
| FooService | routes/fooRoutes.js | AuditService | foo_table | todo |
| AuditService | (shared) | — | audit_log | todo |

## Shared Components
- AuditService — called by every other service, rewrite this first

## Database Tables
- foo_table, audit_log, ...
```

### Scan Report

`migration/scan-report.md` — what was discovered, what was skipped, unresolved references needing manual input.

---

## LLM Strategy

| Tier   | Model               | Used For                                          | Why                                     |
| ------ | ------------------- | ------------------------------------------------- | --------------------------------------- |
| Tier 0 | No LLM              | Static scan — find `constructSoapRequest` calls, extract fields | Zero cost — regex + AST |
| Tier 1 | `claude-haiku-4-5`  | Resolve ambiguous repo matches, group services    | Cheap, fast, no deep reasoning needed   |
| Tier 2 | `claude-sonnet-4-6` | Business logic extraction, context doc generation | 200K context, strong code understanding |

Opus available as future upgrade when budget allows.

**Token efficiency:**
- Static scan pre-filters all noise — LLM only sees relevant files
- Haiku resolves references cheaply before Sonnet does expensive analysis
- Idempotent — reruns skip already-analyzed services
- Shared services analyzed once, referenced across all dependent docs

---

## GitHub Integration

- Personal Access Token (PAT) stored in `.ccs/config.json`
- GitHub REST API v3 — works with GitHub Enterprise Server and github.com
- Operations: file tree walk, file content fetch, cross-repo text search
- Handles pagination for large repos

Config:
```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "github": {
    "token": "ghp_...",
    "host": "github.company.com",
    "org": "your-org"
  }
}
```

---

## Migration Status Tracking

`migration/migration-status.json`:

```json
{
  "scannedAt": "2026-04-22T10:00:00Z",
  "entryRepo": "https://github.com/org/repo",
  "targetLanguage": "csharp",
  "services": [
    {
      "name": "FooService",
      "discoveredVia": "routes/fooRoutes.js → constructSoapRequest",
      "namespace": "FooManager",
      "contextDoc": "migration/context/FooService.md",
      "status": "analyzed",
      "analyzedAt": "2026-04-22T10:05:00Z",
      "rewrittenAt": null
    }
  ]
}
```

Status: `discovered` → `analyzed` → `in-progress` → `done`

---

## Files to Create

```
src/
  commands/
    migrate.ts              — entry point, subcommand routing
  connectors/
    github.ts               — GitHub API client: file tree, content, search
  migration/
    scanner.ts              — static scan: find constructSoapRequest calls, extract fields
    resolver.ts             — resolve serviceNamespace to a GitHub repo
    tracer.ts               — recursive graph traversal, loop detection
    analyzer.ts             — Sonnet: extract business logic per service
    wsdlParser.ts           — parse WSDL/XML schemas
    contextBuilder.ts       — assemble per-service context doc
    indexBuilder.ts         — assemble _index.md system map
    statusTracker.ts        — read/write migration-status.json
```

---

## Open Questions

- Should repos be cloned locally for speed or always streamed via API?
- Should the migration knowledge base feed into the ccs vault so `/enrich` can link it to related chat memory?
- Should `/migrate status` render as a terminal table or a UI panel?

---

_ccs-code · Migration Context Builder · v0.4_
