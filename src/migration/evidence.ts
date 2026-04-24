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
  const rendered: string[] = [];
  let chars = 0;
  let providedLines = 0;
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    const numbered = `${String(i + 1).padStart(width, "0")} | ${lines[i] ?? ""}`;
    if (chars + numbered.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    rendered.push(numbered);
    chars += numbered.length + 1;
    providedLines++;
  }

  if (truncated) {
    rendered.push(
      `[TRUNCATED: only the first ${providedLines} of ${lines.length} lines were provided to the analysis model]`,
    );
  }

  return {
    path,
    content: rendered.join("\n"),
    originalChars: content.length,
    providedChars: Math.min(chars, content.length),
    originalLines: lines.length,
    providedLines,
    truncated,
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
    ...coverage.filesTruncated.map((f) =>
      `${f.path}: analyzed first ${f.providedLines}/${f.originalLines} lines (${f.providedChars}/${f.originalChars} chars).`,
    ),
  ];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
