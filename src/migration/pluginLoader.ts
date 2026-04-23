import { promises as fs } from "fs";
import { join, dirname } from "path";
import { pathToFileURL } from "url";
import os from "os";
import type { MigratePlugin } from "./types.js";

// ---------------------------------------------------------------------------
// Resolve the built-in plugins/ directory regardless of run mode.
// Dev:    process.argv[1] is the source script → go two levels up
// Binary: process.argv[0] is the compiled binary → plugins/ sits next to it
// ---------------------------------------------------------------------------

function builtinPluginsDir(): string {
  const arg1 = process.argv[1] ?? "";
  if (arg1.endsWith(".ts") || arg1.endsWith(".tsx") || arg1.endsWith(".js") || arg1.endsWith(".mjs")) {
    return join(dirname(arg1), "..", "plugins");
  }
  return join(dirname(process.argv[0] ?? ""), "plugins");
}

// ---------------------------------------------------------------------------
// Plugin search order: project-level → global → built-in
// ---------------------------------------------------------------------------

function pluginSearchDirs(cwd: string): string[] {
  return [
    join(cwd, ".ccs", "plugins"),
    join(os.homedir(), ".ccs", "plugins"),
    builtinPluginsDir(),
  ];
}

// ---------------------------------------------------------------------------
// Load a single plugin from its directory
// ---------------------------------------------------------------------------

async function loadPluginDir(pluginDir: string): Promise<MigratePlugin | null> {
  const manifestPath = join(pluginDir, "ccs-plugin.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(raw) as { entry?: string };
    const entryFile = manifest.entry ?? "index.js";
    const entryPath = join(pluginDir, entryFile);

    // Use file URL for ESM dynamic import on any platform
    const mod = await import(pathToFileURL(entryPath).href) as { default?: unknown };
    const plugin = mod.default;

    if (
      plugin === null ||
      typeof plugin !== "object" ||
      typeof (plugin as MigratePlugin).scan !== "function"
    ) {
      return null;
    }

    return plugin as MigratePlugin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Load all plugins found in the search dirs
// ---------------------------------------------------------------------------

export async function loadPlugins(cwd: string): Promise<MigratePlugin[]> {
  const plugins: MigratePlugin[] = [];

  for (const searchDir of pluginSearchDirs(cwd)) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(searchDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const plugin = await loadPluginDir(join(searchDir, entry.name));
      if (plugin) plugins.push(plugin);
    }
  }

  return plugins;
}

// ---------------------------------------------------------------------------
// Load a single plugin by name from the search dirs
// ---------------------------------------------------------------------------

export async function loadPlugin(
  name: string,
  cwd: string
): Promise<MigratePlugin | null> {
  for (const searchDir of pluginSearchDirs(cwd)) {
    const plugin = await loadPluginDir(join(searchDir, name));
    if (plugin) return plugin;
  }
  return null;
}

// ---------------------------------------------------------------------------
// List all installed plugin names across all search dirs
// ---------------------------------------------------------------------------

export async function listPlugins(cwd: string): Promise<Array<{ name: string; version: string; dir: string }>> {
  const seen = new Set<string>();
  const result: Array<{ name: string; version: string; dir: string }> = [];

  for (const searchDir of pluginSearchDirs(cwd)) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(searchDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const pluginDir = join(searchDir, entry.name);
      const plugin = await loadPluginDir(pluginDir);
      if (plugin) {
        seen.add(entry.name);
        result.push({ name: plugin.name, version: plugin.version, dir: pluginDir });
      }
    }
  }

  return result;
}
