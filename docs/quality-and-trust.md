# Quality and Trust

### What Makes This Tool Trustworthy

_ccs-code · Principal Engineer Standards_

---

This document defines what "trustworthy" means for this tool and the specific requirements that enforce it. A tool that does its job well 80% of the time and silently fails the other 20% is worse than useless — developers will build wrong code from wrong context.

Every feature built in this tool must meet these standards.

---

## The Trust Problem

This tool makes claims. Developers act on those claims:

- "This service applies SSN masking" → developer preserves it in the rewrite
- "This service calls BarService" → developer includes BarService in scope
- "The input contract is `{ patientId: string }`" → developer builds the new endpoint to match

If any of these claims are wrong — due to hallucination, missed files, or incomplete scanning — the rewrite will be wrong. In a healthcare system, a wrong rewrite could be a compliance failure.

Trust is not a nice-to-have. It is the entire point of the tool.

---

## The Six Trust Pillars

### 1. Accuracy — claims must be correct

**How we enforce it:**

- The LLM prompt explicitly instructs: "If uncertain, use `"unknown"` — do not guess"
- Every extracted fact includes a `confidence` level: `high | medium | low`
- Extracted facts are classified as `observed`, `inferred`, or `unknown`
- `low` confidence fields are flagged in the context doc for human review — not presented as facts
- JSON output from the LLM is validated — if parse fails, the service is marked `needs-review`, not silently passed through
- No field is synthesized by combining information from unrelated files — the LLM only claims what it can directly see in the code provided

**What this looks like in the output:**

```markdown
**Input contract:** `{ patientId: string, facilityCode: string }`
> Source: FooService.cs:42 (confidence: high)

**Business rule:** Status transition discharged → active is blocked
> Source: FooService.cs:87 (confidence: high)

⚠️ **Unverified:** Return value shape unclear from implementation — review manually
> Source: FooService.cs:112 (confidence: low)
```

---

### 2. Completeness — nothing is silently skipped

**How we enforce it:**

- After every scan, a `scan-report.md` is written listing:
  - Total files scanned
  - Total service references found
  - How many were resolved, partially resolved, or unresolved
  - Exactly which services were not resolved and why
- Unresolved services are never silently dropped — they appear in the system index under "Unresolved (needs manual input)"
- If a file could not be fetched (permission error, deleted, too large), it is logged — not skipped without record
- The system index shows a completeness count: `9/12 services fully analyzed`

---

### 3. Transparency — every claim is traceable

**How we enforce it:**

- Every fact in a context document links to the exact source file and line range on GitHub using line anchors: `github.com/org/repo/file.cs#L42-L78`
- Context docs include an evidence ledger with basis, confidence, source file, line range, and statement
- Context docs include source coverage so truncated files are visible instead of hidden
- The context doc header shows which files were used to produce it
- The system index shows exactly where each service was discovered: `routes/foo.js:14`
- Any claim without a source reference is explicitly marked as uncited and must be manually verified

---

### 4. Honesty about gaps

**How we enforce it:**

- The tool never pretends to have analyzed something it did not analyze
- If source was truncated before model analysis, the context doc records exactly how many lines were visible
- System indexes call out runtime wiring gaps such as DI registrations, reflection, generated code, config-driven handlers, and production-only settings
- If a service was found but not resolvable to a repo, it is listed as a gap — not omitted
- Low-confidence services show a prominent warning in their context doc — not published as authoritative
- The `verify` command requires explicit human sign-off before status advances
- The `done` command requires `verified: true` first — throws an error otherwise
- Low-confidence services can still be verified (the warning is advisory, not a block) — the human reviewer decides, not the tool

---

### 5. Resilience — failures do not lose work

**How we enforce it:**

- The tracer writes a checkpoint to `migration-status.json` after analyzing every single service
- If the scan crashes, timeouts, or hits a rate limit midway, the next run resumes from the last checkpoint — it does not start over
- All file fetch failures are caught and logged — they do not crash the scan
- The tool can be safely interrupted and resumed at any point
- `status.load()` is null-checked explicitly — a missing status file produces a clear error, not a runtime crash

**Note on interactive confirmation:** The tool does not use interactive prompts (`readline`) for cost confirmation because Ink controls `process.stdin` and the two conflict (deadlock). Instead, cost is shown without `--yes` (command exits after preview), and with `--yes` it proceeds automatically. This is more reliable than interactive confirmation and works in all terminal environments.

---

### 6. Cost predictability — no surprise token bills

**How we enforce it:**

- Before any LLM call, `estimateScanCost()` estimates token count of all files to be analyzed
- `formatCostPreview()` displays: estimated Haiku tokens + Sonnet tokens + approximate cost
- Without `--yes`: command shows the estimate and exits — no LLM calls made
- With `--yes`: command proceeds immediately
- This prevents accidental large token spend on large repos

---

