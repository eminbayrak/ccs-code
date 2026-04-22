import { promises as fs } from "fs";
import { join } from "path";
import { parseFrontmatter } from "./frontmatter.js";

export type IndexEntry = {
  slug: string;
  type: string;
  tags: string[];
  last_synced: string;
  staleness: string;
  filePath: string;
};

export async function rebuildMasterIndex(wikiDir: string): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = [];

  async function walk(dir: string) {
    let files: import("fs").Dirent[];
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const f of files) {
      if (f.isDirectory()) {
        await walk(join(dir, f.name));
      } else if (f.isFile() && f.name.endsWith(".md") && !f.name.startsWith("_")) {
        const fullPath = join(dir, f.name);
        try {
          const raw = await fs.readFile(fullPath, "utf-8");
          const { frontmatter } = parseFrontmatter(raw);
          entries.push({
            slug: f.name.replace(/\.md$/, ""),
            type: String(frontmatter.type ?? "concept"),
            tags: Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : [],
            last_synced: String(frontmatter.last_synced ?? ""),
            staleness: String(frontmatter.staleness ?? "fresh"),
            filePath: fullPath,
          });
        } catch {
          // skip unreadable
        }
      }
    }
  }

  await walk(wikiDir);

  const lines = [
    "# Knowledge Base Master Index",
    "",
    `_Last rebuilt: ${new Date().toISOString()}_`,
    `_Total pages: ${entries.length}_`,
    "",
    "## Services",
    "",
    ...entries
      .filter((e) => e.type === "service")
      .map((e) => `- [[${e.slug}]] — ${e.tags.join(", ")} — ${e.staleness}`),
    "",
    "## Architecture Decisions (ADRs)",
    "",
    ...entries
      .filter((e) => e.type === "adr")
      .map((e) => `- [[${e.slug}]]`),
    "",
    "## Patterns",
    "",
    ...entries
      .filter((e) => e.type === "pattern")
      .map((e) => `- [[${e.slug}]]`),
    "",
    "## People",
    "",
    ...entries
      .filter((e) => e.type === "person")
      .map((e) => `- [[${e.slug}]]`),
    "",
    "## Concepts",
    "",
    ...entries
      .filter((e) => e.type === "concept")
      .map((e) => `- [[${e.slug}]]`),
  ];

  const indexPath = join(wikiDir, "_master-index.md");
  await fs.writeFile(indexPath, lines.join("\n"), "utf-8");

  return entries;
}
