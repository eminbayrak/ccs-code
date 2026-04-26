# Agentic Modernization Architecture

## Purpose

CCS Code should evolve from a repository scanner into an agentic modernization planner.

The current migration flow is useful because it scans source code, identifies components, extracts business rules, and writes migration context. The next step is to make those outputs part of a decision system that can reason about the legacy application, the business goal, the approved target platform, and the safest modernization path.

The goal is not to ask an AI agent to simply rewrite old code into a new language. The goal is to create an evidence-backed plan that answers:

- What business capability does this legacy system provide?
- Which behavior must be preserved?
- Which legacy implementation details should be retired?
- Which target architecture pattern fits each component?
- Which decisions are proven by evidence, inferred from patterns, or still blocked?
- What should implementation agents build next?

## Guiding Principle

Modernization should be capability-led, not file-led.

A VB6 module, Node controller, Java service, stored procedure, shell script, or mainframe job should not automatically become the same shape in the target stack. CCS Code should first understand the responsibility and then choose a target landing zone such as Azure Functions, Container Apps, AKS, Databricks, Camunda, API Management, Service Bus, Storage, or a shared library.

## Architecture Baseline Documents

Architecture diagrams, modernization flows, platform standards, and analysis-team recommendations are decision inputs, not passive attachments.

For an MCDS-style modernization, the target architecture flow may already identify approved system boundaries such as:

- Client SFTP and gateway ingestion.
- WORM or blob storage for received files and precomposed outputs.
- Onboarding and rules engine capabilities.
- Orchestration for preprocessing, batch work, quick print, and delivery flows.
- ETL/ELT processing with Databricks or Fabric.
- Event streams through Event Hubs or Service Bus.
- Address correction and external validation APIs.
- Composition through Quadient or another composition platform.
- Archival through Blob Storage, Azure Functions, and communications APIs.
- Delivery orchestration through Logic Apps, Data Factory, APIs, or workflow tooling.
- Reporting, member preference APIs, portal integrations, print output, and downstream delivery adapters.

The architecture agents should use these documents to decide where scanned legacy behavior belongs in the target platform. For example, a legacy file validation module may map to Azure Functions plus Blob Storage and Service Bus if the baseline flow shows event-driven ingestion, while a long-running batch orchestration module may map to Camunda, Logic Apps, or Data Factory depending on state, timing, and human approval requirements.

The agents should not blindly copy a diagram. They should treat it as approved context, then check whether the source code evidence fits the target flow. If the diagram and code disagree, the result should be an architecture question, not a made-up implementation task.

## Agent Roles

### 1. Intake And Context Agent

Collects the modernization brief before repo analysis starts.

Responsibilities:

- Capture business goals, constraints, target platforms, and known decisions.
- Accept architecture diagrams, process notes, schemas, file layouts, and sample data.
- Separate approved facts from assumptions.
- Identify missing context before expensive analysis begins.

Primary output:

- Modernization brief.
- Target architecture profile.
- Initial open questions.

### 2. Repository System Design Agent

Builds a system view from the source repository.

Responsibilities:

- Identify entry points, services, workers, jobs, routes, and scheduled tasks.
- Build dependency and call-flow maps.
- Detect runtime wiring, configuration, external packages, and infrastructure assumptions.
- Group files into business capabilities instead of only technical folders.

Primary output:

- System graph.
- Component inventory.
- Runtime topology.
- Evidence ledger.

### 3. Legacy Behavior Agent

Explains what the legacy system actually does.

Responsibilities:

- Extract business rules and operational behavior.
- Identify input and output contracts.
- Find status transitions, retries, error handling, audit behavior, and completion rules.
- Mark each claim as observed, inferred, provided by context, or unknown.

Primary output:

- Business capability map.
- Business rules with evidence.
- Data contracts.
- Behavior risks.

### 4. Business Context Agent

Connects source behavior to business goals.

Responsibilities:

- Compare code evidence against user-provided business context.
- Find behavior that matters to the business but is not obvious from code.
- Identify legacy behavior that may be accidental, obsolete, or policy-driven.
- Prepare human questions for product owners, architects, and operations teams.

Primary output:

- Business alignment notes.
- Resolved and unresolved business decisions.
- Human review queue.

### 5. Architecture Baseline Agent

Normalizes company-approved architecture documents into decision-ready context.

Responsibilities:

- Read target-state diagrams, modernization flows, platform standards, and architecture decision records.
- Extract approved target domains, service boundaries, integration points, and constraints.
- Mark each architecture recommendation as approved, inferred, or still needing confirmation.
- Preserve references back to the source document that influenced each decision.

Primary output:

- Architecture baseline.
- Approved landing zones.
- Integration boundaries.
- Open architecture decisions.

### 6. Target Architecture Decision Agent

Uses source evidence plus company-approved architecture context to choose landing zones.

Responsibilities:

- Read normalized target architecture baselines from diagrams and platform standards.
- Map legacy capabilities into approved target domains.
- Compare candidate services when a legacy component could land in more than one place.
- Explain when a diagram recommendation fits the code and when it needs architect review.
- Avoid one-for-one rewrites when a better cloud-native pattern exists.

Primary output:

- Target service recommendation matrix.
- Decision rationale.
- Confidence and risk score.
- Required human approvals.

