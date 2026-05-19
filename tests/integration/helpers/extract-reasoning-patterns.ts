/**
 * Extract Reasoning Patterns
 * Converts analysis outputs from failure, success, and efficiency analyzers into
 * structured ideas for storage in the graph-memory system
 */

import { PatternType, ConfidenceLevel } from "../../src/types/evaluation.js";
import type { StoreEvaluationAsIdea } from "../../src/types/evaluation.js";
import type { FailurePatternsAnalysis } from "./failure-pattern-analyzer.js";
import type { SuccessPatternsAnalysis } from "./success-pattern-analyzer.js";
import type { EfficiencyAnalysis } from "./efficiency-analyzer.js";

export interface ReasoningPatternExtraction {
  failure_pattern_ideas: StoreEvaluationAsIdea[];
  success_pattern_ideas: StoreEvaluationAsIdea[];
  efficiency_improvement_ideas: StoreEvaluationAsIdea[];
  preventative_lesson_ideas: StoreEvaluationAsIdea[];
  strategy_recommendation_ideas: StoreEvaluationAsIdea[];
}

function mapConfidenceLevel(confidence: string): ConfidenceLevel {
  if (confidence === "high") return ConfidenceLevel.HIGH;
  if (confidence === "medium") return ConfidenceLevel.MEDIUM;
  return ConfidenceLevel.LOW;
}

export function extractFailurePatternIdeas(
  analysis: FailurePatternsAnalysis,
): StoreEvaluationAsIdea[] {
  const ideas: StoreEvaluationAsIdea[] = [];

  // Create failure pattern ideas
  for (const pattern of analysis.patterns) {
    ideas.push({
      title: `Failure Pattern: ${pattern.root_cause_category}`,
      description:
        `Root Cause: ${pattern.root_cause_category}\n\n` +
        `Affected Tests: ${pattern.affected_test_count}\n\n` +
        `Trigger Conditions:\n${pattern.trigger_conditions.map((t) => `- ${t}`).join("\n")}\n\n` +
        `Prevention Strategies:\n${pattern.preventative_strategies.map((s) => `- ${s}`).join("\n")}\n\n` +
        `Key Lesson: ${pattern.lession_summary}`,
      context: "Test-Time Evaluation",
      category: "Failure Analysis",
      priority: pattern.confidence === "high" ? "high" : "medium",
      pattern_type: PatternType.FAILURE_PATTERN,
      applicability_scope: "general",
      confidence: mapConfidenceLevel(pattern.confidence),
    });
  }

  // Create preventative lesson ideas from high-confidence patterns
  for (const pattern of analysis.high_confidence_patterns) {
    ideas.push({
      title: `Preventative Lesson: Avoid ${pattern.root_cause_category}`,
      description:
        `To prevent ${pattern.root_cause_category} failures:\n\n` +
        `Watch for: ${pattern.trigger_conditions.join("; ")}\n\n` +
        `Recommended actions:\n${pattern.preventative_strategies.map((s) => `- ${s}`).join("\n")}\n\n` +
        `This pattern was identified in ${pattern.affected_test_count} tests.`,
      context: "Test-Time Evaluation",
      category: "Preventative Strategy",
      priority: "high",
      pattern_type: PatternType.PREVENTATIVE_LESSON,
      applicability_scope: "general",
      confidence: ConfidenceLevel.HIGH,
    });
  }

  // Create aggregate insight idea
  if (analysis.actionable_insights.length > 0) {
    ideas.push({
      title: "Test Failure Aggregate Insights",
      description:
        `Based on analysis of ${analysis.total_failed_tests} failed tests:\n\n` +
        analysis.actionable_insights
          .map((insight) => `- ${insight}`)
          .join("\n"),
      context: "Test-Time Evaluation",
      category: "Meta-Lesson",
      priority: "high",
      pattern_type: PatternType.STRATEGY_RECOMMENDATION,
      applicability_scope: "general",
      confidence: ConfidenceLevel.MEDIUM,
    });
  }

  return ideas;
}

