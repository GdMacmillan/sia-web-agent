/**
 * Query Decomposition Implementation
 *
 * Breaks complex multi-part queries into atomic sub-queries,
 * executes searches in parallel, and merges results.
 *
 * Pattern: Query → Complexity Check → Decompose → Parallel Search → Merge & Rank
 */

import { LRUCache } from "./lru-cache.js";
import { logger } from "./logger.js";
import { createMemoryModel } from "../config/model-config.js";
import { processQueryWithHyDE, type HyDEResult } from "./hyde.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Cache configuration for decomposition results
 */
export interface DecompositionCacheConfig {
  maxSize: number;
  ttlMs: number;
}

/**
 * Heuristics for detecting complex queries
 */
export interface DecompositionHeuristics {
  minWordCount: number;
  maxWordCountThreshold: number;
  conjunctionPatterns: RegExp[];
  multipleQuestionWordThreshold: number;
  commaThreshold: number;
}

/**
 * Merge configuration
 */
export interface MergeConfig {
  multiMatchBoost: number;
  preferCoverage: boolean;
}

/**
 * Complete decomposition configuration
 */
export interface DecompositionConfig {
  enabled: boolean;
  autoDetectEnabled: boolean;
  maxSubQueries: number;
  cache: DecompositionCacheConfig;
  heuristics: DecompositionHeuristics;
  merge: MergeConfig;
  promptTemplate: string;
}

/**
 * Hardcoded decomposition configuration
 */
export const DECOMPOSITION_CONFIG: DecompositionConfig = {
  enabled: true,
  autoDetectEnabled: true,
  maxSubQueries: 4,
  cache: {
    maxSize: 100,
    ttlMs: 3600000, // 1 hour
  },
  heuristics: {
    minWordCount: 6,
    maxWordCountThreshold: 15,
    conjunctionPatterns: [
      /\b(and|or|also|plus|additionally|furthermore|moreover)\b/i,
      /\bas\s+well\s+as\b/i,
    ],
    multipleQuestionWordThreshold: 2,
    commaThreshold: 2,
  },
  merge: {
    multiMatchBoost: 1.5,
    preferCoverage: true,
  },
  promptTemplate: `Analyze this query and determine if it contains multiple independent questions or topics that should
be searched separately.

Query: {query}

Respond in JSON format: { "is_complex": boolean, "reasoning": "brief explanation", "sub_queries":
["query1", "query2", ...] }

Rules: - If the query has ONE clear topic/question, set is_complex=false and return the original
query - If the query has 2-4 independent parts, set is_complex=true and break it into atomic
sub-queries - Each sub-query should be self-contained and searchable independently - Max 4
sub-queries - Keep sub-queries focused and specific`,
};

// ============================================================================
// Types
// ============================================================================

/**
 * Retrieved entity from search (matches memory-tools.ts type)
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
 * Result of LLM decomposition
 */
export interface DecompositionResult {
  isComplex: boolean;
  reasoning: string;
  subQueries: string[];
}

/**
 * Result of complexity check (fast heuristics, no LLM)
 */
export interface ComplexityCheckResult {
  mightBeComplex: boolean;
  reason: string;
  signals: {
    wordCount: number;
    hasConjunctions: boolean;
    questionWordCount: number;
    commaCount: number;
  };
}

/**
 * Timing metrics for decomposition operations
 */
export interface DecompositionTimingMetrics {
  decompositionTimeMs: number;
  searchTimeMs: number;
  mergeTimeMs: number;
  totalTimeMs: number;
}

/**
 * Result of a single sub-query search
 */
export interface SubQuerySearchResult {
  subQuery: string;
  hydeResult: HyDEResult;
  entities: RetrievedEntity[];
  success: boolean;
  error?: string;
}

/**
 * Merged entity with boost information
 */
export interface MergedEntity extends RetrievedEntity {
  matchCount: number; // How many sub-queries matched this entity
  matchedSubQueries: string[]; // Which sub-queries matched
  boostScore: number; // Final score after boosting
}

/**
 * Options for query decomposition processing
 */
export interface DecompositionProcessOptions {
  /** Explicitly enable or disable decomposition (overrides auto-detection) */
  decompose?: boolean;
  /** Custom configuration (optional, defaults to DECOMPOSITION_CONFIG) */
  config?: DecompositionConfig;
  /** Whether to apply HyDE to sub-queries */
  applyHydeToSubQueries?: boolean;
  /** Options passed through to search */
  searchOptions?: {
    limit?: number;
    entity_type?: string;
    tags?: string[];
    priority?: "low" | "medium" | "high";
    status?: string;
    level?: string;
    cascade?: boolean;
    use_hyde?: boolean;
  };
}

