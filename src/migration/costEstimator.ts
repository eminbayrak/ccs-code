// ---------------------------------------------------------------------------
// Token estimation — rough but reliable for planning purposes
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

// Pricing as of 2026 (per 1M tokens) - Average across providers
const PRICING = {
  flash: { input: 0.10, output: 0.20 }, // e.g. Gemini 3.1 Flash, GPT-4o-mini
  pro:   { input: 3.00, output: 15.00 }, // e.g. Gemini 3.1 Pro, GPT-4o, Sonnet 3.7
} as const;

export type CostEstimate = {
  flashInputTokens: number;
  proInputTokens: number;
  estimatedFlashCostUsd: number;
  estimatedProCostUsd: number;
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

/**
 * Estimate cost for a planned scan
 */
export function estimateScanCost(
  namespaceCount: number,
  fileSamples: Array<{ content: string }>,
  averageFilesPerService = 2,
  providerName = "Selected Provider"
): CostEstimate {
  // Flash: used for resolving each namespace (short prompts)
  const flashPromptCharsPerNamespace = 800;
  const flashInputTokens = charsToTokens(flashPromptCharsPerNamespace * namespaceCount);

  // Pro: used for deep analysis — bundle all files for a service
  const avgFileChars =
    fileSamples.length > 0
      ? fileSamples.reduce((sum, f) => sum + f.content.length, 0) / fileSamples.length
      : 3000; // fallback if no samples

  // System prompt + per-service prompt overhead
  const systemPromptChars = 600;
  const perServicePromptChars = 400;
  const charsPerService = systemPromptChars + perServicePromptChars + avgFileChars * averageFilesPerService;
  const proInputTokens = charsToTokens(charsPerService * namespaceCount);

  const flashPrice = PRICING.flash;
  const proPrice = PRICING.pro;

  const estimatedFlashCostUsd = cost(flashInputTokens, flashPrice.input);
  const estimatedProCostUsd = cost(proInputTokens, proPrice.input);
  const totalEstimatedCostUsd = estimatedFlashCostUsd + estimatedProCostUsd;

  const breakdown = [
    `Provider: ${providerName}`,
    `Services to analyze:     ${namespaceCount}`,
    `Files per service (avg): ${averageFilesPerService}`,
    `Avg file size (chars):   ${Math.round(avgFileChars).toLocaleString()}`,
    ``,
    `Flash (Lite) — ${flashInputTokens.toLocaleString()} input tokens  → $${estimatedFlashCostUsd.toFixed(4)}`,
    `Pro (Deep)   — ${proInputTokens.toLocaleString()} input tokens  → $${estimatedProCostUsd.toFixed(4)}`,
    ``,
    `Total estimated cost: $${totalEstimatedCostUsd.toFixed(4)}`,
  ].join("\n");

  return {
    flashInputTokens,
    proInputTokens,
    estimatedFlashCostUsd,
    estimatedProCostUsd,
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
  ].join("\n");
}
