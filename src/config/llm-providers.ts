/**
 * LLM Provider Resolution
 *
 * Resolves LLM_PROVIDER env var to provider-specific configuration.
 * Supports openrouter, openai, vllm, ollama, lmstudio, and custom providers.
 *
 * Backward compatible: defaults to openrouter when LLM_PROVIDER is unset,
 * so existing OPENROUTER_* env vars work without changes.
 *
 * Agent-side source of truth for the provider list, env-var prefixes, and
 * preset metadata. A parallel copy lives in
 * `packages/chatroom-db/src/runtime-config-schema.ts` for siad-Go
 * validation and the web NATS responder (AGI-264) — keep both in sync
 * until codegen consolidation lands.
 */

export const LLM_PROVIDERS = [
  "openrouter",
  "openai",
  "vllm",
  "ollama",
  "lmstudio",
  "custom",
] as const;
export type LLMProvider = (typeof LLM_PROVIDERS)[number];

export const PROVIDER_ENV_PREFIXES: Record<LLMProvider, string> = {
  openrouter: "OPENROUTER",
  openai: "OPENAI",
  vllm: "VLLM",
  ollama: "OLLAMA",
  lmstudio: "LMSTUDIO",
  custom: "LLM",
};

export interface LLMProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface ProviderPreset {
  defaultBaseUrl: string;
  defaultModel: string;
  requiresKey: boolean;
}

const PROVIDER_PRESETS: Record<LLMProvider, ProviderPreset> = {
  openrouter: {
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    requiresKey: true,
  },
  openai: {
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    requiresKey: true,
  },
  vllm: {
    defaultBaseUrl: "http://localhost:8000/v1",
    defaultModel: "",
    requiresKey: false,
  },
  ollama: {
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "",
    requiresKey: false,
  },
  lmstudio: {
    defaultBaseUrl: "http://localhost:1234/v1",
    defaultModel: "",
    requiresKey: false,
  },
  custom: {
    defaultBaseUrl: "",
    defaultModel: "",
    requiresKey: false,
  },
};

const SUPPORTED_PROVIDERS = LLM_PROVIDERS;

/**
 * Read the active provider from LLM_PROVIDER env var.
 * Defaults to "openrouter" for backward compatibility.
 */
export function getActiveProvider(): LLMProvider {
  const raw = process.env.LLM_PROVIDER;
  if (!raw) return "openrouter";

  const normalized = raw.toLowerCase() as LLMProvider;

  if (!Object.hasOwn(PROVIDER_PRESETS, normalized)) {
    throw new Error(
      `Unknown LLM provider: "${raw}". ` +
        `Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }

  return normalized;
}

/**
 * Resolve env vars to a complete LLMProviderConfig.
 *
 * @param agentRole - Optional agent role (e.g. "PLANNER", "RESEARCHER").
 *   When provided, checks {PREFIX}_{ROLE}_MODEL and {PREFIX}_{ROLE}_API_KEY
 *   as overrides on top of provider defaults.
 */
export function resolveProviderConfig(agentRole?: string): LLMProviderConfig {
  const provider = getActiveProvider();
  const preset = PROVIDER_PRESETS[provider];
  const prefix = PROVIDER_ENV_PREFIXES[provider];

  // Base values from provider env vars
  const baseUrl = process.env[`${prefix}_BASE_URL`] || preset.defaultBaseUrl;
  let apiKey = process.env[`${prefix}_API_KEY`] || "";
  let model = process.env[`${prefix}_MODEL`] || preset.defaultModel;

  // Per-agent overrides: {PREFIX}_{ROLE}_MODEL, {PREFIX}_{ROLE}_API_KEY
  if (agentRole) {
    const roleModel = process.env[`${prefix}_${agentRole}_MODEL`];
    if (roleModel) model = roleModel;

    const roleKey = process.env[`${prefix}_${agentRole}_API_KEY`];
    if (roleKey) apiKey = roleKey;
  }

  // Validation: remote providers require an API key
  if (preset.requiresKey && !apiKey) {
    throw new Error(
      `API key required for provider "${provider}". ` +
        `Set ${prefix}_API_KEY environment variable.`,
    );
  }

  // Validation: custom provider requires a base URL
  if (provider === "custom" && !baseUrl) {
    throw new Error(
      `Base URL required for custom provider. Set LLM_BASE_URL environment variable.`,
    );
  }

  return { apiKey, baseUrl, model };
}
