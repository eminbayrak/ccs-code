# Migration Report Quality Standard

## Purpose

CCS Code reports are not normal status reports. They are migration contracts for humans and coding agents.

A good report should let an architect, product owner, Codex, Claude Code, or QA reviewer answer:

- What legacy capability is this?
- What behavior must be preserved?
- What target landing zone is recommended?
- Why is that target shape recommended?
- Which facts are proven by source evidence?
- Which facts came from business or architecture context?
- What is inferred or unknown?
- What should a coding agent build?
- What should a coding agent not build yet?
- How will the migrated behavior be validated?

If a report cannot answer those questions, it is not ready for implementation.

## Main Audiences

### Architect

Needs to know whether the recommended target role is sensible and aligned with the target architecture.

Useful content:

- Target landing zone.
- Integration boundary.
- Rationale.
- Rejected alternatives when there is ambiguity.
- Open architecture decisions.

### Product Or Domain Owner

Needs to know whether the business behavior is correctly understood.

Useful content:

- Plain-language purpose.
- Business rules.
- Inputs and outputs.
- Operational behavior.
- Human questions.

### Coding Agent

Needs precise implementation instructions with guardrails.

Useful content:

- Source files to read first.
- Ready or blocked status.
- Target pattern.
- Business rules with evidence.
- Data contracts.
- Dependencies and migration order.
- Validation scenarios.

### QA Or Validation Agent

Needs proof obligations.

Useful content:

- Acceptance criteria.
- Legacy-vs-target parity scenarios.
- Golden files or sample data needs.
- Risk areas.
- Unknowns that require manual checks.

## Required Sections

Every per-component report should include:

- Agent readiness summary.
- Business purpose.
- Target architecture disposition.
- Implementation gate.
- Business rules with evidence.
- Evidence ledger and source coverage.
- Input and output contracts.
- Internal dependencies.
- External packages and target package replacements.
- Migration notes.
- Risks and unknowns.
- Human questions.
- Validation scenarios.
- Source files.
- Rewrite instructions.
- Verification checklist.

Every repo-level report should include:

- System overview.
- Component inventory.
- Migration order.
- Readiness counts.
- Target disposition matrix.
- Human question summary.
- Failed or unanalyzed components.
- Low-confidence and high-complexity items.
- Discovery limits.
- Next steps for humans and agents.

## Agent Readiness Standard

A component is ready for Codex or Claude Code only when:

- The target landing zone is not `unknown` or `human_review`.
- Human questions are resolved or non-blocking.
- The purpose is business-oriented, not only code mechanics.
- Business rules are listed and either cited or clearly marked for review.
- Input and output contracts are present or explicitly marked unknown.
- The implementation boundary is clear.
- Validation scenarios exist.
- Source files are linked.

A component is blocked when:

- The target architecture role is unknown.
- The integration boundary is unknown.
- Human questions affect implementation shape.
- Source analysis failed or returned fake unknown values.
- Critical behavior has no evidence.
- The report only says what the code does mechanically without explaining business behavior.

## Quality Rubric

| Area | Good | Weak | Blocked |
|------|------|------|---------|
| Purpose | Explains business capability | Describes code mechanics | Unknown or generic |
| Target role | Clear landing zone with rationale | Plausible but thin rationale | Unknown or human review |
| Evidence | Facts tied to source lines or context docs | Some uncited facts | No evidence ledger |
| Business rules | Concrete and testable | Vague or incomplete | Missing |
| Data contracts | Inputs and outputs named | Partial contract | Unknown with no follow-up |
| Dependencies | Internal and external dependencies listed | Only package names | Missing |
| Risks | Specific migration risks | Generic warnings | No risks despite uncertainty |
| Human questions | Actionable decisions | Broad questions | Missing despite unknowns |
| Validation | Behavior parity scenarios | Unit-test-only ideas | No validation path |
| Agent instructions | Ready/blocked gate is obvious | Instructions require interpretation | Agent would need to guess |

## What Good Looks Like

Good report language:

```text
Purpose: Classifies inbound client files and creates downstream processing work.
Target role: azure_function
Rationale: The code is stateless after file classification and is triggered by inbound file arrival. The target baseline uses blob storage plus event messaging for ingestion.
Integration boundary: Blob-triggered function emits Service Bus message with client, file type, and validation status.
Business rule: Files without a known client alias are rejected before parsing.
Evidence: src/FileRouter.cs:42-56 observed high confidence.
Validation: Given an unknown client alias, target rejects the file and records the same status as legacy.
```

Weak report language:

```text
Purpose: Handles files.
Target role: microservice.
Business rules: unknown.
Validation: Add tests.
```

The weak version may look tidy, but it does not help a coding agent migrate safely.

## How To Review Current Output

When checking generated migrate output, ask these questions:

- Can I tell what this component means to the business?
- Can I tell where this should live in the target architecture?
- Can I tell why that target was selected?
- Are the business rules testable?
- Are important claims backed by source evidence or context documents?
- Are unknowns specific enough for a human to answer?
- Would Codex or Claude know exactly what file or component to implement?
- Would the agent know when to stop?
- Is there at least one validation scenario that proves behavior parity?

If the answer is mostly yes, the report is useful.

If the answer is mostly no, the report might still be useful for discovery, but it is not implementation-ready.

## Product Direction

CCS Code should optimize reports for agent usefulness, not report length.

The best report is concise, source-backed, decision-oriented, and explicit about blockers. A long report with vague summaries, missing evidence, and no target decision is less useful than a shorter report that clearly says what is known, what is unknown, and what can safely be built next.

