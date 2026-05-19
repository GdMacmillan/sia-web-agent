/**
 * Knowledge Re-ranking Module
 *
 * Implements weighted re-ranking formula with 5 signals:
 * P = w1·Semantic + w2·Recency + w3·AccessCount + w4·SuccessRate + w5·PriorityBoost
 *
 * Prioritizes learnings that have led to successful outcomes, are recently applied,
 * frequently accessed, and marked as high priority.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Entity with metadata (from search results)
 */
export interface RetrievedEntity {
  id: string;
  entity_type: string;
  title: string;
  content: string;
  context?: string;
  tags?: string[];
  priority: "low" | "medium" | "high";
  status: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

/**
 * Re-ranking weights with 5 signals
 */
export interface RerankingWeights {
  /** Weight for semantic similarity position proxy (default: 0.50) */
  semantic: number;
  /** Weight for recency - days since last applied (default: 0.15) */
  recency: number;
  /** Weight for access count - how often retrieved (default: 0.10) */
  accessCount: number;
  /** Weight for success rate - proven to work (default: 0.20) */
  successRate: number;
  /** Weight for priority boost - high/medium/low (default: 0.05) */
  priorityBoost: number;
}

/**
 * Weight preset names for common use cases
 */
export type WeightPreset =
  | "balanced"
  | "semantic_heavy"
  | "recency_heavy"
  | "proven_only";

/**
 * Pre-defined weight configurations for different use cases
 *
 * - balanced: Default, good for general use
 * - semantic_heavy: Prioritize semantic match (precise queries)
 * - recency_heavy: Prioritize recent knowledge (fast-changing domains)
 * - proven_only: Prioritize success rate (high-stakes decisions)
 */
export const WEIGHT_PRESETS: Record<WeightPreset, RerankingWeights> = {
  balanced: {
    semantic: 0.5,
    recency: 0.15,
    accessCount: 0.1,
    successRate: 0.2,
    priorityBoost: 0.05,
  },
  semantic_heavy: {
    semantic: 0.7,
    recency: 0.1,
    accessCount: 0.05,
    successRate: 0.1,
    priorityBoost: 0.05,
  },
  recency_heavy: {
    semantic: 0.35,
    recency: 0.35,
    accessCount: 0.1,
    successRate: 0.15,
    priorityBoost: 0.05,
  },
  proven_only: {
    semantic: 0.3,
    recency: 0.1,
    accessCount: 0.1,
    successRate: 0.45,
    priorityBoost: 0.05,
  },
};

/**
 * Scored entity with all 5 component scores
 */
export interface ScoredEntity {
  entity: RetrievedEntity;
  score: number;
  components: {
    semantic: number;
    recency: number;
    accessCount: number;
    successRate: number;
    priorityBoost: number;
  };
}

/**
 * Re-ranking configuration
 */
export interface RerankingConfig {
  weights: RerankingWeights;
  minApplicationsForRanking: number;
}

// ============================================================================
// Scoring Functions
// ============================================================================

/**
 * Calculate success rate from knowledge health metadata
 *
 * @param metadata - Entity metadata with success/failure counts
 * @param minApplications - Minimum applications before using actual rate
 * @returns Success rate (0-1), defaulting to 0.5 for cold start
 */
export function calculateSuccessRate(
  metadata: Record<string, unknown>,
  minApplications: number,
): number {
  const successCount = (metadata.success_count as number) || 0;
  const failureCount = (metadata.failure_count as number) || 0;
  const totalApplications = successCount + failureCount;

  // Cold start: use neutral score if insufficient data
  if (totalApplications < minApplications) {
    return 0.5;
  }

  return totalApplications > 0 ? successCount / totalApplications : 0.5;
}

/**
 * Calculate recency score based on last application time
 *
 * Formula: 1 / (1 + daysSinceApplied)
 * - Recently applied (0 days ago): score = 1.0
 * - Applied 1 day ago: score ≈ 0.5
 * - Applied 7 days ago: score ≈ 0.125
 *
 * @param metadata - Entity metadata with last_applied_at timestamp
 * @returns Recency score (0-1)
 */
export function calculateRecency(metadata: Record<string, unknown>): number {
  const lastApplied = metadata.last_applied_at as string | undefined;

  if (!lastApplied) {
    return 0.1; // Never applied: use neutral low score
  }

  const now = Date.now();
  const lastAppliedTime = new Date(lastApplied).getTime();
  const daysSinceApplied = (now - lastAppliedTime) / (1000 * 60 * 60 * 24);

  return 1 / (1 + daysSinceApplied);
}

/**
 * Calculate access count score using logarithmic scale
 *
 * Formula: Math.min(1, Math.log10(access_count + 1) / 2)
 * - 0 accesses: score = 0
 * - 1 access: score ≈ 0.15
 * - 10 accesses: score ≈ 0.5
 * - 100 accesses: score = 1.0 (capped)
 *
 * @param metadata - Entity metadata with access_count field
 * @returns Access count score (0-1)
 */
export function calculateAccessCountScore(
  metadata: Record<string, unknown>,
): number {
  const accessCount = (metadata.access_count as number) || 0;
  if (accessCount <= 0) return 0;
  return Math.min(1, Math.log10(accessCount + 1) / 2);
}

/**
 * Calculate priority boost score
 *
 * Maps priority level to numeric score:
 * - high: 1.0
 * - medium: 0.5
 * - low: 0.0
 *
 * @param priority - Entity priority level
 * @returns Priority boost score (0-1)
 */
export function calculatePriorityBoost(
  priority: "low" | "medium" | "high" | undefined,
): number {
  const priorityMap: Record<string, number> = {
    high: 1.0,
    medium: 0.5,
    low: 0.0,
  };
  return priorityMap[priority ?? "medium"] ?? 0.5;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Hardcoded re-ranking configuration
 */
export const RERANKING_CONFIG = {
  minApplicationsForRanking: 3,
} as const;

/**
 * Resolve weight preset or config to actual weights
 */
function resolveWeights(config: RerankingConfig | WeightPreset): {
  weights: RerankingWeights;
  minApps: number;
} {
  if (typeof config === "string") {
    return {
      weights: WEIGHT_PRESETS[config] ?? WEIGHT_PRESETS.balanced,
      minApps: RERANKING_CONFIG.minApplicationsForRanking,
    };
  }
  return {
    weights: config.weights,
    minApps: config.minApplicationsForRanking,
  };
}

// ============================================================================
// Re-ranking Functions
// ============================================================================

/**
 * Re-rank entities using 5-signal weighted formula
 *
 * P = w1*Semantic + w2*Recency + w3*AccessCount + w4*SuccessRate + w5*PriorityBoost
 *
 * - Semantic: Position as proxy (first = highest similarity from semantic search)
 * - Recency: 1 / (1 + daysSinceLastApplied)
 * - AccessCount: Math.min(1, Math.log10(count + 1) / 2)
 * - SuccessRate: success_count / (success_count + failure_count)
 * - PriorityBoost: high=1.0, medium=0.5, low=0.0
 *
 * @param entities - Retrieved entities from semantic search (ordered by similarity)
 * @param config - Re-ranking configuration or preset name
 * @returns Entities sorted by priority score (descending)
 */
export function rerankEntities(
  entities: RetrievedEntity[],
  config: RerankingConfig | WeightPreset = "balanced",
): RetrievedEntity[] {
  if (entities.length === 0) return [];

  const { weights, minApps } = resolveWeights(config);

  // Normalize weights to sum to 1
  const totalWeight =
    weights.semantic +
    weights.recency +
    weights.accessCount +
    weights.successRate +
    weights.priorityBoost;

  // Handle edge case of all zero weights
  if (totalWeight === 0) {
    return entities;
  }

  const normalized = {
    semantic: weights.semantic / totalWeight,
    recency: weights.recency / totalWeight,
    accessCount: weights.accessCount / totalWeight,
    successRate: weights.successRate / totalWeight,
    priorityBoost: weights.priorityBoost / totalWeight,
  };

  const scored: ScoredEntity[] = entities.map((entity, index) => {
    const metadata = entity.metadata || {};

    // Calculate all 5 component scores
    const semantic = 1 - index / Math.max(1, entities.length - 1);
    const recency = calculateRecency(metadata);
    const accessCount = calculateAccessCountScore(metadata);
    const successRate = calculateSuccessRate(metadata, minApps);
    const priorityBoost = calculatePriorityBoost(entity.priority);

    const score =
      normalized.semantic * semantic +
      normalized.recency * recency +
      normalized.accessCount * accessCount +
      normalized.successRate * successRate +
      normalized.priorityBoost * priorityBoost;

    return {
      entity,
      score,
      components: {
        semantic,
        recency,
        accessCount,
        successRate,
        priorityBoost,
      },
    };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.map((s) => s.entity);
}

/**
 * Re-rank entities with detailed scoring information (for debugging/display)
 *
 * @param entities - Retrieved entities from semantic search (ordered by similarity)
 * @param config - Re-ranking configuration or preset name
 * @returns Scored entities with full component breakdown
 */
export function rerankEntitiesWithScores(
  entities: RetrievedEntity[],
  config: RerankingConfig | WeightPreset = "balanced",
): ScoredEntity[] {
  if (entities.length === 0) return [];

  const { weights, minApps } = resolveWeights(config);

  // Normalize weights to sum to 1
  const totalWeight =
    weights.semantic +
    weights.recency +
    weights.accessCount +
    weights.successRate +
    weights.priorityBoost;

  // Handle edge case of all zero weights - return with zero scores
  if (totalWeight === 0) {
    return entities.map((entity) => ({
      entity,
      score: 0,
      components: {
        semantic: 0,
        recency: 0,
        accessCount: 0,
        successRate: 0,
        priorityBoost: 0,
      },
    }));
  }

  const normalized = {
    semantic: weights.semantic / totalWeight,
    recency: weights.recency / totalWeight,
    accessCount: weights.accessCount / totalWeight,
    successRate: weights.successRate / totalWeight,
    priorityBoost: weights.priorityBoost / totalWeight,
  };

  const scored: ScoredEntity[] = entities.map((entity, index) => {
    const metadata = entity.metadata || {};

    // Calculate all 5 component scores
    const semantic = 1 - index / Math.max(1, entities.length - 1);
    const recency = calculateRecency(metadata);
    const accessCount = calculateAccessCountScore(metadata);
    const successRate = calculateSuccessRate(metadata, minApps);
    const priorityBoost = calculatePriorityBoost(entity.priority);

    const score =
      normalized.semantic * semantic +
      normalized.recency * recency +
      normalized.accessCount * accessCount +
      normalized.successRate * successRate +
      normalized.priorityBoost * priorityBoost;

    return {
      entity,
      score,
      components: {
        semantic,
        recency,
        accessCount,
        successRate,
        priorityBoost,
      },
    };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored;
}
