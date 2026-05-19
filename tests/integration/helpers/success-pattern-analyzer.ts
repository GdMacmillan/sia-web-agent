/**
 * Success Pattern Analyzer
 * Extracts effective strategies and generalizable patterns from successful test evaluations
 * Uses LLM semantic analysis to understand what worked and generate strategy recommendations
 */

import { z } from "zod";
import { createChatModel } from "../../src/config/model-config.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { TestOutcomeEvaluation } from "./test-outcome-evaluator.js";

export const SuccessPatternSchema = z.object({
  strategy_category: z.string().describe("Type of effective strategy employed"),
  key_characteristics: z
    .array(z.string())
    .describe("Characteristics of successful approach"),
  applicable_contexts: z
    .array(z.string())
    .describe("Contexts where this strategy works best"),
  replication_steps: z
    .array(z.string())
    .describe("Steps to replicate this success"),
  successful_test_count: z
    .number()
    .describe("Number of tests with this pattern"),
  confidence: z
    .enum(["low", "medium", "high"])
    .describe("Confidence in this pattern generalization"),
  average_efficiency_score: z
    .number()
    .min(1)
    .max(5)
    .describe("Average efficiency rating for successful pattern"),
  strategy_recommendation: z
    .string()
    .describe("Recommendation for using this strategy"),
});

export type SuccessPattern = z.infer<typeof SuccessPatternSchema>;

export interface SuccessPatternsAnalysis {
  total_successful_tests: number;
  analyzed_successes: number;
  patterns: SuccessPattern[];
  pattern_categories: Map<string, number>;
  most_effective_strategy: string | null;
  high_confidence_strategies: SuccessPattern[];
  strategy_recommendations: string[];
  average_scores: {
    trajectory_quality: number;
    tool_usage: number;
    reasoning_clarity: number;
    efficiency: number;
  };
}

async function analyzeSuccessWithLLM(
  testName: string,
  strengths: string[],
  trajectoryQuality: number,
  toolUsage: number,
  efficiency: number,
  toolCallCount: number,
): Promise<{
  strategy_category: string;
  key_characteristics: string[];
  applicable_contexts: string[];
  replication_steps: string[];
  strategy_recommendation: string;
}> {
  const llm = await createChatModel();

  const systemPrompt =
    "You are an expert in agent design and effective reasoning strategies. " +
    "Analyze successful test outcomes and extract reusable strategies and patterns. " +
    "Identify strategy categories, key characteristics, and contexts where the strategy applies. " +
    "Return ONLY valid JSON - no markdown, no extra text.";

  const strengthsText = strengths.join("; ");
  const userPrompt =
    `Analyze this successful agent test and extract strategy insights:\n\n` +
    `Test: ${testName}\n` +
    `Demonstrated Strengths: ${strengthsText}\n` +
    `Scores - Trajectory: ${trajectoryQuality}/5, Tool Usage: ${toolUsage}/5, Efficiency: ${efficiency}/5\n` +
    `Tool Calls Made: ${toolCallCount}\n\n` +
    `Tasks:\n` +
    `1. Categorize the primary strategy used (e.g., "Methodical Tool Chain", "Direct Problem Solving", "Iterative Refinement")\n` +
    `2. Identify 2-3 key characteristics that made this approach successful\n` +
    `3. Identify 2-3 contexts where this strategy would be most applicable\n` +
    `4. Generate 2-3 concrete replication steps for applying this strategy in future tests\n` +
    `5. Provide a recommendation for when/how to use this strategy\n\n` +
    `Return JSON matching this structure:\n` +
    `{\n` +
    `  "strategy_category": "string",\n` +
    `  "key_characteristics": ["string"],\n` +
    `  "applicable_contexts": ["string"],\n` +
    `  "replication_steps": ["string"],\n` +
    `  "strategy_recommendation": "string"\n` +
    `}`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ]);

  const responseText =
    typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content
            .map((c: unknown) => {
              const item = c as { text?: string };
              return item.text || "";
            })
            .join("")
        : "";

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `Failed to extract JSON from LLM response: ${responseText.substring(0, 200)}`,
    );
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    strategy_category: parsed.strategy_category,
    key_characteristics: parsed.key_characteristics,
    applicable_contexts: parsed.applicable_contexts,
    replication_steps: parsed.replication_steps,
    strategy_recommendation: parsed.strategy_recommendation,
  };
}