/**
 * Complete result of query decomposition processing
 */
export interface DecompositionProcessResult {
  /** The entities to return (either from decomposed search or empty) */
  entities: MergedEntity[];
  /** Whether decomposition was applied */
  applied: boolean;
  /** Reason for applying or skipping decomposition */
  reason: string;
  /** The sub-queries used (if decomposition was applied) */
  subQueries?: string[];
  /** Individual sub-query results (for debugging) */
  subQueryResults?: SubQuerySearchResult[];
  /** Number of sub-queries that succeeded */
  successfulSubQueries?: number;
  /** Number of sub-queries that failed */
  failedSubQueries?: number;
  /** Whether the decomposition result came from cache */
  cached?: boolean;
  /** Timing metrics */
  timing?: DecompositionTimingMetrics;
}

// ============================================================================
// Module State
// ============================================================================

// Global cache instance for decomposition results
let decompositionCache: LRUCache<string, DecompositionResult> | null = null;

/**
 * Initialize the decomposition cache
 * Called lazily on first use
 */
function initializeDecomposition(): void {
  if (decompositionCache) {
    return;
  }

  decompositionCache = new LRUCache<string, DecompositionResult>({
    maxSize: DECOMPOSITION_CONFIG.cache.maxSize,
    ttlMs: DECOMPOSITION_CONFIG.cache.ttlMs,
  });
}

// ============================================================================
// Public API - Configuration
// ============================================================================

/**
 * Get the current decomposition configuration
 */
export function getDecompositionConfig(): DecompositionConfig {
  return DECOMPOSITION_CONFIG;
}

/**
 * Clear the decomposition cache
 */
export function clearDecompositionCache(): void {
  if (decompositionCache) {
    decompositionCache.clear();
  }
}

/**
 * Get decomposition cache statistics
 */
export function getDecompositionCacheStats() {
  if (!decompositionCache) {
    return null;
  }
  return decompositionCache.getStats();
}

/**
 * Reset decomposition module (mainly for testing)
 */
export function resetDecomposition(): void {
  decompositionCache = null;
}

// ============================================================================
// Public API - Complexity Detection (Fast Heuristics)
// ============================================================================

/**
 * Fast heuristic check to determine if a query might be complex
 * This runs BEFORE any LLM call to avoid unnecessary API costs
 *
 * @param query - The search query
 * @param config - Decomposition configuration
 * @returns ComplexityCheckResult with signals and recommendation
 */
export function mightBeComplex(
  query: string,
  config: DecompositionConfig,
): ComplexityCheckResult {
  const trimmedQuery = query.trim();
  const words = trimmedQuery.split(/\s+/);
  const wordCount = words.length;

  // Signal 1: Word count
  const isTooShort = wordCount < config.heuristics.minWordCount;
  const isVeryLong = wordCount >= config.heuristics.maxWordCountThreshold;

  // Signal 2: Conjunctions
  const hasConjunctions = config.heuristics.conjunctionPatterns.some(
    (pattern) => pattern.test(trimmedQuery),
  );

  // Signal 3: Multiple question words
  const questionWords = ["how", "what", "why", "when", "where", "which"];
  const questionWordCount = words.filter((word) =>
    questionWords.includes(word.toLowerCase()),
  ).length;
  const hasMultipleQuestions =
    questionWordCount >= config.heuristics.multipleQuestionWordThreshold;

  // Signal 4: Comma count
  const commaCount = (trimmedQuery.match(/,/g) || []).length;
  const hasManyCommas = commaCount >= config.heuristics.commaThreshold;

  // Decision logic
  if (isTooShort) {
    return {
      mightBeComplex: false,
      reason: `Query too short (${wordCount} words < ${config.heuristics.minWordCount} minimum)`,
      signals: { wordCount, hasConjunctions, questionWordCount, commaCount },
    };
  }

  // Check for complexity indicators
  const complexitySignals = [
    isVeryLong,
    hasConjunctions,
    hasMultipleQuestions,
    hasManyCommas,
  ];
  const positiveSignals = complexitySignals.filter(Boolean).length;

  if (positiveSignals >= 1) {
    const reasons: string[] = [];
    if (isVeryLong) reasons.push(`long query (${wordCount} words)`);
    if (hasConjunctions) reasons.push("contains conjunctions");
    if (hasMultipleQuestions)
      reasons.push(`${questionWordCount} question words`);
    if (hasManyCommas) reasons.push(`${commaCount} commas`);

    return {
      mightBeComplex: true,
      reason: `Potential complexity detected: ${reasons.join(", ")}`,
      signals: { wordCount, hasConjunctions, questionWordCount, commaCount },
    };
  }

  return {
    mightBeComplex: false,
    reason: "No complexity indicators detected",
    signals: { wordCount, hasConjunctions, questionWordCount, commaCount },
  };
}

