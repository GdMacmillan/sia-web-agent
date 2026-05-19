/**
 * Test Outcome Evaluator - LLM-as-Judge for Agent Evaluation
 * Evaluates agent test outcomes on multiple dimensions for learning
 */

import { z } from "zod";
import { BaseMessage, AIMessage } from "@langchain/core/messages";
import { createChatModel } from "../../src/config/model-config.js";

export const EvaluationResultSchema = z.object({
  trajectory_quality: z
    .number()
    .min(1)
    .max(5)
    .describe("Quality of agent reasoning (1=poor, 5=excellent)"),
  tool_usage: z
    .number()
    .min(1)
    .max(5)
    .describe("Tool selection appropriateness (1=poor, 5=optimal)"),
  reasoning_clarity: z
    .number()
    .min(1)
    .max(5)
    .describe("Clarity of agent reasoning (1=unclear, 5=very clear)"),
  efficiency: z
    .number()
    .min(1)
    .max(5)
    .describe("Efficiency of approach (1=inefficient, 5=optimal)"),
  overall_score: z
    .number()
    .min(1)
    .max(5)
    .describe("Overall quality assessment"),
  failure_root_cause: z.string().optional().describe("If failed, root cause"),
  key_strengths: z.array(z.string()).describe("Agent strengths"),
  improvement_areas: z.array(z.string()).describe("Improvement areas"),
  reasoning_summary: z.string().describe("Evaluation summary"),
});

export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

export interface TestOutcomeEvaluation {
  testName: string;
  passed: boolean;
  evaluation: EvaluationResult;
  messageCount: number;
  toolCallCount: number;
  executionTime?: number;
}

function extractEvaluationContext(
  messages: BaseMessage[],
  testName: string,
  passed: boolean,
) {
  const toolCalls: Array<{ name: string; args?: unknown }> = [];
  let lastAIMessage = "";

  for (const msg of messages) {
    if (
      "tool_calls" in msg &&
      msg.tool_calls &&
      Array.isArray(msg.tool_calls)
    ) {
      for (const tc of msg.tool_calls) {
        toolCalls.push({
          name: tc.name,
          args: tc.args,
        });
      }
    }

    if (msg instanceof AIMessage || msg.getType?.() === "ai") {
      const content = msg.content;
      if (typeof content === "string") {
        lastAIMessage = content;
      } else if (Array.isArray(content)) {
        const textParts = content.filter((c: unknown) => {
          const item = c as { text?: string; thinking?: string };
          return item.text || item.thinking;
        });
        lastAIMessage = textParts
          .map((c: unknown) => {
            const item = c as { text?: string; thinking?: string };
            return item.text || item.thinking;
          })
          .join("\n");
      }
    }
  }

  const toolSequence = toolCalls
    .map((tc, i) => `${i + 1}. ${tc.name}`)
    .join("\n");
  const messagePreview = lastAIMessage.substring(0, 200);
  const trajectoryLines = [
    `Test: ${testName}`,
    `Result: ${passed ? "PASSED" : "FAILED"}`,
    "Tool Sequence:",
    toolSequence || "(no tools called)",
    `Final Message: ${messagePreview}...`,
  ];
  const trajectory = trajectoryLines.join("\n");

  return {
    messageCount: messages.length,
    toolCalls,
    lastAIMessage,
    trajectory,
  };
}

function buildEvaluationPrompt(
  context: ReturnType<typeof extractEvaluationContext>,
  testName: string,
  passed: boolean,
) {
  const resultText = passed ? "PASSED" : "FAILED";
  const failureNote = passed
    ? ""
    : "This test FAILED. Identify root cause: ambiguous prompt, missing tools, or agent confusion?";

  const parts = [
    "Evaluate this agent test on 5 dimensions (1-5 scale):",
    `Test: ${testName}`,
    `Result: ${resultText}`,
    `Messages: ${context.messageCount}, Tool Calls: ${context.toolCalls.length}`,
    failureNote ? `Note: ${failureNote}` : "",
    "",
    "TRAJECTORY:",
    context.trajectory,
    "",
    "DIMENSIONS:",
    "1. Trajectory Quality - Sound reasoning?",
    "2. Tool Usage - Right tools chosen?",
    "3. Reasoning Clarity - Clear explanations?",
    "4. Efficiency - Direct approach?",
    "5. Overall Score - Holistic assessment",
    "",
    "ALSO PROVIDE:",
    "- failure_root_cause (or null)",
    "- key_strengths (2-3 items)",
    "- improvement_areas (2-3 items)",
    "- reasoning_summary (1-2 sentences)",
    "",
    "RETURN ONLY VALID JSON - no other text",
  ];

  return parts.join("\n");
}

export async function evaluateTestOutcome(
  messages: BaseMessage[],
  testName: string,
  passed: boolean,
  executionTime?: number,
): Promise<TestOutcomeEvaluation> {
  const context = extractEvaluationContext(messages, testName, passed);

  const model = await createChatModel();

  const prompt = buildEvaluationPrompt(context, testName, passed);

  const response = await model
    .withStructuredOutput(EvaluationResultSchema)
    .invoke([
      {
        role: "user" as const,
        content: prompt,
      },
    ]);

  const evaluation = EvaluationResultSchema.parse(response);

  return {
    testName,
    passed,
    evaluation,
    messageCount: context.messageCount,
    toolCallCount: context.toolCalls.length,
    executionTime,
  };
}

