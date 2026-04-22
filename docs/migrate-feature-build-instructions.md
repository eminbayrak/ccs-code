# Build Instructions: `/migrate` Feature

This document captures everything needed to implement the `/migrate` command from scratch.
Written so any developer or AI coding tool can read it cold and start building immediately.

---

## What We Are Building

A `/migrate` command that:

1. Accepts a single repo URL — any legacy codebase, any language
2. Automatically scans the codebase to find all external service references
3. Searches the GitHub org to resolve those services to their own repos — no user input
4. Recursively traces the full call chain: entry layer → service layer → data layer
5. Uses an LLM to deeply understand the business logic at every layer
6. Outputs a structured knowledge base and per-service migration context documents
7. Those context documents are pasted directly into Claude Code, Copilot, or Codex to drive the rewrite

**The app does not rewrite code. It prepares the context that makes AI rewrites accurate.**

This is a general-purpose migration intelligence platform. The first concrete implementation
targets a Node.js + SOAP → REST migration pattern. Future plugins extend it to any pattern.

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

**Important:** The default model in `src/llm/providers/anthropic.ts` is `claude-3-5-sonnet-20241022`.
Update the default to `claude-sonnet-4-6` before building this feature — it has a 200K context window
which is needed for large files.

For two-tier usage (Haiku + Sonnet), instantiate providers directly:
```ts
import { AnthropicProvider } from '../llm/providers/anthropic.js'
const haiku  = new AnthropicProvider('claude-haiku-4-5-20251001')
const sonnet = new AnthropicProvider('claude-sonnet-4-6')
```

### Enricher Pattern (`src/vault/enricher.ts`) — mirror this

The established pattern for batched LLM analysis:
- Walk items → build queue → process in parallel batches → write results
- `onProgress` callback for UI feedback
- Skip already-processed items (idempotent)
- Extract JSON from LLM response with regex fallback: `response.match(/\{[\s\S]*\}/)?.[0]`
- Explicitly handle the case where the model returns `"unknown"` — do not treat it as a value

### GitHub Connector (`src/connectors/github.ts`) — extend, do not rewrite

Already has:
- `ghHeaders(token?)` — builds GitHub API v3 headers, reads from `CCS_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GITHUB_PRIVATE_TOKEN`
- `ghFetch<T>(path, token?)` — authenticated fetch against `https://api.github.com`
- `github.search_code` tool — searches code across all repos in the org
- `github.summarize_org_repos` tool — lists all repos in an org

**Add to this file:**
```ts
// Fetch a single file's raw content (base64 decoded)
async function fetchFileContent(owner: string, repo: string, path: string, token?: string): Promise<string>

// Fetch full recursive file tree — returns array of file paths
async function fetchFileTree(owner: string, repo: string, token?: string): Promise<string[]>

// Support configurable base URL for GitHub Enterprise
// Default: https://api.github.com
// Enterprise: https://{host}/api/v3
function buildApiBase(host?: string): string
```

**Rate limiting** — the GitHub API enforces rate limits (5000 req/hr authenticated, lower for search).
Add exponential backoff with jitter to all `ghFetch` calls. On 429 or 403, read the
`Retry-After` or `X-RateLimit-Reset` header and wait before retrying. Never fail silently on rate limits.

### Command Dispatch (`src/components/App.tsx`) — two places to update

When the plugin system is in place, two things in `App.tsx` need to dynamically include plugin commands:

**1. The `SLASH_COMMANDS` array (line 80)** — used for autocomplete suggestions.
Currently hardcoded. Must be extended at boot time with commands registered by loaded plugins:
```ts
// After plugins load, merge their commands into SLASH_COMMANDS
const pluginSuggestions = loadedPlugins.flatMap(p =>
  (p.commands ?? []).map(c => ({
    id: c.name,
    label: `/${c.name}`,
    description: c.description,
  }))
)
const SLASH_COMMANDS = [...BUILT_IN_COMMANDS, ...pluginSuggestions]
```