// ============================================================================
// Public API - LLM-Based Decomposition
// ============================================================================

/**
 * Decompose a query into sub-queries using LLM
 * Results are cached to avoid redundant LLM calls
 *
 * @param query - The search query
 * @param config - Decomposition configuration
 * @returns DecompositionResult with sub-queries
 */
export async function decomposeQuery(
  query: string,
  config: DecompositionConfig,
): Promise<{ result: DecompositionResult; cached: boolean }> {
  initializeDecomposition();

  // Check cache first
  const cached = decompositionCache!.get(query);
  if (cached) {
    return { result: cached, cached: true };
  }

  try {
    const model = await createMemoryModel();
    const prompt = config.promptTemplate.replace("{query}", query);

    const response = await model.invoke(prompt);
    const responseText = response.content.toString();

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in LLM response");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const result: DecompositionResult = {
      isComplex: parsed.is_complex === true,
      reasoning: parsed.reasoning || "",
      subQueries: Array.isArray(parsed.sub_queries)
        ? parsed.sub_queries.slice(0, config.maxSubQueries)
        : [query],
    };

    // Ensure at least original query if decomposition returns empty
    if (result.subQueries.length === 0) {
      result.subQueries = [query];
      result.isComplex = false;
    }

    // Cache the result
    decompositionCache!.set(query, result);

    return { result, cached: false };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`[Decomposition] Error decomposing query: ${errorMsg}`);

    // Return original query as single sub-query on error
    return {
      result: {
        isComplex: false,
        reasoning: `Decomposition failed: ${errorMsg}`,
        subQueries: [query],
      },
      cached: false,
    };
  }
}

// ============================================================================
// Public API - Parallel Search Execution
// ============================================================================

/**
 * Execute searches for multiple sub-queries in parallel
 * Each sub-query gets HyDE applied (if enabled) before searching
 *
 * @param subQueries - Array of sub-queries to search
 * @param searchFn - Function to execute a single search
 * @param options - Processing options
 * @returns Array of SubQuerySearchResult
 */
export async function executeParallelSearches(
  subQueries: string[],
  searchFn: (query: string, options: any) => Promise<RetrievedEntity[]>,
  options: DecompositionProcessOptions,
): Promise<SubQuerySearchResult[]> {
  const applyHyde = options.applyHydeToSubQueries !== false;

  const searchPromises = subQueries.map(
    async (subQuery): Promise<SubQuerySearchResult> => {
      try {
        // Apply HyDE if enabled
        let hydeResult: HyDEResult = {
          searchQuery: subQuery,
          applied: false,
          reason: "HyDE disabled for sub-queries",
        };

        if (applyHyde) {
          hydeResult = await processQueryWithHyDE(subQuery, {
            useHyde: options.searchOptions?.use_hyde,
          });
        }

        // Execute search with processed query
        const entities = await searchFn(
          hydeResult.searchQuery,
          options.searchOptions,
        );

        return {
          subQuery,
          hydeResult,
          entities,
          success: true,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          subQuery,
          hydeResult: {
            searchQuery: subQuery,
            applied: false,
            reason: "Search failed",
          },
          entities: [],
          success: false,
          error: errorMsg,
        };
      }
    },
  );

  return Promise.all(searchPromises);
}

// ============================================================================
// Public API - Result Merging
// ============================================================================

/**
 * Merge and rank results from multiple sub-query searches
 * Entities appearing in multiple results get boosted
 *
 * @param results - Array of SubQuerySearchResult from parallel searches
 * @param config - Decomposition configuration
 * @returns Array of MergedEntity sorted by boost score
 */
