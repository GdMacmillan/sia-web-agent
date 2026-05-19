/**
 * Behavior-Based Validation Helpers
 *
 * Validates agent behavior patterns instead of exact outputs.
 * Designed to handle non-deterministic LLM outputs while catching regressions.
 */

import { AIMessage, ToolMessage } from "@langchain/core/messages";

/**
 * Verify agent produced at least one substantive response
 */
export function verifyAgentResponded(
  state: any,
  options?: { minContentLength?: number },
): { valid: boolean; reason?: string } {
  const minLength = options?.minContentLength || 50;

  if (!state || !state.messages || state.messages.length === 0) {
    return { valid: false, reason: "No messages in state" };
  }

  // Find last AI message with content
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg instanceof AIMessage || msg.getType?.() === "ai") {
      const content = msg.content;

      // Handle string content
      if (typeof content === "string") {
        if (content.trim().length >= minLength) {
          return { valid: true };
        }
      }

      // Handle array content (Anthropic format)
      if (Array.isArray(content)) {
        const textContent = extractTextContent(content);
        if (textContent.trim().length >= minLength) {
          return { valid: true };
        }
      }
    }
  }

  return {
    valid: false,
    reason: `No AI message with content >= ${minLength} chars found`,
  };
}

/**
 * Verify tool sequence matches expected pattern
 */
export function verifyToolSequencePattern(
  toolCalls: Array<{ name: string; args?: any }>,
  pattern: {
    required?: string[];
    optional?: string[];
    orderMatters?: boolean;
    allowExtra?: boolean;
  },
): { valid: boolean; reason?: string } {
  const toolNames = toolCalls.map((t) => t.name);

  // Check required tools are present
  if (pattern.required) {
    for (const requiredTool of pattern.required) {
      if (!toolNames.includes(requiredTool)) {
        return {
          valid: false,
          reason: `Required tool '${requiredTool}' not found in sequence: ${toolNames.join(", ")}`,
        };
      }
    }
  }

  // Check order if specified
  if (pattern.orderMatters && pattern.required && pattern.required.length > 1) {
    let lastIndex = -1;
    for (const tool of pattern.required) {
      const idx = toolNames.indexOf(tool);
      if (idx <= lastIndex) {
        return {
          valid: false,
          reason: `Tool '${tool}' appears out of order. Expected before previous tools.`,
        };
      }
      lastIndex = idx;
    }
  }

  // Check for forbidden tools if applicable
  if (!pattern.allowExtra && pattern.optional) {
    const allowedTools = new Set([
      ...(pattern.required || []),
      ...pattern.optional,
    ]);
    for (const tool of toolNames) {
      if (!allowedTools.has(tool)) {
        return {
          valid: false,
          reason: `Unexpected tool '${tool}' found. Allowed: ${Array.from(allowedTools).join(", ")}`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Verify subagent was delegated to via task tool
 */
export function verifySubagentDelegation(
  state: any,
  subagentType: string,
): { valid: boolean; reason?: string } {
  if (!state || !state.messages) {
    return { valid: false, reason: "No messages in state" };
  }

  for (const msg of state.messages) {
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.name === "task" && tc.args?.subagent_type === subagentType) {
          return { valid: true };
        }
      }
    }
  }

  return {
    valid: false,
    reason: `No delegation to '${subagentType}' subagent found`,
  };
}

/**
 * Verify specific tool was invoked
 */
export function verifyToolInvoked(
  state: any,
  toolName: string,
  options?: { minCalls?: number; maxCalls?: number },
): { valid: boolean; calls: number; reason?: string } {
  if (!state || !state.messages) {
    return { valid: false, calls: 0, reason: "No messages in state" };
  }

  let calls = 0;
  for (const msg of state.messages) {
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      calls += msg.tool_calls.filter((tc) => tc.name === toolName).length;
    }
  }

  const minCalls = options?.minCalls ?? 1;
  const maxCalls = options?.maxCalls ?? Infinity;

  if (calls < minCalls) {
    return {
      valid: false,
      calls,
      reason: `Tool '${toolName}' called ${calls} times, expected at least ${minCalls}`,
    };
  }

  if (calls > maxCalls) {
    return {
      valid: false,
      calls,
      reason: `Tool '${toolName}' called ${calls} times, expected at most ${maxCalls}`,
    };
  }

  return { valid: true, calls };
}

/**
 * Verify ReAct cycle completion
 * Pattern: AI message → tool calls → ToolMessage response
 */
export function verifyReActCycleCompletion(state: any): {
  valid: boolean;
  cycles: number;
  reason?: string;
} {
  if (!state || !state.messages || state.messages.length < 3) {
    return {
      valid: false,
      cycles: 0,
      reason: "Insufficient messages for complete ReAct cycle",
    };
  }

  let cycles = 0;
  let lastWasToolCall = false;

  for (const msg of state.messages) {
    const msgType = msg.getType?.() || msg.constructor.name;

    // AI message with tool_calls
    if (msgType === "ai" && msg.tool_calls && msg.tool_calls.length > 0) {
      lastWasToolCall = true;
    }
    // ToolMessage (observation)
    else if (msgType === "tool") {
      if (lastWasToolCall) {
        cycles++;
        lastWasToolCall = false;
      }
    }
  }

  if (cycles === 0) {
    return {
      valid: false,
      cycles: 0,
      reason: "No complete ReAct cycles detected",
    };
  }

  return { valid: true, cycles };
}

/**
 * Verify task tool result was properly converted to ToolMessage
 */
export function verifyTaskToolResultHandling(state: any): {
  valid: boolean;
  reason?: string;
} {
  if (!state || !state.messages) {
    return { valid: false, reason: "No messages in state" };
  }

  let foundTaskCall = false;
  let foundToolMessage = false;

  for (const msg of state.messages) {
    // Find task tool call
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      if (msg.tool_calls.some((tc) => tc.name === "task")) {
        foundTaskCall = true;
      }
    }

    // Find ToolMessage (task result)
    if (msg.getType?.() === "tool" || msg instanceof ToolMessage) {
      if (msg.name === "task" || msg.tool_call_id?.includes("task")) {
        // Verify it has content
        if (
          msg.content &&
          (typeof msg.content === "string"
            ? msg.content.trim().length > 0
            : true)
        ) {
          foundToolMessage = true;
        }
      }
    }
  }

  if (!foundTaskCall) {
    return { valid: false, reason: "No task tool call found" };
  }

  if (!foundToolMessage) {
    return {
      valid: false,
      reason: "Task tool call found but no ToolMessage result",
    };
  }

  return { valid: true };
}

