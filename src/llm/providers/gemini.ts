import type { LLMProvider, Message, ToolDefinition, ToolCall } from "./base.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_TOOL_ITERATIONS = 8;

// Retry on 429 with exponential backoff: 5s → 10s → 20s (max 2 retries)
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 2): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429 || attempt === maxRetries) return response;
    const delay = 5_000 * Math.pow(2, attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return fetch(url, options);
}

export class GeminiProvider implements LLMProvider {
  name = "Gemini";
  model: string;

  constructor(model = "gemini-3.1-pro-preview") {
    this.model = model;
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const apiKey = process.env.CCS_GEMINI_API_KEY;
    if (!apiKey) throw new Error("[Gemini Provider] Missing CCS_GEMINI_API_KEY in .env file.");

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      contents,
      generationConfig: { temperature: 0.1 },
    };
    if (systemPrompt) {
      body.system_instruction = { parts: [{ text: systemPrompt }] };
    }

    const url = `${API_BASE}/models/${this.model}:generateContent?key=${apiKey}`;
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text();
      let status = "ERROR";
      try {
        const json = JSON.parse(text);
        if (json.error?.status) status = json.error.status;
      } catch { /* ignore */ }
      throw new Error(`[Gemini Provider] Request failed (${response.status} ${status}): ${text}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await response.json()) as any;
    if (json.error) throw new Error(`[Gemini Provider] API Error: ${json.error.message}`);

    return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    executeToolCall: (call: ToolCall) => Promise<string>,
    systemPrompt?: string,
  ): Promise<string> {
    const apiKey = process.env.CCS_GEMINI_API_KEY;
    if (!apiKey) throw new Error("[Gemini Provider] Missing CCS_GEMINI_API_KEY in .env file.");

    const geminiTools = [
      {
        function_declarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: {
            type: "OBJECT",
            properties: Object.fromEntries(
              t.parameters.map((p) => [
                p.name,
                { type: p.type.toUpperCase(), description: p.description },
              ])
            ),
            required: t.parameters.filter((p) => p.required !== false).map((p) => p.name),
          },
        })),
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let contents: any[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const url = `${API_BASE}/models/${this.model}:generateContent?key=${apiKey}`;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = {
        contents,
        tools: geminiTools,
        generationConfig: { temperature: 0.1 },
      };
      if (systemPrompt) {
        body.system_instruction = { parts: [{ text: systemPrompt }] };
      }

      const response = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`[Gemini Provider] Request failed (${response.status}): ${text}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await response.json()) as any;
      if (json.error) throw new Error(`[Gemini Provider] API Error: ${json.error.message}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = json.candidates?.[0]?.content?.parts ?? [];
      const functionCalls = parts.filter((p) => p.functionCall);

      // No function calls — final text answer
      if (functionCalls.length === 0) {
        return parts.find((p) => p.text)?.text ?? "";
      }

      // Append model's response (with function calls)
      contents.push({ role: "model", parts });

      // Execute each function call and collect responses
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const responseParts: any[] = [];
      for (const part of functionCalls) {
        const fc = part.functionCall;
        const result = await executeToolCall({
          id: fc.name,
          name: fc.name,
          input: fc.args ?? {},
        });
        responseParts.push({
          functionResponse: {
            name: fc.name,
            response: { result },
          },
        });
      }
      contents.push({ role: "user", parts: responseParts });
    }

    // Exhausted iterations — ask for best-effort final answer without tools
    const fallback = await this.chat(
      [{ role: "user", content: "Based on your research, provide your final JSON answer now." }],
      systemPrompt
    );
    return fallback;
  }
}
