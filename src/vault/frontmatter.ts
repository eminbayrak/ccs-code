import { promises as fs } from "fs";

export type FrontmatterData = Record<string, unknown>;

export type ParsedNote = {
  frontmatter: FrontmatterData;
  body: string;
};

const FM_DELIMITER = "---";

export function parseFrontmatter(raw: string): ParsedNote {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== FM_DELIMITER) {
    return { frontmatter: {}, body: raw };
  }
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === FM_DELIMITER);
  if (closeIdx === -1) {
    return { frontmatter: {}, body: raw };
  }
  const yamlLines = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join("\n");
  const frontmatter = parseSimpleYaml(yamlLines.join("\n"));
  return { frontmatter, body };
}

export function serializeFrontmatter(data: FrontmatterData, body: string): string {
  const yaml = Object.entries(data)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map((i) => JSON.stringify(i)).join(", ")}]`;
      if (typeof v === "string" && v.includes(":")) return `${k}: "${v}"`;
      return `${k}: ${v}`;
    })
    .join("\n");
  return `---\n${yaml}\n---\n${body}`;
}

/** Minimal YAML subset: string, number, boolean, string arrays */
function parseSimpleYaml(yaml: string): FrontmatterData {
  const result: FrontmatterData = {};
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1);
      result[key] = inner
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (raw === "true") {
      result[key] = true;
    } else if (raw === "false") {
      result[key] = false;
    } else if (/^\d+(\.\d+)?$/.test(raw)) {
      result[key] = Number(raw);
    } else {
      result[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

export async function loadNote(filePath: string): Promise<ParsedNote> {
  const raw = await fs.readFile(filePath, "utf-8");
  return parseFrontmatter(raw);
}

export async function saveNote(
  filePath: string,
  frontmatter: FrontmatterData,
  body: string,
): Promise<void> {
  const content = serializeFrontmatter(frontmatter, body);
  await fs.writeFile(filePath, content, "utf-8");
}