## Pre-flight Validation

Before any LLM call or network request, `validateSetup(requireGithub)` checks:

1. `CCS_ANTHROPIC_API_KEY` — must be set and non-empty (severity: `error`)
2. GitHub token (`CCS_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `GITHUB_PRIVATE_TOKEN`) — must be set if scanning a private repo (severity: `warning` for public, `error` for private)

Returns `SetupIssue[]` with severity and actionable message. If any `error` severity issue is found, the command exits before doing anything else. The developer sees a clear message like:

```
✗ Missing CCS_ANTHROPIC_API_KEY — set this environment variable to your Anthropic API key
```

This prevents 10+ minutes of waiting only to fail at the first LLM call.

---

## Vault Fallback

`getMigrationDir()` no longer throws if no vault is configured. It falls back to `~/.ccs/migration`. This means `/migrate scan` works immediately in a fresh environment without requiring the user to set up a vault first.

---

## Things That Are Out of Scope (and must stay that way)

**The tool must never:**

- Generate rewritten code — it prepares context, not output
- Auto-commit or auto-push anything
- Modify the repos it is scanning
- Store credentials anywhere except environment variables or the user's local config files
- Make network requests to anything other than GitHub API and the configured LLM provider

These boundaries are what make the tool safe to use in a corporate environment.

---

## Testing Requirements

A tool that claims to be accurate must be testable. Current test coverage:

| Module | Tests | Status |
|--------|-------|--------|
| `scanner.ts` | 22 tests in `scanner.test.ts` | ✅ Passing |
| `wsdlParser.ts` | 6 tests in `wsdlParser.test.ts` | ✅ Passing |
| `resolver.ts` | Integration (mocked GitHub) | Pending |
| `analyzer.ts` | Integration (mocked LLM) | Pending |
| `contextBuilder.ts` | Unit | Pending |
| `statusTracker.ts` | Unit | Pending |
| `tracer.ts` | Integration | Pending |

**Total: 28 tests passing.** All run with `bun test`.

### Scanner tests cover

- Single call site extraction
- Multiple call sites in one file
- Metadata extraction (`isXmlResponse`, parameter flags)
- Configurable function name (`callerFunctionName`)
- Configurable field names (`namespaceField`, `methodField`)
- Nested parentheses handled correctly
- Missing `serviceNamespace` → call site skipped (no false positives)
- `runPluginScan`: extension filtering, `filesWithRefs` counter
- `groupByNamespace`: correct grouping by namespace key

### WSDL parser tests cover

- Service name extraction
- Target namespace extraction
- Operation name extraction
- Input/output message extraction
- Empty WSDL input
- Malformed input (no crash)

---

## Architectural Decisions (Resolved)

### 1. Multi-file services — send all files at once
When a service spans multiple files (interface + implementation + helpers), send all of them to the LLM in a single call. More accurate analysis justifies the extra tokens.

### 2. Database interactions — leaf node for now, plugin later
When the scanner finds a stored procedure call or raw SQL, treat it as a leaf node. Document the call in the context doc but do not attempt to fetch the procedure definition or schema. Database analysis is a future plugin.

### 3. Verification workflow — built into the tool
`/migrate verify <Name> --by <initials>` records `verified: true`, `verifiedBy`, `verifiedAt`. Status only advances to `done` after `verified: true`. The `done` command enforces this — throws if not verified. Low-confidence services display an advisory warning but can still be verified if the reviewer is satisfied.

### 4. Re-analysis — idempotency now, `/sync` later
**Current:** Basic idempotency — skip services whose status is already `analyzed`. Use `/migrate rescan <Name>` to force re-analysis of a single service.

**Near-term:** A `/sync` command that uses git SHA comparison to detect changed source files and re-analyzes only affected services.

### 5. Interactive prompts — replaced by `--yes` flag
`readline.createInterface` on `process.stdin` conflicts with Ink's terminal control and causes deadlocks. All interactive confirmation is replaced by the `--yes` flag pattern. This is more reliable and works in CI/automated environments.

### 6. Plugin architecture — scanner plugins only (for now)
The migrate feature uses a scanner plugin system (not a full command plugin system). The plugin interface (`MigratePlugin`) is narrow and stable. Full command plugins (adding new slash commands to the app) remain a future capability. See `docs/plugin-architecture.md`.

---

## Remaining Enhancements (Post-MVP)

| Enhancement | What it adds |
|-------------|-------------|
| DB plugin (GitHub) | Finds and analyzes schema/migration scripts from org repos |
| DB plugin (Direct) | Connects to live database for schema and stored proc definitions |
| `/sync` command | Diff-based re-analysis — only re-scans changed services |
| Full command plugin system | External plugins that add slash commands to the app |
| Token audit | Log actual tokens used vs. estimated after each scan |

---

_ccs-code · Quality and Trust Standards · 2026-04-22_
