# Use Case: MCDS Modernization Intelligence

## Purpose

This document defines the business goal and modernization use case for applying **CCS Code** to the MCDS legacy application.

The goal is to turn a large, aging, business-critical system into migration-ready context for AI-assisted modernization. CCS Code should help teams understand what the legacy system does, identify the business behavior that must be preserved, classify components into the right target architecture roles, and generate an auditable migration contract before coding agents begin implementation.

## Business Goal

MCDS is a long-running enterprise system with legacy processing, file workflows, database interactions, orchestration logic, business rules, and external delivery responsibilities. The modernization goal is not a simple lift-and-shift or one-for-one language conversion. The goal is to preserve business behavior while moving the system toward a cloud-native architecture that is easier to operate, scale, validate, and evolve.

The target direction includes:

- Azure-native storage, compute, messaging, and orchestration.
- Event-driven file ingestion and processing.
- Clear service and workflow boundaries.
- Modern APIs and integration points.
- Strong validation against legacy behavior.
- Human review for architecture and business decisions that cannot be safely inferred from source code alone.

## Modernization Problem

MCDS modernization is difficult because the legacy system mixes several concerns that need to be separated before implementation:

- Business rules.
- File ingestion and routing.
- Batch and task orchestration.
- Parser and grammar selection.
- Preprocessing and transformation logic.
- Database reads, writes, and status transitions.
- External system integrations.
- Delivery, archival, and audit behavior.
- Error handling, retries, and completion semantics.

AI coding agents can help generate code, tests, and remediation loops, but they need reliable migration context first. Without that context, an agent may produce a technically plausible rewrite that misses key business behavior, preserves the wrong control flow, or invents target architecture decisions that should be made by architects and domain owners.

## CCS Code Role

CCS Code should act as the **pre-generation migration intelligence layer**.

```text
Legacy repositories + documentation + diagrams + schemas + domain context
        |
        v
CCS Code
Evidence-backed knowledge base, migration contract, target disposition, unknowns
        |
        v
Codex / Claude Code / internal agent pipeline
Implementation, tests, QA review, remediation
        |
        v
Legacy-output comparison / validation pipeline
Compare, triage, remediate, report
```

CCS Code does not need to replace coding agents or validation pipelines. Its value is to make those systems safer and more effective by answering:

> What should be implemented, why, from which evidence, and what is still unknown?

This use case should be implemented through the agentic modernization architecture described in [Agentic Modernization Architecture](./agentic-modernization-architecture.md). The important shift is that CCS Code should not only scan source files. It should coordinate specialized agents that gather repository evidence, interpret business behavior, choose target architecture roles, identify validation obligations, and produce a migration contract for downstream coding agents.

## Legacy System Characteristics

The MCDS system should be treated as an architectural modernization problem. The system may include:

- Client file ingestion through FTP or inbound landing locations.
- Configuration loaded at startup or from shared configuration stores.
- Task-based orchestration and worker execution.
- File classification, routing, preprocessing, splitting, and character conversion.
- File ID resolution, grammar resolution, alias handling, and file-set collection.
- Parser coordination and parser selection.
- Grammar-driven ETL and SQL/database loading.
- REST or service calls to composition and downstream platforms.
- Standard layout generation.
- Delivery to downstream destinations.
- Audit logging and archival.
- Status transitions and operational tracking.
- Print, PDF, statement, EDI, or outbound communication workflows.

The migration must preserve behavior while changing implementation shape.

## Target Architecture Direction

The target architecture should classify legacy components by responsibility, not only by source language.

Potential target roles include:

- Camunda workflow for long-running process orchestration.
- Azure Function for event-triggered file routing, preprocessing, parsing, or delivery.
- Databricks or Spark job for large-scale ETL and transformation.
- REST API or microservice for synchronous business capabilities.
- Common library for reusable parsing, conversion, validation, or mapping logic.
- Rules engine module for configurable decision logic.
- Data model or schema contract for persisted entities and file layouts.
- Integration adapter for external systems such as composition, delivery, archival, or partner endpoints.
- Human-review item when the target landing zone cannot be safely inferred from code.

This target classification is one of the core outputs CCS Code should provide.

## Required Migration Context

A high-quality migration run should include more than a repository URL and target language. CCS Code should accept or generate a migration brief that includes:

- Business goals and modernization constraints.
- Approved target architecture patterns.
- Target-state architecture diagrams and modernization flows from architecture or analysis teams.
- Target cloud services and integration standards.
- Source repositories and relevant code paths.
- Architecture diagrams and process flows.
- Database schemas, table descriptions, and stored procedures.
- File layouts, sample inputs, and expected outputs.
- Known business scenarios and acceptance criteria.
- Operational rules for retries, errors, audit, archival, and completion.
- Security, identity, compliance, and data-handling constraints.
- Human decisions that are already resolved.
- Human decisions that must remain gated.

