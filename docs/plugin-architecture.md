# Plugin Architecture

### Architectural Decision Record

_ccs-code · Principal Engineer Decision_

---

## Status: Implemented (Scanner Plugin Layer)

The plugin architecture described in earlier drafts of this document had two layers:

1. **Full CCSPlugin system** — external plugins that add slash commands and connectors to the whole app
2. **Scanner plugin system** — plugins that define how to find service references within `/migrate scan`

Layer 1 (full command plugins) remains a future capability. Layer 2 (scanner plugins) is **fully implemented** and in production use. This document describes what is actually built.

---

## What Is Actually Built

### The Scanner Plugin Interface

Every scanner plugin is a JS module that default-exports a `MigratePlugin` object:

```ts
// src/migration/types.ts

export interface MigratePlugin {
  name: string;
  fileExtensions: string[];          // e.g. [".js", ".ts", ".jsx", ".mjs"]
  scan(file: { path: string; content: string }): ServiceReference[];
}

export interface ServiceReference {
  callerFile: string;
  lineNumber: number;
  serviceNamespace: string;
  methodName: string;
  metadata: Record<string, string>;  // plugin-specific extracted fields
}
```

The core app calls `plugin.scan(file)` on every file matching `plugin.fileExtensions`. The plugin returns `ServiceReference[]`. The core does the rest — resolve, analyze, build context docs, write status.

---

## The Built-In SOAP Plugin

`plugins/migrate-soap/` is the first and currently only built-in scanner plugin.

### What it does

Finds every `constructSoapRequest(...)` call (configurable function name) across Node.js/TypeScript files and extracts:

| Field | Source |
|-------|--------|
| `serviceNamespace` | `serviceNamespace` key in the config object |
| `methodName` | `methodName` key in the config object |
| `isXmlResponse` | `isXmlResponse` flag → stored in `metadata` |
| `parameterFlags` | boolean flags from the `parameters` array → stored in `metadata` |

Nested parentheses are handled correctly — `findClosingParen()` walks the string character by character so deeply nested config objects don't break extraction.

### Files

```
plugins/
  migrate-soap/
    index.ts          — TypeScript source
    index.js          — compiled ESM output (committed — works without a build step)
    ccs-plugin.json   — manifest: { name, version, entry }
```

### Configurable factory

```ts
import { createPlugin } from "plugins/migrate-soap/index.js";

// Default: looks for "constructSoapRequest"
const plugin = createPlugin();

// Custom function name in your codebase
const plugin = createPlugin({ callerFunctionName: "callExternalService" });

// Custom field names in the config object
const plugin = createPlugin({
  callerFunctionName: "callService",
  namespaceField: "serviceName",
  methodField: "operation",
});
```

---

## Plugin Discovery

`src/migration/pluginLoader.ts` implements three-tier discovery. When `/migrate scan` runs, it searches these locations in order:

| Priority | Location | Purpose |
|----------|----------|---------|
| 1 (highest) | `.ccs/plugins/` in current project directory | Project-specific overrides |
| 2 | `~/.ccs/plugins/` in user home | Global user-installed plugins |
| 3 (lowest) | Built-in `plugins/` directory | Shipped with the tool |

The built-in directory is found differently depending on how the tool is running:

```ts
function builtinPluginsDir(): string {
  const arg1 = process.argv[1] ?? "";
  if (arg1.endsWith(".ts") || arg1.endsWith(".tsx") || arg1.endsWith(".js")) {
    // Dev mode (bun run src/main.tsx) — arg1 is the script file
    // plugins/ is two levels up from src/main.tsx
    return join(dirname(arg1), "..", "..", "plugins");
  }
  // Binary mode (./ccs) — arg0 is the compiled binary
  // plugins/ is a sibling of the binary
  return join(dirname(process.argv[0] ?? ""), "plugins");
}
```

This means built-in plugins work immediately in both `bun run src/main.tsx` (dev) and `./ccs` (binary) without any install step.

### Plugin manifest

Each plugin directory must contain `ccs-plugin.json`:

```json
{
  "name": "migrate-soap",
  "version": "1.0.0",
  "entry": "index.js"
}
```

The `entry` field points to the compiled JS file. The loader calls `import(entryPath)` and reads `module.default` as the `MigratePlugin` object.

---

## Plugin Loader API

```ts
import { loadPlugins, loadPlugin, listPlugins } from "./pluginLoader.js";

// Load all plugins from all search dirs
const plugins = await loadPlugins(cwd);

// Load a specific named plugin
const plugin = await loadPlugin("migrate-soap", cwd);

// List installed plugins (for /migrate plugin list)
const list = await listPlugins(cwd);
// → [{ name, version, location, path }]
```

---

## Building and Extending Plugins

### Rebuild the built-in SOAP plugin

```bash
bun run build:plugins
# Runs: bun build ./plugins/migrate-soap/index.ts --outfile ./plugins/migrate-soap/index.js --format esm
```

### Build everything (binary + plugins)

```bash
bun run build:all
```

### Write a new scanner plugin

1. Create a directory under `plugins/<your-plugin-name>/`
2. Write `index.ts` exporting a default `MigratePlugin` object
3. Write `ccs-plugin.json` manifest
4. Compile: `bun build ./plugins/<name>/index.ts --outfile ./plugins/<name>/index.js --format esm`

Or install as a user plugin at `~/.ccs/plugins/<your-plugin-name>/`.

### Example: gRPC plugin skeleton

```ts
import type { MigratePlugin, ServiceReference } from "../../src/migration/types.js";

const plugin: MigratePlugin = {
  name: "migrate-grpc",
  fileExtensions: [".py", ".go", ".ts"],
  scan(file) {
    const refs: ServiceReference[] = [];
    // Find stub.MethodName() calls and extract service + method
    // Push to refs...
    return refs;
  },
};

export default plugin;
```

---

## Plugin Selection at Runtime

When running `/migrate scan`, specify the plugin with `--plugin`:

```
/migrate scan --repo ... --lang ... --plugin migrate-soap
```

Without `--plugin`, the loader picks the first plugin found across the three search directories. Since `migrate-soap` is the only built-in plugin, it is selected by default for new users.

Use `/migrate plugin list` to see all available plugins and where they were found:

```
Available scanner plugins:

  migrate-soap  v1.0.0  [built-in]
    /path/to/ccs-code/plugins/migrate-soap/index.js

  my-grpc-plugin  v0.1.0  [~/.ccs/plugins]
    /Users/you/.ccs/plugins/my-grpc-plugin/index.js
```

---

## Future: Full Command Plugin System

The original design (CCSPlugin with commands and connectors) is still the right long-term direction. When built, it will allow:

- External plugins that register new slash commands (e.g., `/review`, `/standup`)
- External connectors that add LLM tools (e.g., Jira, Linear, Slack)
- Per-environment plugin sets (dev machine vs. CI)

The scanner plugin system built here follows the same discovery conventions (`ccs-plugin.json`, three-tier search), so extending it to support full command plugins later will not require changing the plugin format.

---

_ccs-code · Plugin Architecture · 2026-04-22_
