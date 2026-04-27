import type { LLMProvider, Message, ToolDefinition, ToolCall } from "./base.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_TOOL_ITERATIONS = 8;

// ---------------------------------------------------------------------------
// Format API error responses into a clean, readable message instead of
// dumping raw JSON into the terminal.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatGeminiError(status: number, bodyText: string): string {
  try {
    const json = JSON.parse(bodyText);
    const err = json.error;
    if (!err) throw new Error("no error field");

    // Extract retry delay from RetryInfo detail
    let retryStr = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const retryInfo = (err.details ?? []).find((d: any) =>
      (d["@type"] ?? "").includes("RetryInfo")
    );
    if (retryInfo?.retryDelay) {
      const raw = String(retryInfo.retryDelay);
      const secs = parseFloat(raw);
      if (!isNaN(secs)) {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        retryStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
      }
    }

    // Extract quota info from QuotaFailure detail
    let quotaLine = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quotaFailure = (err.details ?? []).find((d: any) =>
      (d["@type"] ?? "").includes("QuotaFailure")
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const violation = quotaFailure?.violations?.[0] as any | undefined;
    if (violation) {
      const limit = violation.quotaValue ? ` (limit: ${violation.quotaValue}/day)` : "";
      quotaLine = `Quota: ${violation.quotaId ?? "unknown"}${limit}`;
    }

    // Trim the verbose message down to the first useful sentence
    const rawMsg: string = err.message ?? err.status ?? "Unknown error";
    const coreMsg = rawMsg
      .split(/\nFor more information/)[0]!
      .split(/\nTo monitor/)[0]!
      .trim()
      // Pull out just the "Quota exceeded for..." line if buried in a longer message
      .replace(/^You exceeded[^*\n]*\n?(\* Quota exceeded[^\n]*)[\s\S]*/m, "$1")
      .trim();

    const lines = [
      `[Gemini] ${status} ${err.status ?? "ERROR"} — ${coreMsg}`,
      quotaLine ? `  ${quotaLine}` : "",
      retryStr   ? `  Retry in: ${retryStr}` : "",
    ].filter(Boolean);

    return lines.join("\n");
  } catch {
    // Fallback: first 160 chars so it at least fits on screen
    const preview = bodyText.slice(0, 160).replace(/\n/g, " ");
    return `[Gemini Provider] Request failed (${status}): ${preview}${bodyText.length > 160 ? "…" : ""}`;
  }
}

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
      throw new Error(formatGeminiError(response.status, text));
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
        throw new Error(formatGeminiError(response.status, text));
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
