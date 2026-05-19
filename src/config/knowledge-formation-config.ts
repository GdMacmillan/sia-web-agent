/**
 * Configuration for Automated Knowledge Formation Middleware
 *
 * Automatically extracts and stores learnings from agent task completions
 * without requiring explicit store_entity tool calls.
 */

/**
 * Knowledge Health Metadata - tracked for each learning entity
 */
export interface KnowledgeHealthMetadata {
  /** Times this learning was applied in successful tasks */
  success_count: number;
  /** Times this learning was applied in failed tasks */
  failure_count: number;
  /** Computed success rate: success_count / (success_count + failure_count) */
  success_rate: number;
  /** ISO timestamp of last application */
  last_applied_at: string;
  /** Ring buffer of last N applications */
  application_history: ApplicationEvent[];
}

/**
 * Individual application event in history
 */
export interface ApplicationEvent {
  /** Unique task identifier */
  task_id: string;
  /** ISO timestamp */
  timestamp: string;
  /** Outcome of the task */
  outcome: "success" | "failure" | "unknown";
  /** Critic's confidence in the evaluation (0-1) */
  confidence: number;
  /** Brief description of how it was applied */
  context_snippet?: string;
}

/**
 * Configuration for outcome tracking and re-ranking
 */
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

export interface ExtractionConfig {
  /** Enable/disable knowledge extraction (default: true) */
  enabled: boolean;

  /** Minimum confidence score to store learning (0-1, default: 0.7) */
  minConfidence: number;

  /** Maximum learnings to extract per task (default: 3) */
  maxLearningsPerTask: number;

  /** Similarity threshold for deduplication (0-1, default: 0.9) */
  deduplicationThreshold: number;

  /** Agent types to exclude from extraction (e.g., ["planner"]) */
  excludeAgentTypes: string[];

  /** Enable debug logging (default: false) */
  debugLogging: boolean;
}

export type SensitivityPreset = "aggressive" | "balanced" | "conservative";

export const SENSITIVITY_PRESETS: Record<
  SensitivityPreset,
  Partial<ExtractionConfig>
> = {
  aggressive: {
    minConfidence: 0.5,
    maxLearningsPerTask: 5,
    deduplicationThreshold: 0.85,
  },
  balanced: {
    minConfidence: 0.7,
    maxLearningsPerTask: 3,
    deduplicationThreshold: 0.9,
  },
  conservative: {
    minConfidence: 0.85,
    maxLearningsPerTask: 2,
    deduplicationThreshold: 0.95,
  },
};

export const DEFAULT_CONFIG: ExtractionConfig = {
  enabled: true,
  minConfidence: 0.7,
  maxLearningsPerTask: 3,
  deduplicationThreshold: 0.9,
  excludeAgentTypes: [],
  debugLogging: false,
};

export const DEFAULT_OUTCOME_CONFIG: OutcomeTrackingConfig = {
  enabled: true,
  criticEnabled: true,
  rerankingWeights: {
    similarity: 0.5,
    successRate: 0.3,
    recency: 0.2,
  },
  maxApplicationHistory: 10,
  minApplicationsForRanking: 3,
};

/**
 * Load configuration from environment variables
 *
 * Environment variables:
 * - KNOWLEDGE_FORMATION_ENABLED (default: true)
 * - KNOWLEDGE_FORMATION_SENSITIVITY (aggressive|balanced|conservative)
 * - KNOWLEDGE_FORMATION_MIN_CONFIDENCE (0-1)
 * - KNOWLEDGE_FORMATION_MAX_LEARNINGS (number)
 * - KNOWLEDGE_FORMATION_DEDUP_THRESHOLD (0-1)
 * - KNOWLEDGE_FORMATION_EXCLUDE_AGENTS (comma-separated list)
 * - KNOWLEDGE_FORMATION_DEBUG (true|false)
 */
export function loadExtractionConfig(): ExtractionConfig {
  const preset = process.env.KNOWLEDGE_FORMATION_SENSITIVITY as
    | SensitivityPreset
    | undefined;
  const presetConfig = preset ? SENSITIVITY_PRESETS[preset] : {};

  return {
    enabled: process.env.KNOWLEDGE_FORMATION_ENABLED !== "false",
    minConfidence:
      parseFloat(process.env.KNOWLEDGE_FORMATION_MIN_CONFIDENCE || "") ||
      presetConfig.minConfidence ||
      DEFAULT_CONFIG.minConfidence,
    maxLearningsPerTask:
      parseInt(process.env.KNOWLEDGE_FORMATION_MAX_LEARNINGS || "") ||
      presetConfig.maxLearningsPerTask ||
      DEFAULT_CONFIG.maxLearningsPerTask,
    deduplicationThreshold:
      parseFloat(process.env.KNOWLEDGE_FORMATION_DEDUP_THRESHOLD || "") ||
      presetConfig.deduplicationThreshold ||
      DEFAULT_CONFIG.deduplicationThreshold,
    excludeAgentTypes: (process.env.KNOWLEDGE_FORMATION_EXCLUDE_AGENTS || "")
      .split(",")
      .filter(Boolean),
    debugLogging: process.env.KNOWLEDGE_FORMATION_DEBUG === "true",
  };
}

/**
 * Load outcome tracking configuration from environment variables
 *
 * Environment variables:
 * - OUTCOME_TRACKING_ENABLED (default: true)
 * - OUTCOME_TRACKING_CRITIC_ENABLED (default: true)
 * - OUTCOME_TRACKING_SIMILARITY_WEIGHT (default: 0.5)
 * - OUTCOME_TRACKING_SUCCESS_WEIGHT (default: 0.3)
 * - OUTCOME_TRACKING_RECENCY_WEIGHT (default: 0.2)
 * - OUTCOME_TRACKING_MAX_HISTORY (default: 10)
 * - OUTCOME_TRACKING_MIN_APPLICATIONS (default: 3)
 */
export function loadOutcomeTrackingConfig(): OutcomeTrackingConfig {
  return {
    enabled: process.env.OUTCOME_TRACKING_ENABLED !== "false",
    criticEnabled: process.env.OUTCOME_TRACKING_CRITIC_ENABLED !== "false",
    rerankingWeights: {
      similarity:
        parseFloat(process.env.OUTCOME_TRACKING_SIMILARITY_WEIGHT || "") ||
        DEFAULT_OUTCOME_CONFIG.rerankingWeights.similarity,
      successRate:
        parseFloat(process.env.OUTCOME_TRACKING_SUCCESS_WEIGHT || "") ||
        DEFAULT_OUTCOME_CONFIG.rerankingWeights.successRate,
      recency:
        parseFloat(process.env.OUTCOME_TRACKING_RECENCY_WEIGHT || "") ||
        DEFAULT_OUTCOME_CONFIG.rerankingWeights.recency,
    },
    maxApplicationHistory:
      parseInt(process.env.OUTCOME_TRACKING_MAX_HISTORY || "") ||
      DEFAULT_OUTCOME_CONFIG.maxApplicationHistory,
    minApplicationsForRanking:
      parseInt(process.env.OUTCOME_TRACKING_MIN_APPLICATIONS || "") ||
      DEFAULT_OUTCOME_CONFIG.minApplicationsForRanking,
  };
}
