/**
 * Multi-Model Configuration System
 *
 * Enables different agents to use different LLM models and API keys.
 * Supports:
 * - Per-agent model selection (orchestrator, planner, researcher)
 * - Per-agent API keys for cost tracking and isolation
 * - Multiple LLM providers via LLM_PROVIDER env var
 * - Backward compatibility with single OPENROUTER_MODEL setup
 * - Fallback chains for missing configuration
 *
 * ============================================================================
 * CONFIGURATION GUIDE
 * ============================================================================
 * See docs/ENVIRONMENT.md for complete configuration instructions.
 *
 * Provider selection (LLM_PROVIDER env var):
 * - openrouter (default): Uses OPENROUTER_* env vars
 * - openai: Uses OPENAI_* env vars
 * - vllm / ollama / lmstudio: Local providers, no API key required
 * - custom: Uses LLM_* env vars
 *
 * Configuration Priority (highest to lowest):
 * 1. Per-agent env vars (e.g., OPENROUTER_PLANNER_MODEL)
 * 2. Provider env vars (e.g., OPENROUTER_MODEL)
 * 3. Provider preset defaults
 *
 * Example setup:
 * LLM_PROVIDER=openrouter (or unset for backward compatibility)
 * OPENROUTER_API_KEY=sk-or-v1-yyy
 * OPENROUTER_PLANNER_MODEL=openai/gpt-oss-120b
 *
 * Or with OpenAI directly:
 * LLM_PROVIDER=openai
 * OPENAI_API_KEY=sk-xxx
 * OPENAI_PLANNER_MODEL=gpt-4o
 *
 * See docs/ENVIRONMENT.md for all variables.
 * ============================================================================
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getConfig, resolveModelEndpoint } from "./loader.js";
import { logger as defaultLogger } from "../utils/logger.js";

/**
 * Configuration for a specific LLM model and its API key
 */
export interface ModelConfig {
  /** Model identifier (e.g., "openai/gpt-4o-mini", "gpt-4o") */
  model: string;
  /** API key for this model */
  apiKey: string;
  /** Base URL for the API endpoint */
  baseUrl: string;
}

/**
 * All available agent model configurations
 */
export interface AgentModelConfigs {
  /** Manager agent - routes and orchestrates other agents */
  orchestrator: ModelConfig;
  /** Planner agent - creates implementation plans with RAG */
  planner: ModelConfig;
  /** Researcher agent - performs web searches and lookups */
  researcher: ModelConfig;
}

/**
 * Load model configurations from environment variables
 *
 * Uses the active LLM provider (from LLM_PROVIDER env var, default: openrouter)
 * to resolve per-agent model, apiKey, and baseUrl.
 *
 * @returns AgentModelConfigs with all agents configured
 * @throws Error if required configuration is missing
 */
export function loadModelConfigs(): AgentModelConfigs {
  const llmConfig = getConfig().llm;
  return {
    orchestrator: resolveModelEndpoint(llmConfig, "orchestrator"),
    planner: resolveModelEndpoint(llmConfig, "planner"),
    researcher: resolveModelEndpoint(llmConfig, "researcher"),
  };
}

/**
 * Get a specific agent's model configuration
 *
 * @param configs - Full AgentModelConfigs from loadModelConfigs()
 * @param agentType - Type of agent: 'orchestrator' | 'planner' | 'researcher'
 * @returns ModelConfig for the requested agent
 */
export function getAgentModelConfig(
  configs: AgentModelConfigs,
  agentType: keyof AgentModelConfigs,
): ModelConfig {
  return configs[agentType];
}

/**
 * Log model configuration for debugging
 *
 * @param configs - Full AgentModelConfigs from loadModelConfigs()
 * @param logger - Logger instance (optional)
 */
export function logModelConfigs(
  configs: AgentModelConfigs,
  logger?: { info: (msg: string, data?: any) => void },
): void {
  const summary = {
    orchestrator: configs.orchestrator.model,
    planner: configs.planner.model,
    researcher: configs.researcher.model,
  };

  const message =
    "[Model Configuration]\n" +
    `  Orchestrator (Manager): ${configs.orchestrator.model}\n` +
    `  Planner: ${configs.planner.model}\n` +
    `  Researcher: ${configs.researcher.model}`;

  if (logger) {
    logger.info(message, { models: summary });
  } else {
    defaultLogger.info({ models: summary }, message);
  }
}

/**
 * Validate model configuration for best practices
 *
 * @param configs - Full AgentModelConfigs from loadModelConfigs()
 * @param logger - Logger instance (optional)
 */
