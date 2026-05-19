/**
 * Evaluation Schema Types
 *
 * Defines TypeScript types and Zod schemas for test-time evaluation results.
 * Used to store, retrieve, and analyze agent evaluation data in the graph-memory system.
 */

import { z } from "zod";

/**
 * Core evaluation scores (1-5 scale)
 */
export const EvaluationScoresSchema = z.object({
  trajectory_quality: z.number().min(1).max(5),
  tool_usage: z.number().min(1).max(5),
  reasoning_clarity: z.number().min(1).max(5),
  efficiency: z.number().min(1).max(5),
  overall_score: z.number().min(1).max(5),
});

export type EvaluationScores = z.infer<typeof EvaluationScoresSchema>;

/**
 * Full evaluation result with analysis
 */
export const EvaluationResultMetadataSchema = z.object({
  // Core scores
  scores: EvaluationScoresSchema,

  // Analysis
  failure_root_cause: z.string().optional(),
  key_strengths: z.array(z.string()),
  improvement_areas: z.array(z.string()),
  reasoning_summary: z.string(),

  // Test metadata
  test_name: z.string(),
  test_passed: z.boolean(),
  message_count: z.number(),
  tool_call_count: z.number(),
  execution_time_ms: z.number().optional(),

  // Evaluation metadata
  evaluated_at: z.string(), // ISO timestamp
  evaluator_model: z.string().optional(),
});

export type EvaluationResultMetadata = z.infer<
  typeof EvaluationResultMetadataSchema
>;

/**
 * Pattern type classification
 */
export enum PatternType {
  SUCCESS_PATTERN = "success_pattern",
  FAILURE_PATTERN = "failure_pattern",
  EFFICIENCY_IMPROVEMENT = "efficiency_improvement",
  PREVENTATIVE_LESSON = "preventative_lesson",
  STRATEGY_RECOMMENDATION = "strategy_recommendation",
  CONTEXT_REQUIREMENT = "context_requirement",
}

/**
 * Confidence level for patterns
 */
export enum ConfidenceLevel {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
}

/**
 * Enhanced idea metadata with evaluation and pattern information
 */
export const EnhancedIdeaMetadataSchema = z.object({
  // Standard idea fields
  title: z.string(),
  description: z.string(),
  context: z.string(),
  category: z.string(),
  priority: z.enum(["low", "medium", "high"]),
  status: z.enum(["active", "attempted", "success", "failure", "blocked"]),

  // Pattern information
  pattern_type: z.nativeEnum(PatternType).optional(),
  applicability_scope: z.enum(["general", "context_specific"]).optional(),
  confidence: z.nativeEnum(ConfidenceLevel).optional(),
  occurrence_count: z.number().default(1),

  // Evaluation results (if from test evaluation)
  evaluation_result: EvaluationResultMetadataSchema.optional(),

  // Related ideas (for linking failures to successes)
  related_idea_ids: z.array(z.string()).optional(),
  related_test_names: z.array(z.string()).optional(),

  // Timestamps
  created_at: z.string(), // ISO timestamp
  updated_at: z.string(), // ISO timestamp
  attempted_at: z.string().optional(), // ISO timestamp
});

export type EnhancedIdeaMetadata = z.infer<typeof EnhancedIdeaMetadataSchema>;

/**
 * Request to store an evaluation result as an idea
 */
export const StoreEvaluationAsIdeaSchema = z.object({
  title: z.string().describe("Title summarizing the test or outcome"),
  description: z
    .string()
    .describe("Detailed description including evaluation results"),
  context: z.string().describe("Context where this applies"),
  category: z.string().describe("Category for organization"),
  priority: z.enum(["low", "medium", "high"]).optional(),
  pattern_type: z.nativeEnum(PatternType).optional(),
  applicability_scope: z.enum(["general", "context_specific"]).optional(),
  confidence: z.nativeEnum(ConfidenceLevel).optional(),
  evaluation_result: EvaluationResultMetadataSchema.optional(),
  related_test_names: z.array(z.string()).optional(),
});

export type StoreEvaluationAsIdea = z.infer<typeof StoreEvaluationAsIdeaSchema>;

/**
 * Query for discovering evaluation-related patterns
 */
export const DiscoverEvaluationPatternsSchema = z.object({
  query: z.string().describe("Semantic search query"),
  pattern_type: z.nativeEnum(PatternType).optional(),
  min_confidence: z.nativeEnum(ConfidenceLevel).optional(),
  include_failed_attempts: z.boolean().default(true),
  limit: z.number().default(10),
});

export type DiscoverEvaluationPatterns = z.infer<
  typeof DiscoverEvaluationPatternsSchema
>;

/**
 * Evaluation statistics summary
 */
export const EvaluationStatisticsSchema = z.object({
  total_tests: z.number(),
  passed_tests: z.number(),
  failed_tests: z.number(),
  pass_rate: z.number(),
  average_scores: EvaluationScoresSchema,
  most_common_failures: z.array(
    z.object({
      cause: z.string(),
      frequency: z.number(),
    }),
  ),
  most_common_strengths: z.array(
    z.object({
      strength: z.string(),
      frequency: z.number(),
    }),
  ),
  most_common_improvements: z.array(
    z.object({
      area: z.string(),
      frequency: z.number(),
    }),
  ),
});

export type EvaluationStatistics = z.infer<typeof EvaluationStatisticsSchema>;

/**
 * Discovered idea from graph-memory search
 * Represents a pattern that was retrieved from memory
 */
export interface DiscoveredIdea {
  id: string;
  title: string;
  description?: string;
  category?: string;
  priority?: string;
  status?: string;
  pattern_type?: PatternType;
  confidence?: ConfidenceLevel;
  applicability_scope?: string;
  metadata?: Record<string, any>;
}
