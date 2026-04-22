# Quality and Trust

### What Makes This Tool Trustworthy

_ccs-code · Principal Engineer Standards_

---

This document defines what "trustworthy" means for this tool and the specific requirements
that enforce it. A tool that does its job well 80% of the time and silently fails the other 20%
is worse than useless — developers will build wrong code from wrong context.

Every feature built in this tool must meet these standards.

---

## The Trust Problem

This tool makes claims. Developers act on those claims:

- "This service applies SSN masking" → developer preserves it in the rewrite
- "This service calls BarService" → developer includes BarService in scope
- "The input contract is `{ patientId: string }`" → developer builds the new endpoint to match

If any of these claims are wrong — due to hallucination, missed files, or incomplete scanning —
the rewrite will be wrong. In a healthcare system, a wrong rewrite could be a compliance failure.

Trust is not a nice-to-have. It is the entire point of the tool.

---

## The Six Trust Pillars

### 1. Accuracy — claims must be correct

**How we enforce it:**

- The LLM prompt explicitly instructs: "If uncertain, use `"unknown"` — do not guess"
- Every extracted fact includes a `confidence` level: `high | medium | low`
- `low` confidence fields are blocked from being presented as facts — they become flagged items
  requiring human verification before the context doc is considered usable
- JSON output from the LLM is validated against a strict schema — if it fails, the service
  is marked `needs-review`, not silently passed through with corrupt data
- No field is synthesized by combining information from unrelated files — the LLM only
  claims what it can directly see in the code provided to it

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
- Unresolved services are never silently dropped — they appear in the system index under
  "Unresolved (needs manual input)" with the namespace that was found
- If a file could not be fetched (permission error, deleted, too large), it is logged in the
  scan report — not skipped without record
- The system index `_index.md` shows a completeness percentage: `9/12 services fully analyzed`

**The rule:** the developer must be able to look at the scan report and know
with certainty whether the tool saw everything. No ambiguity about what was covered.

---

### 3. Transparency — every claim is traceable

**How we enforce it:**

- Every fact in a context document links to the exact source file and line range on GitHub
  using line anchors: `github.com/org/repo/file.cs#L42-L78`
- The context doc header shows which files were used to produce it — the developer can
  open each one and verify the tool's interpretation
- The system index shows exactly where each service was discovered: `routes/foo.js:14`
- No claim appears without a source reference. If the source cannot be identified,
  the claim is marked as unverified

**Why line numbers matter:** A developer who sees "SSN masking applied" and wants to verify it
should be able to click one link and see the exact 3 lines of code that do the masking.
Without line anchors, the link is a navigation hint. With line anchors, it is a proof.

---

### 4. Honesty about gaps

**How we enforce it:**

- The tool never pretends to have analyzed something it did not analyze
- If a service was found but not resolvable to a repo, it is listed as a gap — not omitted
- If the LLM returned low confidence on a service, the context doc prominently shows this —
  it does not get quietly published as if it were authoritative
- The verification checklist at the bottom of every context doc forces the developer to
  explicitly sign off before the status advances — the tool does not auto-advance to `in-progress`
- The scan report always includes: "If you believe something is missing, these are the
  likely causes: [list of common resolution failures]"

---

### 5. Resilience — failures do not lose work

**How we enforce it:**

- The tracer writes a checkpoint to `migration-status.json` after analyzing every single service
- If the scan crashes, timeouts, or hits a rate limit midway, the next run resumes from
  the last checkpoint — it does not start over
- Rate limits are handled explicitly: read `Retry-After` or `X-RateLimit-Reset` headers,
  wait the specified time, then continue — never fail with a 403 and stop
- All file fetch failures are caught and logged — they do not crash the scan
- The tool can be safely interrupted and resumed at any point

---

### 6. Cost predictability — no surprise token bills

**How we enforce it:**

- Before any LLM call, estimate the token count of all files to be analyzed
- Show the user a cost preview: estimated Haiku tokens + Sonnet tokens + approximate cost
- Only proceed after explicit user confirmation (`y/n`)
- After the scan, log actual tokens used vs. estimated — so the user can calibrate future runs
- Token counts per service are stored in `migration-status.json` for auditability

