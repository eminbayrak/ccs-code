// ---------------------------------------------------------------------------
// Semantic intent router — Feature 1 from features.md
//
// When the user types a natural-language migration request instead of an
// explicit subcommand, this module detects the intent and extracts the
// parameters needed to route to the correct handler.
//
// Two-tier approach:
//  1. Cheap heuristics (regex) — handles the common cases for free.
//  2. LLM extraction — only invoked when a repo URL is present but parameters
//     can't be extracted by regex alone.
//
// Returns null if the input doesn't look like a migration request.
// ---------------------------------------------------------------------------

import { createProvider } from "../llm/index.js";

export type RouterDecision = {
  handler: "scan" | "rewrite";
  repoUrl: string;
  targetLanguage: string;
  /** True when targetLanguage came from a hard default (e.g. "python") rather
   *  than an explicit hint in the user's input. The UI should ask the user
   *  to confirm or override before running anything when this is true. */
  targetLanguageWasInferred: boolean;
  org: string;
  sourceLanguage: string;
  autoConfirm: boolean;
  /** True when the user explicitly wants a neutral benchmark run that ignores
   *  local/company context docs. */
  noContext?: boolean;
  confidence: "heuristic" | "llm";
};

// ---------------------------------------------------------------------------
// Language alias normalisation
// ---------------------------------------------------------------------------

const LANG_ALIASES: Record<string, string> = {
  "c#": "csharp", "cs": "csharp", ".net": "csharp", "dotnet": "csharp",
  "asp.net": "csharp", "aspnet": "csharp",
  "ts": "typescript", "node": "typescript", "nodejs": "typescript",
  "node.js": "typescript", "express": "typescript",
  "js": "javascript", "javascript": "javascript",
  "py": "python", "fastapi": "python", "django": "python", "flask": "python",
  "java": "java", "spring": "java", "springboot": "java",
  "go": "go", "golang": "go",
  "rb": "ruby", "rails": "ruby",
  "rs": "rust", "rust": "rust",
  "vb": "vb.net", "vb.net": "vb.net",
  "php": "php",
  "swift": "swift",
  "kt": "kotlin", "kotlin": "kotlin",
};

export function normaliseLang(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return LANG_ALIASES[lower] ?? lower;
}

/** Languages we accept as a one-word reply when asking the user to fill in
 *  a missing target. Used by the App's pending-migration clarification flow. */
export const SUPPORTED_TARGET_LANGUAGES = new Set([
  "csharp", "typescript", "javascript", "python", "java",
  "go", "ruby", "rust", "php", "swift", "kotlin", "vb.net",
]);

export function isSupportedTargetLanguage(value: string): boolean {
  return SUPPORTED_TARGET_LANGUAGES.has(normaliseLang(value));
}

// ---------------------------------------------------------------------------
// Heuristic extraction
// ---------------------------------------------------------------------------

const GITHUB_URL_RE = /https?:\/\/(?:www\.)?github(?:\.com|\.enterprise\S*?)\/[\w.-]+\/[\w.-]+/gi;
const GITLAB_URL_RE = /https?:\/\/gitlab\.com\/[\w.-]+\/[\w.-]+/gi;

const MIGRATION_KEYWORDS = [
  "migrat", "rewrite", "convert", "port", "modernize", "modernise",
  "legacy", "upgrade", "translate",
];

