import { promises as fs } from "fs";
import { join, basename, extname } from "path";

type WikiPage = { filename: string; content: string };

const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ").trim();
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function updateFrontmatterField(raw: string, key: string, value: string): string {
  const fmRe = /^---\n([\s\S]*?)\n---\n/;
  const m = raw.match(fmRe);
  if (!m) return raw;
  const fm = m[1]!;
  const updated = fm.includes(`${key}:`)
    ? fm.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`)
    : fm + `\n${key}: ${value}`;
  return raw.replace(fmRe, `---\n${updated}\n---\n`);
}

// ---------------------------------------------------------------------------
// HTML → wiki page (merge if exists)
// ---------------------------------------------------------------------------

async function ingestHtml(filePath: string, vaultPath: string): Promise<WikiPage[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  const text = stripHtml(raw);
  const name = basename(filePath, extname(filePath));
  const slug = slugify(name);
  const dest = `wiki/concepts/${slug}.md`;
  const fullDest = join(vaultPath, dest);

  let content: string;
  try {
    // Page exists — update last_synced and append if content grew
    const existing = await fs.readFile(fullDest, "utf-8");
    const existingBody = existing.replace(/^---[\s\S]*?---\n/, "").trim();
    const newBody = text.slice(0, 6000);
    if (existingBody === newBody) return []; // unchanged

    content = updateFrontmatterField(existing, "last_synced", TODAY);
    // Replace body after frontmatter
    content = content.replace(/^(---[\s\S]*?---\n)[\s\S]*$/, `$1\n# ${name.replace(/-|_/g, " ")}\n\n${newBody}\n`);
  } catch {
    // New page
    content = [
      "---",
      `title: ${name.replace(/-|_/g, " ")}`,
      `type: concept`,
      `source: raw/${filePath.replace(vaultPath + "/raw/", "")}`,
      `last_synced: ${TODAY}`,
      `staleness: fresh`,
      "---",
      "",
      `# ${name.replace(/-|_/g, " ")}`,
      "",
      text.slice(0, 6000),
    ].join("\n");
  }

  return [{ filename: dest, content }];
}

// ---------------------------------------------------------------------------
// Claude conversations.json → one page per conversation (merge if exists)
// ---------------------------------------------------------------------------

type ClaudeMessage = {
  sender?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
};

type ClaudeConversation = {
  uuid?: string;
  name?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeMessage[];
};

function renderMessages(messages: ClaudeMessage[]): string[] {
  const lines: string[] = [];
  for (const msg of messages) {
    const sender = msg.sender === "human" ? "**You**" : "**Claude**";
    let text = msg.text ?? "";
    if (!text && Array.isArray(msg.content)) {
      text = msg.content.map(c => c.text ?? "").join(" ");
    }
    if (text.trim()) {
      lines.push(`${sender}: ${text.slice(0, 300)}`);
      lines.push("");
    }
  }
  return lines;
}

async function ingestConversationsJson(
  filePath: string,
  vaultPath: string,
): Promise<{ pages: WikiPage[]; updated: string[] }> {
  const raw = await fs.readFile(filePath, "utf-8");
  let data: ClaudeConversation[];
  try { data = JSON.parse(raw); }
  catch { return { pages: [], updated: [] }; }
  if (!Array.isArray(data)) return { pages: [], updated: [] };

  const pages: WikiPage[] = [];
  const updated: string[] = [];

  for (const conv of data) {
    const title = conv.name || conv.uuid || "untitled";
    const slug = slugify(title);
    const date = conv.created_at ? conv.created_at.slice(0, 10) : "unknown";
    const dest = `wiki/conversations/${slug}.md`;
    const fullDest = join(vaultPath, dest);
    const messages = conv.chat_messages ?? [];
    const summaryLines = conv.summary ? ["## Summary", "", conv.summary, ""] : [];

    let content: string;
    try {
      const existing = await fs.readFile(fullDest, "utf-8");
      const existingMsgCount = (existing.match(/\*\*You\*\*:/g) ?? []).length;
      const newMsgCount = messages.filter(m => m.sender === "human").length;

      if (newMsgCount <= existingMsgCount) continue; // no new messages

      // Merge: append only the new messages beyond what's already there
      const newMessages = messages.slice(existingMsgCount * 2); // rough slice
      const appendLines = renderMessages(newMessages);
      content = updateFrontmatterField(existing, "last_synced", TODAY)
        .trimEnd() + "\n\n" + appendLines.join("\n") + "\n";
      updated.push(dest);
    } catch {
      // New page
      const msgLines = renderMessages(messages);
      content = [
        "---",
        `title: "${title.replace(/"/g, "'")}"`,
        `type: conversation`,
        `date: ${date}`,
        `source: claude-export`,
        `last_synced: ${TODAY}`,
        `staleness: fresh`,
        "---",
        "",
        `# ${title}`,
        "",
        `*${date}*`,
        "",
        ...summaryLines,
        ...msgLines,
      ].join("\n");
      pages.push({ filename: dest, content });
    }
  }

  return { pages, updated };
}

// ---------------------------------------------------------------------------
// Public: ingest all files in raw/
// ---------------------------------------------------------------------------

export async function ingestAll(vaultPath: string): Promise<{
  written: string[];
  updated: string[];
  skipped: string[];
  errors: string[];
}> {
  const rawDir = join(vaultPath, "raw");
  const written: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  const INGESTABLE = new Set([".html", ".json"]);

  const allFiles: string[] = [];
  async function walk(dir: string) {
    let entries: import("fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "README.md") continue;
      if (e.isDirectory()) await walk(join(dir, e.name));
      else allFiles.push(join(dir, e.name));
    }
  }
  await walk(rawDir);

  for (const filePath of allFiles) {
    const ext = extname(filePath).toLowerCase();
    if (!INGESTABLE.has(ext)) { skipped.push(basename(filePath)); continue; }

    try {
      if (ext === ".html") {
        const pages = await ingestHtml(filePath, vaultPath);
        for (const page of pages) {
          const fullPath = join(vaultPath, page.filename);
          await fs.mkdir(fullPath.replace(/\/[^/]+$/, ""), { recursive: true });
          // If file existed, ingestHtml already merged — this is an update
          let existed = false;
          try { await fs.access(fullPath); existed = true; } catch {}
          await fs.writeFile(fullPath, page.content, "utf-8");
          (existed ? updated : written).push(page.filename);
        }
      } else if (ext === ".json" && basename(filePath) === "conversations.json") {
        const { pages, updated: mergedPaths } = await ingestConversationsJson(filePath, vaultPath);
        for (const page of pages) {
          const fullPath = join(vaultPath, page.filename);
          await fs.mkdir(fullPath.replace(/\/[^/]+$/, ""), { recursive: true });
          await fs.writeFile(fullPath, page.content, "utf-8");
          written.push(page.filename);
        }
        updated.push(...mergedPaths);
      } else {
        skipped.push(basename(filePath));
      }
    } catch (e) {
      errors.push(`${basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { written, updated, skipped, errors };
}