---

## Things That Are Out of Scope (and must stay that way)

**The tool must never:**

- Generate rewritten code — it prepares context, not output
- Auto-commit or auto-push anything
- Modify the repos it is scanning
- Store credentials anywhere except the user's local config files
- Make network requests to anything other than GitHub API and the configured LLM provider

These boundaries are what make the tool safe to use in a corporate environment.
A tool that only reads and writes locally is easy to audit, easy to approve, and easy to trust.

---

## Testing Requirements

A tool that claims to be accurate must be testable. Every core module needs tests.

| Module | Test type | What to test |
|--------|-----------|-------------|
| `scanner.ts` | Unit | Given known code samples, extracts correct `serviceNamespace` and `methodName` |
| `wsdlParser.ts` | Unit | Given known WSDL strings, extracts correct operation names and schemas |
| `resolver.ts` | Integration (mocked GitHub) | Resolves known namespaces to correct repos |
| `analyzer.ts` | Integration (mocked LLM) | Correctly parses LLM JSON output; handles parse failures gracefully |
| `contextBuilder.ts` | Unit | Given known analysis, produces correctly formatted markdown |
| `statusTracker.ts` | Unit | Read/write/resume logic works correctly |
| `tracer.ts` | Integration | Loop detection works; partial failure resumes correctly |

The scanner tests are the most critical — they are the foundation of everything.
Write them first, before writing the scanner itself.

---

## Architectural Decisions (Resolved)

### 1. Multi-file services — send all files at once
When a service spans multiple files (interface + implementation + helpers), send all of them
to the LLM in a single call. More accurate analysis justifies the extra tokens.
The analyzer bundles all files belonging to one service namespace before calling Sonnet.

### 2. Database interactions — leaf node for now, plugin later
When the scanner finds a stored procedure call or raw SQL, treat it as a **leaf node**.
Document the call (procedure name, table name) in the context doc but do not attempt to
fetch the procedure definition or schema.

Database analysis is a **future plugin** — not core. Two plugin options to build later:
- **GitHub DB plugin** — searches the org for database migration scripts/schema repos and analyzes them
- **Direct DB plugin** — connects to a live database to fetch schema and stored procedure definitions

Neither is needed for MVP. The context doc notes the database interaction clearly enough
for a developer to investigate manually.

### 3. Verification workflow — built into the tool
The tool tracks verification as a first-class status. A context doc is not considered
ready for rewriting until a human has marked it verified.

Built-in command:
```
/migrate verify <ServiceName>
```
This prompts the developer to confirm the checklist items and records:
```json
{
  "verified": true,
  "verifiedBy": "dev name or initials",
  "verifiedAt": "ISO timestamp"
}
```
Status only advances `analyzed → in-progress` after `verified: true`.
This is non-negotiable — it is what separates a trustworthy tool from an overconfident one.

### 4. Re-analysis — idempotency now, `/sync` later (Principal Engineer decision)
**Day one:** Basic idempotency — skip services whose context doc already exists.
Use `/migrate rescan <ServiceName>` to force re-analysis of a single service.

**Near-term enhancement (not MVP):** A `/sync` command that uses git SHA comparison
to detect which source files changed since the last scan and re-analyzes only affected services.

Reasoning: idempotency is needed immediately — without it the tool is unusable on large repos.
Full diff-based sync is convenient but not blocking. Ship the important thing first.

---

## Remaining Enhancements (Post-MVP)

These are valid features that do not block the first usable version:

| Enhancement | What it adds |
|-------------|-------------|
| DB plugin (GitHub) | Finds and analyzes schema/migration scripts from org repos |
| DB plugin (Direct) | Connects to live database for schema and stored proc definitions |
| `/sync` command | Diff-based re-analysis — only re-scans changed services |
| Multi-pattern scanner | Support non-SOAP patterns (gRPC stubs, REST clients, etc.) via additional plugins |
| Output format options | Export context docs as JSON or structured prompt format in addition to markdown |

---

_ccs-code · Quality and Trust Standards · 2026-04-22_
