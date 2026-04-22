import { promises as fs } from "fs";
import { join, basename } from "path";
import type { LLMProvider } from "../llm/index.js";

type WikiEntry = { path: string; id: string; title: string; body: string };

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: import("fs").Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (e.name.endsWith(".md")) out.push(join(d, e.name));
    }
  }
  await walk(dir);
  return out;
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?---\n/, "").trim();
}

function getTitle(raw: string): string {
  const m = raw.match(/^title:\s*"?(.+?)"?$/m);
  return m?.[1]?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Ask the LLM to extract entities and related topics from a page
// ---------------------------------------------------------------------------

async function analyzePageWithLLM(
  provider: LLMProvider,
  pageTitle: string,
  pageBody: string,
  allTitles: string[],
): Promise<{ summary: string; relatedTitles: string[]; tags: string[] }> {
  const titlesSnippet = allTitles.slice(0, 80).join(", ");

  const prompt = `You are analyzing a wiki page from a personal knowledge base.

Page title: "${pageTitle}"

Page content (first 800 chars):
${pageBody.slice(0, 800)}

Other pages in this knowledge base (titles only):
${titlesSnippet}

Respond with ONLY valid JSON, no explanation:
{
  "summary": "one sentence summary of this page",
  "relatedTitles": ["exact title from the list above that is related", "another title"],
  "tags": ["keyword1", "keyword2", "keyword3"]
}

Rules:
- relatedTitles must be exact matches from the provided list
- relatedTitles: 2–5 items max, only genuinely related pages
- tags: 3–6 short keywords describing the topic
- summary: max 120 chars`;

  const response = await provider.chat(
    [{ role: "user", content: prompt }],
    "You extract structured knowledge from wiki pages. Always respond with valid JSON only.",
  );

  try {
    const json = response.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const parsed = JSON.parse(json);
    return {
      summary: parsed.summary ?? "",
      relatedTitles: Array.isArray(parsed.relatedTitles) ? parsed.relatedTitles : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    };
  } catch {
    return { summary: "", relatedTitles: [], tags: [] };
  }
}

// ---------------------------------------------------------------------------
// Rewrite a wiki page with enriched frontmatter + wikilinks appended
// ---------------------------------------------------------------------------

async function enrichPage(
  filePath: string,
  summary: string,
  relatedTitles: string[],
  tags: string[],
  titleToId: Map<string, string>,
): Promise<void> {
  const raw = await fs.readFile(filePath, "utf-8");

  // Update frontmatter — inject summary and tags
  let updated = raw;

  if (summary && !raw.includes("summary:")) {
    updated = updated.replace(/^(---\n[\s\S]*?)(---\n)/, `$1summary: "${summary.replace(/"/g, "'")}"\n$2`);
  }
  if (tags.length > 0 && !raw.includes("tags:")) {
    updated = updated.replace(/^(---\n[\s\S]*?)(---\n)/, `$1tags: [${tags.map(t => `"${t}"`).join(", ")}]\n$2`);
  }

  // Append Related section with [[wikilinks]] if not already present
  if (relatedTitles.length > 0 && !updated.includes("## Related")) {
    const wikilinks = relatedTitles
      .map(t => {
        const id = titleToId.get(t);
        return id ? `- [[${id}]]` : null;
      })
      .filter(Boolean)
      .join("\n");

    if (wikilinks) {
      updated = updated.trimEnd() + `\n\n## Related\n\n${wikilinks}\n`;
    }
  }

  if (updated !== raw) {
    await fs.writeFile(filePath, updated, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Public: enrich wiki pages in batches
// ---------------------------------------------------------------------------

export type EnrichProgress = {
  total: number;
  done: number;
  current: string;
  enriched: number;
  errors: number;
};

export async function enrichWiki(
  vaultPath: string,
  provider: LLMProvider,
  onProgress?: (p: EnrichProgress) => void,
  batchSize = 10,
): Promise<{ enriched: number; errors: number }> {
  const wikiDir = join(vaultPath, "wiki");
  const files = await walkMd(wikiDir);

  // Only process pages that haven't been enriched yet (no "summary:" in frontmatter)
  const unenriched: WikiEntry[] = [];
  for (const fpath of files) {
    const raw = await fs.readFile(fpath, "utf-8");
    if (raw.includes("summary:")) continue; // already enriched
    const title = getTitle(raw);
    const body = stripFrontmatter(raw);
    const id = basename(fpath, ".md");
    unenriched.push({ path: fpath, id, title: title || id, body });
  }

  if (unenriched.length === 0) return { enriched: 0, errors: 0 };

  // Build title → id map for wikilink resolution
  const titleToId = new Map<string, string>();
  for (const e of unenriched) titleToId.set(e.title, e.id);

  const allTitles = unenriched.map(e => e.title);
  let enriched = 0;
  let errors = 0;

  for (let i = 0; i < unenriched.length; i += batchSize) {
    const batch = unenriched.slice(i, i + batchSize);

    await Promise.all(batch.map(async (entry) => {
      onProgress?.({ total: unenriched.length, done: i, current: entry.title, enriched, errors });
      try {
        const { summary, relatedTitles, tags } = await analyzePageWithLLM(
          provider, entry.title, entry.body, allTitles,
        );
        await enrichPage(entry.path, summary, relatedTitles, tags, titleToId);
        enriched++;
      } catch {
        errors++;
      }
    }));
  }

  return { enriched, errors };
}
