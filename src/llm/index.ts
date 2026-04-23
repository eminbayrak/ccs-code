import { promises as fs } from "fs";
import { join } from "path";
import type { LLMProvider } from "./providers/base.js";
import { EnterpriseProvider } from "./providers/enterprise.js";
import { OpenAIProvider } from "./providers/openai.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";

export type { LLMProvider };
export type { Message, ToolDefinition, ToolCall } from "./providers/base.js";

export type LLMTier = "flash" | "pro";

type CCSConfig = {
  provider: "enterprise" | "openai" | "anthropic" | "gemini";
  model?: string;
  model_flash?: string;
};

const DEFAULT_CONFIG: CCSConfig = { provider: "openai" };

export async function loadConfig(): Promise<CCSConfig> {
  try {
    const configPath = join(process.cwd(), ".ccs", "config.json");
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as CCSConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Factory function: reads .ccs/config.json and returns the correct provider.
 * tier: "flash" (faster/cheaper) or "pro" (smarter/complex).
 * Priority: config.model_flash/pro -> config.model (only for pro) -> tier default.
 */
export async function createProvider(tier: LLMTier = "pro"): Promise<LLMProvider> {
  const config = await loadConfig();

  switch (config.provider) {
    case "enterprise":
      return new EnterpriseProvider(config.model);
    case "anthropic": {
      const model = (tier === "flash")
        ? (config.model_flash || "claude-haiku-4-5-20251001")
        : (config.model || "claude-sonnet-4-6");
      return new AnthropicProvider(model);
    }
    case "gemini": {
      const model = (tier === "flash")
        ? (config.model_flash || "gemini-3.1-flash-lite-preview")
        : (config.model || "gemini-3.1-pro-preview");
      return new GeminiProvider(model);
    }
    case "openai":
    default: {
      const model = (tier === "flash")
        ? (config.model_flash || "gpt-4o-mini")
        : (config.model || "gpt-4o");
      return new OpenAIProvider(model);
    }
  }
}
