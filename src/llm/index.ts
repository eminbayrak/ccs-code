import { promises as fs } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import type { LLMProvider } from "./providers/base.js";
import { EnterpriseProvider } from "./providers/enterprise.js";
import { OpenAIProvider } from "./providers/openai.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import { CodexCliProvider, type CodexApproval, type CodexSandbox } from "./providers/codexCli.js";
import { ClaudeCodeProvider } from "./providers/claudeCode.js";

export type { LLMProvider };
export type { Message, ToolDefinition, ToolCall } from "./providers/base.js";

export type LLMTier = "flash" | "pro";
export type ProviderName = "enterprise" | "openai" | "anthropic" | "gemini" | "codex_cli" | "claudecode";

export type CCSConfig = {
  provider: ProviderName;
  model?: string;
  model_flash?: string;
  codexCommand?: string;
  sandbox?: CodexSandbox;
  approval?: CodexApproval;
  output_schema?: string;
  /**
   * Optional independent verifier model/provider. This lets teams run the
   * analyzer with one model family and the evidence-checking verifier with
   * another, reducing shared blind spots without changing the main provider.
   */
  verifier_provider?: ProviderName;
  verifier_model?: string;
  verifier_model_flash?: string;
  verifier_codexCommand?: string;
  verifier_sandbox?: CodexSandbox;
  verifier_approval?: CodexApproval;
  verifier_output_schema?: string;
};

// ---------------------------------------------------------------------------
// Multi-provider config format
// ---------------------------------------------------------------------------

/**
 * The new config format — stores all providers under a named map so the user
 * can switch defaults without re-typing credentials.
 *
 * Example .ccs/config.json:
 * {
 *   "defaultProvider": "claudecode",
 *   "providers": {
 *     "claudecode": { "provider": "claudecode", "model": "claude-sonnet-4-6" },
 *     "anthropic":  { "provider": "anthropic",  "model": "claude-sonnet-4-6" },
 *     ...
 *   }
 * }
 *
 * The old flat format ({ "provider": "openai", ... }) is still supported for
 * backwards compatibility — it is treated as a single-provider config.
 */
export type MultiProviderConfig = {
  defaultProvider: string;
  providers: Record<string, CCSConfig>;
};

/** Human-readable summary of a single provider entry. */
export type ProviderInfo = {
  key: string;           // the map key  (e.g. "claudecode")
  providerType: ProviderName;
  model: string;
  modelFlash: string;
  isDefault: boolean;
  envStatus: string;     // brief note about required env var or auth method
};

const CONFIG_PATH = join(process.cwd(), ".ccs", "config.yaml");

const LEGACY_DEFAULT: CCSConfig = { provider: "openai" };

/** Metadata used by `provider list` to describe each entry. */
const PROVIDER_META: Record<ProviderName, { label: string; envNote: string }> = {
  claudecode: { label: "Claude Code CLI", envNote: "claude login  (no API key needed)" },
  anthropic:  { label: "Anthropic API",   envNote: "CCS_ANTHROPIC_API_KEY" },
  openai:     { label: "OpenAI API",      envNote: "CCS_OPENAI_API_KEY" },
  gemini:     { label: "Gemini API",      envNote: "CCS_GEMINI_API_KEY" },
  codex_cli:  { label: "Codex CLI",       envNote: "codex login  (no API key needed)" },
  enterprise: { label: "Enterprise Azure",envNote: "CCS_ENTERPRISE_* env vars" },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isMultiConfig(raw: unknown): raw is MultiProviderConfig {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "defaultProvider" in raw &&
    "providers" in raw &&
    typeof (raw as MultiProviderConfig).providers === "object"
  );
}

