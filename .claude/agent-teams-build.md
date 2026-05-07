# CCS Code — Agent Teams Build Plan
# Paste this entire file as your prompt in Claude Code with agent teams enabled.

## Prerequisites

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
# Requires Claude Code v2.1.32+
```

Then open this project in Claude Code and paste the prompt below.

---

## Orchestrator Prompt (paste this into Claude Code)

```
You are the lead agent for a CCS Code feature build.
The project is at the current working directory.

We are adding Graphify-style structural code understanding to the CCS Code vault pipeline.
There are three independent workstreams. Spawn an agent team with three teammates working in parallel.

---

## Team Structure

### Teammate A — Code Ingestor
Build `src/vault/codeIngester.ts`.

This file should:
1. Accept a `vaultPath: string` and `sourceDirs: string[]` as input
2. Call `buildCodeIntelligenceArtifact()` from `src/migration/codeIntelligence.ts`
   with the sourceDirs to get symbols + call edges
3. Convert each significant symbol (classes, functions with complexity > 2, exported functions)
   into a wiki page at `wiki/code/{slug}.md` with this frontmatter:
   ```yaml
   ---
   title: {symbolName}
   type: code
   kind: function|class|method
   file: {relativeFilePath}
   complexity: {number}
   params: {number}
   calls: [list of called symbol names]
   last_synced: {YYYY-MM-DD}
   staleness: fresh
   ---
   ```
4. Body should be: "Defined in `{file}` at line {lineStart}. {Calls X, Y, Z if any calls exist.}"
5. Export `ingestCode(vaultPath, sourceDirs)` returning `{ written: number, skipped: number, errors: string[] }`
6. Skip re-ingesting if the wiki page already exists and `last_synced` is today (idempotent)

Reference: `src/vault/ingestor.ts` for the existing wiki page format and frontmatter pattern.
Reference: `src/migration/codeIntelligence.ts` for the `buildCodeIntelligenceArtifact` signature.

---

### Teammate B — Structural Graph Edges
Extend `src/vault/graphBuilder.ts` to add call-graph edges.

This teammate MUST wait for Teammate A to confirm the frontmatter schema before finalising
the edge-reading logic. Communicate via the shared task list.

Changes needed:
1. In `buildGraphData(wikiDir)`, after reading all wiki pages, do a second pass:
   - For pages with `type: code`, read the `calls:` frontmatter field (YAML array)
   - For each called symbol name, find the matching node by title
   - If found, add an edge of type `call` between them
2. Add a new edge style for call edges — use `dashes: true` and `color: "#7c5cfc"` in vis.js
   so they're visually distinct from keyword-match edges (which stay solid)
3. In the HTML legend, add a "Call graph" entry showing the dashed purple line
4. The connection cap (max 12 per node) should apply to keyword edges only —
   call edges are always shown since they're structural truth

Reference: The existing edge-building section in `graphBuilder.ts` around line 200-280.

---

### Teammate C — SHA-256 Incremental Caching
Add file-hash caching to `/harvest` and `/graph` so only changed files are reprocessed.

Create `src/vault/cache.ts`:
```typescript
// Interface
export async function readCache(cacheFile: string): Promise<Record<string, string>>
export async function writeCache(cacheFile: string, cache: Record<string, string>): Promise<void>
export async function hashFile(filePath: string): Promise<string>  // SHA-256 hex
export async function getChangedFiles(
  filePaths: string[],
  cacheFile: string
): Promise<{ changed: string[]; unchanged: string[]; newCache: Record<string, string> }>
```

Cache file location: `{vaultPath}/.ccs-cache.json` (gitignore this file)
Hash algorithm: SHA-256 via Node's built-in `crypto` module (no new dependencies)
Cache format: `{ "relative/path/to/file.md": "sha256hex", ... }`

Then wire it into:
1. `src/vault/graphBuilder.ts` — at the top of `generateGraphHtml()`, check if any wiki
   page has changed since last graph build. If none changed, skip rebuild and return early
   with a "Graph up to date" message. Cache file: `{outputDir}/.graph-cache.json`
2. `src/services/miner.ts` — in the harvest loop, before writing a raw memory file,
   hash the source content and skip if the hash matches the cache. This prevents
   re-harvesting unchanged Cursor/VS Code sessions. Cache file: `{vaultPath}/.harvest-cache.json`

---

## Coordination Rules

1. Teammate A owns the wiki/code page schema. Teammates B and C must not modify `wiki/code/` pages.
2. Teammate B must read Teammate A's output format from the task list before writing
   the frontmatter parser in graphBuilder.ts.
3. Teammate C works fully independently — no dependencies on A or B.
4. The lead agent synthesizes after all three teammates complete:
   - Runs `bun run typecheck` (or `tsc --noEmit`) to verify no TypeScript errors
   - Reports any conflicts between teammates' changes
   - Creates a summary of all three changes in `CHANGES.md`

## Success Criteria

- `src/vault/codeIngester.ts` exists and exports `ingestCode()`
- `src/vault/cache.ts` exists and exports the four functions
- `src/vault/graphBuilder.ts` reads `calls:` frontmatter and renders dashed call edges
- `bun run typecheck` passes with no new errors
- No existing tests are broken
```

---

## What each phase delivers

| Phase | Teammate | File | What it unlocks |
|-------|----------|------|-----------------|
| Code ingestion | A | `src/vault/codeIngester.ts` | Code symbols become wiki pages — agents can `/ask` about functions |
| Structural edges | B | `src/vault/graphBuilder.ts` | Graph shows actual call relationships, not just keyword similarity |
| Incremental cache | C | `src/vault/cache.ts` | `/graph` and `/harvest` skip unchanged files — stays fast as wiki grows |

## Running after the build

Once all three phases are merged, wire Phase 1 into the `/ingest` command:

```typescript
// In src/commands/ingest.ts (or wherever /ingest is handled)
import { ingestCode } from "../vault/codeIngester.js";

// Add after existing ingestAll():
const sourceDirs = ["src"]; // or read from ccs.yaml
const codeResult = await ingestCode(vaultPath, sourceDirs);
console.log(`Code symbols: +${codeResult.written} pages`);
```
