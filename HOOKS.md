# CCS Hooks System

Hooks provide a way to extend CCS behavior by intercepting and reacting to key events in the orchestration lifecycle.

## Overview

### Supported Events (Phase 1)

- **`session_start`** - Emitted when an orchestration session begins
- **`session_end`** - Emitted when an orchestration session completes (success or error)
- **`pre_tool_use`** - Emitted before a tool is executed; can block execution or mutate input
- **`post_tool_use`** - Emitted after a tool successfully executes
- **`post_tool_use_failure`** - Emitted after a tool fails
- **`permission_request`** - Emitted when a tool requires permission; hooks can approve/reject

### Hook Types

Hooks can handle events using different mechanisms:

#### 1. Command Hook

Executes a shell command. Useful for notifications, logging, or integration with local tools.

```json
{
  "type": "command",
  "command": "echo",
  "args": ["Tool executed"],
  "timeout": 5000,
  "continueOnError": true
}
```

#### 2. HTTP Hook

Sends event context to an HTTP endpoint. Useful for webhooks, serverless functions, or remote systems.

```json
{
  "type": "http",
  "url": "https://example.com/hooks",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer token"
  },
  "timeout": 5000
}
```

#### 3. Prompt Hook (Phase 2)

Uses the LLM to analyze context and make decisions. Not yet implemented.

#### 4. Agent Hook (Phase 2)

Spins up a CCS agent to handle complex decision-making. Not yet implemented.

## Configuration

### Project-level Hooks (.ccs-hooks.json)

Create a `.ccs-hooks.json` file in your project root:

```json
{
  "hooks": [
    {
      "event": "pre_tool_use",
      "matcher": {
        "toolNames": ["write_file"],
        "riskClasses": ["write"]
      },
      "handler": {
        "type": "command",
        "command": "verify-write",
        "args": ["$TOOL_NAME"]
      }
    },
    {
      "event": "permission_request",
      "handler": {
        "type": "http",
        "url": "http://localhost:3000/approval",
        "method": "POST"
      }
    }
  ]
}
```

The hook engine automatically loads `.ccs-hooks.json` on startup.

## Hook Matcher

Limit when hooks execute with matchers:

- **`toolNames`** - Array of tool names to match
- **`riskClasses`** - Array of risk classes (`read`, `write`, `dangerous`)
- **`condition`** - Custom JS expression (Phase 2)

Example - only watch "write" operations:

```json
{
  "matcher": {
    "riskClasses": ["write", "dangerous"]
  }
}
```

## Hook Context

Every hook receives a `HookContext` object containing:

```typescript
{
  event: "pre_tool_use" | "post_tool_use" | ...,
  timestamp: number,           // Unix timestamp
  sessionId: string,           // Session identifier
  toolName?: string,           // Tool being used
  toolInput?: unknown,         // Input to tool
  toolOutput?: unknown,        // Tool result
  toolError?: string,          // Error message (failures only)
  riskClass?: string,          // read | write | dangerous
  cwd: string,                 // Current working directory
  permissionReason?: string,   // Why permission required
  permissionId?: string,       // Permission request ID
}
```

## Hook Result

Hooks can return:

```typescript
{
  allow: boolean,              // Whether to allow/continue
  updatedInput?: unknown,      // Modified tool input (pre_tool_use only)
  message?: string,            // Status message to display
  permissionDecision?: "approved" | "rejected"  // (permission_request only)
}
```

### Input Mutation (pre_tool_use)

Multiple hooks can chain input mutations:

```json
{
  "event": "pre_tool_use",
  "handler": {
    "type": "command",
    "command": "transform-input",
    "args": ["."]
  }
}
```

The hook can output JSON to stdout which updates `updatedInput`.

### Permission Approval (permission_request)

HTTP hooks can directly approve tool execution:

```json
{
  "event": "permission_request",
  "handler": {
    "type": "http",
    "url": "http://localhost:3000/auto-approve"
  }
}
```

The endpoint should return:

```json
{
  "allow": true,
  "permissionDecision": "approved"
}
```

## Advanced Features

### Hook Modes

- **`once`** - Execute hook only once per session
- **`async`** - Run hook without blocking execution
- **`asyncRewake`** - Re-trigger async hook if paused

### Priority

Hooks with higher `priority` execute first:

```json
{
  "priority": 100
}
```

## Examples

### Example 1: Audit All Tool Calls

Log every tool invocation to a remote system:

```json
{
  "hooks": [
    {
      "event": "pre_tool_use",
      "handler": {
        "type": "http",
        "url": "https://audit.example.com/tools",
        "method": "POST"
      }
    }
  ]
}
```

### Example 2: Guard Write Operations

Require approval only for write operations:

```json
{
  "hooks": [
    {
      "event": "permission_request",
      "matcher": {
        "riskClasses": ["write", "dangerous"]
      },
      "handler": {
        "type": "http",
        "url": "http://localhost:8000/approval",
        "method": "POST"
      }
    }
  ]
}
```

### Example 3: Session Lifecycle Notifications

Notify Slack on session start/end:

```json
{
  "hooks": [
    {
      "event": "session_start",
      "handler": {
        "type": "http",
        "url": "https://hooks.slack.com/services/YOUR/WEBHOOK",
        "method": "POST"
      }
    },
    {
      "event": "session_end",
      "handler": {
        "type": "http",
        "url": "https://hooks.slack.com/services/YOUR/WEBHOOK",
        "method": "POST"
      }
    }
  ]
}
```

## Phase 2 (Upcoming)

- Prompt hooks for LLM-based decision making
- Agent hooks for complex workflows
- Condition expressions in matchers
- Structured hook output parsing
- Hook event history and debugging
- User-level hook management (`~/.ccs/hooks`)
- Plugin hook registration

## FAQ

**Q: Can hooks block tool execution?**
A: Yes, for `pre_tool_use`, `post_tool_use_failure`, and `permission_request` events, returning `allow: false` will block execution.

**Q: What happens if a hook times out?**
A: Hook executors have default timeouts (5 seconds for HTTP, command). Timeouts return `allow: true` to avoid blocking.

**Q: Can hooks modify tool input?**
A: Yes, `pre_tool_use` hooks can return `updatedInput` which gets passed to the tool.

**Q: Are hooks synchronized or async?**
A: By default, hooks run synchronously and block. Set `async: true` to run non-blocking.
