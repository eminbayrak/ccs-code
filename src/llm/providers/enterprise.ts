import type { LLMProvider, Message } from "./base.js";

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
      choices: Array<{ message: { content: string } }>;
    };

    return json.choices[0]?.message?.content ?? "";
  }
}
