/**
 * Failure Pattern Analyzer
 * Extracts generalizable lessons and preventative patterns from failed test evaluations
 * Uses LLM semantic analysis to understand failure root causes and generate actionable insights
 */

import { z } from "zod";
import { createChatModel } from "../../src/config/model-config.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { TestOutcomeEvaluation } from "./test-outcome-evaluator.js";

export const FailurePatternSchema = z.object({
  root_cause_category: z.string().describe("Semantic category of the failure"),
  trigger_conditions: z
    .array(z.string())
    .describe("Conditions that trigger this failure"),
  preventative_strategies: z
    .array(z.string())
    .describe("Strategies to prevent this failure"),
  affected_test_count: z.number().describe("Number of tests with this pattern"),
  confidence: z
    .enum(["low", "medium", "high"])
    .describe("Confidence in this pattern"),
  common_improvement_areas: z
    .array(z.string())
    .describe("Most common improvement areas in affected tests"),
  lession_summary: z
    .string()
    .describe("Actionable lesson for agent improvement"),
});

export type FailurePattern = z.infer<typeof FailurePatternSchema>;

export interface FailurePatternsAnalysis {
  total_failed_tests: number;
  analyzed_failures: number;
  patterns: FailurePattern[];
  pattern_categories: Map<string, number>;
  most_common_root_cause: string | null;
  high_confidence_patterns: FailurePattern[];
  actionable_insights: string[];
}

async function analyzeFailureWithLLM(
  testName: string,
  rootCause: string | undefined,
  improvementAreas: string[],
  toolCallCount: number,
): Promise<{
  root_cause_category: string;
  trigger_conditions: string[];
  preventative_strategies: string[];
  confidence: "low" | "medium" | "high";
  lession_summary: string;
}> {
  const llm = await createChatModel();

  const systemPrompt =
    "You are an expert in AI agent debugging and improvement. " +
    "Analyze failure patterns and extract actionable lessons for agent improvement. " +
    "Identify root cause categories, trigger conditions, and prevention strategies. " +
    "Return ONLY valid JSON - no markdown, no extra text.";

  const improvementText = improvementAreas.join("; ");
  const userPrompt =
    `Analyze this agent test failure and extract generalizable lessons:\n\n` +
    `Test: ${testName}\n` +
    `Root Cause Identified: ${rootCause || "(not identified)"}\n` +
    `Tool Calls Made: ${toolCallCount}\n` +
    `Improvement Areas: ${improvementText}\n\n` +
    `Tasks:\n` +
    `1. Categorize the root cause into a semantic category (e.g., "Tool Selection Error", "Reasoning Breakdown", "Context Misunderstanding")\n` +
    `2. Identify 2-3 trigger conditions that likely caused this failure\n` +
    `3. Generate 2-3 preventative strategies to avoid this failure\n` +
    `4. Assess confidence (low/medium/high) based on clarity of root cause\n` +
    `5. Summarize one actionable lesson for the agent\n\n` +
    `Return JSON matching this structure:\n` +
    `{\n` +
    `  "root_cause_category": "string",\n` +
    `  "trigger_conditions": ["string"],\n` +
    `  "preventative_strategies": ["string"],\n` +
    `  "confidence": "low" | "medium" | "high",\n` +
    `  "lession_summary": "string"\n` +
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
    root_cause_category: parsed.root_cause_category,
    trigger_conditions: parsed.trigger_conditions,
    preventative_strategies: parsed.preventative_strategies,
    confidence: parsed.confidence,
    lession_summary: parsed.lession_summary,
  };
}

