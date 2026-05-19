/**
 * Agent Tool Configuration
 *
 * Defines explicit tool sets for each agent type.
 * Centralizes tool assignments so they're auditable and maintainable.
 *
 * Tool Sets:
 * - Manager: Full tools for orchestration and delegation
 * - Planner: Read-only filesystem tools for systematic exploration
 * - Memory: Knowledge management tools only
 */

import type { StructuredTool } from "@langchain/core/tools";

/**
 * Get tool set for the manager/orchestrator agent.
 *
 * Manager has full tool access to delegate effectively:
 * - Filesystem tools (via middleware)
 * - Search tool
 * - Memory tools (via middleware)
 * - Task tool (via middleware)
 * - Todo tools (via middleware)
 *
 * Note: Tools provided via middleware are not filtered at this level.
 * This function documents what the manager can access.
 *
 * @param filesystemTools Array of filesystem tools from middleware
 * @param searchTool Search tool for codebase investigation
 * @returns Tool array for manager agent
 */
export function getManagerToolSet(
  filesystemTools: StructuredTool[],
  searchTool: StructuredTool,
): StructuredTool[] {
  // Manager gets full tool set for delegation decisions
  // Actual tools are provided by middleware, but documented here
  return [
    ...filesystemTools, // ls, read_file, write_file, edit_file, glob, grep
    searchTool, // search tool
    // Task tool added by createSubAgentMiddleware
    // Memory tools added by middleware
    // Todo tools from todoListMiddleware
  ];
}

/**
 * Get tool set for the planner agent.
 *
 * Planner is read-only focused, designed for systematic exploration:
 * - Read-only filesystem tools (ls, read_file, glob, grep)
 * - Search tool (for investigation)
 * - Memory tools (retrieve, discover - read-only)
 * - Todo tools (write_todos for planning)
 *
 * Intentionally excludes:
 * - write_file, edit_file (prevents accidental modifications)
 * - task tool (no further delegation)
 *
 * This restriction forces the planner to explore systematically
 * without modifying files during analysis phase.
 *
 * @param filesystemTools Array of filesystem tools from middleware
 * @param searchTool Search tool for codebase investigation
 * @returns Filtered tool array for planner agent
 */
export function getPlannerToolSet(
  filesystemTools: StructuredTool[],
  searchTool: StructuredTool,
): StructuredTool[] {
  // Filter filesystem tools to read-only operations
  const readOnlyFilesystemTools = filesystemTools.filter((tool) => {
    const readOnlyTools = ["ls", "read_file", "glob", "grep"];
    return readOnlyTools.includes(tool.name);
  });

  return [
    ...readOnlyFilesystemTools, // Only read operations
    searchTool, // Search for investigation
    // write_todos from todoListMiddleware
    // Memory tools (retrieve, discover - read-only)
    // NO task tool - no further delegation
    // NO write_file/edit_file - read-only constraint
  ];
}

/**
 * Document the tool mapping for the manager's understanding.
 *
 * This is used in system prompts and task tool descriptions
 * to help the manager understand which agents have which tools.
 *
 * @returns String describing agent-to-tool mapping
 */
export function getAgentToolMapping(): string {
  return `
## Available Agents and Their Tools

### planner
- Read-only filesystem tools (ls, read_file, glob, grep)
- Search tool
- Memory retrieval and discovery (read-only)
- Purpose: Analyze codebase and create implementation plans
- Constraint: Read-only (cannot modify files)`;
}