**2. The `executeSlashCommand` switch statement (line 371)** — the command router.
Currently ends with `default: unknown command`. Must check plugin commands before that default:
```ts
// Add before the default: case
default: {
  const plugin = loadedPluginCommands.find(c => c.name === id)
  if (plugin) {
    setMessages(prev => [...prev, createUIMessage('assistant', `Running /${id}...`)])
    plugin.handler(args, process.cwd()).then(output => {
      setMessages(prev => [...prev, createUIMessage('assistant', output)])
    })
    break
  }
  setMessages(prev => [...prev, createUIMessage('assistant', `Unknown command: /${id}`)])
  break
}
```

### Config (`ccsconfig.json` + `.ccs/config.json`)

`ccsconfig.json` at project root holds the vault path.
`.ccs/config.json` holds LLM provider config — extend this shape:
```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "github": {
    "host": "github.com",
    "org": "your-org"
  }
}
```

Token stays in env vars — never in any config file.

---

## The Node.js + SOAP Pattern (First Implementation)

This is the first concrete migration pattern the scanner targets.
Other patterns will follow as separate plugins.

Every SOAP call in the target Node.js codebase follows this structure:

```js
const config = {
  methodName: 'someMethod',          // SOAP operation name
  serviceNamespace: 'FooManager',    // ← key: identifies which SOAP service repo to find
  actionName: 'someMethod',
  isXmlResponse: true,
  parameters: [
    { isSecurityContext: true },
    { isSomeCriteria: true, value: req.body },
  ],
}
const response = await constructSoapRequest(config, req.session)
```

**Fields to extract per call site:**

| Field | Purpose |
|-------|---------|
| `serviceNamespace` | Used to find the SOAP service repo on GitHub |
| `methodName` | The specific operation called |
| `parameters` | Input shape — flags and value sources |
| `isXmlResponse` | Whether response is raw XML |

The scanner finds every call to `constructSoapRequest` across all files and extracts these fields.
Each unique `serviceNamespace` becomes one node in the dependency graph.

---

## Recursive Tracing

The codebase is a directed graph. Each service is a node; each outbound call is an edge.

```
Entry repo
  └─► constructSoapRequest({ serviceNamespace: 'FooManager', methodName: 'getItems' })
        └─► FooManager.getItems()
              ├─► SQL: SELECT * FROM items WHERE ...
              └─► BarService.logAccess()
                    └─► SQL: INSERT INTO audit_log ...
```

**Traversal algorithm:**

```
function trace(repoUrl, visited = new Set()):
  if repoUrl in visited: return        // loop detection
  visited.add(repoUrl)

  files = fetchFileTree(repoUrl)
  refs  = staticScan(files)            // Tier 0 — no LLM

  for each ref in refs:
    serviceRepo = resolve(ref.namespace)    // Tier 1 — Haiku if ambiguous
    if not found: flag in scan report, skip

    code     = fetchServiceImplementation(serviceRepo, ref)
    analysis = analyzeWithLLM(code, ref)   // Tier 2 — Sonnet

    nested = extractOutboundCalls(code)    // Tier 0 — static
    for each n in nested:
      trace(n.repoUrl, visited)            // recurse
```

**Leaf nodes — stop recursing when you hit these:**
- SQL query strings — document the table/query, do not recurse
- Stored procedure calls — document the procedure name, do not recurse
- File system operations
- External HTTP calls
- Any service already in `visited`

Database interactions are documented in the context doc but not analyzed further.
Database analysis (schema fetching, stored procedure definitions) is a future plugin.
See `quality-and-trust.md` for the full decision rationale.

**Resolving a `serviceNamespace` to a repo:**
1. Search GitHub org: `FooManager filename:.cs` or `FooManager filename:.asmx`
2. Check naming patterns: `FooManager.cs`, `FooManagerService.cs`, `IFooManager.cs`, `FooManager.asmx`
3. Single match → use it. Multiple → Haiku ranks by relevance. None → flag as unresolved.

---

## LLM Usage

### Tier 0 — No LLM (static scan)

Find `constructSoapRequest` calls and extract field values using string matching + regex.
The pattern is consistent enough — no AST parser needed for the MVP.

### Tier 1 — Haiku

Used only when resolution is ambiguous: multiple repo matches for a namespace, or grouping related files.
Keep prompts under 500 tokens. Give it names and short snippets, never full files.
Always parse JSON from response. Handle parse failure gracefully.

### Tier 2 — Sonnet (`claude-sonnet-4-6`)