export function extractSuccessPatternIdeas(
  analysis: SuccessPatternsAnalysis,
): StoreEvaluationAsIdea[] {
  const ideas: StoreEvaluationAsIdea[] = [];

  // Create success pattern ideas
  for (const pattern of analysis.patterns) {
    ideas.push({
      title: `Success Strategy: ${pattern.strategy_category}`,
      description:
        `Strategy: ${pattern.strategy_category}\n\n` +
        `Successful Tests: ${pattern.successful_test_count}\n\n` +
        `Key Characteristics:\n${pattern.key_characteristics.map((c) => `- ${c}`).join("\n")}\n\n` +
        `Applicable Contexts:\n${pattern.applicable_contexts.map((ctx) => `- ${ctx}`).join("\n")}\n\n` +
        `Replication Steps:\n${pattern.replication_steps.map((step) => `- ${step}`).join("\n")}\n\n` +
        `Recommendation: ${pattern.strategy_recommendation}`,
      context: "Test-Time Evaluation",
      category: "Success Analysis",
      priority: pattern.confidence === "high" ? "high" : "medium",
      pattern_type: PatternType.SUCCESS_PATTERN,
      applicability_scope: "general",
      confidence: mapConfidenceLevel(pattern.confidence),
    });
  }

  // Create strategy recommendation ideas from high-confidence patterns
  for (const pattern of analysis.high_confidence_strategies) {
    ideas.push({
      title: `Proven Strategy: ${pattern.strategy_category}`,
      description:
        `This strategy has proven successful in ${pattern.successful_test_count} tests with an average efficiency score of ${pattern.average_efficiency_score.toFixed(1)}/5.\n\n` +
        `How to apply it:\n${pattern.replication_steps.map((step) => `- ${step}`).join("\n")}\n\n` +
        `Context Requirements: ${pattern.applicable_contexts.join("; ")}\n\n` +
        `Key Success Factors: ${pattern.key_characteristics.join("; ")}`,
      context: "Test-Time Evaluation",
      category: "Proven Strategy",
      priority: "high",
      pattern_type: PatternType.STRATEGY_RECOMMENDATION,
      applicability_scope: "general",
      confidence: ConfidenceLevel.HIGH,
    });
  }

  // Create aggregate strategy idea
  if (analysis.strategy_recommendations.length > 0) {
    ideas.push({
      title: "Test Success Aggregate Strategies",
      description:
        `Based on analysis of ${analysis.total_successful_tests} successful tests:\n\n` +
        `Overall Strategy Recommendations:\n` +
        analysis.strategy_recommendations.map((rec) => `- ${rec}`).join("\n") +
        `\n\nAverage Performance Scores:\n` +
        `- Trajectory Quality: ${analysis.average_scores.trajectory_quality.toFixed(2)}/5\n` +
        `- Tool Usage: ${analysis.average_scores.tool_usage.toFixed(2)}/5\n` +
        `- Reasoning Clarity: ${analysis.average_scores.reasoning_clarity.toFixed(2)}/5\n` +
        `- Efficiency: ${analysis.average_scores.efficiency.toFixed(2)}/5`,
      context: "Test-Time Evaluation",
      category: "Meta-Strategy",
      priority: "high",
      pattern_type: PatternType.STRATEGY_RECOMMENDATION,
      applicability_scope: "general",
      confidence: ConfidenceLevel.HIGH,
    });
  }

  return ideas;
}

