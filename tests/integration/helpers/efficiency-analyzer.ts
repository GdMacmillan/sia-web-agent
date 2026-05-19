/**
 * Efficiency Analyzer
 * Tracks and analyzes efficiency metrics from test evaluations
 * Identifies optimization patterns and suggests performance improvements
 */

import { z } from "zod";
import { createChatModel } from "../../src/config/model-config.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { TestOutcomeEvaluation } from "./test-outcome-evaluator.js";

export const EfficiencyPatternSchema = z.object({
  optimization_area: z.string().describe("Area of optimization"),
  current_inefficiency: z
    .string()
    .describe("Description of current inefficiency"),
  optimization_strategy: z.string().describe("Proposed optimization strategy"),
  expected_improvement: z.string().describe("Expected performance improvement"),
  implementation_steps: z
    .array(z.string())
    .describe("Steps to implement optimization"),
  test_count: z.number().describe("Number of tests affecting this area"),
  average_efficiency_before: z
    .number()
    .min(1)
    .max(5)
    .describe("Current average efficiency score"),
  estimated_efficiency_after: z
    .number()
    .min(1)
    .max(5)
    .describe("Estimated efficiency after optimization"),
});

export type EfficiencyPattern = z.infer<typeof EfficiencyPatternSchema>;

export interface EfficiencyAnalysis {
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  average_efficiency: number;
  average_tool_calls: number;
  tool_call_efficiency: number; // efficiency / tool_calls ratio
  patterns: EfficiencyPattern[];
  most_inefficient_areas: EfficiencyPattern[];
  high_impact_optimizations: EfficiencyPattern[];
  efficiency_recommendations: string[];
  efficiency_trend: {
    best_performing: string;
    worst_performing: string;
    optimization_potential: number; // percentage potential improvement
  };
}

async function analyzeEfficiencyIssueWithLLM(
  testName: string,
  passed: boolean,
  efficiency: number,
  toolCallCount: number,
  messageCount: number,
  executionTime: number | undefined,
): Promise<{
  optimization_area: string;
  current_inefficiency: string;
  optimization_strategy: string;
  expected_improvement: string;
  implementation_steps: string[];
}> {
  const llm = await createChatModel();

  const systemPrompt =
    "You are an expert in agent optimization and efficiency analysis. " +
    "Analyze test execution metrics and identify optimization opportunities. " +
    "Focus on tool usage efficiency, reasoning steps, and execution patterns. " +
    "Return ONLY valid JSON - no markdown, no extra text.";

  const statusText = passed ? "PASSED" : "FAILED";
  const executionText = executionTime ? `${executionTime}ms` : "unknown";

  const userPrompt =
    `Analyze the efficiency of this agent test and suggest optimizations:\n\n` +
    `Test: ${testName}\n` +
    `Status: ${statusText}\n` +
    `Efficiency Score: ${efficiency}/5\n` +
    `Tool Calls: ${toolCallCount}\n` +
    `Messages in Trajectory: ${messageCount}\n` +
    `Execution Time: ${executionText}\n\n` +
    `Tasks:\n` +
    `1. Identify the primary area of inefficiency (e.g., "Excessive Tool Calls", "Redundant Reasoning Steps", "Exploration Overhead")\n` +
    `2. Describe the current inefficiency pattern\n` +
    `3. Propose a specific optimization strategy\n` +
    `4. Estimate the expected improvement\n` +
    `5. Generate 2-3 concrete implementation steps\n\n` +
    `Return JSON matching this structure:\n` +
    `{\n` +
    `  "optimization_area": "string",\n` +
    `  "current_inefficiency": "string",\n` +
    `  "optimization_strategy": "string",\n` +
    `  "expected_improvement": "string",\n` +
    `  "implementation_steps": ["string"]\n` +
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
    optimization_area: parsed.optimization_area,
    current_inefficiency: parsed.current_inefficiency,
    optimization_strategy: parsed.optimization_strategy,
    expected_improvement: parsed.expected_improvement,
    implementation_steps: parsed.implementation_steps,
  };
}

