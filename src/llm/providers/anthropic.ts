import type { LLMProvider, Message } from "./base.js";

/**
 * Personal Anthropic Provider
 * Uses the Anthropic Messages API directly.
 *
 * Required environment variables:
 *   CCS_ANTHROPIC_API_KEY - Your personal Anthropic API key (sk-ant-...)
 */

const API_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicProvider implements LLMProvider {
  name = "Anthropic";
  model: string;

  constructor(model = "claude-3-5-sonnet-20241022") {
    this.model = model;
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const apiKey = process.env.CCS_ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("[Anthropic Provider] Missing CCS_ANTHROPIC_API_KEY in .env file.");
    }

    // Anthropic uses a separate system field, not a system message in the array
    const userMessages = messages.filter((m) => m.role !== "system");

    const response = await fetch(`${API_BASE}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: userMessages,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[Anthropic Provider] Request failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };

    return json.content[0]?.text ?? "";
  }
}
