/**
 * HyDE (Hypothetical Document Embedding) Implementation
 *
 * Improves semantic search for abstract/vague queries by generating a hypothetical
 * ideal document first, then using that embedding to find similar real documents.
 *
 * Pattern: Query → Generate Hypothetical Doc → Embed → Search
 */

import { LRUCache } from "./lru-cache.js";
import { logger } from "./logger.js";
import { createMemoryModel } from "../config/model-config.js";
import { createUsageEnvelopeCallbackHandler } from "../middleware/usage-callback-handler.js";

/**
 * Cache configuration for hypothetical documents
 */
export interface HyDECacheConfig {
  /** Maximum number of entries in the LRU cache */
  maxSize: number;
  /** Time-to-live in milliseconds for cached hypothetical documents */
  ttlMs: number;
}

/**
 * Heuristics for auto-detecting when to apply HyDE
 */
export interface HyDEHeuristics {
  /** Minimum word count for a query to be considered for HyDE */
  minWordCount: number;
  /** Patterns that trigger HyDE (e.g., question words, abstract concepts) */
  triggerPatterns: RegExp[];
  /** Patterns that skip HyDE (e.g., technical specifics, short queries) */
  skipPatterns: RegExp[];
}

/**
 * Complete HyDE configuration
 */
export interface HyDEConfig {
  /** Global enable/disable flag */
  enabled: boolean;
  /** Enable auto-detection of when to apply HyDE */
  autoDetectEnabled: boolean;
  /** Cache configuration */
  cache: HyDECacheConfig;
  /** Auto-detection heuristics */
  heuristics: HyDEHeuristics;
  /** Prompt template for generating hypothetical documents */
  promptTemplate: string;
}

/**
 * Hardcoded HyDE configuration
 */
export const HYDE_CONFIG: HyDEConfig = {
  enabled: true,
  autoDetectEnabled: true,
  cache: {
    maxSize: 100,
    ttlMs: 3600000, // 1 hour
  },
  heuristics: {
    minWordCount: 4,
    // Trigger patterns: question words, abstract concepts
    triggerPatterns: [
      /^(how|what|why|when|where|which)\b/i, // Question words at start
      /\b(pattern|approach|strategy|best practice|way to|method for)\b/i, // Abstract concepts
    ],
    // Skip patterns: technical specifics, entity IDs, short technical terms
    skipPatterns: [
      /\b(error|function|class|file|api|endpoint|method|variable)\s+\w+/i, // Technical terms with specific names
      /^conv_\w+$/i, // Entity IDs
      /^[a-z_]+\([^)]*\)$/i, // Function signatures like "createAgent()"
    ],
  },
  promptTemplate: `You are generating a hypothetical memory entry that would perfectly answer the following query.

Query: {query}

Write a detailed, informative passage (2-3 paragraphs) that would be stored in a knowledge base and
would be the ideal result for this query. Include: - Specific technical details - Concrete examples
if applicable - The "why" behind the approach

Write as if this is an actual stored learning or pattern, not as an answer to a question. Do not use
phrases like "The answer is..." or "To solve this...".`,
};

/**
 * Result of HyDE processing
 */
export interface HyDEResult {
  /** The query to use for search (either hypothetical doc or original query) */
  searchQuery: string;
  /** Whether HyDE was applied */
  applied: boolean;
  /** Reason for applying or skipping HyDE */
  reason: string;
  /** Whether the hypothetical document came from cache */
  cached?: boolean;
}

/**
 * Options for HyDE processing
 */
export interface HyDEProcessOptions {
  /** Explicitly enable or disable HyDE (overrides auto-detection) */
  useHyde?: boolean;
  /** Custom configuration (optional, defaults to HYDE_CONFIG) */
  config?: HyDEConfig;
}

// Global cache instance for hypothetical documents
let hydeCache: LRUCache<string, string> | null = null;

/**
 * Initialize the HyDE cache
 * Called lazily on first use
 */
function initializeHyDE(): void {
  if (hydeCache) {
    return;
  }

  hydeCache = new LRUCache<string, string>({
    maxSize: HYDE_CONFIG.cache.maxSize,
    ttlMs: HYDE_CONFIG.cache.ttlMs,
  });
}

/**
 * Get the current HyDE configuration
 */
export function getHyDEConfig(): HyDEConfig {
  return HYDE_CONFIG;
}

/**
 * Determine if HyDE should be applied to a query based on heuristics
 *
 * @param query - The search query
 * @param config - HyDE configuration
 * @returns Object with shouldUse flag and reason
 */
