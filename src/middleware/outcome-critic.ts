/**
 * Outcome Critic Module
 *
 * Evaluates task outcomes via heuristics + LLM-based intent fulfillment analysis.
 * Determines whether a task succeeded or failed to inform knowledge health tracking.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { logger } from "../utils/logger.js";

/**
 * Task outcome evaluation result
 */
export interface TaskOutcome {
  /** Whether the user's intent was fulfilled */
  fulfilled: boolean;
  /** List of tool errors encountered during execution */
  toolErrors: string[];
  /** Confidence in the evaluation (0-1) */
  confidence: number;
  /** Brief reasoning for the evaluation */
  reasoning: string;
}

/**
 * Critic evaluation prompt for LLM
 */
const CRITIC_SYSTEM_PROMPT = `You are a task evaluation critic. Analyze the conversation and determine if the task was
successfully completed.

EVALUATION CRITERIA: 1. Intent Fulfillment: Did the agent accomplish what the user requested? 2.
Tool Errors: Were there any tool failures that prevented completion? 3. Explicit Signals: Did the
agent indicate success or failure?

IMPORTANT: Focus on whether the USER's goal was achieved, not whether the agent executed tools.

Examples of SUCCESS: - User asks to "create a file", agent creates it successfully - User asks to
"find a bug", agent identifies and explains the bug - User asks to "refactor code", agent refactors
it and tests pass

Examples of FAILURE: - User asks to "fix the build", but build still fails - User asks to "add a
feature", but agent encounters permission errors - User asks to "analyze performance", but agent
cannot access profiling data

Respond with JSON only (no markdown): { "fulfilled": boolean, "tool_errors": string[], "confidence":
0.0-1.0, "reasoning": "brief explanation (1-2 sentences)" }`;

/**
 * Check if message content indicates an error
 */
function isErrorResult(content: unknown): boolean {
  const str = typeof content === "string" ? content : JSON.stringify(content);
  return /error|failed|exception|not found|permission denied|timed out/i.test(
    str,
  );
}

/**
 * Extract error message from content
 */
function extractErrorMessage(content: unknown): string {
  const str = typeof content === "string" ? content : JSON.stringify(content);
  // Extract first line that looks like an error
  const match = str.match(/(error|exception|failed):?\s*([^\n]+)/i);
  return match ? match[0].substring(0, 100) : "Unknown error";
}

function resolveMessageType(message: BaseMessage): string {
  const getterType = message.getType?.();
  if (getterType) {
    return getterType;
  }

  const asRecord = message as unknown as Record<string, unknown>;
  if (typeof asRecord.type === "string" && asRecord.type.length > 0) {
    return asRecord.type;
  }

  const constructorName =
    typeof message.constructor?.name === "string"
      ? message.constructor.name
      : undefined;

  return constructorName ?? "unknown";
}

/**
 * Evaluate task outcome using heuristics and LLM fallback
 *
 * Quick heuristics:
 * - If many tool errors (>2), likely failure
 * - If no messages, unknown
 * - Otherwise, use LLM for nuanced evaluation
 *
 * @param model - Language model for evaluation
 * @param messages - Full conversation history
 * @param originalRequest - First user message (task description)
 * @returns Task outcome with confidence score
 */
export async function evaluateTaskOutcome(
  model: BaseChatModel,
  messages: BaseMessage[],
  originalRequest: string,
): Promise<TaskOutcome> {
  try {
    // Extract tool results and check for errors
    const toolMessages = messages.filter((m) => m.getType?.() === "tool");
    const toolErrors = toolMessages
      .filter((m) => isErrorResult(m.content))
      .map((m) => extractErrorMessage(m.content));

    // Quick heuristic: If many tool errors, likely failure
    if (toolErrors.length > 2) {
      return {
        fulfilled: false,
        toolErrors,
        confidence: 0.8,
        reasoning: `Multiple tool errors (${toolErrors.length}) prevented task completion`,
      };
    }

    // No messages = unknown
    if (messages.length === 0) {
      return {
        fulfilled: false,
        toolErrors: [],
        confidence: 0.5,
        reasoning: "No conversation history to evaluate",
      };
    }

    // LLM-based evaluation for ambiguous cases
    const context = {
      original_request: originalRequest,
      final_messages: messages.slice(-5).map((m) => ({
        type: resolveMessageType(m),
        content:
          typeof m.content === "string"
            ? m.content.substring(0, 500)
            : JSON.stringify(m.content).substring(0, 500),
      })),
      tool_error_count: toolErrors.length,
      tool_errors: toolErrors.slice(0, 3), // First 3 errors
    };

    const response = await model.invoke([
      new SystemMessage(CRITIC_SYSTEM_PROMPT),
      new HumanMessage(
        `Evaluate this task:\n\n${JSON.stringify(context, null, 2)}`,
      ),
    ]);

    // Extract text content, handling array responses (e.g., reasoning + text blocks)
    let responseText: string;
    if (typeof response.content === "string") {
      responseText = response.content;
    } else if (Array.isArray(response.content)) {
      responseText = response.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n");
      if (!responseText) {
        responseText = JSON.stringify(response.content);
      }
    } else {
      responseText = JSON.stringify(response.content);
    }

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(
        "[OutcomeCritic] Failed to parse LLM response, defaulting to unknown",
      );
      return {
        fulfilled: false,
        toolErrors,
        confidence: 0.5,
        reasoning: "Unable to evaluate task outcome",
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      fulfilled: parsed.fulfilled ?? false,
      toolErrors: parsed.tool_errors || toolErrors,
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      reasoning: parsed.reasoning || "No reasoning provided",
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(
      { err, errorMessage: err.message },
      "[OutcomeCritic] Evaluation failed",
    );
    return {
      fulfilled: false,
      toolErrors: [],
      confidence: 0.3,
      reasoning: "Evaluation failed due to error",
    };
  }
}