**System prompt:**
```
You are a code analyst helping document a legacy system for migration.
Extract business logic clearly and accurately.
If you are uncertain about any field, use exactly the string "unknown" — do not guess.
Respond only with valid JSON matching the schema provided.
```

**User prompt structure:**
```
Analyze this service implementation for migration documentation.

Caller file: {callerFile}
Service namespace: {namespace}
Method: {methodName}

Caller code (Node.js):
{callerCode — trimmed to the relevant method, max 1500 tokens}

Service implementation:
{serviceCode — trimmed to the relevant method, max 2000 tokens}

Respond ONLY with this JSON:
{
  "purpose": "one sentence — business intent, not code mechanics",
  "dataFlow": "what comes in → what transforms → what goes out",
  "businessRules": ["rule 1", "rule 2"],
  "databaseInteractions": ["table: foo — SELECT", "proc: sp_GetFoo"],
  "nestedServiceCalls": ["BarService.method"],
  "inputContract": { "fieldName": "type" },
  "outputContract": { "fieldName": "type" },
  "confidence": "high | medium | low"
}
```

**Hallucination prevention rules — enforce these in every prompt:**
- Any field the model cannot determine from the code must be `"unknown"` — not a guess
- All `"unknown"` and `"low"` confidence fields are flagged in the context doc for human review
- Validate JSON output — if parse fails, mark the service as `needs-review`, do not silently skip

**Multi-file services:** when a service spans multiple files (interface + implementation + helpers),
bundle all files for that namespace into a single Sonnet call. Do not analyze each file separately
and merge — a single call produces more accurate cross-file understanding.
Concatenate files with clear separators:
```
=== FILE: FooManager.cs ===
{content}

=== FILE: IFooManager.cs ===
{content}

=== FILE: FooManagerHelpers.cs ===
{content}
```

**Token budget per service:** target under 6000 input tokens for multi-file bundles.
If the combined files exceed this, prioritize: implementation file first, then interface, then helpers.
Trim each file to its relevant method range using static scan results before bundling.

---

## Trustworthiness Requirements

This tool makes claims that developers act on. Every claim must be verifiable.

### Source Attribution
Every piece of extracted information links back to its source:
- GitHub file links use line anchors: `github.com/org/repo/file.js#L42-L78`
- The context doc notes: `Derived from: FooManager.cs:112-156`
- No claim appears in a context doc without a source reference

### Confidence Scoring
The LLM returns a `confidence` field per analysis: `high | medium | low`.
- `high` — published as-is
- `medium` — published with a note: `(AI-extracted — verify before rewriting)`
- `low` — published with a warning block and added to the human review checklist

### Human Verification Step
Every context doc includes a verification checklist at the bottom:

```markdown
## Before You Rewrite — Verify These

- [ ] The business rules above are complete and accurate
- [ ] The data flow diagram matches what the code actually does
- [ ] All SOAP operations called are listed
- [ ] Database tables and stored procedures are correct
- [ ] No downstream services are missing from the dependency list

Reviewed by: _______________  Date: _______________
```

The status tracker has a separate `verified` boolean. Status only advances to `in-progress`
after the human marks it verified.

### Scan Completeness Report
After every scan, write `migration/scan-report.md`:

```
Total files scanned:     142
SOAP call sites found:    31
Unique services found:    12
  Fully resolved:          9
  Partially resolved:      2  (flagged below)
  Unresolved:              1  (manual input needed)

Unresolved services:
  - BarManager — searched org, no match found. Possible locations: [list]

Partial resolutions:
  - BazService — found 3 candidate repos, ranked by Haiku. Review: [list]

Estimated token cost:  ~$X (Haiku) + ~$Y (Sonnet)
```

### Cost Preview Before Running
Before any LLM call, estimate and show the cost:
```
Found 12 services to analyze.
Estimated: ~23,000 tokens (Haiku) + ~180,000 tokens (Sonnet)
Approximate cost: $0.12

Continue? [y/n]
```
Only proceed on confirmation. This prevents accidental large token spend.

### Resume on Failure
The tracer writes progress to `migration/migration-status.json` after every service is analyzed.
If the scan fails midway (rate limit, network error, timeout), the next run skips already-analyzed
services. Never start over from scratch. Always resume from the last checkpoint.