async function generateEfficiencyRecommendations(
  patterns: EfficiencyPattern[],
): Promise<string[]> {
  if (patterns.length === 0) {
    return [];
  }

  const llm = await createChatModel();

  const systemPrompt =
    "You are an expert in agent performance optimization. " +
    "Given efficiency analysis patterns, synthesize high-level optimization recommendations. " +
    "Focus on systemic improvements that benefit multiple tests. " +
    "Prioritize high-impact, low-effort optimizations. " +
    "Return ONLY a JSON array of strings - no markdown, no extra text.";

  const patternSummaries = patterns
    .slice(0, 5)
    .map(
      (p) =>
        `${p.optimization_area} (${p.test_count} tests): ${p.optimization_strategy} (est. improvement: ${p.estimated_efficiency_after - p.average_efficiency_before > 0 ? "+" : ""}${(p.estimated_efficiency_after - p.average_efficiency_before).toFixed(1)})`,
    )
    .join("\n");

  const userPrompt =
    `Synthesize efficiency optimization recommendations from these patterns:\n\n` +
    `${patternSummaries}\n\n` +
    `Generate 3-5 high-level recommendations for improving agent efficiency. ` +
    `Focus on systemic improvements that benefit multiple tests. ` +
    `Prioritize changes with the highest impact on tool call reduction and reasoning efficiency. ` +
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

export async function analyzeEfficiency(
  evaluations: TestOutcomeEvaluation[],
): Promise<EfficiencyAnalysis> {
  if (evaluations.length === 0) {
    return {
      total_tests: 0,
      passed_tests: 0,
      failed_tests: 0,
      average_efficiency: 0,
      average_tool_calls: 0,
      tool_call_efficiency: 0,
      patterns: [],
      most_inefficient_areas: [],
      high_impact_optimizations: [],
      efficiency_recommendations: [],
      efficiency_trend: {
        best_performing: "",
        worst_performing: "",
        optimization_potential: 0,
      },
    };
  }

  const patterns: EfficiencyPattern[] = [];
  let totalEfficiency = 0;
  let totalToolCalls = 0;
  const areaMap = new Map<string, EfficiencyPattern[]>();

  // Analyze each test for efficiency opportunities
  for (const evaluation of evaluations) {
    totalEfficiency += evaluation.evaluation.efficiency;
    totalToolCalls += evaluation.toolCallCount;

    const analysis = await analyzeEfficiencyIssueWithLLM(
      evaluation.testName,
      evaluation.passed,
      evaluation.evaluation.efficiency,
      evaluation.toolCallCount,
      evaluation.messageCount,
      evaluation.executionTime,
    );

    const pattern: EfficiencyPattern = {
      optimization_area: analysis.optimization_area,
      current_inefficiency: analysis.current_inefficiency,
      optimization_strategy: analysis.optimization_strategy,
      expected_improvement: analysis.expected_improvement,
      implementation_steps: analysis.implementation_steps,
      test_count: 1,
      average_efficiency_before: evaluation.evaluation.efficiency,
      estimated_efficiency_after: Math.min(
        5,
        evaluation.evaluation.efficiency + 1.5,
      ), // Conservative estimate
    };

    patterns.push(pattern);

    const area = analysis.optimization_area;
    if (!areaMap.has(area)) {
      areaMap.set(area, []);
    }
    areaMap.get(area)!.push(pattern);
  }

  // Aggregate patterns by optimization area
  const aggregatedPatterns: EfficiencyPattern[] = [];
  const processedAreas = new Set<string>();

  for (const pattern of patterns) {
    if (processedAreas.has(pattern.optimization_area)) {
      continue;
    }
    processedAreas.add(pattern.optimization_area);

    const areaPatterns = areaMap.get(pattern.optimization_area) || [];

    const avgEfficiencyBefore =
      areaPatterns.reduce((sum, p) => sum + p.average_efficiency_before, 0) /
      areaPatterns.length;
    const avgEfficiencyAfter =
      areaPatterns.reduce((sum, p) => sum + p.estimated_efficiency_after, 0) /
      areaPatterns.length;

    aggregatedPatterns.push({
      optimization_area: pattern.optimization_area,
      current_inefficiency: pattern.current_inefficiency,
      optimization_strategy: pattern.optimization_strategy,
      expected_improvement: pattern.expected_improvement,
      implementation_steps: pattern.implementation_steps,
      test_count: areaPatterns.length,
      average_efficiency_before: avgEfficiencyBefore,
      estimated_efficiency_after: avgEfficiencyAfter,
    });
  }

  // Sort by frequency and impact
  aggregatedPatterns.sort((a, b) => {
    const impactA =
      (a.estimated_efficiency_after - a.average_efficiency_before) *
      a.test_count;
    const impactB =
      (b.estimated_efficiency_after - b.average_efficiency_before) *
      b.test_count;
    return impactB - impactA;
  });

  const mostInefficient = aggregatedPatterns
    .filter((p) => p.average_efficiency_before < 3)
    .slice(0, 3);
  const highImpact = aggregatedPatterns
    .filter(
      (p) =>
        p.estimated_efficiency_after - p.average_efficiency_before > 1 &&
        p.test_count >= 2,
    )
    .slice(0, 3);

  const efficiencyRecommendations =
    await generateEfficiencyRecommendations(aggregatedPatterns);

  const passedCount = evaluations.filter((e) => e.passed).length;
  const failedCount = evaluations.length - passedCount;
  const avgEfficiency = totalEfficiency / evaluations.length;
  const avgToolCalls = totalToolCalls / evaluations.length;
  const toolCallEfficiency = avgEfficiency / (avgToolCalls || 1);

  // Calculate best and worst performing areas
  const bestArea = aggregatedPatterns.reduce((best, current) =>
    current.average_efficiency_before > best.average_efficiency_before
      ? current
      : best,
  );
  const worstArea = aggregatedPatterns.reduce((worst, current) =>
    current.average_efficiency_before < worst.average_efficiency_before
      ? current
      : worst,
  );

  const optimizationPotential =
    avgEfficiency < 5 ? ((5 - avgEfficiency) / 5) * 100 : 0;

  return {
    total_tests: evaluations.length,
    passed_tests: passedCount,
    failed_tests: failedCount,
    average_efficiency: avgEfficiency,
    average_tool_calls: avgToolCalls,
    tool_call_efficiency: toolCallEfficiency,
    patterns: aggregatedPatterns,
    most_inefficient_areas: mostInefficient,
    high_impact_optimizations: highImpact,
    efficiency_recommendations: efficiencyRecommendations,
    efficiency_trend: {
      best_performing: bestArea.optimization_area,
      worst_performing: worstArea.optimization_area,
      optimization_potential: optimizationPotential,
    },
  };
}

export function formatEfficiencyReport(analysis: EfficiencyAnalysis): string {
  const lines = [
    "EFFICIENCY ANALYSIS REPORT",
    "==========================",
    `Total Tests: ${analysis.total_tests}`,
    `Passed: ${analysis.passed_tests} | Failed: ${analysis.failed_tests}`,
    "",
    "EFFICIENCY METRICS:",
    `  Average Efficiency Score: ${analysis.average_efficiency.toFixed(2)}/5`,
    `  Average Tool Calls: ${analysis.average_tool_calls.toFixed(1)}`,
    `  Tool Call Efficiency Ratio: ${analysis.tool_call_efficiency.toFixed(2)}`,
    "",
    "OPTIMIZATION POTENTIAL:",
    `  ${analysis.efficiency_trend.best_performing} - Best performing`,
    `  ${analysis.efficiency_trend.worst_performing} - Worst performing`,
    `  Overall improvement potential: ${analysis.efficiency_trend.optimization_potential.toFixed(1)}%`,
    "",
  ];

  if (analysis.most_inefficient_areas.length > 0) {
    lines.push("INEFFICIENCY HOTSPOTS (Priority Focus Areas):");
    for (const pattern of analysis.most_inefficient_areas) {
      lines.push(
        `\n  ${pattern.optimization_area} (affects ${pattern.test_count} tests)`,
      );
      lines.push(
        `    Current: ${pattern.average_efficiency_before.toFixed(2)}/5`,
      );
      lines.push(
        `    Potential: ${pattern.estimated_efficiency_after.toFixed(2)}/5`,
      );
      lines.push(`    Issue: ${pattern.current_inefficiency}`);
      lines.push(`    Strategy: ${pattern.optimization_strategy}`);
      lines.push(`    Expected: ${pattern.expected_improvement}`);
    }
    lines.push("");
  }

  if (analysis.high_impact_optimizations.length > 0) {
    lines.push("HIGH-IMPACT OPTIMIZATIONS (Quick Wins):");
    for (const pattern of analysis.high_impact_optimizations) {
      lines.push(
        `\n  ${pattern.optimization_area} (affects ${pattern.test_count} tests)`,
      );
      lines.push(
        `    Improvement: +${(pattern.estimated_efficiency_after - pattern.average_efficiency_before).toFixed(1)} efficiency points`,
      );
      lines.push(`    Implementation:`);
      pattern.implementation_steps.forEach((step) => {
        lines.push(`      • ${step}`);
      });
    }
    lines.push("");
  }

  if (analysis.efficiency_recommendations.length > 0) {
    lines.push("OPTIMIZATION RECOMMENDATIONS:");
    analysis.efficiency_recommendations.forEach((rec) => {
      lines.push(`  • ${rec}`);
    });
  }

  return lines.join("\n");
}
