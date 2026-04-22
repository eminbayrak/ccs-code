import type { LLMProvider, Message } from "./base.js";

/**
 * UHG Corporate Provider
 * Uses a two-step OAuth2 client_credentials flow against UHG's API gateway,
 * then sends requests to an Azure OpenAI-compatible endpoint.
 *
 * Required environment variables:
 *   CCS_UHG_CLIENT_ID      - OAuth2 client ID
 *   CCS_UHG_CLIENT_SECRET  - OAuth2 client secret
 */

const AUTH_URL = "https://api.uhg.com/oauth2/token";
const SCOPE = "https://api.uhg.com/.default";
const API_BASE = "https://api.uhg.com/api/cloud/api-management/ai-gateway-reasoning/1.0";

async function getAccessToken(): Promise<string> {
  const clientId = process.env.CCS_UHG_CLIENT_ID;
  const clientSecret = process.env.CCS_UHG_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "[UHG Provider] Missing credentials. Set CCS_UHG_CLIENT_ID and CCS_UHG_CLIENT_SECRET in your .env file."
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: SCOPE,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[UHG Provider] OAuth2 token request failed (401: Unauthorized). 

Possible reasons:
1. CCS_UHG_CLIENT_ID or CCS_UHG_CLIENT_SECRET are incorrect in your .env file.
2. Your client registration has expired or hasn't been approved yet.
3. You are not on the corporate VPN.

Original Error: ${text}`);
  }

  const json = (await response.json()) as { access_token: string };
  return json.access_token;
}

export class UHGProvider implements LLMProvider {
  name = "UHG Azure OpenAI";
  model: string;

  constructor(model = "gpt-4o-mini") {
    this.model = model;
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const token = await getAccessToken();

    const allMessages = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : messages;

    const response = await fetch(`${API_BASE}/chat/completions`, {
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
      throw new Error(`[UHG Provider] Chat request failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return json.choices[0]?.message?.content ?? "";
  }
}
