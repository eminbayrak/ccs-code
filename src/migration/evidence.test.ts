import { describe, expect, test } from "bun:test";
import {
  buildNumberedSourceExcerpt,
  buildSourceCoverage,
  evidenceSourceLabel,
  normalizeEvidenceItems,
} from "./evidence.js";

describe("migration evidence helpers", () => {
  test("numbers source lines and records truncation", () => {
    const excerpt = buildNumberedSourceExcerpt(
      "Service.cs",
      ["first", "second", "third", "fourth"].join("\n"),
      30,
    );

    expect(excerpt.content).toContain("1 | first");
    expect(excerpt.content).toContain("4 | fourth");
    expect(excerpt.content).toContain("TRUNCATED MIDDLE");
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.providedLines).toBeLessThan(excerpt.originalLines);
    expect(excerpt.segments).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 4, endLine: 4 },
    ]);
  });

  test("normalizes evidence and rejects unsupported shapes", () => {
    const evidence = normalizeEvidenceItems([
      {
        kind: "business_rule",
        statement: "VIP accounts skip the fee",
        basis: "observed",
        sourceFile: "BillingService.cs",
        lineStart: 42,
        lineEnd: 44,
        confidence: "high",
      },
      { statement: "" },
      "bad",
    ]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.basis).toBe("observed");
    expect(evidenceSourceLabel(evidence[0]!)).toBe("BillingService.cs:L42-L44");
  });

  test("summarizes only truncated files in coverage", () => {
    const truncated = buildNumberedSourceExcerpt("Large.cs", "a\n".repeat(100), 20);
    const coverage = buildSourceCoverage([truncated]);

    expect(coverage.filesProvided).toBe(1);
    expect(coverage.filesTruncated[0]?.path).toBe("Large.cs");
  });
});