Example decision:

```text
Legacy capability: VB6 inbound file validator
Observed behavior: watches for files, validates layout, writes status rows, emits downstream work
Architecture baseline: event-driven ingestion through storage plus queue/event boundary
Recommended target: Azure Function plus Blob Storage and Service Bus
Why: event-triggered, stateless validation, clear downstream queue boundary
Not recommended: AKS service
Why not: long-running container hosting is unnecessary unless validation depends on local state or custom runtime services
Blocked until: confirm retry ownership and poison-message policy
```

### 7. Risk And Validation Agent

Turns modernization decisions into proof obligations.

Responsibilities:

- Generate validation scenarios for behavior parity.
- Identify high-risk flows, missing samples, and untestable assumptions.
- Recommend golden-file tests, contract tests, integration tests, and legacy-output comparisons.
- Block implementation when critical evidence is missing.

Primary output:

- Validation matrix.
- Test data needs.
- Risk register.
- Readiness gates.

### 8. Migration Contract Agent

Consolidates findings into a machine-readable contract.

Responsibilities:

- Merge system graph, business behavior, architecture decisions, and validation needs.
- Preserve traceability from recommendation back to evidence.
- Separate ready components from blocked components.
- Produce agent-ready implementation instructions.

Primary output:

- Migration contract JSON.
- Per-component migration context docs.
- Implementation gates.
- Agent handoff pack.

### 9. Implementation Handoff Agent

Prepares downstream coding agents.

Responsibilities:

- Convert migration contract sections into implementation tasks.
- Write Codex and Claude Code instructions.
- Provide file-level source references and acceptance criteria.
- Keep blocked decisions out of coding tasks.

Primary output:

- Implementation task plan.
- Agent instructions.
- Acceptance criteria.
- Test plan.

## Orchestration Flow

```text
User migration request
        |
        v
Intake And Context Agent
        |
        v
Repository System Design Agent
        |
        v
Legacy Behavior Agent <---- Business Context Agent
        |
        v
Architecture Baseline Agent
        |
        v
Target Architecture Decision Agent
        |
        v
Risk And Validation Agent
        |
        v
Migration Contract Agent
        |
        v
Implementation Handoff Agent
        |
        v
Codex / Claude Code / internal implementation agents
```

The decision-making agent should act as the arbiter. It should not invent missing facts. It should combine evidence from the scan, business context, architecture baseline, and target architecture profile, then either recommend a target path or block the component for human review.

## Required Artifacts

CCS Code should treat these artifacts as first-class data, not only Markdown:

- Modernization brief: business goal, target platform, constraints, and success criteria.
- Architecture baseline: normalized target diagrams, platform flow, approved service boundaries, and known decisions.
- Target architecture profile: approved services, integration patterns, security rules, and platform standards.
- Evidence ledger: every important claim tied to source files, docs, or user-provided context.
- System graph: components, dependencies, entry points, data stores, external integrations, and runtime flows.
- Business capability map: what the system does in business terms.
- Target decision matrix: candidate landing zones, selected landing zone, rationale, confidence, source architecture documents, and blockers.
- Validation matrix: scenarios, required samples, expected outputs, and test strategy.
- Migration contract: final handoff record used by implementation agents.

## Confidence Rules

Low confidence should not mean "write unknown into every section and continue."

The preferred behavior is:

- If parsing fails, fail the component analysis and record the error.
- If source evidence is thin, mark specific fields as unknown.
- If business context is missing, ask for context or route to human review.
- If target architecture is ambiguous, list candidate options and the decision needed.
- If a target diagram drives a decision, cite that document as provided context and still check source evidence.
- If enough evidence exists, produce a useful medium or high confidence recommendation with citations.

## Product Direction

CCS Code should borrow the useful ideas from code-intelligence tools:

- Repository indexing.
- Knowledge graph.
- Call-chain and dependency tracing.
- Multi-repo context.
- MCP or tool-facing access to repo facts.
- Graph-backed agent prompts.

CCS Code should keep its own product center:

- Migration readiness.
- Business behavior preservation.
- Target architecture decisions.
- Human review gates.
- Implementation contracts for coding agents.

This keeps the app focused on modernization outcomes instead of becoming only a code-search tool.

## Implementation Roadmap

### Phase 1: Stabilize The Analyzer

- Make parse failures visible instead of generating fake unknown documents.
- Preserve evidence for every extracted fact.
- Accept migration briefs, architecture baseline documents, and target architecture profiles as input.
- Report confidence by field, not only by component.

### Phase 2: Build The System Graph

- Index entry points, dependencies, data stores, package use, and external calls.
- Group technical components into business capabilities.
- Expose graph queries to agents through internal tools or MCP.

### Phase 3: Add Architecture Decisions

- Add a target architecture decision matrix.
- Score candidate landing zones.
- Explain rejected options.
- Cite architecture baseline documents when they influence decisions.
- Block unresolved platform decisions.

### Phase 4: Produce Agent Handoff Packs

- Generate implementation tasks only for ready components.
- Attach source evidence, target decisions, architecture context, and validation scenarios.
- Keep human-review items separate from build tasks.

### Phase 5: Close The Loop With Validation

- Compare legacy and target outputs.
- Feed validation failures back into the migration contract.
- Track decision history and sign-off status.
