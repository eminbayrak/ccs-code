# MCP and Enterprise Integration Plan

## What CCS Code Should Be

CCS Code should be the migration intelligence and contract layer for coding agents.

It should not compete with Codex, Claude Code, or an internal agent pipeline as another code-writing agent. Those tools already write and edit code well. CCS Code should make them safer and more useful by giving them:

- Evidence-backed source understanding.
- Target architecture disposition.
- Business rules and contracts.
- Human questions and implementation gates.
- Validation scenarios and acceptance criteria.
- Migration order and dependency context.

## Remaining Gaps From The Meeting Notes

The current implementation covers the core gap: source-backed migration context, target role classification, human questions, and agent-readable contracts.

The remaining product gaps are:

- **Target architecture profile:** a company/team-specific file that defines approved landing zones, for example Camunda, Azure Functions, Databricks, AKS, API Gateway, Quadient, and archival patterns.
- **Pre-flight readiness gates:** a checklist that confirms required inputs exist before generation starts, such as source repos, diagrams, database schema, file layouts, sample inputs/outputs, and target architecture rules.
- **Validation/comparison contract:** an artifact tailored for downstream QA or DB2/legacy-output comparison pipelines.
- **Question resolution workflow:** a way to record human answers and regenerate the migration contract with those answers included.
- **Question resolution workflow:** a way to record human answers and regenerate the migration contract with those answers included.
- **Enterprise packaging:** documented setup for company model gateways, private repos, secrets, and deployment inside the company network.
- **Remote/team MCP service:** optional later packaging for shared environments. The local stdio MCP bridge now exists.

## Implemented Local Integrations

CCS Code now supports two local agent integrations that do not require users to paste API keys into CCS:

- **Codex CLI provider:** set `provider` to `codex_cli` and CCS delegates model work to the locally logged-in `codex exec` command. Authentication stays inside Codex CLI/Desktop.
- **Dependency-free MCP bridge:** run `ccs-code mcp` so Codex, Claude Code, or another MCP-capable agent can query CCS migration artifacts.

No MCP SDK dependency is required. The local MCP bridge uses the standard stdio protocol directly, which fits restricted company machines where new npm packages or executable downloads may be blocked.

Example `.ccs/config.json` for local Codex OAuth mode:

```json
{
  "provider": "codex_cli",
  "model": "default",
  "sandbox": "read-only",
  "approval": "never"
}
```

If setup validation fails, the user should run:

```bash
codex login
```

and choose Sign in with ChatGPT. CCS does not read Codex credential files and does not try to reuse OAuth tokens directly.

## What MCP Means

MCP stands for Model Context Protocol. In practical terms, it lets an AI coding tool call your app as a set of tools.

For CCS Code, the local MCP bridge currently exposes:

- `ccs_get_ready_work(migrationDir)` returns components safe for agent implementation.
- `ccs_list_ready_components(migrationDir)` is the same ready-work listing with a clearer name.
- `ccs_get_component_context(migrationDir, componentName)` returns the evidence-backed context for one component.
- `ccs_get_human_questions(migrationDir)` returns blocked decisions.
- `ccs_get_validation_contract(migrationDir, componentName)` returns validation scenarios and acceptance criteria.
- `ccs_get_architecture_baseline(migrationDir)` returns the target architecture baseline or disposition matrix.

## Does MCP Require A Server?

Not always.

There are two common deployment modes:

| Mode | Where it runs | Best for |
|---|---|---|
| Local stdio MCP server | On the developer machine, launched by Codex or Claude Code | First version, demos, local/private repo access |
| Remote HTTP MCP server | Internal company server or container | Shared team usage, centralized audit, shared credentials |

For innovation days, start with a **local stdio MCP server**. It is called a server, but it does not need to be a public web service. Codex or Claude Code starts it as a local process and talks to it through standard input/output.

Later, if the company wants a shared service, package the same MCP tools behind an internal HTTP service.

## Recommended Build Path

### Phase 1: Artifact Contract Mode

This is what CCS Code already supports.

Run the CLI, generate `rewrite/`, then Codex or Claude reads:

- `AGENTS.md`
- `migration-contract.json`
- `component-disposition-matrix.md`
- `human-questions.md`
- `context/<Component>.md`

This is enough to demo the value.

### Phase 2: Local MCP Tool

This is now implemented as `ccs-code mcp`.

The MCP server should not duplicate analysis logic. It should call the same functions used by the CLI and read the same generated artifacts.

Current tools:

- `ccs_get_ready_work`
- `ccs_list_ready_components`
- `ccs_get_component_context`
- `ccs_get_human_questions`
- `ccs_get_validation_contract`
- `ccs_get_architecture_baseline`

Codex registration:

```bash
codex mcp add ccs -- ccs-code mcp
```

Claude Code `.mcp.json` registration:

```json
{
  "mcpServers": {
    "ccs": {
      "command": "ccs-code",
      "args": ["mcp"]
    }
  }
}
```

### Phase 3: Internal Service

Move the MCP server into a company-controlled environment only after the local version proves useful.

The internal service can add:

- Centralized logging.
- Approval workflows.
- Enterprise credential management.
- Shared migration workspaces.
- Integration with internal GitHub, Azure DevOps, DB2 validation, and QA pipelines.

## Enterprise Model Access

CCS Code already has an enterprise provider that uses OAuth2 client credentials and then calls an OpenAI-compatible chat completions endpoint.

Required `.ccs/config.json`:

```json
{
  "provider": "enterprise",
  "model": "your-company-model-or-deployment-name"
}
```

Required environment variables:

```bash
export CCS_ENTERPRISE_CLIENT_ID="..."
export CCS_ENTERPRISE_CLIENT_SECRET="..."
export CCS_ENTERPRISE_AUTH_URL="https://.../oauth2/token"
export CCS_ENTERPRISE_SCOPE="..."
export CCS_ENTERPRISE_API_BASE="https://.../v1"
```

This will work if the company gateway exposes an OpenAI-compatible endpoint:

```text
POST <CCS_ENTERPRISE_API_BASE>/chat/completions
Authorization: Bearer <oauth-token>
```

If the company gateway uses Azure OpenAI's native deployment URL shape instead, CCS Code needs a small provider variant that sends requests to:

```text
/openai/deployments/<deployment>/chat/completions?api-version=<version>
```

## Best Enterprise Positioning

For the company environment, describe CCS Code like this:

> CCS Code runs inside the company boundary, uses the company-approved model gateway, reads internal source artifacts, and produces a migration contract that Codex, Claude Code, internal agents, QA pipelines, and architects can all consume.

That is the cleanest story: safe context generation first, then agent implementation, then validation.
