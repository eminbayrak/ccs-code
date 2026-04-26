// ---------------------------------------------------------------------------
// Verification pass. Re-reads the source code an analyzer cited and asks the
// LLM "does this code actually support the claim?" for source-observable facts
// — business rules, contract fields, and migration risks. Architecture
// disposition is recorded here for review, but it is not expected to have a
// literal source-line proof because target landing zones come from code shape
// plus modernization context.
// ---------------------------------------------------------------------------

import type { LLMProvider } from "../llm/providers/base.js";
import type { ComponentAnalysis } from "./rewriteTypes.js";
import { findEvidenceForStatement, type EvidenceItem } from "./evidence.js";

export type VerificationOutcome =
  | "verified"
  | "unsupported"
  | "inconclusive"
  | "no_evidence";

export type ClaimKind =
  | "business_rule"
  | "input_contract"
  | "output_contract"
  | "target_role"
  | "migration_risk"
  | "purpose";

export type VerifiedClaim = {
  id: string;
  kind: ClaimKind;
  statement: string;
  loadBearing: boolean;
  evidence: EvidenceItem | null;
  quotedSource: string | null;
  outcome: VerificationOutcome;
  reason: string;
};

export type TrustVerdict = "ready" | "needs_review" | "blocked";

export type ComponentVerification = {
  component: string;
  generatedAt: string;
  verifierModel: string;
  trustVerdict: TrustVerdict;
  trustReasons: string[];
  totals: {
    claimsChecked: number;
    verified: number;
    unsupported: number;
    inconclusive: number;
    noEvidence: number;
  };
  claims: VerifiedClaim[];
  /** Set when verification could not run (LLM failed, malformed output). */
  error?: string;
};

const MAX_QUOTE_LINES = 40;
const MAX_CLAIMS_PER_COMPONENT = 32;
const VERIFIER_SYSTEM =
  "You verify whether quoted source code supports specific claims about its behavior. " +
  "Be strict: only mark a claim 'verified' if the quoted lines literally show it. " +
  "If the quoted lines are silent, mark 'inconclusive'. If they contradict the claim, mark 'unsupported'. " +
  "Respond with valid JSON only.";

// ---------------------------------------------------------------------------
// Claim collection — what we actually check
// ---------------------------------------------------------------------------

type RawClaim = {
  id: string;
  kind: ClaimKind;
  statement: string;
  loadBearing: boolean;
  evidenceKind: string;
};

function collectClaims(analysis: ComponentAnalysis): RawClaim[] {
  const claims: RawClaim[] = [];
  let counter = 0;
  const nextId = () => `c${++counter}`;

  // Purpose — descriptive, not load-bearing for implementation but useful to flag.
  if (analysis.purpose && analysis.purpose !== "unknown") {
    claims.push({
      id: nextId(),
      kind: "purpose",
      statement: analysis.purpose,
      loadBearing: false,
      evidenceKind: "purpose",
    });
  }

  // Business rules — load-bearing. Each rule Codex would preserve.
  for (const rule of analysis.businessRules) {
    if (!rule.trim()) continue;
    claims.push({
      id: nextId(),
      kind: "business_rule",
      statement: rule,
      loadBearing: true,
      evidenceKind: "business_rule",
    });
  }

  // Input contract — load-bearing. The shape Codex implements against.
  for (const [field, type] of Object.entries(analysis.inputContract)) {
    if (!field || !type) continue;
    claims.push({
      id: nextId(),
      kind: "input_contract",
      statement: `Input contract: \`${field}\` is \`${type}\``,
      loadBearing: true,
      evidenceKind: "data_contract",
    });
  }

  // Output contract — load-bearing.
  for (const [field, type] of Object.entries(analysis.outputContract)) {
    if (!field || !type) continue;
    claims.push({
      id: nextId(),
      kind: "output_contract",
      statement: `Output contract: \`${field}\` is \`${type}\``,
      loadBearing: true,
      evidenceKind: "data_contract",
    });
  }

  // Target role — important, but not a strict source-line verification target.
  // A source file can show "this is an HTTP route" or "this calls SOAP"; it
  // cannot literally prove "this should become an ASP.NET Core Web API".
  // Human questions and architecture-baseline.md gate that decision separately.
  if (analysis.targetRole && analysis.targetRole !== "unknown") {
    const rationale = analysis.targetRoleRationale && analysis.targetRoleRationale !== "unknown"
      ? analysis.targetRoleRationale
      : `belongs in target role ${analysis.targetRole}`;
    claims.push({
      id: nextId(),
      kind: "target_role",
      statement: `Target landing zone is \`${analysis.targetRole}\` because: ${rationale}`,
      loadBearing: false,
      evidenceKind: "purpose",
    });
  }

  // Migration risks — flagging these as unsupported is informative but not a
  // hard gate, since they're forward-looking warnings.
  for (const risk of analysis.migrationRisks) {
    if (!risk.trim()) continue;
    claims.push({
      id: nextId(),
      kind: "migration_risk",
      statement: risk,
      loadBearing: false,
      evidenceKind: "migration_note",
    });
  }

  return claims.slice(0, MAX_CLAIMS_PER_COMPONENT);
}

