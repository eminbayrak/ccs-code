# Plugin Architecture

### Architectural Decision Record

_ccs-code · Principal Engineer Decision_

---

## Decision

**Open the existing connector/registry system into a true plugin architecture.
Build `/migrate` as the first external plugin using this system.**

This document explains the decision, the design, and how to implement it.

---

## Why a Plugin Architecture

The tool is growing: `/harvest`, `/vault`, `/enrich`, `/migrate` — and more will come.
Without a plugin boundary, every new capability gets compiled into the core binary.
That creates a monolith that is hard to maintain, impossible to extend without touching core code,
and difficult to audit for security.

A plugin system solves this:
- Core stays lean and stable
- New capabilities are isolated, versioned, and independently deployable
- External contributors (or a company's internal team) can add capabilities without touching core
- Features can be enabled per-environment: development machine vs. company deployment

## Why Not a Separate Plugin System

The existing codebase already has the right shape:

- `ConnectorAdapter` in `src/connectors/base.ts` — the connector interface
- `ToolDescriptor` in `src/capabilities/types.ts` — the tool contract
- `loadCapabilities()` in `src/capabilities/registry.ts` — the aggregation point

The only thing missing is **dynamic discovery**. Right now `loadConnectorAdapters()` hardcodes the list:

```ts
function loadConnectorAdapters(): ConnectorAdapter[] {
  return [githubConnector, jiraConnector];  // ← closed list
}
```

One change — scanning `.ccs/plugins/` instead of importing a hardcoded list — unlocks the whole system.
There is no need to design a new plugin protocol from scratch.

## Prior Art

This pattern is well established:

| Tool | Plugin directory | Manifest | Export contract |
|------|-----------------|----------|----------------|
| Claude Code | `.claude/commands/` | none (file = command) | default export function |
| Obsidian | `.obsidian/plugins/<name>/` | `manifest.json` | `Plugin` class |
| VS Code | `~/.vscode/extensions/` | `package.json` | `activate()` function |
| Raycast | npm packages | `package.json` | `Command` export |

ccs-code follows the same idea: a well-known directory, a manifest, a standard export shape.

---

## Plugin Contract

Every plugin is a directory under `.ccs/plugins/<plugin-name>/`.

### Manifest — `ccs-plugin.json`

```json
{
  "name": "migrate",
  "version": "0.1.0",
  "description": "Scans legacy codebases and generates migration context for AI rewrite tools",
  "entry": "index.js",
  "commands": ["migrate"],
  "connectors": []
}
```

### Entry Point — `index.js` (compiled from TypeScript)

The entry point must export a default object satisfying `CCSPlugin`:

```ts
// src/plugin.ts (in each plugin repo)

import type { ConnectorAdapter } from 'ccs-code/connectors/base'

export interface CommandPlugin {
  name: string           // slash command name — e.g. "migrate" registers /migrate
  description: string
  handler: (args: string[], cwd: string) => Promise<string>
}

export interface CCSPlugin {
  name: string
  version: string
  commands?: CommandPlugin[]
  connectors?: ConnectorAdapter[]
}
```

A plugin can contribute **commands**, **connectors**, or both.

- **Commands** add slash commands: `/migrate`, `/review`, `/standup`, etc.
- **Connectors** add tools the LLM orchestrator can call during agent runs.

### Example Plugin Entry Point

```ts
// migrate plugin — .ccs/plugins/migrate/index.ts

import { handleMigrateCommand } from './migration/command.js'
import type { CCSPlugin } from 'ccs-code'

const plugin: CCSPlugin = {
  name: 'migrate',
  version: '0.1.0',
  commands: [
    {
      name: 'migrate',
      description: 'Scan a legacy codebase and generate AI migration context',
      handler: handleMigrateCommand,
    }
  ],
  connectors: [],
}

export default plugin
```

---

## App.tsx Integration Points

Two specific locations in `src/components/App.tsx` must be updated:

### 1. `SLASH_COMMANDS` array (line 80)

Currently hardcoded. At boot time, merge plugin commands into this list so they
appear in autocomplete suggestions:

```ts
// After plugins are loaded in triggerBoot()
const pluginSuggestions = loadedPlugins.flatMap(p =>
  (p.commands ?? []).map(c => ({
    id: c.name,
    label: `/${c.name} `,
    description: c.description,
  }))
)
// Merge into SLASH_COMMANDS state (convert from const to state)
setSlashCommands([...BUILT_IN_COMMANDS, ...pluginSuggestions])
```

### 2. `executeSlashCommand` switch statement (line 371)

Add a plugin lookup before the `default:` case:

```ts
default: {
  const pluginCmd = loadedPluginCommands.find(c => c.name === id)
  if (pluginCmd) {
    setMessages(prev => [...prev, createUIMessage('assistant', `Running /${id}...`)])
    pluginCmd.handler(args, process.cwd()).then(output => {
      setMessages(prev => [...prev, createUIMessage('assistant', output)])
    })
    break
  }
  setMessages(prev => [...prev, createUIMessage('assistant', `Unknown command: /${id}`)])
  break
}
```

Both `loadedPlugins` and `loadedPluginCommands` are populated in `triggerBoot()` and stored in refs,
same pattern as `providerRef` and `orchestratorRef`.

---

## Changes to Core

### 1. Add plugin types to `src/capabilities/types.ts`

```ts
export interface CommandPlugin {
  name: string
  description: string
  handler: (args: string[], cwd: string) => Promise<string>
}

export interface CCSPlugin {
  name: string
  version: string
  commands?: CommandPlugin[]
  connectors?: ConnectorAdapter[]
}
```

### 2. Add plugin loader to `src/capabilities/registry.ts`

```ts
import { join } from 'path'
import { promises as fs } from 'fs'
import type { CCSPlugin } from './types.js'

const PLUGIN_DIR = join(os.homedir(), '.ccs', 'plugins')

async function loadPlugins(): Promise<CCSPlugin[]> {
  const plugins: CCSPlugin[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(PLUGIN_DIR)
  } catch {
    return []  // no plugins directory — fine
  }

  for (const entry of entries) {
    const manifestPath = join(PLUGIN_DIR, entry, 'ccs-plugin.json')
    const entryPath = join(PLUGIN_DIR, entry, 'index.js')

    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
      const mod = await import(entryPath)
      const plugin = mod.default as CCSPlugin

      if (plugin && plugin.name) {
        plugins.push(plugin)
      }
    } catch (e) {
      console.warn(`[plugins] Failed to load plugin "${entry}":`, e)
    }
  }

  return plugins
}
```

Update `loadCapabilities()` to incorporate plugin connectors and return plugin commands:

```ts
export async function loadCapabilities(cwd: string): Promise<CapabilitySnapshot> {
  const localTools = getLocalTools()
  const builtInAdapters = loadConnectorAdapters()  // github, jira — stays as-is
  const plugins = await loadPlugins()

  const pluginAdapters = plugins.flatMap(p => p.connectors ?? [])
  const pluginCommands = plugins.flatMap(p => p.commands ?? [])

  const allAdapters = [...builtInAdapters, ...pluginAdapters]

  const connectors: ConnectorDescriptor[] = allAdapters.map(adapter => ({
    id: `connector.${adapter.name}`,
    name: adapter.name,
    kind: 'connector',
    tools: adapter.getTools({ cwd }),
  }))

  return {
    tools: [...localTools, ...connectors.flatMap(c => c.tools)],
    connectors,
    commands: pluginCommands,   // new field — slash commands from plugins
  }
}
```

### 3. Update command dispatch to check plugin commands

Wherever slash commands are currently routed (command handler in `main.tsx` or orchestrator),
add a check against loaded plugin commands before falling through to built-in handlers:

```ts
// pseudocode — adapt to actual dispatch location
const pluginCommand = loadedPluginCommands.find(c => c.name === commandName)
if (pluginCommand) {
  return pluginCommand.handler(args, cwd)
}
// fall through to built-in commands
```

---

## Plugin Directory Layout

```
~/.ccs/
  plugins/
    migrate/
      ccs-plugin.json
      index.js
      migration/
        scanner.js
        resolver.js
        tracer.js
        analyzer.js
        wsdlParser.js
        contextBuilder.js
        indexBuilder.js
        statusTracker.js
    review/          ← future plugin
      ccs-plugin.json
      index.js
    standup/         ← future plugin
      ccs-plugin.json
      index.js
```

Plugins live in the user's home directory under `~/.ccs/plugins/`, not inside the project repo.
This means:
- The core tool repo stays clean — no plugin code
- Each plugin is independently versioned and installed
- Company deployments can pre-install plugins without touching the core binary

---

## Plugin Development Workflow

To develop and install a plugin locally:

```bash
# 1. Create the plugin directory
mkdir -p ~/.ccs/plugins/migrate

# 2. Build the plugin
cd ~/projects/ccs-migrate-plugin
bun run build   # outputs to dist/

# 3. Copy to plugin directory
cp dist/index.js ~/.ccs/plugins/migrate/
cp ccs-plugin.json ~/.ccs/plugins/migrate/

# 4. The tool picks it up automatically on next run
ccs
# → /migrate is now available
```

For development, symlink instead of copying:

```bash
ln -s ~/projects/ccs-migrate-plugin/dist ~/.ccs/plugins/migrate
```

---

## What Is Built-In vs. Plugin

| Capability | Location | Reason |
|------------|----------|--------|
| `/harvest` | Built-in | Core feature, used by everyone |
| `/vault` | Built-in | Core feature, used by everyone |
| `/enrich` | Built-in | Core feature, used by everyone |
| GitHub connector | Built-in | Core integration, used by many features |
| Jira connector | Built-in | Core integration |
| `/migrate` | **Plugin** | Large, specialized, not needed by all users |
| Future: `/review` | Plugin | Specialized |
| Future: `/standup` | Plugin | Specialized |

The rule: if a feature is needed to make the core tool work, it is built-in.
If it is a large, specialized capability that specific users opt into, it is a plugin.

---

## Implementation Order

1. Add `CommandPlugin` and `CCSPlugin` types to `src/capabilities/types.ts`
2. Write `loadPlugins()` in `src/capabilities/registry.ts`
3. Update `loadCapabilities()` to merge plugin connectors and return plugin commands
4. Update command dispatch to check plugin commands
5. Build the `migrate` plugin as a separate project in `~/.ccs/plugins/migrate/`

Steps 1–4 are small, focused changes to core.
Step 5 is the full migrate feature build — follows `migrate-feature-build-instructions.md`.

---

## What This Unlocks Long Term

Once the plugin system exists, the tool becomes a platform:

- **Company-specific plugins** — internal teams can add capabilities without touching core
- **Community plugins** — others can build and share plugins as npm packages
- **Per-environment installs** — dev machine has all plugins, CI has only what it needs
- **Security boundary** — plugins run in the same process but are clearly separated from core logic

---

_ccs-code · Plugin Architecture Decision · 2026-04-22_
