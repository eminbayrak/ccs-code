import type { SoapCallSite } from "./scanner.js";

// ---------------------------------------------------------------------------
// Token estimation — rough but reliable for planning purposes
// Anthropic tokens ≈ 4 chars per token (English/code mix)
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

// Pricing as of 2025 (per 1M tokens)
const PRICING = {
  "claude-haiku-4-5-20251001": { input: 0.80, output: 2.50 },
  "claude-sonnet-4-6":         { input: 3.00, output: 15.00 },
} as const;

export type CostEstimate = {
  haikuInputTokens: number;
  sonnetInputTokens: number;
  estimatedHaikuCostUsd: number;
  estimatedSonnetCostUsd: number;
  totalEstimatedCostUsd: number;
  serviceCount: number;
  breakdown: string;
};

function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function cost(tokens: number, pricePerMillion: number): number {
  return (tokens / 1_000_000) * pricePerMillion;
}

// ---------------------------------------------------------------------------
// Estimate cost for a planned scan
// ---------------------------------------------------------------------------

export function estimateScanCost(
  namespaceCount: number,
  fileSamples: Array<{ content: string }>,
  averageFilesPerService = 2
): CostEstimate {
  // Haiku: used for resolving each namespace (short prompts)
  const haikuPromptCharsPerNamespace = 800;
  const haikuInputTokens = charsToTokens(haikuPromptCharsPerNamespace * namespaceCount);

  // Sonnet: used for deep analysis — bundle all files for a service
  const avgFileChars =
    fileSamples.length > 0
      ? fileSamples.reduce((sum, f) => sum + f.content.length, 0) / fileSamples.length
      : 3000; // fallback if no samples

  // System prompt + per-service prompt overhead
  const systemPromptChars = 600;
  const perServicePromptChars = 400;
  const charsPerService = systemPromptChars + perServicePromptChars + avgFileChars * averageFilesPerService;
  const sonnetInputTokens = charsToTokens(charsPerService * namespaceCount);

  const haikuPrice = PRICING["claude-haiku-4-5-20251001"];
  const sonnetPrice = PRICING["claude-sonnet-4-6"];

  const estimatedHaikuCostUsd = cost(haikuInputTokens, haikuPrice.input);
  const estimatedSonnetCostUsd = cost(sonnetInputTokens, sonnetPrice.input);
  const totalEstimatedCostUsd = estimatedHaikuCostUsd + estimatedSonnetCostUsd;

  const breakdown = [
    `Services to analyze:     ${namespaceCount}`,
    `Files per service (avg): ${averageFilesPerService}`,
    `Avg file size (chars):   ${Math.round(avgFileChars).toLocaleString()}`,
    ``,
    `Haiku  — ${haikuInputTokens.toLocaleString()} input tokens  → $${estimatedHaikuCostUsd.toFixed(4)}`,
    `Sonnet — ${sonnetInputTokens.toLocaleString()} input tokens  → $${estimatedSonnetCostUsd.toFixed(4)}`,
    ``,
    `Total estimated cost: $${totalEstimatedCostUsd.toFixed(4)}`,
  ].join("\n");

  return {
    haikuInputTokens,
    sonnetInputTokens,
    estimatedHaikuCostUsd,
    estimatedSonnetCostUsd,
    totalEstimatedCostUsd,
    serviceCount: namespaceCount,
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// Format estimate for display in the terminal
// ---------------------------------------------------------------------------

export function formatCostPreview(estimate: CostEstimate): string {
  return [
    ``,
    `Cost Estimate`,
    `─────────────────────────────────────`,
    estimate.breakdown,
    `─────────────────────────────────────`,
    ``,
    `Continue? [y/n]`,
  ].join("\n");
}