async function generateAggregateLessons(
  patterns: FailurePattern[],
): Promise<string[]> {
  if (patterns.length === 0) {
    return [];
  }

  const llm = await createChatModel();

  const systemPrompt =
    "You are an expert in agent improvement and pattern synthesis. " +
    "Given failure patterns, synthesize high-level actionable insights for agent improvement. " +
    "Focus on meta-patterns that apply across multiple failures. " +
    "Return ONLY a JSON array of strings - no markdown, no extra text.";

  const patternSummaries = patterns
    .map(
      (p) =>
        `${p.root_cause_category} (${p.affected_test_count} tests): ${p.lession_summary}`,
    )
    .join("\n");

  const userPrompt =
    `Synthesize actionable insights from these failure patterns:\n\n` +
    `${patternSummaries}\n\n` +
    `Generate 3-5 high-level insights that apply across multiple failures. ` +
    `Focus on meta-strategies the agent should employ to reduce failures generally. ` +
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

export async function analyzeFailurePatterns(
  evaluations: TestOutcomeEvaluation[],
): Promise<FailurePatternsAnalysis> {
  const failedEvaluations = evaluations.filter((e) => !e.passed);

  if (failedEvaluations.length === 0) {
    return {
      total_failed_tests: 0,
      analyzed_failures: 0,
      patterns: [],
      pattern_categories: new Map(),
      most_common_root_cause: null,
      high_confidence_patterns: [],
      actionable_insights: [],
    };
  }

  const patterns: FailurePattern[] = [];
  const categoryMap = new Map<string, number>();

  // Analyze each failure
  for (const evaluation of failedEvaluations) {
    const analysis = await analyzeFailureWithLLM(
      evaluation.testName,
      evaluation.evaluation.failure_root_cause,
      evaluation.evaluation.improvement_areas,
      evaluation.toolCallCount,
    );

    categoryMap.set(
      analysis.root_cause_category,
      (categoryMap.get(analysis.root_cause_category) ?? 0) + 1,
    );

    patterns.push({
      root_cause_category: analysis.root_cause_category,
      trigger_conditions: analysis.trigger_conditions,
      preventative_strategies: analysis.preventative_strategies,
      affected_test_count: 1, // Will aggregate later
      confidence: analysis.confidence,
      common_improvement_areas: evaluation.evaluation.improvement_areas,
      lession_summary: analysis.lession_summary,
    });
  }

  // Aggregate patterns by category
  const aggregatedPatterns: FailurePattern[] = [];
  const processedCategories = new Set<string>();

  for (const pattern of patterns) {
    if (processedCategories.has(pattern.root_cause_category)) {
      continue;
    }
    processedCategories.add(pattern.root_cause_category);

    const categoryPatterns = patterns.filter(
      (p) => p.root_cause_category === pattern.root_cause_category,
    );

    // Aggregate trigger conditions and strategies
    const allTriggers = new Set<string>();
    const allStrategies = new Set<string>();

    for (const p of categoryPatterns) {
      p.trigger_conditions.forEach((t) => allTriggers.add(t));
      p.preventative_strategies.forEach((s) => allStrategies.add(s));
    }

    aggregatedPatterns.push({
      root_cause_category: pattern.root_cause_category,
      trigger_conditions: Array.from(allTriggers),
      preventative_strategies: Array.from(allStrategies),
      affected_test_count: categoryPatterns.length,
      confidence:
        categoryPatterns.length >= 3
          ? "high"
          : categoryPatterns.length >= 2
            ? "medium"
            : "low",
      common_improvement_areas: Array.from(
        new Set(categoryPatterns.flatMap((p) => p.common_improvement_areas)),
      ).slice(0, 3),
      lession_summary: categoryPatterns[0].lession_summary,
    });
  }

  // Sort by frequency
  aggregatedPatterns.sort(
    (a, b) => b.affected_test_count - a.affected_test_count,
  );

  const highConfidencePatterns = aggregatedPatterns.filter(
    (p) => p.confidence === "high",
  );

  const actionableInsights = await generateAggregateLessons(aggregatedPatterns);

  const rootCauseSorted = Array.from(categoryMap.entries()).sort(
    (a, b) => b[1] - a[1],
  );

  return {
    total_failed_tests: failedEvaluations.length,
    analyzed_failures: patterns.length,
    patterns: aggregatedPatterns,
    pattern_categories: categoryMap,
    most_common_root_cause:
      rootCauseSorted.length > 0 ? rootCauseSorted[0][0] : null,
    high_confidence_patterns: highConfidencePatterns,
    actionable_insights: actionableInsights,
  };
}

export function formatFailurePatternsReport(
  analysis: FailurePatternsAnalysis,
): string {
  const lines = [
    "FAILURE PATTERN ANALYSIS",
    "========================",
    `Total Failed Tests: ${analysis.total_failed_tests}`,
    `Patterns Identified: ${analysis.patterns.length}`,
    "",
  ];

  if (analysis.most_common_root_cause) {
    lines.push(`Most Common Root Cause: ${analysis.most_common_root_cause}`);
    lines.push("");
  }

  if (analysis.patterns.length > 0) {
    lines.push("FAILURE PATTERNS:");
    for (const pattern of analysis.patterns) {
      lines.push(
        `\n[${pattern.confidence.toUpperCase()}] ${pattern.root_cause_category} (${pattern.affected_test_count} tests)`,
      );
      lines.push(`  Lesson: ${pattern.lession_summary}`);
      lines.push(`  Trigger Conditions:`);
      pattern.trigger_conditions.forEach((t) => lines.push(`    • ${t}`));
      lines.push(`  Prevention Strategies:`);
      pattern.preventative_strategies.forEach((s) => lines.push(`    • ${s}`));
      if (pattern.common_improvement_areas.length > 0) {
        lines.push(`  Common Improvement Areas:`);
        pattern.common_improvement_areas.forEach((a) =>
          lines.push(`    • ${a}`),
        );
      }
    }
  }

  if (analysis.high_confidence_patterns.length > 0) {
    lines.push("");
    lines.push("HIGH CONFIDENCE PATTERNS (Focus Areas):");
    for (const pattern of analysis.high_confidence_patterns) {
      lines.push(
        `  • ${pattern.root_cause_category}: ${pattern.lession_summary}`,
      );
    }
  }

  if (analysis.actionable_insights.length > 0) {
    lines.push("");
    lines.push("ACTIONABLE INSIGHTS:");
    analysis.actionable_insights.forEach((insight) => {
      lines.push(`  • ${insight}`);
    });
  }

  return lines.join("\n");
}