async function readRawConfig(): Promise<unknown> {
  try {
    const text = await fs.readFile(CONFIG_PATH, "utf-8");
    return yaml.load(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads the active provider config.
 * Supports both the new multi-provider format and the legacy flat format.
 */
export async function loadConfig(): Promise<CCSConfig> {
  const raw = await readRawConfig();
  if (!raw) return LEGACY_DEFAULT;

  if (isMultiConfig(raw)) {
    const entry = raw.providers[raw.defaultProvider];
    return entry ?? LEGACY_DEFAULT;
  }

  // Legacy flat format
  return raw as CCSConfig;
}

/**
 * Reads the full multi-provider config file.
 * If the file is in the old flat format, wraps it automatically.
 */
export async function loadMultiConfig(): Promise<MultiProviderConfig> {
  const raw = await readRawConfig();

  if (isMultiConfig(raw)) return raw;

  // Wrap legacy flat config
  const legacy = (raw ?? LEGACY_DEFAULT) as CCSConfig;
  return {
    defaultProvider: legacy.provider,
    providers: { [legacy.provider]: legacy },
  };
}

/**
 * Returns a list of all configured providers with status info — used by
 * `ccs-code provider list`.
 */
export async function listProviders(): Promise<ProviderInfo[]> {
  const multi = await loadMultiConfig();

  return Object.entries(multi.providers).map(([key, cfg]) => {
    const meta = PROVIDER_META[cfg.provider] ?? { label: cfg.provider, envNote: "" };
    return {
      key,
      providerType: cfg.provider,
      model: cfg.model ?? "(default)",
      modelFlash: cfg.model_flash ?? "(default)",
      isDefault: key === multi.defaultProvider,
      envStatus: meta.envNote,
    };
  });
}

/**
 * Switches the default provider in .ccs/config.json.
 * Throws if the key does not exist in the providers map.
 */
export async function saveDefaultProvider(key: string): Promise<void> {
  const multi = await loadMultiConfig();

  if (!multi.providers[key]) {
    const available = Object.keys(multi.providers).join(", ");
    throw new Error(
      `Provider "${key}" not found in config.\nAvailable: ${available}\n` +
      `Edit .ccs/config.json to add it first.`,
    );
  }

  multi.defaultProvider = key;
  await fs.mkdir(join(process.cwd(), ".ccs"), { recursive: true });
  await fs.writeFile(CONFIG_PATH, yaml.dump(multi, { lineWidth: 120 }), "utf-8");
}

/**
 * Factory function: reads .ccs/config.json and returns the correct provider.
 * tier: "flash" (faster/cheaper) or "pro" (smarter/complex).
 * Priority: config.model_flash/pro -> config.model (only for pro) -> tier default.
 */
function providerFromConfig(config: CCSConfig, tier: LLMTier = "pro"): LLMProvider {
  switch (config.provider) {
    case "codex_cli": {
      const model = (tier === "flash")
        ? (config.model_flash || config.model || "default")
        : (config.model || "default");
      return new CodexCliProvider({
        command: config.codexCommand,
        model,
        sandbox: config.sandbox ?? "read-only",
        approval: config.approval ?? "never",
        outputSchema: config.output_schema,
        cwd: process.cwd(),
      });
    }
    case "enterprise":
      return new EnterpriseProvider(
        tier === "flash"
          ? (config.model_flash || config.model)
          : config.model
      );
    case "anthropic": {
      const model = (tier === "flash")
        ? (config.model_flash || "claude-haiku-4-5-20251001")
        : (config.model || "claude-sonnet-4-6");
      return new AnthropicProvider(model);
    }
    case "claudecode": {
      // Piggybacks on Claude Code CLI auth — no ANTHROPIC_API_KEY needed.
      // Install: npm install -g @anthropic-ai/claude-code && claude login
      const model = (tier === "flash")
        ? (config.model_flash || "claude-haiku-4-5-20251001")
        : (config.model || "claude-sonnet-4-6");
      return new ClaudeCodeProvider({ model });
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

export async function createProvider(tier: LLMTier = "pro"): Promise<LLMProvider> {
  return providerFromConfig(await loadConfig(), tier);
}

export async function createVerifierProvider(tier: LLMTier = "flash"): Promise<LLMProvider> {
  const config = await loadConfig();
  if (!config.verifier_provider) return providerFromConfig(config, tier);

  return providerFromConfig({
    provider: config.verifier_provider,
    model: config.verifier_model,
    model_flash: config.verifier_model_flash,
    codexCommand: config.verifier_codexCommand ?? config.codexCommand,
    sandbox: config.verifier_sandbox ?? config.sandbox,
    approval: config.verifier_approval ?? config.approval,
    output_schema: config.verifier_output_schema ?? config.output_schema,
  }, tier);
}