export function extractEfficiencyImprovementIdeas(
  analysis: EfficiencyAnalysis,
): StoreEvaluationAsIdea[] {
  const ideas: StoreEvaluationAsIdea[] = [];

  // Create efficiency improvement ideas for high-impact patterns
  for (const pattern of analysis.high_impact_optimizations) {
    const improvementPoints =
      pattern.estimated_efficiency_after - pattern.average_efficiency_before;

    ideas.push({
      title: `Efficiency Improvement: ${pattern.optimization_area}`,
      description:
        `Current Issue: ${pattern.current_inefficiency}\n\n` +
        `Optimization Strategy: ${pattern.optimization_strategy}\n\n` +
        `Current Efficiency: ${pattern.average_efficiency_before.toFixed(2)}/5\n` +
        `Estimated After: ${pattern.estimated_efficiency_after.toFixed(2)}/5\n` +
        `Potential Improvement: +${improvementPoints.toFixed(1)} points\n\n` +
        `Affected Tests: ${pattern.test_count}\n\n` +
        `Implementation Steps:\n${pattern.implementation_steps.map((step) => `- ${step}`).join("\n")}\n\n` +
        `Expected Result: ${pattern.expected_improvement}`,
      context: "Test-Time Evaluation",
      category: "Efficiency Optimization",
      priority: "high",
      pattern_type: PatternType.EFFICIENCY_IMPROVEMENT,
      applicability_scope: "general",
      confidence: ConfidenceLevel.HIGH,
    });
  }

  // Create inefficiency hotspot ideas
  for (const pattern of analysis.most_inefficient_areas) {
    ideas.push({
      title: `Inefficiency Hotspot: ${pattern.optimization_area}`,
      description:
        `Area: ${pattern.optimization_area}\n` +
        `Current Efficiency Score: ${pattern.average_efficiency_before.toFixed(2)}/5\n` +
        `Problem: ${pattern.current_inefficiency}\n\n` +
        `Root Cause Analysis:\n${pattern.optimization_strategy}\n\n` +
        `Affects ${pattern.test_count} tests`,
      context: "Test-Time Evaluation",
      category: "Performance Bottleneck",
      priority: "high",
      pattern_type: PatternType.CONTEXT_REQUIREMENT,
      applicability_scope: "context_specific",
      confidence: ConfidenceLevel.MEDIUM,
    });
  }

  // Create aggregate efficiency recommendation idea
  if (analysis.efficiency_recommendations.length > 0) {
    const improvementPercentage =
      analysis.efficiency_trend.optimization_potential.toFixed(1);

    ideas.push({
      title: "Efficiency Optimization Recommendations",
      description:
        `Current Metrics:\n` +
        `- Average Efficiency: ${analysis.average_efficiency.toFixed(2)}/5\n` +
        `- Average Tool Calls: ${analysis.average_tool_calls.toFixed(1)}\n` +
        `- Tool Call Efficiency Ratio: ${analysis.tool_call_efficiency.toFixed(2)}\n\n` +
        `Overall Improvement Potential: ${improvementPercentage}%\n\n` +
        `Key Recommendations:\n` +
        analysis.efficiency_recommendations.map((rec) => `- ${rec}`).join("\n"),
      context: "Test-Time Evaluation",
      category: "Performance Strategy",
      priority: "high",
      pattern_type: PatternType.STRATEGY_RECOMMENDATION,
      applicability_scope: "general",
      confidence: ConfidenceLevel.MEDIUM,
    });
  }

  return ideas;
}

export function extractAllReasoningPatterns(
  failureAnalysis: FailurePatternsAnalysis,
  successAnalysis: SuccessPatternsAnalysis,
  efficiencyAnalysis: EfficiencyAnalysis,
): ReasoningPatternExtraction {
  return {
    failure_pattern_ideas: extractFailurePatternIdeas(failureAnalysis),
    success_pattern_ideas: extractSuccessPatternIdeas(successAnalysis),
    efficiency_improvement_ideas:
      extractEfficiencyImprovementIdeas(efficiencyAnalysis),
    preventative_lesson_ideas: extractFailurePatternIdeas(
      failureAnalysis,
    ).filter((idea) => idea.pattern_type === PatternType.PREVENTATIVE_LESSON),
    strategy_recommendation_ideas: [
      ...extractSuccessPatternIdeas(successAnalysis).filter(
        (idea) => idea.pattern_type === PatternType.STRATEGY_RECOMMENDATION,
      ),
      ...extractEfficiencyImprovementIdeas(efficiencyAnalysis).filter(
        (idea) => idea.pattern_type === PatternType.STRATEGY_RECOMMENDATION,
      ),
    ],
  };
}

export function formatExtractionSummary(
  extraction: ReasoningPatternExtraction,
): string {
  const lines = [
    "REASONING PATTERN EXTRACTION SUMMARY",
    "====================================",
    "",
    "Extracted Ideas by Type:",
    `  Failure Patterns: ${extraction.failure_pattern_ideas.length}`,
    `  Success Patterns: ${extraction.success_pattern_ideas.length}`,
    `  Efficiency Improvements: ${extraction.efficiency_improvement_ideas.length}`,
    `  Preventative Lessons: ${extraction.preventative_lesson_ideas.length}`,
    `  Strategy Recommendations: ${extraction.strategy_recommendation_ideas.length}`,
    "",
    `Total Ideas Ready for Storage: ${extraction.failure_pattern_ideas.length + extraction.success_pattern_ideas.length + extraction.efficiency_improvement_ideas.length}`,
    "",
    "These ideas are now ready to be stored in the graph-memory system",
    "and can be queried by the agent to improve behavior in future tests.",
  ];

  return lines.join("\n");
}
