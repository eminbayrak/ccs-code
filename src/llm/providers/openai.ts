import type { LLMProvider, Message, ToolDefinition, ToolCall } from "./base.js";

const API_BASE = "https://api.openai.com/v1";
const MAX_TOOL_ITERATIONS = 8;

export class OpenAIProvider implements LLMProvider {
  name = "OpenAI";
  model: string;

  constructor(model = "gpt-4o") {
    this.model = model;
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const apiKey = process.env.CCS_OPENAI_API_KEY;
    if (!apiKey) throw new Error("[OpenAI Provider] Missing CCS_OPENAI_API_KEY in .env file.");

    const allMessages = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : messages;

    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages: allMessages }),
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

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    executeToolCall: (call: ToolCall) => Promise<string>,
    systemPrompt?: string,
  ): Promise<string> {
    const apiKey = process.env.CCS_OPENAI_API_KEY;
    if (!apiKey) throw new Error("[OpenAI Provider] Missing CCS_OPENAI_API_KEY in .env file.");

    const openaiTools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            t.parameters.map((p) => [p.name, { type: p.type, description: p.description }])
          ),
          required: t.parameters.filter((p) => p.required !== false).map((p) => p.name),
        },
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let allMessages: any[] = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
    ];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: allMessages,
          tools: openaiTools,
          tool_choice: "auto",
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`[OpenAI Provider] Request failed (${response.status}): ${text}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await response.json()) as any;
      const choice = json.choices[0];
      const message = choice.message;

      if (choice.finish_reason !== "tool_calls" || !message.tool_calls?.length) {
        return message.content ?? "";
      }

      allMessages.push(message);

      for (const tc of message.tool_calls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments ?? "{}"); } catch { /* ignore */ }
        const result = await executeToolCall({ id: tc.id, name: tc.function.name, input });
        allMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }

    return allMessages[allMessages.length - 1]?.content ?? "";
  }
}