async function generateStrategyRecommendations(
  patterns: SuccessPattern[],
): Promise<string[]> {
  if (patterns.length === 0) {
    return [];
  }

  const llm = await createChatModel();

  const systemPrompt =
    "You are an expert in agent strategy and effective learning patterns. " +
    "Given successful patterns, synthesize strategic recommendations for maximizing success rates. " +
    "Focus on meta-strategies that apply across multiple successful approaches. " +
    "Return ONLY a JSON array of strings - no markdown, no extra text.";

  const patternSummaries = patterns
    .map(
      (p) =>
        `${p.strategy_category} (${p.successful_test_count} successes, avg efficiency: ${p.average_efficiency_score.toFixed(1)}/5): ${p.strategy_recommendation}`,
    )
    .join("\n");

  const userPrompt =
    `Synthesize strategic recommendations from these successful patterns:\n\n` +
    `${patternSummaries}\n\n` +
    `Generate 3-5 strategic recommendations for the agent to consistently achieve success. ` +
    `Focus on meta-strategies that span multiple successful approaches. ` +
    `Emphasize preventive measures and proactive approaches. ` +
    `Return ONLY a JSON array of strings.`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ]);

  const responseText =
    typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content
            .map((c: unknown) => {
              const item = c as { text?: string };
              return item.text || "";
            })
            .join("")
        : "";

  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [];
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return Array.isArray(parsed) ? parsed : [];
}

export async function analyzeSuccessPatterns(
  evaluations: TestOutcomeEvaluation[],
): Promise<SuccessPatternsAnalysis> {
  const successfulEvaluations = evaluations.filter((e) => e.passed);

  if (successfulEvaluations.length === 0) {
    return {
      total_successful_tests: 0,
      analyzed_successes: 0,
      patterns: [],
      pattern_categories: new Map(),
      most_effective_strategy: null,
      high_confidence_strategies: [],
      strategy_recommendations: [],
      average_scores: {
        trajectory_quality: 0,
        tool_usage: 0,
        reasoning_clarity: 0,
        efficiency: 0,
      },
    };
  }

  const patterns: SuccessPattern[] = [];
  const categoryMap = new Map<string, number>();

  // Calculate average scores
  const scoreSum = {
    trajectory_quality: 0,
    tool_usage: 0,
    reasoning_clarity: 0,
    efficiency: 0,
  };

  // Analyze each success
  for (const evaluation of successfulEvaluations) {
    const analysis = await analyzeSuccessWithLLM(
      evaluation.testName,
      evaluation.evaluation.key_strengths,
      evaluation.evaluation.trajectory_quality,
      evaluation.evaluation.tool_usage,
      evaluation.evaluation.efficiency,
      evaluation.toolCallCount,
    );

    scoreSum.trajectory_quality += evaluation.evaluation.trajectory_quality;
    scoreSum.tool_usage += evaluation.evaluation.tool_usage;
    scoreSum.reasoning_clarity += evaluation.evaluation.reasoning_clarity;
    scoreSum.efficiency += evaluation.evaluation.efficiency;

    categoryMap.set(
      analysis.strategy_category,
      (categoryMap.get(analysis.strategy_category) ?? 0) + 1,
    );

    patterns.push({
      strategy_category: analysis.strategy_category,
      key_characteristics: analysis.key_characteristics,
      applicable_contexts: analysis.applicable_contexts,
      replication_steps: analysis.replication_steps,
      successful_test_count: 1, // Will aggregate later
      confidence: "medium", // Will adjust based on frequency
      average_efficiency_score: evaluation.evaluation.efficiency,
      strategy_recommendation: analysis.strategy_recommendation,
    });
  }

  // Aggregate patterns by category
  const aggregatedPatterns: SuccessPattern[] = [];
  const processedCategories = new Set<string>();

  for (const pattern of patterns) {
    if (processedCategories.has(pattern.strategy_category)) {
      continue;
    }
    processedCategories.add(pattern.strategy_category);

    const categoryPatterns = patterns.filter(
      (p) => p.strategy_category === pattern.strategy_category,
    );

    // Aggregate characteristics, contexts, and steps
    const allCharacteristics = new Set<string>();
    const allContexts = new Set<string>();
    const allSteps = new Set<string>();

    for (const p of categoryPatterns) {
      p.key_characteristics.forEach((c) => allCharacteristics.add(c));
      p.applicable_contexts.forEach((ctx) => allContexts.add(ctx));
      p.replication_steps.forEach((step) => allSteps.add(step));
    }

    const avgEfficiency =
      categoryPatterns.reduce((sum, p) => sum + p.average_efficiency_score, 0) /
      categoryPatterns.length;

    aggregatedPatterns.push({
      strategy_category: pattern.strategy_category,
      key_characteristics: Array.from(allCharacteristics).slice(0, 3),
      applicable_contexts: Array.from(allContexts).slice(0, 3),
      replication_steps: Array.from(allSteps).slice(0, 3),
      successful_test_count: categoryPatterns.length,
      confidence:
        categoryPatterns.length >= 3
          ? "high"
          : categoryPatterns.length >= 2
            ? "medium"
            : "low",
      average_efficiency_score: avgEfficiency,
      strategy_recommendation: categoryPatterns[0].strategy_recommendation,
    });
  }

  // Sort by frequency and efficiency
  aggregatedPatterns.sort((a, b) => {
    if (a.successful_test_count !== b.successful_test_count) {
      return b.successful_test_count - a.successful_test_count;
    }
    return b.average_efficiency_score - a.average_efficiency_score;
  });

  const highConfidenceStrategies = aggregatedPatterns.filter(
    (p) => p.confidence === "high",
  );

  const strategyRecommendations =
    await generateStrategyRecommendations(aggregatedPatterns);

  const strategySorted = Array.from(categoryMap.entries()).sort(
    (a, b) => b[1] - a[1],
  );

  const avgScores = {
    trajectory_quality:
      scoreSum.trajectory_quality / successfulEvaluations.length,
    tool_usage: scoreSum.tool_usage / successfulEvaluations.length,
    reasoning_clarity:
      scoreSum.reasoning_clarity / successfulEvaluations.length,
    efficiency: scoreSum.efficiency / successfulEvaluations.length,
  };

  return {
    total_successful_tests: successfulEvaluations.length,
    analyzed_successes: patterns.length,
    patterns: aggregatedPatterns,
    pattern_categories: categoryMap,
    most_effective_strategy:
      strategySorted.length > 0 ? strategySorted[0][0] : null,
    high_confidence_strategies: highConfidenceStrategies,
    strategy_recommendations: strategyRecommendations,
    average_scores: avgScores,
  };
}

