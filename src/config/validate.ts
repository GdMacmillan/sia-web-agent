/**
 * Configuration Validation
 *
 * Validates the loaded AgentConfig and returns helpful error messages.
 * Called once at startup to fail fast on misconfiguration.
 */

import type { AgentConfig } from "./schema.js";
import { logger as defaultLogger } from "../utils/logger.js";

export interface ValidationResult {
  /** Whether the config is valid (no errors) */
  valid: boolean;
  /** Fatal errors that prevent startup */
  errors: string[];
  /** Non-fatal warnings about potential issues */
  warnings: string[];
}

/**
 * Validate configuration and return errors/warnings.
 *
 * Checks:
 * - Required API keys for remote providers
 * - Custom provider has base URL
 * - Model tiers are populated
 * - Re-ranking weights sum to ~1.0
 * - Numeric ranges are valid
 */
export function validateConfig(config: AgentConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- LLM Provider Validation ---

  const { llm } = config;
  const requiresKey =
    llm.provider === "openrouter" || llm.provider === "openai";

  if (requiresKey && !llm.apiKey) {
    const prefix = llm.envPrefix;
    const urls: Record<string, string> = {
      OPENROUTER: "https://openrouter.ai/keys",
      OPENAI: "https://platform.openai.com/api-keys",
    };
    errors.push(
      `${prefix}_API_KEY is required when LLM_PROVIDER=${llm.provider}. ` +
        `Get a key at ${urls[prefix] || "your provider's dashboard"}.`,
    );
  }

  if (llm.provider === "custom" && !llm.baseUrl) {
    errors.push(
      "LLM_BASE_URL is required for custom provider. " +
        "Set LLM_BASE_URL to your LLM endpoint.",
    );
  }

  // Warn if no model is set for any tier
  if (!llm.model && !llm.tiers.smallFast) {
    warnings.push(
      `No default model configured for provider "${llm.provider}". ` +
        `Set ${llm.envPrefix}_MODEL or tier-specific models.`,
    );
  }

  // Warn about empty tiers for remote providers
  if (requiresKey) {
    for (const [tier, model] of Object.entries(llm.tiers)) {
      if (!model) {
        warnings.push(
          `Model tier "${tier}" has no model configured. ` +
            `Set ${llm.envPrefix}_${tierToEnvSuffix(tier)}_MODEL.`,
        );
      }
    }
  }

  // --- Features Validation ---

  const { knowledgeFormation, outcomeTracking } = config.features;

  if (
    knowledgeFormation.minConfidence < 0 ||
    knowledgeFormation.minConfidence > 1
  ) {
    errors.push(
      `KNOWLEDGE_FORMATION_MIN_CONFIDENCE must be between 0 and 1, ` +
        `got ${knowledgeFormation.minConfidence}.`,
    );
  }

  if (
    knowledgeFormation.deduplicationThreshold < 0 ||
    knowledgeFormation.deduplicationThreshold > 1
  ) {
    errors.push(
      `KNOWLEDGE_FORMATION_DEDUP_THRESHOLD must be between 0 and 1, ` +
        `got ${knowledgeFormation.deduplicationThreshold}.`,
    );
  }

  // Check re-ranking weights sum
  const { similarity, successRate, recency } = outcomeTracking.rerankingWeights;
  const weightSum = similarity + successRate + recency;
  if (Math.abs(weightSum - 1.0) > 0.01) {
    warnings.push(
      `Outcome tracking re-ranking weights sum to ${weightSum.toFixed(2)} ` +
        `(expected ~1.0). Weights: similarity=${similarity}, ` +
        `successRate=${successRate}, recency=${recency}.`,
    );
  }

  // --- Services Validation ---

  if (!config.services.tavily.apiKey) {
    warnings.push(
      "TAVILY_API_KEY is not set. Web search will be unavailable. " +
        "Get a key at https://tavily.com",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Log validation results in a human-friendly format.
 */
export function logValidationResult(
  result: ValidationResult,
  logger?: {
    error: (msg: string) => void;
    warn: (msg: string) => void;
    info: (msg: string) => void;
  },
): void {
  const log = logger || {
    error: defaultLogger.error.bind(defaultLogger),
    warn: defaultLogger.warn.bind(defaultLogger),
    info: defaultLogger.info.bind(defaultLogger),
  };

  if (result.errors.length > 0) {
    log.error("[Config] Configuration errors:");
    for (const err of result.errors) {
      log.error(`  ✗ ${err}`);
    }
  }

  if (result.warnings.length > 0) {
    log.warn("[Config] Configuration warnings:");
    for (const warn of result.warnings) {
      log.warn(`  ⚠ ${warn}`);
    }
  }

  if (result.valid && result.warnings.length === 0) {
    log.info("[Config] Configuration validated successfully.");
  }
}

// ============================================================================
// Helpers
// ============================================================================

function tierToEnvSuffix(tier: string): string {
  // smallFast -> SMALL_FAST, midtier -> MIDTIER, heavyThinking -> HEAVY_THINKING
  return tier.replace(/([A-Z])/g, "_$1").toUpperCase();
}
