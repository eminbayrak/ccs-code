import { promises as fs } from "fs";
import { join } from "path";
import type { MigratePlugin, ServiceReference, ScanResult, ServiceGroup } from "./types.js";

// ---------------------------------------------------------------------------
// Generic plugin runner — no scanning logic here.
// Calls plugin.scan() on each file, aggregates results.
// ---------------------------------------------------------------------------

export function runPluginScan(
  files: Array<{ path: string; content: string }>,
  plugin: MigratePlugin
): ScanResult {
  const allowed = new Set(plugin.fileExtensions);
  const references: ServiceReference[] = [];
  let filesScanned = 0;
  let filesWithRefs = 0;

  for (const { path, content } of files) {
    const ext = path.slice(path.lastIndexOf("."));
    if (!allowed.has(ext)) continue;

    filesScanned++;
    const found = plugin.scan(path, content);
    if (found.length > 0) {
      filesWithRefs++;
      references.push(...found);
    }
  }

  return { references, filesScanned, filesWithRefs };
}

// ---------------------------------------------------------------------------
// Filesystem scanner — reads files from a local directory, then runs plugin
// ---------------------------------------------------------------------------

export async function scanDirectory(
  rootDir: string,
  plugin: MigratePlugin
): Promise<ScanResult> {
  const files: Array<{ path: string; content: string }> = [];
  const allowed = new Set(plugin.fileExtensions);

  async function walk(dir: string) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (!allowed.has(ext)) continue;
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          files.push({ path: fullPath, content });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(rootDir);
  return runPluginScan(files, plugin);
}

// ---------------------------------------------------------------------------
// Group references by namespace — one group per external service
// ---------------------------------------------------------------------------

export function groupByNamespace(references: ServiceReference[]): ServiceGroup {
  const map: ServiceGroup = new Map();
  for (const ref of references) {
    const existing = map.get(ref.serviceNamespace) ?? [];
    existing.push(ref);
    map.set(ref.serviceNamespace, existing);
  }
  return map;
}