const TO_LANG_RE = /\b(?:to|into|using|in|with)\s+([a-zA-Z.#+]+(?:\s+\d+)?)/gi;
const FROM_LANG_RE = /\b(?:from|legacy)\s+([a-zA-Z.#+]+)/gi;

function extractRepoUrls(text: string): string[] {
  const found = new Set<string>();
  for (const re of [GITHUB_URL_RE, GITLAB_URL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.add(m[0]!.replace(/[.,;)]+$/, ""));
  }
  return [...found];
}

function extractLanguageHint(text: string, pattern: RegExp): string {
  const candidates: string[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const lang = normaliseLang(m[1]!);
    if (lang.length > 1) candidates.push(lang);
  }
  return candidates[0] ?? "";
}

function hasMigrationIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return MIGRATION_KEYWORDS.some((kw) => lower.includes(kw));
}

function isScanLike(text: string): boolean {
  const lower = text.toLowerCase();
  // "scan" intent: scanning external SOAP/WS service calls in a Node repo
  return /\b(scan|soap|wsdl|service[s]?|external|call[s]?|endpoint)\b/.test(lower);
}

function wantsNoContext(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(no context|without context|ignore context|skip context|neutral benchmark|benchmark run|public benchmark)\b/.test(lower);
}

// ---------------------------------------------------------------------------
// LLM-based extraction (only when heuristics can't get language)
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM = `You are a parameter extractor for a legacy migration CLI tool.
Extract migration task parameters from the user's natural language request.
Respond ONLY with a single-line JSON object — no markdown, no explanation.`;

const EXTRACTION_PROMPT = (text: string) => `User request:
"""
${text.slice(0, 800)}
"""

Extract these fields and return as JSON:
{
  "handler": "scan" or "rewrite",
  "repoUrl": "full GitHub URL or empty string",
  "targetLanguage": "csharp|typescript|python|java|go|ruby|php (or empty string)",
  "sourceLanguage": "csharp|typescript|python|java|go|vb6|delphi|cobol or empty string",
  "org": "GitHub org extracted from URL or empty string",
  "noContext": true if the user asks for no context, without context, benchmark, or neutral/public test run; otherwise false
}`;

async function llmExtract(text: string): Promise<Partial<RouterDecision> | null> {
  try {
    const provider = await createProvider("flash");
    const response = await provider.chat(
      [{ role: "user", content: EXTRACTION_PROMPT(text) }],
      EXTRACTION_SYSTEM,
    );

    const raw = response.trim().replace(/^```json|```$/g, "").trim();
    const parsed = JSON.parse(raw) as Partial<RouterDecision>;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to route a natural-language input to a migration handler.
 * Returns null if the input is not a migration request.
 * useLlm=false skips the LLM fallback (useful in tests).
 */
export async function routeIntent(
  input: string,
  useLlm = true,
): Promise<RouterDecision | null> {
  if (!hasMigrationIntent(input) && !extractRepoUrls(input).length) return null;

  const urls = extractRepoUrls(input);
  if (urls.length === 0) return null;

  const repoUrl = urls[0]!;

  // Extract org from URL
  const orgMatch = repoUrl.replace(/https?:\/\/[^/]+\//, "").split("/");
  const org = orgMatch[0] ?? "";

  // Heuristic language extraction
  let targetLang = extractLanguageHint(input, TO_LANG_RE);
  let sourceLang = extractLanguageHint(input, FROM_LANG_RE);
  let handler: "scan" | "rewrite" = isScanLike(input) ? "scan" : "rewrite";
  const noContext = wantsNoContext(input);

  if (targetLang) {
    return {
      handler,
      repoUrl,
      targetLanguage: targetLang,
      targetLanguageWasInferred: false,
      org,
      sourceLanguage: sourceLang,
      autoConfirm: false,
      noContext,
      confidence: "heuristic",
    };
  }

  // Fall back to LLM if heuristics didn't get a language
  if (!useLlm) {
    return {
      handler,
      repoUrl,
      targetLanguage: "",
      targetLanguageWasInferred: true,
      org,
      sourceLanguage: sourceLang,
      autoConfirm: false,
      noContext,
      confidence: "heuristic",
    };
  }

  const llmResult = await llmExtract(input);
  if (!llmResult) return null;

  const llmTarget = (llmResult.targetLanguage ?? "").trim();
  return {
    handler: llmResult.handler ?? handler,
    repoUrl: llmResult.repoUrl || repoUrl,
    targetLanguage: llmTarget || "",
    targetLanguageWasInferred: !llmTarget,
    org: llmResult.org || org,
    sourceLanguage: llmResult.sourceLanguage || sourceLang,
    autoConfirm: false,
    noContext: Boolean(llmResult.noContext) || noContext,
    confidence: "llm",
  };
}

function shortRepoLabel(decision: RouterDecision): string {
  const tail = decision.repoUrl.replace(/\/+$/, "").split("/").slice(-2).join("/");
  return tail || decision.repoUrl;
}

/**
 * Build the slash-command that the auto-router will execute on the user's
 * behalf. Returns null if the decision is missing the bits needed to run.
 */
export function decisionToSlashCommand(decision: RouterDecision): string | null {
  if (!decision.repoUrl || !decision.targetLanguage || decision.targetLanguageWasInferred) {
    return null;
  }
  if (decision.handler === "scan") {
    return `migrate scan --repo ${decision.repoUrl} --lang ${decision.targetLanguage} --yes`;
  }
  const contextFlag = decision.noContext ? " --no-context" : "";
  return `migrate rewrite --repo ${decision.repoUrl} --to ${decision.targetLanguage}${contextFlag} --yes`;
}

/**
 * Short acknowledgement printed when CCS auto-executes the migration.
 * Stays friendly and tells the user exactly what's running.
 */
export function formatRouterAck(decision: RouterDecision): string {
  const handlerLabel = decision.handler === "scan"
    ? "Scanning external service calls"
    : "Running full codebase rewrite analysis";
  const repoLabel = shortRepoLabel(decision);
  const sourceNote = decision.sourceLanguage ? ` (from ${decision.sourceLanguage})` : "";
  const contextNote = decision.noContext ? " · context disabled for neutral benchmark" : "";
  return [
    `${handlerLabel}: **${repoLabel}**${sourceNote} → \`${decision.targetLanguage}\`${contextNote}`,
    `_Detected from your message — type \`cancel\` after to stop, or type explicitly with \`/migrate\` next time._`,
  ].join("\n");
}

/**
 * Short clarifying question shown when the router has a repo but no target
 * language. The App stores the partial decision and treats the next user
 * message as the language reply.
 */
export function formatRouterClarification(decision: RouterDecision): string {
  const repoLabel = shortRepoLabel(decision);
  return [
    `Looks like you want to migrate **${repoLabel}**, but I couldn't tell the **target language** from your message.`,
    ``,
    `Reply with one word — for example \`csharp\`, \`typescript\`, \`python\`, \`java\`, or \`go\`. Type \`cancel\` to drop it.`,
  ].join("\n");
}

/**
 * Legacy formatter — kept so existing call sites that previously rendered the
 * verbose "re-run with this command" text still compile. New code paths
 * should use formatRouterAck / formatRouterClarification.
 */
export function formatRouterConfirmation(decision: RouterDecision): string {
  if (decision.targetLanguageWasInferred || !decision.targetLanguage) {
    return formatRouterClarification(decision);
  }
  return formatRouterAck(decision);
}
