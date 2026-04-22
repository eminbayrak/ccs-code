import { promises as fs } from "fs";
import { join } from "path";
import type { LLMProvider } from "./providers/base.js";
import { EnterpriseProvider } from "./providers/enterprise.js";
import { OpenAIProvider } from "./providers/openai.js";
import { AnthropicProvider } from "./providers/anthropic.js";

export type { LLMProvider };
export type { Message } from "./providers/base.js";

type CCSConfig = {
  provider: "enterprise" | "openai" | "anthropic";
  model?: string;
};

const DEFAULT_CONFIG: CCSConfig = { provider: "openai" };

async function loadConfig(): Promise<CCSConfig> {
  try {
    const configPath = join(process.cwd(), ".ccs", "config.json");
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as CCSConfig;
  } catch {
    // No config file — fall back to default
    return DEFAULT_CONFIG;
  }
}

/**
 * Factory function: reads .ccs/config.json and returns the correct provider.
 * To add a new provider, create a file in ./providers/ and add a case here.
 */
export async function createProvider(): Promise<LLMProvider> {
  const config = await loadConfig();

  switch (config.provider) {
    case "enterprise":
      return new EnterpriseProvider(config.model);
    case "anthropic":
      return new AnthropicProvider(config.model);
    case "openai":
    default:
      return new OpenAIProvider(config.model);
  }
}
