/**
 * Configuration Public API
 *
 * Single entry point for all configuration needs.
 * Import from here instead of individual config files.
 */

// Schema types
export type {
  AgentConfig,
  LLMConfig,
  LLMProvider,
  ModelTiers,
  ModelTier,
  ModelEndpoint,
  FeaturesConfig,
  KnowledgeFormationConfig,
  OutcomeTrackingConfig,
  MiddlewareConfig,
  ServicesConfig,
  RuntimeConfig,
} from "./schema.js";

export { AGENT_TIER_DEFAULTS } from "./schema.js";

// Loader
export {
  getConfig,
  loadConfig,
  resetConfig,
  resolveModelEndpoint,
} from "./loader.js";

// Validation
export { validateConfig, logValidationResult } from "./validate.js";
export type { ValidationResult } from "./validate.js";

// Backward-compatible re-exports from existing files
export {
  getActiveProvider,
  resolveProviderConfig,
  type LLMProviderConfig,
} from "./llm-providers.js";

export {
  loadModelConfigs,
  getAgentModelConfig,
  logModelConfigs,
  validateModelConfigs,
  createChatModel,
  createPlanModel,
  createResearchModel,
  createMemoryModel,
  createAnswerModel,
  createOpenRouterModel,
  createPlannerModel,
  createResearcherModel,
  type ModelConfig,
  type AgentModelConfigs,
} from "./model-config.js";

export {
  loadExtractionConfig,
  loadOutcomeTrackingConfig,
  type ExtractionConfig,
  type KnowledgeHealthMetadata,
  type ApplicationEvent,
  type SensitivityPreset,
  SENSITIVITY_PRESETS,
  DEFAULT_CONFIG,
  DEFAULT_OUTCOME_CONFIG,
} from "./knowledge-formation-config.js";