export async function evaluateTestOutcomes(
  testResults: Array<{
    messages: BaseMessage[];
    testName: string;
    passed: boolean;
    executionTime?: number;
  }>,
): Promise<TestOutcomeEvaluation[]> {
  const evaluations: TestOutcomeEvaluation[] = [];

  for (const result of testResults) {
    const evaluation = await evaluateTestOutcome(
      result.messages,
      result.testName,
      result.passed,
      result.executionTime,
    );
    evaluations.push(evaluation);
  }

  return evaluations;
}

export function aggregateEvaluations(evaluations: TestOutcomeEvaluation[]) {
  const passedTests = evaluations.filter((e) => e.passed).length;
  const totalTests = evaluations.length;

  const scoreFields = [
    "trajectory_quality",
    "tool_usage",
    "reasoning_clarity",
    "efficiency",
    "overall_score",
  ] as const;
  const averageScores: Record<string, number> = {};

  for (const field of scoreFields) {
    const sum = evaluations.reduce((acc, e) => acc + e.evaluation[field], 0);
    averageScores[field] = sum / totalTests;
  }

  const strengthsMap = new Map<string, number>();
  const improvementsMap = new Map<string, number>();
  const rootCausesMap = new Map<string, number>();

  for (const evalItem of evaluations) {
    for (const strength of evalItem.evaluation.key_strengths) {
      strengthsMap.set(strength, (strengthsMap.get(strength) ?? 0) + 1);
    }

    for (const improvement of evalItem.evaluation.improvement_areas) {
      improvementsMap.set(
        improvement,
        (improvementsMap.get(improvement) ?? 0) + 1,
      );
    }

    if (evalItem.evaluation.failure_root_cause) {
      rootCausesMap.set(
        evalItem.evaluation.failure_root_cause,
        (rootCausesMap.get(evalItem.evaluation.failure_root_cause) ?? 0) + 1,
      );
    }
  }

  const sortedRootCauses = Array.from(rootCausesMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([cause, count]) => ({ cause, count }));

  return {
    passRate: totalTests > 0 ? passedTests / totalTests : 0,
    averageScores: averageScores as Record<string, number>,
    commonStrengths: strengthsMap,
    commonImprovements: improvementsMap,
    failureRootCauses: sortedRootCauses,
    totalTests,
    passedTests,
  };
}

export function formatEvaluationResults(
  evaluation: TestOutcomeEvaluation,
): string {
  const result = evaluation.evaluation;
  const lines = [
    `Test: ${evaluation.testName}`,
    `Status: ${evaluation.passed ? "✓ PASSED" : "✗ FAILED"}`,
    "",
    "SCORES:",
    `  Trajectory Quality:   ${result.trajectory_quality}/5`,
    `  Tool Usage:           ${result.tool_usage}/5`,
    `  Reasoning Clarity:    ${result.reasoning_clarity}/5`,
    `  Efficiency:           ${result.efficiency}/5`,
    `  Overall:              ${result.overall_score}/5`,
    "",
    "ANALYSIS:",
    result.reasoning_summary,
    "",
    "STRENGTHS:",
    ...result.key_strengths.map((s) => `  • ${s}`),
    "",
    "AREAS FOR IMPROVEMENT:",
    ...result.improvement_areas.map((a) => `  • ${a}`),
    ...(result.failure_root_cause
      ? ["", `ROOT CAUSE: ${result.failure_root_cause}`]
      : []),
    "",
    "Metrics:",
    `  Messages: ${evaluation.messageCount}`,
    `  Tool Calls: ${evaluation.toolCallCount}`,
    ...(evaluation.executionTime
      ? [`  Execution Time: ${evaluation.executionTime}ms`]
      : []),
  ];

  return lines.join("\n");
}

export function formatAggregateStatistics(
  stats: ReturnType<typeof aggregateEvaluations>,
) {
  const passRatePercent = (stats.passRate * 100).toFixed(1);
  const strengthItems = Array.from(stats.commonStrengths.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([s, count]) => `  • ${s} (${count} tests)`)
    .join("\n");

  const improvementItems = Array.from(stats.commonImprovements.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([i, count]) => `  • ${i} (${count} tests)`)
    .join("\n");

  const rootCauseItems = stats.failureRootCauses
    .slice(0, 5)
    .map(({ cause, count }) => `  • ${cause} (${count} failures)`)
    .join("\n");

  const lines = [
    "TEST EVALUATION SUMMARY",
    "=======================",
    `Total Tests: ${stats.totalTests}`,
    `Passed: ${stats.passedTests}`,
    `Pass Rate: ${passRatePercent}%`,
    "",
    "AVERAGE SCORES:",
    `  Trajectory Quality:   ${stats.averageScores.trajectory_quality?.toFixed(2)}/5`,
    `  Tool Usage:           ${stats.averageScores.tool_usage?.toFixed(2)}/5`,
    `  Reasoning Clarity:    ${stats.averageScores.reasoning_clarity?.toFixed(2)}/5`,
    `  Efficiency:           ${stats.averageScores.efficiency?.toFixed(2)}/5`,
    `  Overall:              ${stats.averageScores.overall_score?.toFixed(2)}/5`,
    "",
    "TOP STRENGTHS:",
    strengthItems || "  (none yet)",
    "",
    "TOP IMPROVEMENT AREAS:",
    improvementItems || "  (none yet)",
    ...(stats.failureRootCauses.length > 0
      ? ["", "FAILURE ROOT CAUSES:", rootCauseItems]
      : []),
  ];

  return lines.join("\n");
}
