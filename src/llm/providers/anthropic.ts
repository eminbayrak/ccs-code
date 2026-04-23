import type { LLMProvider, Message, ToolDefinition, ToolCall } from "./base.js";

const API_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOOL_ITERATIONS = 8;

export class AnthropicProvider implements LLMProvider {
  name = "Anthropic";
  model: string;

  constructor(model = "claude-sonnet-4-6") {
    this.model = model;
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const apiKey = process.env.CCS_ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("[Anthropic Provider] Missing CCS_ANTHROPIC_API_KEY in .env file.");

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

    const json = (await response.json()) as { content: Array<{ type: string; text: string }> };
    return json.content[0]?.text ?? "";
  }

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    executeToolCall: (call: ToolCall) => Promise<string>,
    systemPrompt?: string,
  ): Promise<string> {
    const apiKey = process.env.CCS_ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("[Anthropic Provider] Missing CCS_ANTHROPIC_API_KEY in .env file.");

    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object",
        properties: Object.fromEntries(
          t.parameters.map((p) => [p.name, { type: p.type, description: p.description }])
        ),
        required: t.parameters.filter((p) => p.required !== false).map((p) => p.name),
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let conversation: any[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
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
          tools: anthropicTools,
          messages: conversation,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`[Anthropic Provider] Request failed (${response.status}): ${text}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await response.json()) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content: any[] = json.content ?? [];

      // No tool calls — final answer
      if (json.stop_reason !== "tool_use" || !content.some((b) => b.type === "tool_use")) {
        return content.find((b) => b.type === "text")?.text ?? "";
      }

      conversation.push({ role: "assistant", content });

      // Execute each tool_use block
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolResults: any[] = [];
      for (const block of content) {
        if (block.type === "tool_use") {
          const result = await executeToolCall({ id: block.id, name: block.name, input: block.input });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      conversation.push({ role: "user", content: toolResults });
    }

    // Exhausted iterations — ask for best-effort final answer without tools
    const fallback = await this.chat(
      [{ role: "user", content: "Based on your research, provide your final JSON answer now." }],
      systemPrompt
    );
    return fallback;
  }
}