export function formatSuccessPatternsReport(
  analysis: SuccessPatternsAnalysis,
): string {
  const lines = [
    "SUCCESS PATTERN ANALYSIS",
    "========================",
    `Total Successful Tests: ${analysis.total_successful_tests}`,
    `Patterns Identified: ${analysis.patterns.length}`,
    "",
  ];

  lines.push("AVERAGE SCORES (Successful Tests):");
  lines.push(
    `  Trajectory Quality: ${analysis.average_scores.trajectory_quality.toFixed(2)}/5`,
  );
  lines.push(
    `  Tool Usage: ${analysis.average_scores.tool_usage.toFixed(2)}/5`,
  );
  lines.push(
    `  Reasoning Clarity: ${analysis.average_scores.reasoning_clarity.toFixed(2)}/5`,
  );
  lines.push(
    `  Efficiency: ${analysis.average_scores.efficiency.toFixed(2)}/5`,
  );

  if (analysis.most_effective_strategy) {
    lines.push("");
    lines.push(`Most Effective Strategy: ${analysis.most_effective_strategy}`);
  }

  if (analysis.patterns.length > 0) {
    lines.push("");
    lines.push("SUCCESS PATTERNS:");
    for (const pattern of analysis.patterns) {
      lines.push(
        `\n[${pattern.confidence.toUpperCase()}] ${pattern.strategy_category} (${pattern.successful_test_count} tests, avg efficiency: ${pattern.average_efficiency_score.toFixed(1)}/5)`,
      );
      lines.push(`  Recommendation: ${pattern.strategy_recommendation}`);
      lines.push(`  Key Characteristics:`);
      pattern.key_characteristics.forEach((c) => lines.push(`    • ${c}`));
      lines.push(`  Applicable Contexts:`);
      pattern.applicable_contexts.forEach((ctx) => lines.push(`    • ${ctx}`));
      lines.push(`  Replication Steps:`);
      pattern.replication_steps.forEach((step) => lines.push(`    • ${step}`));
    }
  }

  if (analysis.high_confidence_strategies.length > 0) {
    lines.push("");
    lines.push("PROVEN STRATEGIES (High Confidence):");
    for (const pattern of analysis.high_confidence_strategies) {
      lines.push(
        `  • ${pattern.strategy_category}: ${pattern.strategy_recommendation}`,
      );
    }
  }

  if (analysis.strategy_recommendations.length > 0) {
    lines.push("");
    lines.push("STRATEGIC RECOMMENDATIONS:");
    analysis.strategy_recommendations.forEach((rec) => {
      lines.push(`  • ${rec}`);
    });
  }

  return lines.join("\n");
}