/**
 * Extract text content from message content (handles array format)
 */
function extractTextContent(content: any): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block) continue;

      if (block.text && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.thinking && typeof block.thinking === "string") {
        parts.push(block.thinking);
      } else if (typeof block === "string") {
        parts.push(block);
      }
    }
    return parts.join("\n\n");
  }

  return "";
}

/**
 * Verify state has expected updates
 */
export function verifyStateUpdates(
  state: any,
  expectedUpdates: {
    filesCreated?: string[];
    filesModified?: string[];
    messagesAdded?: number;
    todosAdded?: number;
  },
): { valid: boolean; reason?: string } {
  if (!state) {
    return { valid: false, reason: "No state provided" };
  }

  // Check files
  if (expectedUpdates.filesCreated) {
    const createdFiles = state.filesCreated || state.files || {};
    for (const file of expectedUpdates.filesCreated) {
      if (typeof createdFiles === "object" && !(file in createdFiles)) {
        return { valid: false, reason: `Expected file '${file}' not created` };
      }
    }
  }

  // Check message count
  if (expectedUpdates.messagesAdded) {
    const messageCount = state.messages?.length || 0;
    if (messageCount < expectedUpdates.messagesAdded) {
      return {
        valid: false,
        reason: `Expected at least ${expectedUpdates.messagesAdded} messages, found ${messageCount}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Check for deadlock patterns (same tool called repeatedly)
 */
export function detectDeadlock(
  state: any,
  options?: { maxRepeats?: number },
): { detected: boolean; tool?: string; repeats?: number } {
  const maxRepeats = options?.maxRepeats ?? 5;

  if (!state || !state.messages) {
    return { detected: false };
  }

  const toolSequence: string[] = [];
  for (const msg of state.messages) {
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        toolSequence.push(tc.name);
      }
    }
  }

  // Check for same tool repeated
  if (toolSequence.length >= maxRepeats) {
    for (let i = 0; i <= toolSequence.length - maxRepeats; i++) {
      const tool = toolSequence[i];
      let repeats = 1;

      for (let j = i + 1; j < toolSequence.length && j < i + maxRepeats; j++) {
        if (toolSequence[j] === tool) {
          repeats++;
        } else {
          break;
        }
      }

      if (repeats >= maxRepeats) {
        return { detected: true, tool, repeats };
      }
    }
  }

  return { detected: false };
}
