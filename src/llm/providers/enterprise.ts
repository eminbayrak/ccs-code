import type { LLMProvider, Message, ToolDefinition, ToolCall } from "./base.js";

const MAX_TOOL_ITERATIONS = 8;

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record["text"] === "string") return record["text"];
          if (typeof record["content"] === "string") return record["content"];
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record["text"] === "string") return record["text"];
    if (typeof record["content"] === "string") return record["content"];
  }
  return "";
}

/**
 * Enterprise Corporate Provider
 * Uses a two-step OAuth2 client_credentials flow against an API gateway,
 * then sends requests to an Azure OpenAI-compatible endpoint.
 *
 * Required environment variables:
 *   CCS_ENTERPRISE_CLIENT_ID      - OAuth2 client ID
 *   CCS_ENTERPRISE_CLIENT_SECRET  - OAuth2 client secret
 *   CCS_ENTERPRISE_AUTH_URL       - OAuth2 token endpoint
 *   CCS_ENTERPRISE_SCOPE          - OAuth2 scope
 *   CCS_ENTERPRISE_API_BASE       - Base URL for the AI Gateway
 */

async function getAccessToken(): Promise<string> {
  const clientId = process.env.CCS_ENTERPRISE_CLIENT_ID;
  const clientSecret = process.env.CCS_ENTERPRISE_CLIENT_SECRET;
  const authUrl = process.env.CCS_ENTERPRISE_AUTH_URL;
  const scope = process.env.CCS_ENTERPRISE_SCOPE;

  if (!clientId || !clientSecret || !authUrl || !scope) {
    throw new Error(
      "[Enterprise Provider] Missing configuration. Ensure CCS_ENTERPRISE_CLIENT_ID, CCS_ENTERPRISE_CLIENT_SECRET, CCS_ENTERPRISE_AUTH_URL, and CCS_ENTERPRISE_SCOPE are set in your .env file."
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: scope,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[Enterprise Provider] OAuth2 token request failed (${response.status}). 

Possible reasons:
1. Credentials (ID/Secret) are incorrect in your .env file.
2. The AUTH_URL or SCOPE is incorrect.
3. Your client registration has expired or hasn't been approved yet.
4. Network connectivity issues (e.g., VPN required).

Original Error: ${text}`);
  }

  const json = (await response.json()) as { access_token: string };
  return json.access_token;
}

export class EnterpriseProvider implements LLMProvider {
  name = "Enterprise Azure OpenAI";
  model: string;

  constructor(model = "gpt-4o-mini") {
    this.model = model;
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const token = await getAccessToken();
    const apiBase = process.env.CCS_ENTERPRISE_API_BASE;

    if (!apiBase) {
      throw new Error("[Enterprise Provider] Missing CCS_ENTERPRISE_API_BASE in .env file.");
    }

    const allMessages = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : messages;

    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: allMessages,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[Enterprise Provider] Chat request failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as {
      choices: Array<{ message: { content: unknown } }>;
    };

    return normalizeMessageContent(json.choices[0]?.message?.content);
  }

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    executeToolCall: (call: ToolCall) => Promise<string>,
    systemPrompt?: string,
  ): Promise<string> {
    const token = await getAccessToken();
    const apiBase = process.env.CCS_ENTERPRISE_API_BASE;
    if (!apiBase) throw new Error("[Enterprise Provider] Missing CCS_ENTERPRISE_API_BASE in .env file.");

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
      // Re-fetch token per iteration in case it expires during a long research session
      const iterToken = i === 0 ? token : await getAccessToken();

      const response = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${iterToken}`,
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
        throw new Error(`[Enterprise Provider] Tool chat request failed (${response.status}): ${text}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await response.json()) as any;
      const choice = json.choices[0];
      const message = choice.message;

      if (choice.finish_reason !== "tool_calls" || !message.tool_calls?.length) {
        return normalizeMessageContent(message.content);
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
