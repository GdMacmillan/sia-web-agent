/**
 * Sample tool call structures for testing
 *
 * Provides example tool call objects that match the structure
 * used by the agent's various tools.
 */

/**
 * Bash execution tool call
 */
export const bashToolCall = {
  name: "execute_bash",
  args: {
    command: "npm test",
  },
  id: "call_bash_001",
  type: "tool_call" as const,
};

/**
 * Code grep tool call
 */
export const grepToolCall = {
  name: "grep_code",
  args: {
    pattern: "function.*authenticate",
    filePattern: "*.ts",
  },
  id: "call_grep_001",
  type: "tool_call" as const,
};

/**
 * Create checklist tool call
 */
export const createChecklistToolCall = {
  name: "create_checklist",
  args: {
    requirements: [
      "Set up project structure",
      "Install dependencies",
      "Configure TypeScript",
      "Write initial tests",
    ],
  },
  id: "call_checklist_001",
  type: "tool_call" as const,
};

/**
 * Get checklist tool call
 */
export const getChecklistToolCall = {
  name: "get_checklist",
  args: {
    checklistId: "checklist_123",
  },
  id: "call_checklist_002",
  type: "tool_call" as const,
};

/**
 * Check item tool call
 */
export const checkItemToolCall = {
  name: "check_item",
  args: {
    checklistId: "checklist_123",
    itemIndex: 0,
  },
  id: "call_checklist_003",
  type: "tool_call" as const,
};

/**
 * Uncheck item tool call
 */
export const uncheckItemToolCall = {
  name: "uncheck_item",
  args: {
    checklistId: "checklist_123",
    itemIndex: 0,
  },
  id: "call_checklist_004",
  type: "tool_call" as const,
};

/**
 * Delete checklist tool call
 */
export const deleteChecklistToolCall = {
  name: "delete_checklist",
  args: {
    checklistId: "checklist_123",
  },
  id: "call_checklist_005",
  type: "tool_call" as const,
};

/**
 * MCP file read tool call (example)
 */
export const mcpReadFileToolCall = {
  name: "read_file",
  args: {
    path: "/path/to/file.ts",
  },
  id: "call_mcp_001",
  type: "tool_call" as const,
};

/**
 * MCP file write tool call (example)
 */
export const mcpWriteFileToolCall = {
  name: "write_file",
  args: {
    path: "/path/to/output.ts",
    content: "export const config = { /* ... */ };",
  },
  id: "call_mcp_002",
  type: "tool_call" as const,
};
