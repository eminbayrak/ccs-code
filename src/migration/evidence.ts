export type EvidenceBasis = "observed" | "inferred" | "unknown";
export type EvidenceConfidence = "high" | "medium" | "low";

export type EvidenceItem = {
  kind: string;
  statement: string;
  basis: EvidenceBasis;
  confidence: EvidenceConfidence;
  sourceFile: string | null;
  lineStart: number | null;
  lineEnd: number | null;
};

export type FileCoverage = {
  path: string;
  originalChars: number;
  providedChars: number;
  originalLines: number;
  providedLines: number;
  truncated: boolean;
  segments?: Array<{ startLine: number; endLine: number }>;
};

export type SourceCoverage = {
  filesProvided: number;
  filesTruncated: FileCoverage[];
};

export type NumberedSourceExcerpt = FileCoverage & {
  content: string;
};

export function buildNumberedSourceExcerpt(
  path: string,
  content: string,
  maxChars: number,
): NumberedSourceExcerpt {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  const renderLine = (index: number) => `${String(index + 1).padStart(width, "0")} | ${lines[index] ?? ""}`;

  const fullRendered = lines.map((_, index) => renderLine(index)).join("\n");
  if (fullRendered.length <= maxChars) {
    return {
      path,
      content: fullRendered,
      originalChars: content.length,
      providedChars: content.length,
      originalLines: lines.length,
      providedLines: lines.length,
      truncated: false,
      segments: [{ startLine: 1, endLine: lines.length }],
    };
  }

  const headBudget = Math.max(1, Math.floor(maxChars * 0.55));
  const tailBudget = Math.max(1, maxChars - headBudget);
  const head: string[] = [];
  const tail: string[] = [];
  let headChars = 0;
  let tailChars = 0;
  let headEnd = -1;
  let tailStart = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const numbered = renderLine(i);
    if (headChars + numbered.length + 1 > headBudget) {
      break;
    }
    head.push(numbered);
    headChars += numbered.length + 1;
    headEnd = i;
  }

  for (let i = lines.length - 1; i > headEnd; i--) {
    const numbered = renderLine(i);
    if (tailChars + numbered.length + 1 > tailBudget) {
      break;
    }
    tail.unshift(numbered);
    tailChars += numbered.length + 1;
    tailStart = i;
  }

  const omittedStart = headEnd + 2;
  const omittedEnd = tailStart;
  const marker = `[TRUNCATED MIDDLE: lines ${omittedStart}-${omittedEnd} omitted. Head and tail were provided so the model can see imports, declarations, endings, returns, and cleanup logic.]`;
  const rendered = [...head, marker, ...tail];
  const segments = [
    head.length > 0 ? { startLine: 1, endLine: headEnd + 1 } : null,
    tail.length > 0 ? { startLine: tailStart + 1, endLine: lines.length } : null,
  ].filter((segment): segment is { startLine: number; endLine: number } => segment !== null);

  return {
    path,
    content: rendered.join("\n"),
    originalChars: content.length,
    providedChars: Math.min(headChars + tailChars, content.length),
    originalLines: lines.length,
    providedLines: head.length + tail.length,
    truncated: true,
    segments,
  };
}

export function buildSourceCoverage(excerpts: NumberedSourceExcerpt[]): SourceCoverage {
  return {
    filesProvided: excerpts.length,
    filesTruncated: excerpts
      .filter((e) => e.truncated)
      .map(({ content: _content, ...coverage }) => coverage),
  };
}

export function emptySourceCoverage(): SourceCoverage {
  return { filesProvided: 0, filesTruncated: [] };
}

export function normalizeEvidenceItems(raw: unknown): EvidenceItem[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const statement = typeof record["statement"] === "string" ? record["statement"].trim() : "";
    if (!statement) return [];

    const basis = record["basis"];
    const confidence = record["confidence"];

    return [{
      kind: typeof record["kind"] === "string" ? record["kind"] : "unknown",
      statement,
      basis: basis === "observed" || basis === "inferred" || basis === "unknown"
        ? basis
        : "unknown",
      confidence: confidence === "high" || confidence === "medium" || confidence === "low"
        ? confidence
        : "low",
      sourceFile: typeof record["sourceFile"] === "string" && record["sourceFile"].trim()
        ? record["sourceFile"].trim()
        : null,
      lineStart: typeof record["lineStart"] === "number" && Number.isFinite(record["lineStart"])
        ? Math.max(1, Math.floor(record["lineStart"]))
        : null,
      lineEnd: typeof record["lineEnd"] === "number" && Number.isFinite(record["lineEnd"])
        ? Math.max(1, Math.floor(record["lineEnd"]))
        : null,
    }];
  });
}

export function evidenceSourceLabel(evidence: EvidenceItem): string {
  if (!evidence.sourceFile) return "no source citation";
  if (!evidence.lineStart) return evidence.sourceFile;
  const end = evidence.lineEnd && evidence.lineEnd !== evidence.lineStart
    ? `-L${evidence.lineEnd}`
    : "";
  return `${evidence.sourceFile}:L${evidence.lineStart}${end}`;
}

export function findEvidenceForStatement(
  evidence: EvidenceItem[],
  statement: string,
  kind?: string,
): EvidenceItem | null {
  const wanted = normalizeText(statement);
  return evidence.find((item) => {
    if (kind && item.kind !== kind) return false;
    const got = normalizeText(item.statement);
    return got === wanted || got.includes(wanted) || wanted.includes(got);
  }) ?? null;
}

export function summarizeCoverage(coverage: SourceCoverage): string[] {
  if (coverage.filesTruncated.length === 0) {
    return [`${coverage.filesProvided} source file(s) were provided without model-side truncation.`];
  }

  return [
    `${coverage.filesProvided} source file(s) were provided to the analysis model.`,
    ...coverage.filesTruncated.map((f) => {
      if (!f.segments || f.segments.length === 0) {
        return `${f.path}: analyzed first ${f.providedLines}/${f.originalLines} lines (${f.providedChars}/${f.originalChars} chars).`;
      }
      return `${f.path}: analyzed ${formatSegments(f)} (${f.providedLines}/${f.originalLines} lines, ${f.providedChars}/${f.originalChars} chars).`;
    }),
  ];
}

function formatSegments(file: FileCoverage): string {
  if (!file.segments || file.segments.length === 0) {
    return `a truncated excerpt`;
  }
  return file.segments
    .map((segment) => segment.startLine === segment.endLine
      ? `line ${segment.startLine}`
      : `lines ${segment.startLine}-${segment.endLine}`)
    .join(" and ");
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
