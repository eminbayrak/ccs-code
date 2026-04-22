# CCS Code Instructions

Always use concise language.

## Phase 2: Hook System Implementation ✅

### Core Features:

- **Hook registration**: Register custom hooks via `registerHook(event, handler, options)`
- **Hook execution**: Execute registered hooks with context via `executeHooks(event, data)`
- **Debugging tools**: Use `/hooks list`, `/hooks debug`, and `/hooks stats` commands
- **Error handling**: Graceful error handling with logging and context preservation
- **Status tracking**: Active hook count and execution statistics in status bar

### Supported Events:

- `file:before-read`: Before reading a file
- `file:after-read`: After successfully reading a file
- `file:before-write`: Before writing to a file
- `file:after-write`: After successfully writing to a file
- `query:before-execute`: Before executing a query
- `query:after-execute`: After executing a query
- `tool:before-invoke`: Before invoking a tool
- `tool:after-invoke`: After invoking a tool

### Hook Options:

```typescript
interface HookOptions {
  priority?: number; // Execution order (default: 0)
  name?: string; // Unique identifier
  async?: boolean; // Support async handlers
}
```

### Examples:

```typescript
// Register a hook
registerHook('file:before-read', (data) => {
  console.log('Reading file:', data.path);
});

// Execute hooks
await executeHooks('file:before-read', { path: '/example.ts' });

// Debug hooks
/hooks list      # Show all registered hooks
/hooks debug     # Get detailed debug info
/hooks stats     # Show execution statistics
```