export function shouldUseHyDE(
  query: string,
  config: HyDEConfig,
): { shouldUse: boolean; reason: string } {
  // Trim query once at the beginning for consistent processing
  const trimmedQuery = query.trim();

  // Check minimum word count
  const wordCount = trimmedQuery.split(/\s+/).length;
  if (wordCount < config.heuristics.minWordCount) {
    return {
      shouldUse: false,
      reason: `Query too short (${wordCount} words < ${config.heuristics.minWordCount} minimum)`,
    };
  }

  // Check skip patterns first (more specific)
  for (const pattern of config.heuristics.skipPatterns) {
    if (pattern.test(trimmedQuery)) {
      return {
        shouldUse: false,
        reason: `Query matches technical skip pattern: ${pattern.source}`,
      };
    }
  }

  // Check trigger patterns
  for (const pattern of config.heuristics.triggerPatterns) {
    if (pattern.test(trimmedQuery)) {
      return {
        shouldUse: true,
        reason: `Query matches HyDE trigger pattern: ${pattern.source}`,
      };
    }
  }

  // Default: don't use HyDE for queries that don't match any patterns
  return {
    shouldUse: false,
    reason: "Query does not match HyDE trigger patterns",
  };
}

/**
 * Generate a hypothetical document for a query using LLM
 * Results are cached to avoid redundant LLM calls
 *
 * @param query - The search query
 * @param config - HyDE configuration
 * @returns Object with hypothetical document and cache status
 */
export async function generateHypotheticalDocument(
  query: string,
  config: HyDEConfig,
): Promise<{ document: string; cached: boolean }> {
  initializeHyDE();

  // Check cache first
  const cached = hydeCache!.get(query);
  if (cached) {
    return { document: cached, cached: true };
  }

  try {
    // Generate hypothetical document using LLM
    const model = await createMemoryModel();
    const prompt = config.promptTemplate.replace("{query}", query);

    // Emit raw token usage for this side-channel LLM call (AGI-312).
    const response = await model.invoke(prompt, {
      callbacks: [createUsageEnvelopeCallbackHandler()],
    });
    const hypotheticalDoc = response.content.toString();

    // Cache the result
    hydeCache!.set(query, hypotheticalDoc);

    return { document: hypotheticalDoc, cached: false };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`[HyDE] Error generating hypothetical document: ${errorMsg}`);
    throw new Error(`Failed to generate hypothetical document: ${errorMsg}`, {
      cause: error,
    });
  }
}

/**
 * Process a query with HyDE
 * Main entry point for HyDE processing
 *
 * @param query - The search query
 * @param options - Processing options (explicit enable/disable, custom config)
 * @returns HyDEResult with search query and metadata
 */
export async function processQueryWithHyDE(
  query: string,
  options: HyDEProcessOptions = {},
): Promise<HyDEResult> {
  const config = options.config || HYDE_CONFIG;

  // Check if HyDE is globally disabled
  if (!config.enabled) {
    return {
      searchQuery: query,
      applied: false,
      reason: "HyDE is globally disabled",
    };
  }

  // Check for explicit opt-in/opt-out
  if (options.useHyde !== undefined) {
    if (!options.useHyde) {
      return {
        searchQuery: query,
        applied: false,
        reason: "Explicitly disabled via use_hyde parameter",
      };
    }

    // Explicit opt-in: always use HyDE
    try {
      const { document, cached } = await generateHypotheticalDocument(
        query,
        config,
      );
      return {
        searchQuery: document,
        applied: true,
        reason: "Explicitly enabled via use_hyde parameter",
        cached,
      };
    } catch (error) {
      // Fallback to original query on error
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[HyDE] Falling back to original query due to error: ${errorMsg}`,
      );
      return {
        searchQuery: query,
        applied: false,
        reason: `Failed to generate hypothetical document: ${errorMsg}`,
      };
    }
  }

  // Auto-detection logic
  if (!config.autoDetectEnabled) {
    return {
      searchQuery: query,
      applied: false,
      reason: "Auto-detection is disabled",
    };
  }

  const { shouldUse, reason } = shouldUseHyDE(query, config);

  if (!shouldUse) {
    return {
      searchQuery: query,
      applied: false,
      reason: `Auto-skipped: ${reason}`,
    };
  }

  // Apply HyDE
  try {
    const { document, cached } = await generateHypotheticalDocument(
      query,
      config,
    );
    return {
      searchQuery: document,
      applied: true,
      reason: `Auto-detected: ${reason}`,
      cached,
    };
  } catch (error) {
    // Fallback to original query on error
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[HyDE] Falling back to original query due to error: ${errorMsg}`,
    );
    return {
      searchQuery: query,
      applied: false,
      reason: `Failed to generate hypothetical document: ${errorMsg}`,
    };
  }
}

/**
 * Clear the HyDE cache
 * Useful for testing or manual cache management
 */
export function clearHyDECache(): void {
  if (hydeCache) {
    hydeCache.clear();
  }
}

/**
 * Get HyDE cache statistics
 * Useful for monitoring and debugging
 */
export function getHyDECacheStats() {
  if (!hydeCache) {
    return null;
  }
  return hydeCache.getStats();
}

/**
 * Reset HyDE module (mainly for testing)
 * Clears cache and forces reinitialization
 */
export function resetHyDE(): void {
  hydeCache = null;
}
