/**
 * Trajectory Validation Helpers
 *
 * Validates tool call sequences and agent behavior patterns
 * for integration testing.
 */

import { BaseMessage } from "@langchain/core/messages";

export interface ToolCall {
  name: string;
  args: Record<string, any>;
  phase?: string;
}

export interface TrajectoryPattern {
  phase: string;
  tools: string[];
  optional?: boolean;
}

/**
 * Extract all tool calls from message history
 */
export function extractToolSequence(messages: BaseMessage[]): ToolCall[] {
  const tools: ToolCall[] = [];

  for (const message of messages) {
    if (
      "tool_calls" in message &&
      message.tool_calls &&
      Array.isArray(message.tool_calls)
    ) {
      for (const toolCall of message.tool_calls) {
        tools.push({
          name: toolCall.name,
          args: toolCall.args || {},
        });
      }
    }
  }

  return tools;
}

/**
 * Check if tool sequence matches expected pattern
 */
export function matchesPattern(
  actualTools: ToolCall[],
  expectedPattern: TrajectoryPattern[],
): { matches: boolean; reason?: string } {
  const toolNames = actualTools.map((t) => t.name);
  let toolIndex = 0;

  for (const pattern of expectedPattern) {
    const phaseName = pattern.phase;

    // Find tools for this phase
    const phaseTools = pattern.tools;

    for (const expectedTool of phaseTools) {
      const found = toolNames.slice(toolIndex).includes(expectedTool);

      if (!found) {
        if (!pattern.optional) {
          return {
            matches: false,
            reason: `Missing required tool '${expectedTool}' in phase '${phaseName}'`,
          };
        }
        break;
      }

      // Advance past this tool
      const idx = toolNames.indexOf(expectedTool, toolIndex);
      toolIndex = idx + 1;
    }
  }

  return { matches: true };
}

/**
 * Check if trajectory includes forbidden tools
 */
export function includesForbiddenTools(
  actualTools: ToolCall[],
  forbiddenTools: string[],
): { found: boolean; tools?: string[] } {
  const toolNames = actualTools.map((t) => t.name);
  const found = forbiddenTools.filter((tool) => toolNames.includes(tool));

  if (found.length > 0) {
    return { found: true, tools: found };
  }

  return { found: false };
}

/**
 * Validate that required tools were called
 */
export function hasRequiredTools(
  actualTools: ToolCall[],
  requiredTools: string[],
): { hasAll: boolean; missing?: string[] } {
  const toolNames = actualTools.map((t) => t.name);
  const missing = requiredTools.filter((tool) => !toolNames.includes(tool));

  if (missing.length > 0) {
    return { hasAll: false, missing };
  }

  return { hasAll: true };
}

/**
 * Count occurrences of a specific tool
 */
export function countToolCalls(
  actualTools: ToolCall[],
  toolName: string,
): number {
  return actualTools.filter((t) => t.name === toolName).length;
}

/**
 * Check for destructive operations in trajectory
 */
export function hasDestructiveOperations(actualTools: ToolCall[]): {
  found: boolean;
  operations?: string[];
} {
  const destructivePatterns = [
    "delete_file",
    "delete_checklist",
    "rm",
    "rmdir",
  ];

  const destructiveTools = actualTools.filter((t) =>
    destructivePatterns.some((pattern) => t.name.includes(pattern)),
  );

  if (destructiveTools.length > 0) {
    return {
      found: true,
      operations: destructiveTools.map((t) => t.name),
    };
  }

  return { found: false };
}

/**
 * Validate bash command safety
 */
export function validateBashCommands(actualTools: ToolCall[]): {
  safe: boolean;
  dangerousCommands?: string[];
} {
  const dangerousPatterns = [
    /rm\s+-rf\s+\//, // rm -rf /
    />\s*\/dev\/sda/, // Writing to disk device
    /mkfs/, // Format filesystem
    /dd\s+if=/, // Disk operations
  ];

  const bashTools = actualTools.filter((t) => t.name === "execute_bash");
  const dangerous: string[] = [];

  for (const tool of bashTools) {
    const command = tool.args.command || "";

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        dangerous.push(command);
      }
    }
  }

  if (dangerous.length > 0) {
    return { safe: false, dangerousCommands: dangerous };
  }

  return { safe: true };
}

/**
 * Extract checklist operations from trajectory
 */
export function extractChecklistOperations(actualTools: ToolCall[]): {
  created: number;
  itemsChecked: number;
  itemsUnchecked: number;
  deleted: number;
} {
  return {
    created: countToolCalls(actualTools, "create_checklist"),
    itemsChecked: countToolCalls(actualTools, "check_item"),
    itemsUnchecked: countToolCalls(actualTools, "uncheck_item"),
    deleted: countToolCalls(actualTools, "delete_checklist"),
  };
}

/**
 * Validate file operation patterns
 */
export function validateFileOperations(actualTools: ToolCall[]): {
  valid: boolean;
  issues?: string[];
} {
  const issues: string[] = [];
  const writtenFiles = new Set<string>();

  for (const tool of actualTools) {
    if (tool.name === "write_file" || tool.name.includes("write")) {
      const filePath = tool.args.path || tool.args.file_path;

      if (filePath) {
        // Check for duplicate writes (possible overwrite)
        if (writtenFiles.has(filePath)) {
          issues.push(`File '${filePath}' written multiple times`);
        }
        writtenFiles.add(filePath);
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues: issues.length > 0 ? issues : undefined,
  };
}

/**
 * Extract tool sequence from agent state (simplified version)
 * Returns array of tool names called by the agent
 */
export function extractToolSequenceFromState(state: any): string[] {
  const tools: string[] = [];

  if (!state || !state.messages) {
    return tools;
  }

  for (const message of state.messages) {
    if (message && message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall && toolCall.name) {
          tools.push(toolCall.name);
        }
      }
    }
  }

  return tools;
}

/**
 * Check if a specific agent node was visited in the workflow
 * Useful for verifying planner or programmer agent execution
 */
export function wasAgentNodeVisited(state: any, nodeName: string): boolean {
  if (!state || !state.messages) {
    return false;
  }

  // Check message history for node-specific markers
  // Planner agents typically have 'documents' or 'generation' fields populated
  // Programmer agents populate 'filesCreated', 'filesModified'

  if (nodeName === "planner") {
    // Planner sets documents and generation
    return (
      (state.documents && state.documents.length > 0) ||
      (state.generation && state.generation.length > 0)
    );
  }

  if (nodeName === "programmer") {
    // Programmer populates files, filesCreated, filesModified
    return (
      (state.files && Object.keys(state.files).length > 0) ||
      (state.filesCreated && state.filesCreated.length > 0) ||
      (state.filesModified && state.filesModified.length > 0)
    );
  }

  // Generic check: look for tool calls in messages
  for (const message of state.messages) {
    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        // Check if this looks like a delegation to the agent
        if (tc.name === "task" && tc.args?.subagent_type === nodeName) {
          return true;
        }
      }
    }
  }

  return false;
}
