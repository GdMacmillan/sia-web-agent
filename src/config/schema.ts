/**
 * Centralized, type-safe configuration schema for the agent.
 *
 * All environment variables are parsed, validated, and typed here.
 * This is the single source of truth for configuration shape.
 */

import type { LLMProvider } from "./llm-providers.js";

// ============================================================================
// Top-Level Config
// ============================================================================

export interface AgentConfig {
  /** LLM provider and model configuration */
  llm: LLMConfig;

  /** Feature toggles and settings */
  features: FeaturesConfig;

  /** Middleware configuration */
  middleware: MiddlewareConfig;

  /** External service configuration */
  services: ServicesConfig;

  /** Runtime configuration */
  runtime: RuntimeConfig;
}

// ============================================================================
// LLM Configuration
// ============================================================================

export type { LLMProvider } from "./llm-providers.js";

/**
 * Capability-based model tiers.
 *
 * Instead of mapping models to agent roles (planner, researcher),
 * we map them to capability tiers. Agents then declare which tier
 * they need, making the mapping explicit and configurable.
 *
 * - smallFast: Quick, cheap models for routing, simple tasks
 * - midtier: Balanced cost/capability for most agent work
 * - heavyThinking: Most capable models for complex reasoning
 */
export interface ModelTiers {
  /** Quick, cheap model for routing and simple tasks */
  smallFast: string;
  /** Balanced cost/capability for most agent work */
  midtier: string;
  /** Most capable model for complex reasoning and planning */
  heavyThinking: string;
}

/**
 * Per-model endpoint configuration
 */
export interface ModelEndpoint {
  /** Model identifier (e.g., "openai/gpt-4o-mini") */
  model: string;
  /** API key for this endpoint */
  apiKey: string;
  /** Base URL for the API endpoint */
  baseUrl: string;
}

/**
 * Full LLM configuration
 */
export interface LLMConfig {
  /** Active LLM provider */
  provider: LLMProvider;

  /** Provider-specific env prefix (e.g., "OPENROUTER") */
  envPrefix: string;

  /** Default API key for the provider */
  apiKey: string;

  /** Default base URL for the provider */
  baseUrl: string;

  /** Default model for the provider */
  model: string;

  /** Capability-based model tiers */
  tiers: ModelTiers;

  /**
   * Per-agent model overrides (legacy role-based).
   *
   * These map agent roles to specific models/keys. They take
   * precedence over tier-based defaults for backward compatibility.
   *
   * New code should prefer tier-based configuration.
   */
  agentOverrides: {
    orchestrator?: Partial<ModelEndpoint>;
    planner?: Partial<ModelEndpoint>;
    researcher?: Partial<ModelEndpoint>;
    memory?: Partial<ModelEndpoint>;
    answer?: Partial<ModelEndpoint>;
    toolUse?: Partial<ModelEndpoint>;
  };
}

// ============================================================================
// Agent-to-Tier Mapping
// ============================================================================

/**
 * Default mapping of agent roles to capability tiers.
 *
 * This determines which tier each agent uses when no explicit
 * per-agent override is configured.
 */
export type ModelTier = keyof ModelTiers;

export const AGENT_TIER_DEFAULTS: Record<string, ModelTier> = {
  orchestrator: "midtier",
  planner: "heavyThinking",
  researcher: "midtier",
  memory: "smallFast",
  answer: "midtier",
  toolUse: "midtier",
};

// ============================================================================
// Features Configuration
// ============================================================================

export interface FeaturesConfig {
  knowledgeFormation: KnowledgeFormationConfig;
  outcomeTracking: OutcomeTrackingConfig;
}

export interface KnowledgeFormationConfig {
  /** Enable/disable knowledge extraction (default: true) */
  enabled: boolean;
  /** Sensitivity preset: aggressive | balanced | conservative */
  sensitivity: "aggressive" | "balanced" | "conservative";
  /** Minimum confidence score to store learning (0-1, default: 0.7) */
  minConfidence: number;
  /** Maximum learnings to extract per task (default: 3) */
  maxLearningsPerTask: number;
  /** Similarity threshold for deduplication (0-1, default: 0.9) */
  deduplicationThreshold: number;
  /** Agent types to exclude from extraction */
  excludeAgentTypes: string[];
  /** Enable debug logging (default: false) */
  debugLogging: boolean;
}

export interface OutcomeTrackingConfig {
  /** Enable/disable outcome tracking (default: true) */
  enabled: boolean;
  /** Enable LLM-based critic evaluation (default: true) */
  criticEnabled: boolean;
  /** Re-ranking formula weights */
  rerankingWeights: {
    /** Weight for semantic similarity (default: 0.5) */
    similarity: number;
    /** Weight for success rate (default: 0.3) */
    successRate: number;
    /** Weight for recency (default: 0.2) */
    recency: number;
  };
  /** Maximum application history entries per entity (default: 10) */
  maxApplicationHistory: number;
  /** Minimum applications before using success rate for ranking (default: 3) */
  minApplicationsForRanking: number;
}

// ============================================================================
// Middleware Configuration
// ============================================================================

export interface MiddlewareConfig {
  summarization: {
    /** Token threshold to trigger summarization (default: 170000) */
    triggerTokens: number;
    /** Number of recent messages to preserve (default: 20) */
    keepMessages: number;
  };
  costTracking: {
    /** Cache TTL for pricing data in ms */
    cacheTtlMs: number | undefined;
  };
}

// ============================================================================
// Services Configuration
// ============================================================================

export interface ServicesConfig {
  tavily: {
    /** Tavily API key for web search */
    apiKey: string;
  };
  graphMemory: {
    /** Full API URL (overrides host/port if set) */
    apiUrl: string;
    /** Hostname (default: localhost) */
    host: string;
    /** Port (default: 8080) */
    port: string;
    /** Resolved base URL */
    baseUrl: string;
  };
}

// ============================================================================
// Runtime Configuration
// ============================================================================

export interface RuntimeConfig {
  /** Log verbosity (default: info) */
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  /** Node environment */
  nodeEnv: string;
  /** Project root override for self-improve mode */
  siaProjectRoot: string | undefined;
  /** IPC socket path for CLI communication */
  siaCliSocketPath: string | undefined;
  /** Unique agent identifier (default: "self-improving-agent") */
  agentId: string;
  /** Human-friendly agent name (default: "Self-Improving Agent") */
  agentName: string;
}
