/**
 * Configuration Loader
 *
 * The ONLY place that reads process.env for agent configuration.
 * Loads, validates, and returns a typed AgentConfig singleton.
 *
 * All environment variables are read here and nowhere else.
 * Consumer code imports getConfig() and accesses typed properties.
 */

import {
  AGENT_TIER_DEFAULTS,
  type AgentConfig,
  type LLMConfig,
  type LLMProvider,
  type ModelTiers,
  type ModelEndpoint,
  type FeaturesConfig,
  type KnowledgeFormationConfig,
  type OutcomeTrackingConfig,
  type MiddlewareConfig,
  type ServicesConfig,
  type RuntimeConfig,
} from "./schema.js";
import {
  SENSITIVITY_PRESETS,
  DEFAULT_CONFIG,
  DEFAULT_OUTCOME_CONFIG,
  type SensitivityPreset,
} from "./knowledge-formation-config.js";
import { LLM_PROVIDERS, PROVIDER_ENV_PREFIXES } from "./llm-providers.js";

// ============================================================================
// Provider Presets
// ============================================================================

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

// ============================================================================
// Singleton
// ============================================================================

let cachedConfig: AgentConfig | null = null;

/**
 * Get the agent configuration (singleton).
 *
 * Loads from environment on first call, returns cached config thereafter.
 * Call resetConfig() in tests to force reload.
 */
export function getConfig(): AgentConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * Load configuration from environment variables.
 *
 * Creates a fresh config each time — prefer getConfig() for cached access.
 * Useful in tests or when env vars change at runtime.
 */
export function loadConfig(): AgentConfig {
  return {
    llm: loadLLMConfig(),
    features: loadFeaturesConfig(),
    middleware: loadMiddlewareConfig(),
    services: loadServicesConfig(),
    runtime: loadRuntimeConfig(),
  };
}

/**
 * Reset the cached config (for testing).
 */
export function resetConfig(): void {
  cachedConfig = null;
}

// ============================================================================
// LLM Config Loading
// ============================================================================

function loadLLMConfig(): LLMConfig {
  const provider = resolveProvider();
  const preset = PROVIDER_PRESETS[provider];
  const prefix = PROVIDER_ENV_PREFIXES[provider];

  const baseUrl = env(`${prefix}_BASE_URL`) || preset.defaultBaseUrl;
  const apiKey = env(`${prefix}_API_KEY`) || "";
  const model = env(`${prefix}_MODEL`) || preset.defaultModel;

  return {
    provider,
    envPrefix: prefix,
    apiKey,
    baseUrl,
    model,
    tiers: loadModelTiers(prefix, model),
    agentOverrides: loadAgentOverrides(prefix),
  };
}