This context should guide component discovery, business-rule extraction, target-role classification, validation scenario generation, and agent instructions.

Architecture diagrams and target-state flows should be treated as an architecture baseline. CCS Code should use them to understand approved service boundaries, integration points, and target landing zones, then compare those decisions against source-code evidence before generating implementation instructions.

## Proposed CCS Code Workflow

### 1. Ingest Evidence

Inputs may include:

- Legacy source repositories.
- Existing documentation.
- Architecture diagrams.
- Target-state modernization flows.
- Process diagrams.
- Configuration files.
- Database schemas.
- File layouts.
- Example input and output files.
- Known test scenarios.
- Domain notes and migration requirements.

Outputs:

- Source inventory.
- Artifact index.
- Initial dependency map.
- Evidence ledger.

### 2. Analyze Legacy Behavior

CCS Code should identify:

- Entry points.
- Controllers, services, jobs, workers, and shared libraries.
- File watchers and task triggers.
- Preprocessing and parsing logic.
- Database access patterns.
- External service calls.
- Business rules.
- Status transitions.
- Error handling.
- Runtime wiring that may not be obvious from static code.

Outputs:

- System overview.
- Component map.
- Per-component context docs.
- Business rules with source evidence.
- Data contracts.
- Dependency graph.
- Unknowns and risks.

### 3. Classify Target Disposition

Each component should receive a target architecture recommendation:

- Recommended target role.
- Rationale.
- Integration boundary.
- Confidence.
- Required human decisions.
- Migration risks.
- Validation scenarios.

Outputs:

- Component disposition matrix.
- Target architecture recommendations.
- Human questions.
- Migration order.

### 4. Generate Agent Instructions

CCS Code should produce agent-ready artifacts for implementation tools:

- Codex `AGENTS.md`.
- Claude Code slash commands.
- Per-component rewrite instructions.
- Migration contract JSON.
- Validation scenarios.
- Acceptance criteria.
- Human-review gates.

Agents should be instructed to:

- Preserve observed business rules.
- Treat inferred facts as review items.
- Avoid one-for-one rewrites when architecture classification is required.
- Stop when required human decisions are unresolved.
- Use validation scenarios to prove parity.

### 5. Feed Implementation and Validation Pipelines

Downstream coding and QA systems can use the CCS Code outputs to:

- Implement ready components.
- Generate unit and functional tests.
- Compare target behavior with legacy outputs.
- Route defects to implementation or human review.
- Produce sign-off artifacts.

## Migration Contract

The most important artifact is a machine-readable migration contract.

Example:

```json
{
  "system": "MCDS",
  "globalGuardrails": [
    "Preserve business behavior, not legacy control flow.",
    "Do not perform a one-for-one rewrite without target architecture classification.",
    "Classify facts as observed, inferred, or unknown.",
    "Route unresolved architecture decisions to human review."
  ],
  "components": [
    {
      "name": "FileRouter",
      "legacyRole": "Detects and classifies inbound files.",
      "targetRole": "azure_function",
      "targetIntegrationBoundary": "Blob trigger plus Service Bus topic",
      "businessRules": [
        {
          "statement": "Inbound files are classified by client, file type, and format before processing.",
          "basis": "observed",
          "confidence": "high",
          "source": "src/path/FileRouter:<line-range>"
        }
      ],
      "humanQuestions": [
        "Confirm whether retry ownership belongs in Azure Functions, Camunda, or both."
      ],
      "validationScenarios": [
        "Given a valid client file, verify the target system emits the same processing task classification as the legacy system."
      ]
    }
  ]
}
```

This contract should be readable by humans, Codex, Claude Code, QA agents, and downstream validation tools.

## Success Criteria

The use case is successful when CCS Code can produce a migration intelligence pack that:

- Explains the legacy system in business terms.
- Identifies components and dependencies.
- Extracts business rules with source evidence.
- Separates business behavior from legacy control flow.
- Classifies target architecture roles.
- Flags unresolved decisions clearly.
- Produces implementation-ready agent instructions.
- Provides validation scenarios for behavior parity.
- Reduces silent assumptions by coding agents.
- Gives architects and product owners a reviewable contract before code generation begins.

## Product Positioning

**CCS Code turns legacy systems into migration-ready context for AI coding agents.**

For MCDS modernization, CCS Code should be positioned as an evidence-backed migration intelligence layer that prepares the contract, guardrails, and implementation context before AI agents write code.

The core message:

> AI agents can write code and validation pipelines can compare outputs, but modernization fails if nobody first builds a trustworthy map of the legacy system. CCS Code builds that map.