// ---------------------------------------------------------------------------
// Quoting cited source ranges
// ---------------------------------------------------------------------------

export function quoteSourceRange(
  files: Map<string, string>,
  sourceFile: string | null,
  lineStart: number | null,
  lineEnd: number | null,
): string | null {
  if (!sourceFile) return null;
  const content = files.get(sourceFile);
  if (typeof content !== "string") return null;

  const lines = content.split("\n");
  const start = Math.max(1, lineStart ?? 1);
  const end = Math.min(
    lines.length,
    Math.max(start, lineEnd ?? lineStart ?? start),
    start + MAX_QUOTE_LINES - 1,
  );
  if (start > lines.length) return null;

  const width = String(end).length;
  const slice = [];
  for (let i = start; i <= end; i++) {
    slice.push(`${String(i).padStart(width, "0")} | ${lines[i - 1] ?? ""}`);
  }
  return slice.join("\n");
}

function findClaimEvidence(analysis: ComponentAnalysis, claim: RawClaim): EvidenceItem | null {
  const direct = findEvidenceForStatement(analysis.evidence, claim.statement, claim.evidenceKind);
  if (direct) return direct;
  // Loose fallback: any evidence with the same kind helps for contract claims
  // where the LLM tends to phrase the evidence as "field X exists" rather than
  // mirroring our "Input contract: ..." wrapper.
  if (claim.kind === "input_contract" || claim.kind === "output_contract") {
    const fieldMatch = claim.statement.match(/`([^`]+)`/);
    const fieldName = fieldMatch?.[1];
    if (fieldName) {
      return analysis.evidence.find((item) =>
        item.kind === claim.evidenceKind &&
        item.statement.toLowerCase().includes(fieldName.toLowerCase())
      ) ?? null;
    }
  }
  if (claim.kind === "target_role") {
    return analysis.evidence.find((item) => item.kind === "purpose") ?? null;
  }
  return null;
}

function findContractEvidenceInSource(
  analysis: ComponentAnalysis,
  claim: RawClaim,
  files: Map<string, string>,
): EvidenceItem | null {
  if (claim.kind !== "input_contract" && claim.kind !== "output_contract") return null;
  const fieldMatch = claim.statement.match(/`([^`]+)`/);
  const fieldName = fieldMatch?.[1]?.trim();
  if (!fieldName || fieldName === "unknown") return null;

  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = fieldName.split(".").filter(Boolean);
  const lastWord = words[words.length - 1] ?? fieldName;
  const lastEscaped = lastWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pascal = lastWord ? lastWord[0]?.toUpperCase() + lastWord.slice(1) : fieldName;
  const pascalEscaped = pascal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    new RegExp(`\\b${escaped}\\b`, "i"),
    new RegExp(`\\b(params|query|body|session|headers)\\.${lastEscaped}\\b`, "i"),
    new RegExp(`\\b${lastEscaped}\\s*:`, "i"),
    new RegExp(`\\b${lastEscaped}\\b`, "i"),
    new RegExp(`\\b${pascalEscaped}\\b`),
  ];

  for (const sourcePath of analysis.component.filePaths) {
    const content = files.get(sourcePath);
    if (!content) continue;
    const lines = content.split("\n");
    const index = lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)));
    if (index === -1) continue;
    const lineNumber = index + 1;
    return {
      kind: "data_contract",
      statement: claim.statement,
      basis: "observed",
      confidence: "medium",
      sourceFile: sourcePath,
      lineStart: Math.max(1, lineNumber - 2),
      lineEnd: Math.min(lines.length, lineNumber + 2),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Prompt + parse
// ---------------------------------------------------------------------------

type ClaimPromptItem = {
  raw: RawClaim;
  evidence: EvidenceItem;
  quoted: string;
};

function buildVerifierPrompt(componentName: string, items: ClaimPromptItem[]): string {
  const blocks = items.map((item, index) => {
    const ref = `${item.evidence.sourceFile}:L${item.evidence.lineStart ?? "?"}-${item.evidence.lineEnd ?? item.evidence.lineStart ?? "?"}`;
    return [
      `--- claim ${index + 1} (id=${item.raw.id}, kind=${item.raw.kind}) ---`,
      `Statement: ${item.raw.statement}`,
      `Cited source: ${ref}`,
      `Quoted source:`,
      item.quoted,
    ].join("\n");
  }).join("\n\n");

  return [
    `Verify whether each claim about the component "${componentName}" is supported by the quoted source code.`,
    "",
    "For each claim, output one of:",
    "- verified: the quoted lines literally show the behavior described.",
    "- unsupported: the quoted lines contradict the claim or the cited code does something different.",
    "- inconclusive: the quoted lines are too small or too generic to confirm the claim.",
    "",
    "Respond with ONLY this JSON shape:",
    `{ "results": [ { "id": "c1", "outcome": "verified", "reason": "one short sentence" } ] }`,
    "",
    "Claims:",
    blocks,
  ].join("\n");
}

type ParsedResult = { id: string; outcome: VerificationOutcome; reason: string };

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced?.[1] ?? raw).trim();
  const first = text.indexOf("{");
  if (first === -1) throw new Error("No JSON object in verifier response.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = first; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(first, i + 1);
    }
  }
  throw new Error("Unterminated JSON in verifier response.");
}

