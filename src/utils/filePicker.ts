import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import { join, relative } from "path";

export type FileEntry = {
  path: string;   // relative path from cwd, e.g. "src/utils/configLoader.ts"
  label: string;  // display label, same as path
};

const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".ccs", "dist", "build", ".next", "coverage",
]);

function toDisplayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Fast recursive directory walk (fallback when not in a git repo).
 * Skips common noise directories.
 */
async function walkDir(dir: string, base: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, base, results);
    } else if (entry.isFile()) {
      results.push(relative(base, full));
    }
  }
}

/**
 * Returns an ordered file list for the current project.
 * Strategy (mirrors Claude Code's fileSuggestions.ts):
 *   1. Try `git ls-files` — fast, respects .gitignore
 *   2. Fall back to recursive fs walk
 */
export async function getProjectFiles(cwd: string): Promise<FileEntry[]> {
  // --- Strategy 1: git ls-files ---
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();

    const paths = output.trim().split("\n").filter(Boolean).map(toDisplayPath);
    return paths.map((p) => ({ path: p, label: p }));
  } catch {
    // Not a git repo or git not installed — fall through
  }

  // --- Strategy 2: recursive walk ---
  const results: string[] = [];
  await walkDir(cwd, cwd, results);
  return results.map(toDisplayPath).map((p) => ({ path: p, label: p }));
}

/**
 * Filter a file list by a fuzzy query string.
 * Keeps entries that contain every character of the query in order
 * (similar to Cursor's fuzzy file picker).
 */
export function filterFiles(files: FileEntry[], query: string): FileEntry[] {
  if (!query) return files.slice(0, 15);

  const q = query.toLowerCase();
  return files
    .filter((f) => fuzzyMatch(f.path.toLowerCase(), q))
    .slice(0, 15);
}

function fuzzyMatch(text: string, query: string): boolean {
  let qi = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) qi++;
  }
  return qi === query.length;
}
