import { promises as fs } from "fs";
import { join, basename } from "path";

export type SearchResult = {
  id: string;
  title: string;
  type: string;
  score: number;
  snippet: string;
  content: string;
  path: string;
};

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","been","have","has","had","do","does",
  "did","will","would","could","should","not","this","that","these","those",
  "i","you","he","she","it","we","they","what","how","when","where","who","why",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

function parseFrontmatter(raw: string): { title: string; type: string; tags: string[]; summary: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  let title = "", type = "unknown", tags: string[] = [], summary = "";
  if (m) {
    const fm = m[1] ?? "";
    title   = fm.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1]?.trim() ?? "";
    type    = fm.match(/^type:\s*(.+)$/m)?.[1]?.trim() ?? "unknown";
    summary = fm.match(/^summary:\s*"?(.+?)"?\s*$/m)?.[1]?.trim() ?? "";
    const tagM = fm.match(/^tags:\s*\[(.+)\]/m);
    if (tagM) tags = tagM[1]!.split(",").map(t => t.trim().replace(/"/g, ""));
  }
  return { title, type, tags, summary };
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?---\n/, "").trim();
}

function scoreDocument(queryTokens: string[], docTokens: string[], titleTokens: string[], tags: string[]): number {
  if (queryTokens.length === 0) return 0;

  const docFreq = new Map<string, number>();
  for (const t of docTokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);

  let score = 0;
  for (const qt of queryTokens) {
    // Title match (5x weight)
    if (titleTokens.includes(qt)) score += 5;
    // Tag match (3x weight)
    if (tags.some(tag => tag.toLowerCase().includes(qt))) score += 3;
    // Body match (1x weight, TF component)
    const freq = docFreq.get(qt) ?? 0;
    if (freq > 0) score += 1 + Math.log(freq);
  }

  // Normalize by query length
  return score / queryTokens.length;
}

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

export async function searchWiki(
  wikiDir: string,
  query: string,
  topK = 5,
): Promise<SearchResult[]> {
  const files = await walkMd(wikiDir);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const results: SearchResult[] = [];

  for (const fpath of files) {
    const raw = await fs.readFile(fpath, "utf-8");
    const { title, type, tags, summary } = parseFrontmatter(raw);
    const body = stripFrontmatter(raw);
    const id = basename(fpath, ".md");

    const docTokens = tokenize(`${title} ${summary} ${body}`);
    const titleTokens = tokenize(title);
    const score = scoreDocument(queryTokens, docTokens, titleTokens, tags);

    if (score > 0) {
      // Build a snippet: first 200 chars of body that contain a query term
      const lines = body.split("\n").filter(l => l.trim());
      const snippetLine = lines.find(l =>
        queryTokens.some(qt => l.toLowerCase().includes(qt))
      ) ?? lines[0] ?? "";
      const snippet = snippetLine.slice(0, 200);

      results.push({ id, title: title || id, type, score, snippet, content: raw, path: fpath });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