### Idempotency
Running `/migrate scan` twice on the same repo produces the same output.
Use the file's git SHA (from the GitHub API) as a cache key — re-analyze only if the SHA changed.

---

## Output

### Per-Service Context Document (`migration/context/{ServiceName}.md`)

```markdown
# Migration Context: {ServiceName}

**Discovered via:** {callerFile}:{lineNumber} → constructSoapRequest
**Service namespace:** {namespace}
**Source repo:** {githubRepoUrl}
**Target language:** {targetLanguage}
**Analyzed:** {date}
**Confidence:** {high|medium|low}
**Status:** todo

---

## What This Service Does

{LLM-generated purpose — one paragraph, plain language}

> Source: [{serviceFile}]({githubUrl}#L{start}-L{end})

---

## Full Call Chain

```
Client → {httpMethod} /{endpoint}
  → {callerFile}:{line}
    → constructSoapRequest({ serviceNamespace: '{namespace}' })
      → {namespace}.{methodName}()
        → {SQL or nested service calls}
```

---

## Business Rules

{each rule links to the source line where it was found}

- Rule 1 — source: [{file}]({url}#L{line})
- Rule 2 — source: [{file}]({url}#L{line})

---

## Data Contract

**Input:** `{inputContract}`
**Output:** `{outputContract}`

---

## Database Interactions

- `{table}` — {query type} — source: [{file}]({url}#L{line})
- `{storedProc}` — source: [{file}]({url}#L{line})

---

## Source Files

| File | Purpose | Lines |
|------|---------|-------|
| [{file}]({url}) | {description} | {start}–{end} |

---

## Rewrite Instructions

You are rewriting {ServiceName} as a {targetLanguage} REST API.

**Read these files before writing any code:**
1. [{file}]({githubUrl}) — {purpose}
2. [{file}]({githubUrl}) — {purpose}

**Produce:**
- `{OutputFile1}` — {purpose}
- `{OutputFile2}` — {purpose}

**Preserve these business rules exactly — they are non-negotiable:**
{repeated rule list}

**Architecture:**
- No legacy service calls — connect to the data layer directly
- {targetLanguage} conventions: {specifics}
- All business rules above must be preserved exactly as written

---

## Before You Rewrite — Verify These

- [ ] Business rules are complete and accurate
- [ ] Data flow diagram matches the code
- [ ] All service calls are listed
- [ ] Database interactions are correct
- [ ] No dependencies are missing

Reviewed by: _______________  Date: _______________
```

### System Index (`migration/knowledge-base/_index.md`)

The full system map — read this first before opening any service context doc.

```markdown
# Migration Knowledge Base

_Scanned: {date} | Entry: {repoUrl} | Target: {language} | Confidence: {overall %}_

---

## System Overview

{LLM-generated 2–3 sentence description of the whole system}

---

## Service Map

| Service | Discovered Via | Calls | DB Tables | Confidence | Status |
|---------|---------------|-------|-----------|------------|--------|
| FooService | routes/foo.js:14 | BarService | foo_items | high | todo |
| BarService | FooService:88 | — | audit_log | medium | todo |

---

## Shared Dependencies (rewrite these first)

{services called by 2+ other services — rewriting shared services first unblocks everything}

---

## Unresolved (needs manual input)

{service namespaces found in code but not matched to a repo}

---

## Low Confidence (needs human review)

{services where AI confidence was low — verify before rewriting}
```

---

## Files to Create