export function mergeAndRankResults(
  results: SubQuerySearchResult[],
  config: DecompositionConfig,
): MergedEntity[] {
  // Map to track entities by ID
  const entityMap = new Map<string, MergedEntity>();

  // Process each sub-query result
  for (const result of results) {
    if (!result.success) continue;

    for (const entity of result.entities) {
      const existing = entityMap.get(entity.id);

      if (existing) {
        // Entity found in multiple results - increment match count
        existing.matchCount++;
        existing.matchedSubQueries.push(result.subQuery);
      } else {
        // First occurrence of entity
        entityMap.set(entity.id, {
          ...entity,
          matchCount: 1,
          matchedSubQueries: [result.subQuery],
          boostScore: 1.0,
        });
      }
    }
  }

  // Calculate boost scores
  const successfulResults = results.filter((r) => r.success);
  const totalSubQueries = successfulResults.length;

  for (const entity of entityMap.values()) {
    // Base score: entities in more results get boosted
    if (entity.matchCount > 1) {
      entity.boostScore *= Math.pow(
        config.merge.multiMatchBoost,
        entity.matchCount - 1,
      );
    }

    // Coverage bonus: percentage of sub-queries matched
    if (config.merge.preferCoverage && totalSubQueries > 1) {
      const coverageRatio = entity.matchCount / totalSubQueries;
      entity.boostScore *= 1 + coverageRatio;
    }
  }

  // Sort by boost score (descending)
  const merged = Array.from(entityMap.values());
  merged.sort((a, b) => b.boostScore - a.boostScore);

  return merged;
}

// ============================================================================
// Public API - Main Entry Point
// ============================================================================

/**
 * Process a query with decomposition
 * Main entry point for query decomposition processing
 *
 * @param query - The search query
 * @param searchFn - Function to execute a single search
 * @param options - Processing options
 * @returns DecompositionProcessResult with merged entities and metadata
 */
export async function processQueryWithDecomposition(
  query: string,
  searchFn: (query: string, options: any) => Promise<RetrievedEntity[]>,
  options: DecompositionProcessOptions = {},
): Promise<DecompositionProcessResult> {
  const startTime = Date.now();
  const config = options.config || DECOMPOSITION_CONFIG;

  // Check if decomposition is globally disabled
  if (!config.enabled) {
    return {
      entities: [],
      applied: false,
      reason: "Decomposition is globally disabled",
    };
  }

  // Check for explicit opt-out
  if (options.decompose === false) {
    return {
      entities: [],
      applied: false,
      reason: "Explicitly disabled via decompose parameter",
    };
  }

  // Auto-detection or explicit opt-in
  const shouldDecompose = options.decompose === true;

  if (!shouldDecompose) {
    // Auto-detect: run fast heuristic check first
    if (!config.autoDetectEnabled) {
      return {
        entities: [],
        applied: false,
        reason: "Auto-detection is disabled",
      };
    }

    const complexityCheck = mightBeComplex(query, config);
    if (!complexityCheck.mightBeComplex) {
      return {
        entities: [],
        applied: false,
        reason: `Auto-skipped: ${complexityCheck.reason}`,
      };
    }
  }

  // Decompose the query
  const decompositionStart = Date.now();
  const decomposition = await decomposeQuery(query, config);
  const cached = decomposition.cached;
  const decompositionTimeMs = Date.now() - decompositionStart;

  // If query is not actually complex (per LLM), skip decomposition
  if (!decomposition.result.isComplex) {
    return {
      entities: [],
      applied: false,
      reason: `LLM determined query is atomic: ${decomposition.result.reasoning}`,
      cached,
      timing: {
        decompositionTimeMs,
        searchTimeMs: 0,
        mergeTimeMs: 0,
        totalTimeMs: Date.now() - startTime,
      },
    };
  }

  // Execute parallel searches
  const searchStart = Date.now();
  const subQueryResults = await executeParallelSearches(
    decomposition.result.subQueries,
    searchFn,
    options,
  );
  const searchTimeMs = Date.now() - searchStart;

  // Count successes and failures
  const successfulSubQueries = subQueryResults.filter((r) => r.success).length;
  const failedSubQueries = subQueryResults.length - successfulSubQueries;

  // If all sub-queries failed, report error
  if (successfulSubQueries === 0) {
    return {
      entities: [],
      applied: true,
      reason: "All sub-query searches failed",
      subQueries: decomposition.result.subQueries,
      subQueryResults,
      successfulSubQueries: 0,
      failedSubQueries,
      cached,
      timing: {
        decompositionTimeMs,
        searchTimeMs,
        mergeTimeMs: 0,
        totalTimeMs: Date.now() - startTime,
      },
    };
  }

  // Merge results
  const mergeStart = Date.now();
  const mergedEntities = mergeAndRankResults(subQueryResults, config);
  const mergeTimeMs = Date.now() - mergeStart;

  return {
    entities: mergedEntities,
    applied: true,
    reason: `Decomposed into ${decomposition.result.subQueries.length} sub-queries`,
    subQueries: decomposition.result.subQueries,
    subQueryResults,
    successfulSubQueries,
    failedSubQueries,
    cached,
    timing: {
      decompositionTimeMs,
      searchTimeMs,
      mergeTimeMs,
      totalTimeMs: Date.now() - startTime,
    },
  };
}
