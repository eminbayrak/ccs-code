import type { LLMProvider, Message } from "./base.js";

/**
 * Personal OpenAI Provider
 * Uses the standard OpenAI chat completions API directly.
 *
 * Required environment variables:
 *   CCS_OPENAI_API_KEY - Your personal OpenAI API key (sk-...)
 */

const API_BASE = "https://api.openai.com/v1";

export class OpenAIProvider implements LLMProvider {
  name = "OpenAI";
  model: string;

  constructor(model = "gpt-4o") {
    this.model = model;
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const apiKey = process.env.CCS_OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("[OpenAI Provider] Missing CCS_OPENAI_API_KEY in .env file.");
    }

    const allMessages = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : messages;

    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: allMessages,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[OpenAI Provider] Request failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return json.choices[0]?.message?.content ?? "";
  }
}