```
src/
  commands/
    migrate.ts              — entry point, subcommand routing
                              subcommands: scan, status, context <name>, verify <name>, rescan <name>
                              exports: handleMigrateCommand(args, cwd): Promise<string>

  migration/
    scanner.ts              — Tier 0: static scan, find service references, extract fields
                              input: file paths + contents
                              output: ServiceReference[]

    resolver.ts             — find the GitHub repo for a given service name
                              uses github.search_code + Haiku for ambiguous matches
                              output: { repoUrl, filePath } | null

    tracer.ts               — recursive graph traversal, loop detection, progress checkpoint
                              orchestrates scanner → resolver → analyzer
                              writes to migration-status.json after each node
                              output: ServiceGraph

    analyzer.ts             — Tier 2: Sonnet analysis per service
                              follows enricher.ts pattern exactly
                              validates JSON output, flags parse failures
                              output: ServiceAnalysis (with confidence field)

    wsdlParser.ts           — parses WSDL/XML when found in service repo
                              extracts: operation names, input/output schemas
                              plain string parsing — no heavy XML library needed
                              output: WsdlOperation[]

    contextBuilder.ts       — assembles per-service markdown context doc
                              pure function: ServiceAnalysis → markdown string
                              injects source line anchors into all links

    indexBuilder.ts         — assembles _index.md
                              one LLM call for system overview paragraph
                              rest is deterministic from ServiceAnalysis[]

    statusTracker.ts        — reads/writes migration-status.json
                              methods: load(), save(), upsertService(), getProgress()
                              tracks: status, confidence, verified, analyzedAt, gitSha

    costEstimator.ts        — estimates token count + cost before any LLM call
                              input: list of files to analyze
                              output: { haikuTokens, sonnetTokens, estimatedCost }

  connectors/
    github.ts               — EXTEND existing file
                              add: fetchFileContent, fetchFileTree
                              add: configurable Enterprise host support
                              add: exponential backoff with Retry-After header support
```

---

## Implementation Order

Build in this sequence — each step unblocks the next:

1. Update `AnthropicProvider` default model to `claude-sonnet-4-6`
2. Extend `src/connectors/github.ts` — add `fetchFileContent`, `fetchFileTree`, Enterprise host, retry logic
3. `src/migration/scanner.ts` — static scan, no dependencies, easy to unit test first
4. `src/migration/wsdlParser.ts` — standalone, no dependencies
5. `src/migration/statusTracker.ts` — standalone file I/O
6. `src/migration/resolver.ts` — depends on github connector
7. `src/migration/costEstimator.ts` — depends on scanner output
8. `src/migration/analyzer.ts` — depends on LLM provider + enricher pattern
9. `src/migration/contextBuilder.ts` — pure function, string assembly
10. `src/migration/indexBuilder.ts` — depends on analyzer output
11. `src/migration/tracer.ts` — orchestrates 3–10, adds resume logic
12. `src/commands/migrate.ts` — wires tracer + status + output, adds cost preview prompt
13. Plugin system — wrap migrate command in the plugin contract
14. `src/components/App.tsx` — update `SLASH_COMMANDS` and `executeSlashCommand` to load plugin commands dynamically

---

## Environment Variables

| Variable | Purpose | Read by |
|----------|---------|---------|
| `CCS_ANTHROPIC_API_KEY` | Anthropic API key | `anthropic.ts` |
| `CCS_GITHUB_TOKEN` | GitHub PAT | `github.ts` (also accepts `GITHUB_TOKEN`, `GITHUB_PRIVATE_TOKEN`) |

No new env vars needed — existing infrastructure handles both.

---

## Plugin Contract (wraps the migrate command)

The `/migrate` feature ships as a plugin under `.ccs/plugins/migrate/`.
It must export a `CCSPlugin` object:

```ts
import type { CCSPlugin } from '../../capabilities/types.js'
import { handleMigrateCommand } from './migration/command.js'

const plugin: CCSPlugin = {
  name: 'migrate',
  version: '0.1.0',
  commands: [{
    name: 'migrate',
    description: 'Scan a legacy codebase and generate AI rewrite context',
    handler: handleMigrateCommand,
  }],
  connectors: [],
}

export default plugin
```

See `docs/plugin-architecture.md` for the full plugin system design.

---

## What This Unlocks Beyond the First Use Case

The scanner pattern is general. A different plugin can target different codebases:

| Pattern | Plugin scans for | Resolves to |
|---------|-----------------|-------------|
| Node.js + SOAP | `constructSoapRequest` calls | SOAP service repos |
| Python + gRPC | `stub.MethodName()` calls | `.proto` definitions |
| Java + REST clients | `RestTemplate.getForObject` | OpenAPI specs |
| Any → Any | User-defined patterns | User-defined repos |

Each is a separate plugin. The core infrastructure (tracer, resolver, analyzer, GitHub connector,
LLM providers) is shared. Only the scanner changes per migration pattern.

---

_ccs-code · /migrate build instructions · v2 · 2026-04-22_