export function validateModelConfigs(
  configs: AgentModelConfigs,
  logger?: { warn: (msg: string) => void },
): void {
  // :exacto is an OpenRouter-specific endpoint; skip validation for other providers
  if (getConfig().llm.provider !== "openrouter") return;

  const warn = logger?.warn || defaultLogger.warn.bind(defaultLogger);

  if (configs.orchestrator.model.includes(":exacto")) {
    warn(
      "[Model Config] Warning: :exacto endpoint recommended only for tool-heavy workloads. " +
        "Orchestrator (Manager) does not use tools - consider using a lighter model",
    );
  }

  if (configs.planner.model.includes(":exacto")) {
    warn(
      "[Model Config] Warning: :exacto endpoint recommended only for tool-heavy workloads. " +
        "Planner does not use tools - consider using a lighter model",
    );
  }

  if (configs.researcher.model.includes(":exacto")) {
    warn(
      "[Model Config] Warning: :exacto endpoint recommended only for tool-heavy workloads. " +
        "Researcher does not use tools - consider using a lighter model",
    );
  }
}

interface ResolvedEndpoint {
  model: string;
  apiKey: string;
  baseUrl: string;
}

/**
 * Provider-aware chat-model factory.
 *
 * `LLM_PROVIDER === "openrouter"` → `ChatOpenRouter` (talks directly to OR via
 *   fetch — does not auto-route codex models through OpenAI's Responses API,
 *   which is why we need it for AGI-235's cost capture).
 *
 * Any other provider → `ChatOpenAI` against the resolved baseURL. Unchanged.
 */
async function instantiateChatModel(
  endpoint: ResolvedEndpoint,
): Promise<BaseChatModel> {
  const provider = getConfig().llm.provider;
  if (provider === "openrouter") {
    const { ChatOpenRouter } = await import("@langchain/openrouter");
    return new ChatOpenRouter({
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      baseURL: endpoint.baseUrl,
    }) as unknown as BaseChatModel;
  }
  const { ChatOpenAI } = await import("@langchain/openai");
  return new ChatOpenAI({
    apiKey: endpoint.apiKey,
    model: endpoint.model,
    configuration: { baseURL: endpoint.baseUrl },
  }) as unknown as BaseChatModel;
}

/**
 * Create a chat-model instance configured for the active LLM provider.
 *
 * Returns a `BaseChatModel` so callers don't depend on the concrete class.
 * Under `LLM_PROVIDER=openrouter` this is a `ChatOpenRouter`; otherwise a
 * `ChatOpenAI`. Both implement the same Runnable surface used by the agent.
 *
 * @param modelName - Model identifier override
 * @param apiKey - API key override
 * @param baseUrl - Base URL override
 */
export async function createChatModel(
  modelName?: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<BaseChatModel> {
  const llmConfig = getConfig().llm;
  const defaultEndpoint = resolveModelEndpoint(llmConfig);
  const model = modelName || defaultEndpoint.model;
  const key = apiKey || defaultEndpoint.apiKey;
  const url = baseUrl || defaultEndpoint.baseUrl;

  if (!model) {
    throw new Error(
      "Model name required. Provide modelName parameter or set the appropriate MODEL environment variable for your provider",
    );
  }

  return instantiateChatModel({ model, apiKey: key, baseUrl: url });
}

/**
 * @deprecated Use createChatModel instead
 */
export const createOpenRouterModel = createChatModel;

/**
 * Plan-agent chat model. Resolves the planner-tier endpoint from env
 * (e.g. `OPENROUTER_PLANNER_MODEL`, `OPENROUTER_HEAVY_THINKING_MODEL`),
 * then dispatches to the active provider via `createChatModel`.
 */
export async function createPlanModel(): Promise<BaseChatModel> {
  const endpoint = resolveModelEndpoint(getConfig().llm, "planner");
  return createChatModel(endpoint.model, endpoint.apiKey, endpoint.baseUrl);
}

/** @deprecated Use createPlanModel instead */
export const createPlannerModel = createPlanModel;

/**
 * Memory-agent chat model. Resolves the memory-tier endpoint from env
 * (e.g. `OPENROUTER_MEMORY_MODEL`, `OPENROUTER_SMALL_FAST_MODEL`).
 */
export async function createMemoryModel(): Promise<BaseChatModel> {
  const endpoint = resolveModelEndpoint(getConfig().llm, "memory");
  return createChatModel(endpoint.model, endpoint.apiKey, endpoint.baseUrl);
}

/**
 * Research-agent chat model. Resolves the researcher-tier endpoint from env
 * (e.g. `OPENROUTER_RESEARCHER_MODEL`, `OPENROUTER_MIDTIER_MODEL`).
 */
export async function createResearchModel(): Promise<BaseChatModel> {
  const endpoint = resolveModelEndpoint(getConfig().llm, "researcher");
  return createChatModel(endpoint.model, endpoint.apiKey, endpoint.baseUrl);
}

/** @deprecated Use createResearchModel instead */
export const createResearcherModel = createResearchModel;

/**
 * Answer-agent chat model. Resolves the answer-tier endpoint from env
 * (e.g. `OPENROUTER_ANSWER_MODEL`, `OPENROUTER_MIDTIER_MODEL`).
 */
export async function createAnswerModel(): Promise<BaseChatModel> {
  const endpoint = resolveModelEndpoint(getConfig().llm, "answer");
  return createChatModel(endpoint.model, endpoint.apiKey, endpoint.baseUrl);
}
