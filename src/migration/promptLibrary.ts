/**
 * PromptLibrary — versioned, file-based migration prompt templates.
 *
 * Each prompt lives in: vault/migrations/prompts/<name>.md
 * Prompts are plain Markdown — human-editable, git-committable, testable.
 *
 * A prompt file MUST contain these sections (used for auto-selection):
 *   ## Trigger Keywords   — comma-separated words for auto-matching
 *   ## Languages          — comma-separated target languages
 *   ## What to Change     — the actual transformation rules
 *   ## Before / ## After  — examples
 *   ## Edge Cases         — exceptions and how to handle them
 *   ## Forbidden Patterns — patterns that must not exist after migration
 *   ## Acceptance Criteria — checklist items
 */

import { promises as fs } from "fs";
import { join, basename, extname } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PromptMeta = {
  /** Filename without extension, e.g. "commonjs-to-esm" */
  name: string;
  /** Full absolute path */
  path: string;
  /** Keywords from ## Trigger Keywords section */
  keywords: string[];
  /** Languages from ## Languages section */
  languages: string[];
  /** Patterns from ## Forbidden Patterns section */
  forbiddenPatterns: string[];
  /** Raw file content */
  content: string;
};

// ---------------------------------------------------------------------------
// Library location
// ---------------------------------------------------------------------------

function defaultPromptsDir(): string {
  return join(process.cwd(), "vault", "migrations", "prompts");
}

// ---------------------------------------------------------------------------
// Load / list
// ---------------------------------------------------------------------------

export async function listPrompts(promptsDir?: string): Promise<PromptMeta[]> {
  const dir = promptsDir ?? defaultPromptsDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const metas: PromptMeta[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const path = join(dir, file);
    try {
      const content = await fs.readFile(path, "utf-8");
      metas.push(parsePromptMeta(path, content));
    } catch {
      // skip unreadable files
    }
  }
  return metas;
}

export async function loadPrompt(promptPath: string): Promise<PromptMeta> {
  const content = await fs.readFile(promptPath, "utf-8");
  return parsePromptMeta(promptPath, content);
}

// ---------------------------------------------------------------------------
// Auto-select best matching prompt for a natural language description
// ---------------------------------------------------------------------------

export async function findBestPrompt(
  description: string,
  promptsDir?: string,
): Promise<PromptMeta | null> {
  const prompts = await listPrompts(promptsDir);
  if (prompts.length === 0) return null;

  const descLower = description.toLowerCase();
  let bestScore = 0;
  let best: PromptMeta | null = null;

  for (const prompt of prompts) {
    let score = 0;
    for (const kw of prompt.keywords) {
      if (descLower.includes(kw.toLowerCase())) score += 2;
    }
    // Also score against name tokens
    const nameTokens = prompt.name.split("-");
    for (const token of nameTokens) {
      if (descLower.includes(token.toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = prompt;
    }
  }

  return bestScore > 0 ? best : null;
}

// ---------------------------------------------------------------------------
// Parser — extracts metadata from prompt content
// ---------------------------------------------------------------------------

function extractSection(content: string, heading: string): string {
  const pattern = new RegExp(
    `##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    "i",
  );
  const match = content.match(pattern);
  return match?.[1] != null ? match[1].trim() : "";
}

function extractListItems(section: string): string[] {
  return section
    .split("\n")
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function parsePromptMeta(path: string, content: string): PromptMeta {
  const name = basename(path, extname(path));

  const keywordsRaw = extractSection(content, "Trigger Keywords");
  const keywords = keywordsRaw
    ? keywordsRaw.split(",").map((k) => k.trim()).filter(Boolean)
    : name.split("-");

  const langsRaw = extractSection(content, "Languages");
  const languages = langsRaw
    ? langsRaw.split(",").map((l) => l.trim()).filter(Boolean)
    : [];

  const forbiddenRaw = extractSection(content, "Forbidden Patterns");
  const forbiddenPatterns = extractListItems(forbiddenRaw);

  return { name, path, keywords, languages, forbiddenPatterns, content };
}

// ---------------------------------------------------------------------------
// Create a blank prompt template
// ---------------------------------------------------------------------------

export async function createPromptTemplate(
  name: string,
  promptsDir?: string,
): Promise<string> {
  const dir = promptsDir ?? defaultPromptsDir();
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.md`);

  const template = `# Migration: ${name}

## Trigger Keywords
${name.split("-").join(", ")}

## Languages
TypeScript, JavaScript

## What to Change
<!-- Describe the transformation rules here -->
1. Replace X with Y
2. Update all call sites

## Before
\`\`\`typescript
// Old code
\`\`\`

## After
\`\`\`typescript
// New code
\`\`\`

## Edge Cases
- <!-- Edge case 1 -->
- <!-- Edge case 2 -->

## Forbidden Patterns
- <!-- Pattern that must not exist after migration -->

## Acceptance Criteria
- [ ] All instances transformed
- [ ] Build passes
- [ ] Tests pass
- [ ] No forbidden patterns remain
`;

  await fs.writeFile(path, template, "utf-8");
  return path;
}