function resolveProvider(): LLMProvider {
  const raw = env("LLM_PROVIDER");
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
 * Load capability-based model tiers.
 *
 * Checks for tier-specific env vars first:
 *   {PREFIX}_SMALL_FAST_MODEL
 *   {PREFIX}_MIDTIER_MODEL
 *   {PREFIX}_HEAVY_THINKING_MODEL
 *
 * Falls back to the default model for all tiers if not set.
 */
function loadModelTiers(prefix: string, defaultModel: string): ModelTiers {
  return {
    smallFast: env(`${prefix}_SMALL_FAST_MODEL`) || defaultModel,
    midtier: env(`${prefix}_MIDTIER_MODEL`) || defaultModel,
    heavyThinking: env(`${prefix}_HEAVY_THINKING_MODEL`) || defaultModel,
  };
}

/**
 * Load per-agent model overrides (legacy role-based env vars).
 *
 * These take precedence over tier-based defaults when set.
 * Env vars: {PREFIX}_{ROLE}_MODEL, {PREFIX}_{ROLE}_API_KEY
 */
function loadAgentOverrides(prefix: string): LLMConfig["agentOverrides"] {
  const roles = [
    "ORCHESTRATOR",
    "PLANNER",
    "RESEARCHER",
    "MEMORY",
    "ANSWER",
    "TOOL_USE",
  ] as const;

  const roleToKey: Record<string, keyof LLMConfig["agentOverrides"]> = {
    ORCHESTRATOR: "orchestrator",
    PLANNER: "planner",
    RESEARCHER: "researcher",
    MEMORY: "memory",
    ANSWER: "answer",
    TOOL_USE: "toolUse",
  };

  const overrides: LLMConfig["agentOverrides"] = {};

  for (const role of roles) {
    const roleModel = env(`${prefix}_${role}_MODEL`);
    const roleKey = env(`${prefix}_${role}_API_KEY`);

    if (roleModel || roleKey) {
      const key = roleToKey[role];
      overrides[key] = {
        ...(roleModel && { model: roleModel }),
        ...(roleKey && { apiKey: roleKey }),
      };
    }
  }

  return overrides;
}

// ============================================================================
// Features Config Loading
// ============================================================================

function loadFeaturesConfig(): FeaturesConfig {
  return {
    knowledgeFormation: loadKnowledgeFormationConfig(),
    outcomeTracking: loadOutcomeTrackingConfig(),
    codeInterpreter: loadCodeInterpreterConfig(),
  };
}

function loadCodeInterpreterConfig(): FeaturesConfig["codeInterpreter"] {
  return {
    // Opt-in: only the QuickJS interpreter is gated here. The default
    // tsx `execute_code` tool stays on regardless.
    enabled: env("ENABLE_CODE_INTERPRETER") === "true",
  };
}

function loadKnowledgeFormationConfig(): KnowledgeFormationConfig {
  const sensitivityRaw = env("KNOWLEDGE_FORMATION_SENSITIVITY") as
    | SensitivityPreset
    | undefined;
  const presetConfig = sensitivityRaw
    ? SENSITIVITY_PRESETS[sensitivityRaw]
    : {};
  const sensitivity = sensitivityRaw || "balanced";

  return {
    enabled: env("KNOWLEDGE_FORMATION_ENABLED") !== "false",
    sensitivity: sensitivity as KnowledgeFormationConfig["sensitivity"],
    minConfidence:
      parseFloatOrDefault(
        env("KNOWLEDGE_FORMATION_MIN_CONFIDENCE"),
        presetConfig.minConfidence,
      ) || DEFAULT_CONFIG.minConfidence,
    maxLearningsPerTask:
      parseIntOrDefault(
        env("KNOWLEDGE_FORMATION_MAX_LEARNINGS"),
        presetConfig.maxLearningsPerTask,
      ) || DEFAULT_CONFIG.maxLearningsPerTask,
    deduplicationThreshold:
      parseFloatOrDefault(
        env("KNOWLEDGE_FORMATION_DEDUP_THRESHOLD"),
        presetConfig.deduplicationThreshold,
      ) || DEFAULT_CONFIG.deduplicationThreshold,
    excludeAgentTypes: (env("KNOWLEDGE_FORMATION_EXCLUDE_AGENTS") || "")
      .split(",")
      .filter(Boolean),
    debugLogging: env("KNOWLEDGE_FORMATION_DEBUG") === "true",
  };
}

function loadOutcomeTrackingConfig(): OutcomeTrackingConfig {
  return {
    enabled: env("OUTCOME_TRACKING_ENABLED") !== "false",
    criticEnabled: env("OUTCOME_TRACKING_CRITIC_ENABLED") !== "false",
    rerankingWeights: {
      similarity:
        parseFloatOrDefault(env("OUTCOME_TRACKING_SIMILARITY_WEIGHT")) ||
        DEFAULT_OUTCOME_CONFIG.rerankingWeights.similarity,
      successRate:
        parseFloatOrDefault(env("OUTCOME_TRACKING_SUCCESS_WEIGHT")) ||
        DEFAULT_OUTCOME_CONFIG.rerankingWeights.successRate,
      recency:
        parseFloatOrDefault(env("OUTCOME_TRACKING_RECENCY_WEIGHT")) ||
        DEFAULT_OUTCOME_CONFIG.rerankingWeights.recency,
    },
    maxApplicationHistory:
      parseIntOrDefault(env("OUTCOME_TRACKING_MAX_HISTORY")) ||
      DEFAULT_OUTCOME_CONFIG.maxApplicationHistory,
    minApplicationsForRanking:
      parseIntOrDefault(env("OUTCOME_TRACKING_MIN_APPLICATIONS")) ||
      DEFAULT_OUTCOME_CONFIG.minApplicationsForRanking,
  };
}

// ============================================================================
// Middleware Config Loading
// ============================================================================

function loadMiddlewareConfig(): MiddlewareConfig {
  return {
    summarization: {
      triggerTokens: parseIntOrDefault(
        env("SUMMARIZATION_TRIGGER_TOKENS"),
        170000,
      )!,
      keepMessages: parseIntOrDefault(env("SUMMARIZATION_KEEP_MESSAGES"), 20)!,
    },
    costTracking: {
      cacheTtlMs: parseIntOrDefault(env("COST_TRACKING_CACHE_TTL_MS")),
    },
  };
}

// ============================================================================
// Services Config Loading
// ============================================================================

function loadServicesConfig(): ServicesConfig {
  return {
    tavily: {
      apiKey: env("TAVILY_API_KEY") || "",
    },
  };
}

// ============================================================================
// Runtime Config Loading
// ============================================================================

function loadRuntimeConfig(): RuntimeConfig {
  const logLevel = (env("LOG_LEVEL") || "info") as RuntimeConfig["logLevel"];

  return {
    logLevel,
    nodeEnv: env("NODE_ENV") || "development",
    siaProjectRoot: env("SIA_PROJECT_ROOT") || undefined,
    siaCliSocketPath: env("SIA_CLI_SOCKET_PATH") || undefined,
    harnessProfile: env("HARNESS_PROFILE") || undefined,
    agentId: env("SIA_AGENT_ID") || "self-improving-agent",
    agentName: env("SIA_AGENT_NAME") || "Self-Improving Agent",
    workspaceId: env("SIA_WORKSPACE_ID") || undefined,
  };
}

// ============================================================================
// Model Resolution (public API for agent setup)
// ============================================================================

/**
 * Resolve the model endpoint for a specific agent role.
 *
 * Resolution priority:
 * 1. Per-agent override env var (e.g., OPENROUTER_PLANNER_MODEL) — legacy
 * 2. Tier-based model (agent → tier → tier model)
 * 3. Provider default model
 *
 * This replaces the old resolveProviderConfig(agentRole) pattern.
 */
export function resolveModelEndpoint(
  config: LLMConfig,
  agentRole?: string,
): ModelEndpoint {
  let model = config.model;
  let apiKey = config.apiKey;
  const baseUrl = config.baseUrl;

  // Step 1: Apply tier-based default if agent role has a tier mapping
  if (agentRole) {
    const roleKey =
      agentRole.toLowerCase() as keyof LLMConfig["agentOverrides"];
    const tier = AGENT_TIER_DEFAULTS[roleKey];
    if (tier) {
      model = config.tiers[tier];
    }
  }

  // Step 2: Apply per-agent overrides (highest priority)
  if (agentRole) {
    const roleKey =
      agentRole.toLowerCase() as keyof LLMConfig["agentOverrides"];
    const override = config.agentOverrides[roleKey];
    if (override?.model) model = override.model;
    if (override?.apiKey) apiKey = override.apiKey;
  }

  return { model, apiKey, baseUrl };
}

// ============================================================================
// Helpers
// ============================================================================

function env(key: string): string | undefined {
  return process.env[key];
}

function parseIntOrDefault(
  value: string | undefined,
  fallback?: number,
): number | undefined {
  if (value) {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}

function parseFloatOrDefault(
  value: string | undefined,
  fallback?: number,
): number | undefined {
  if (value) {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}