function parseResults(raw: string): ParsedResult[] {
  const json = JSON.parse(extractJson(raw)) as { results?: unknown };
  if (!Array.isArray(json.results)) {
    throw new Error("Verifier response missing `results` array.");
  }
  return json.results.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"] : null;
    const outcome = record["outcome"];
    const reason = typeof record["reason"] === "string" ? record["reason"].trim() : "";
    if (!id) return [];
    if (outcome !== "verified" && outcome !== "unsupported" && outcome !== "inconclusive") {
      return [];
    }
    return [{ id, outcome, reason }];
  });
}

// ---------------------------------------------------------------------------
// Verdict logic
// ---------------------------------------------------------------------------

function decideVerdict(claims: VerifiedClaim[]): { verdict: TrustVerdict; reasons: string[] } {
  const reasons: string[] = [];
  let verdict: TrustVerdict = "ready";

  const loadBearing = claims.filter((c) => c.loadBearing);
  const unsupportedLoadBearing = loadBearing.filter((c) => c.outcome === "unsupported");
  const noEvidenceLoadBearing = loadBearing.filter((c) => c.outcome === "no_evidence");
  const inconclusiveLoadBearing = loadBearing.filter((c) => c.outcome === "inconclusive");

  if (unsupportedLoadBearing.length > 0) {
    verdict = "needs_review";
    reasons.push(
      `${unsupportedLoadBearing.length} load-bearing claim(s) are not supported by the cited source: ${unsupportedLoadBearing
        .slice(0, 3)
        .map((c) => `${c.kind}:${c.statement}`)
        .join("; ")}`,
    );
  }

  if (noEvidenceLoadBearing.length > 2 && verdict === "ready") {
    verdict = "needs_review";
    reasons.push(`${noEvidenceLoadBearing.length} load-bearing claim(s) have no evidence citation`);
  }

  if (inconclusiveLoadBearing.length > 3 && verdict === "ready") {
    verdict = "needs_review";
    reasons.push(`${inconclusiveLoadBearing.length} load-bearing claim(s) are inconclusive`);
  }

  return { verdict, reasons };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function verifyComponent(
  analysis: ComponentAnalysis,
  sourceFiles: Array<{ path: string; content: string }>,
  flash: LLMProvider,
  options: { generatedAt?: string } = {},
): Promise<ComponentVerification> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const componentName = analysis.component.name;
  const fileMap = new Map(sourceFiles.map((file) => [file.path, file.content]));
  const rawClaims = collectClaims(analysis);

  // Pre-build the per-claim evidence + quoted source. Claims with no evidence
  // skip the LLM entirely — we already know the outcome.
  const verified: VerifiedClaim[] = [];
  const promptItems: ClaimPromptItem[] = [];

  for (const claim of rawClaims) {
    const evidence = findClaimEvidence(analysis, claim) ?? findContractEvidenceInSource(analysis, claim, fileMap);
    if (!evidence) {
      verified.push({
        id: claim.id,
        kind: claim.kind,
        statement: claim.statement,
        loadBearing: claim.loadBearing,
        evidence: null,
        quotedSource: null,
        outcome: "no_evidence",
        reason: "Analyzer produced this claim without a source citation.",
      });
      continue;
    }

    const quoted = quoteSourceRange(fileMap, evidence.sourceFile, evidence.lineStart, evidence.lineEnd);
    if (!quoted) {
      verified.push({
        id: claim.id,
        kind: claim.kind,
        statement: claim.statement,
        loadBearing: claim.loadBearing,
        evidence,
        quotedSource: null,
        outcome: "inconclusive",
        reason: `Cited source ${evidence.sourceFile}:L${evidence.lineStart ?? "?"} could not be retrieved or was empty.`,
      });
      continue;
    }

    promptItems.push({ raw: claim, evidence, quoted });
  }

  if (promptItems.length === 0) {
    const totals = aggregate(verified);
    const { verdict, reasons } = decideVerdict(verified);
    return {
      component: componentName,
      generatedAt,
      verifierModel: flash.name,
      trustVerdict: verdict,
      trustReasons: reasons,
      totals,
      claims: verified,
    };
  }

  let parsed: ParsedResult[] = [];
  let errorMessage: string | undefined;
  try {
    const response = await flash.chat(
      [{ role: "user", content: buildVerifierPrompt(componentName, promptItems) }],
      VERIFIER_SYSTEM,
    );
    parsed = parseResults(response);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const byId = new Map(parsed.map((r) => [r.id, r]));
  for (const item of promptItems) {
    const result = byId.get(item.raw.id);
    if (result) {
      verified.push({
        id: item.raw.id,
        kind: item.raw.kind,
        statement: item.raw.statement,
        loadBearing: item.raw.loadBearing,
        evidence: item.evidence,
        quotedSource: item.quoted,
        outcome: result.outcome,
        reason: result.reason || "(no reason provided)",
      });
    } else {
      verified.push({
        id: item.raw.id,
        kind: item.raw.kind,
        statement: item.raw.statement,
        loadBearing: item.raw.loadBearing,
        evidence: item.evidence,
        quotedSource: item.quoted,
        outcome: "inconclusive",
        reason: errorMessage
          ? `Verification call failed: ${errorMessage}`
          : "Verifier did not return a result for this claim.",
      });
    }
  }

  // Stable ordering by claim id so reports diff cleanly across runs.
  verified.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const totals = aggregate(verified);
  const { verdict, reasons } = decideVerdict(verified);
  const adjustedVerdict: TrustVerdict = errorMessage && verdict === "ready" ? "needs_review" : verdict;
  const adjustedReasons = errorMessage
    ? [...reasons, `Verifier call failed: ${errorMessage}`]
    : reasons;

  return {
    component: componentName,
    generatedAt,
    verifierModel: flash.name,
    trustVerdict: adjustedVerdict,
    trustReasons: adjustedReasons,
    totals,
    claims: verified,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}

function aggregate(claims: VerifiedClaim[]): ComponentVerification["totals"] {
  return {
    claimsChecked: claims.length,
    verified: claims.filter((c) => c.outcome === "verified").length,
    unsupported: claims.filter((c) => c.outcome === "unsupported").length,
    inconclusive: claims.filter((c) => c.outcome === "inconclusive").length,
    noEvidence: claims.filter((c) => c.outcome === "no_evidence").length,
  };
}

// ---------------------------------------------------------------------------
// Markdown formatting helpers — used by both per-component and summary reports
// ---------------------------------------------------------------------------

const OUTCOME_ICON: Record<VerificationOutcome, string> = {
  verified: "✓",
  unsupported: "✗",
  inconclusive: "?",
  no_evidence: "—",
};

const VERDICT_ICON: Record<TrustVerdict, string> = {
  ready: "✓ ready",
  needs_review: "⚠ needs_review",
  blocked: "✗ blocked",
};

export function formatVerificationMarkdown(verification: ComponentVerification): string {
  const lines: string[] = [];
  lines.push(`## Verification`);
  lines.push("");
  lines.push(`- **Trust verdict:** ${VERDICT_ICON[verification.trustVerdict]}`);
  lines.push(`- **Verifier model:** \`${verification.verifierModel}\``);
  lines.push(`- **Checked at:** ${verification.generatedAt}`);
  lines.push(
    `- **Totals:** ${verification.totals.verified} verified · ${verification.totals.unsupported} unsupported · ${verification.totals.inconclusive} inconclusive · ${verification.totals.noEvidence} no-evidence (${verification.totals.claimsChecked} total)`,
  );
  if (verification.trustReasons.length > 0) {
    lines.push(`- **Why:**`);
    for (const reason of verification.trustReasons) {
      lines.push(`  - ${reason}`);
    }
  }
  lines.push("");
  lines.push(`| | Kind | Claim | Source | Outcome | Reviewer note |`);
  lines.push(`|---|------|-------|--------|---------|---------------|`);
  for (const claim of verification.claims) {
    const ref = claim.evidence?.sourceFile
      ? `${claim.evidence.sourceFile}:L${claim.evidence.lineStart ?? "?"}${claim.evidence.lineEnd && claim.evidence.lineEnd !== claim.evidence.lineStart ? `-L${claim.evidence.lineEnd}` : ""}`
      : "_no citation_";
    const escapedStatement = claim.statement.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const escapedReason = claim.reason.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(
      `| ${OUTCOME_ICON[claim.outcome]} | ${claim.kind}${claim.loadBearing ? "*" : ""} | ${escapedStatement} | ${ref} | ${claim.outcome} | ${escapedReason} |`,
    );
  }
  lines.push("");
  lines.push("_Rows marked with `*` are load-bearing and gate the implementation status._");
  return lines.join("\n");
}

export function buildVerificationSummary(
  verifications: ComponentVerification[],
  meta: { repoUrl: string; generatedAt: string },
): string {
  const lines: string[] = [];
  lines.push(`# Verification Summary`);
  lines.push("");
  lines.push(`_Repo: ${meta.repoUrl}_`);
  lines.push(`_Generated: ${meta.generatedAt}_`);
  lines.push("");

  const ready = verifications.filter((v) => v.trustVerdict === "ready").length;
  const needsReview = verifications.filter((v) => v.trustVerdict === "needs_review").length;
  const blocked = verifications.filter((v) => v.trustVerdict === "blocked").length;

  lines.push(
    `**Trust posture:** ${ready} ready · ${needsReview} needs_review · ${blocked} blocked (of ${verifications.length} components)`,
  );
  lines.push("");
  lines.push("Components in `needs_review` or `blocked` should not be handed to a coding agent until a reviewer confirms or rewrites the flagged claims. Each per-component report under `components/<Component>.md` lists the exact claim, the cited source, and the verifier's reason.");
  lines.push("");

  lines.push(`| Component | Verdict | Verified | Unsupported | Inconclusive | No-evidence | Reasons |`);
  lines.push(`|-----------|---------|----------|-------------|--------------|-------------|---------|`);
  for (const v of verifications) {
    const reasons = v.trustReasons.length > 0
      ? v.trustReasons.join("; ").replace(/\|/g, "\\|").replace(/\n/g, " ")
      : "—";
    lines.push(
      `| ${v.component} | ${VERDICT_ICON[v.trustVerdict]} | ${v.totals.verified} | ${v.totals.unsupported} | ${v.totals.inconclusive} | ${v.totals.noEvidence} | ${reasons} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Status gating — used by migrationContract.ts to demote unverified components
// ---------------------------------------------------------------------------

export function gatedImplementationStatus(
  baseStatus: "ready" | "blocked",
  verification: ComponentVerification | undefined,
): "ready" | "needs_review" | "blocked" {
  if (baseStatus === "blocked") return "blocked";
  if (!verification) return baseStatus;
  if (verification.trustVerdict === "blocked") return "blocked";
  if (verification.trustVerdict === "needs_review") return "needs_review";
  return baseStatus;
}
