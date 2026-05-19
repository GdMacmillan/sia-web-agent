/**
 * Tool Set Helpers
 *
 * Functions to assemble and filter tool sets for different agent types.
 * Works with tool instances to provide type-safe filtering based on tool names.
 */

import type { StructuredTool } from "@langchain/core/tools";

/**
 * Tool type identifiers for filtering
 */
const FILESYSTEM_TOOLS = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
];
const READ_ONLY_FILESYSTEM_TOOLS = ["ls", "read_file", "glob", "grep"];
const MEMORY_TOOLS = [
  "store_entity",
  "retrieve_entity",
  "search_entities",
  "list_entities",
  "update_entity_status",
  "update_entity",
  "traverse_graph",
];
const CHECKLIST_TOOLS = [
  "create_checklist",
  "get_checklist",
  "check_item",
  "uncheck_item",
  "set_dependencies",
  "get_ready_items",
  "delete_checklist",
];
const SEARCH_TOOLS = ["search"];
const WEB_SEARCH_TOOLS = ["web_search"];
const BASH_TOOLS = ["bash"];
const CODE_EXECUTION_TOOLS = ["execute_code"];

/**
 * Filter tools by name
 *
 * @param tools Tool instances to filter
 * @param toolNames Names of tools to keep
 * @returns Filtered tool array
 */
function filterToolsByName(
  tools: StructuredTool[],
  toolNames: string[],
): StructuredTool[] {
  const nameSet = new Set(toolNames);
  return tools.filter((tool) => nameSet.has(tool.name));
}

/**
 * Get tool set for manager/orchestrator agent
 *
 * Manager has full access to all tools for effective delegation:
 * - Search tools
 * - Memory tools
 * - Filesystem tools are provided via middleware
 * - Task tool is provided via middleware
 * - Todo tools are provided via middleware
 *
 * @param allTools All available tools
 * @returns Tool array for manager agent
 */
export function getManagerTools(allTools: StructuredTool[]): StructuredTool[] {
  // Manager gets: search, web search, memory, bash, code execution, checklist tools
  // Filesystem and task tools come from middleware
  const toolNames = [
    ...SEARCH_TOOLS,
    ...WEB_SEARCH_TOOLS,
    ...MEMORY_TOOLS,
    ...BASH_TOOLS,
    ...CODE_EXECUTION_TOOLS,
    ...CHECKLIST_TOOLS,
  ];
  return filterToolsByName(allTools, toolNames);
}

/**
 * Get tool set for planner agent
 *
 * Planner is read-only focused for systematic codebase exploration:
 * - Search tools (for pattern investigation)
 * - Memory tools (retrieve, discover, and traverse - read-only)
 *   - Includes traverse_graph for exploring relationship chains (IMPLEMENTS, DEPENDS_ON, SIMILAR_TO edges)
 * - Read-only filesystem tools are provided via middleware
 *
 * NOTE: Write operations are intentionally excluded at middleware level
 * by creating restricted filesystem middleware for planner
 *
 * @param allTools All available tools
 * @returns Tool array for planner agent
 */
export function getPlannerTools(allTools: StructuredTool[]): StructuredTool[] {
  // Planner gets: search, memory (read-only)
  const toolNames = [...SEARCH_TOOLS, ...MEMORY_TOOLS];
  return filterToolsByName(allTools, toolNames);
}

/**
 * Get tool set for memory agent
 *
 * Memory agent is completely isolated to knowledge management:
 * - Memory tools ONLY (store_entity, retrieve_entity, search_entities, list_entities, update_entity_status)
 *
 * No other tools:
 * - NO filesystem tools
 * - NO search tools
 * - NO task tool (no delegation)
 *
 * @param allTools All available tools
 * @returns Tool array for memory agent (memory tools only)
 */
export function getMemoryTools(allTools: StructuredTool[]): StructuredTool[] {
  return filterToolsByName(allTools, MEMORY_TOOLS);
}

/**
 * Get tool set for researcher agent
 *
 * Researcher is focused on evidence-based investigation and synthesis:
 * - Search tools (for codebase pattern discovery)
 * - Read-only filesystem tools (ls, read_file, glob, grep for exploration)
 * - Memory tools (retrieve and search only - for corroboration)
 *
 * Does NOT include:
 * - Write filesystem operations (read-only constraint)
 * - Memory write tools (store_entity, update_entity_status)
 * - Task tool (delegates via manager if deep exploration needed)
 *
 * NOTE: Memory tools filter for read-only access (retrieve_entity, search_entities, list_entities)
 * is intentionally loose here; filtering at middleware level or by instruction
 *
 * @param allTools All available tools
 * @returns Tool array for researcher agent
 */
export function getResearcherTools(
  allTools: StructuredTool[],
): StructuredTool[] {
  // Researcher gets: search, web search, read-only filesystem, memory (read-only), code execution
  // Read-only filesystem tools come from middleware (READ_ONLY_FILESYSTEM_TOOLS)
  // Memory tools accessed via retrieve/discover/list/analyze (instructions-based filtering)
  const toolNames = [
    ...SEARCH_TOOLS,
    ...WEB_SEARCH_TOOLS,
    ...READ_ONLY_FILESYSTEM_TOOLS,
    ...MEMORY_TOOLS,
    ...CODE_EXECUTION_TOOLS,
  ];
  return filterToolsByName(allTools, toolNames);
}

/**
 * Get tool set for answer agent
 *
 * Answer agent is specialized for deep web research:
 * - Web search tools (primary - search, extract, crawl)
 * - Search tools (for codebase context when needed)
 * - Read-only filesystem tools (for context)
 * - Memory tools (for storing/retrieving research findings)
 *
 * @param allTools All available tools
 * @returns Tool array for answer agent
 */
export function getAnswerTools(allTools: StructuredTool[]): StructuredTool[] {
  const toolNames = [
    ...WEB_SEARCH_TOOLS,
    ...SEARCH_TOOLS,
    ...READ_ONLY_FILESYSTEM_TOOLS,
    ...MEMORY_TOOLS,
  ];
  return filterToolsByName(allTools, toolNames);
}

/**
 * Get tools for a subagent by type
 *
 * Utility function to get the appropriate tool set based on agent name/type.
 * Supports both new names (plan, research) and legacy names (planner, researcher).
 *
 * @param agentName Name/type of the agent
 * @param allTools All available tools
 * @returns Tool array specific to that agent type
 */
export function getSubagentTools(
  agentName: string,
  allTools: StructuredTool[],
): StructuredTool[] {
  switch (agentName.toLowerCase()) {
    case "plan":
    case "planner": // backward compatibility
      return getPlannerTools(allTools);
    case "memory":
      return getMemoryTools(allTools);
    case "research":
    case "researcher": // backward compatibility
      return getResearcherTools(allTools);
    case "answer":
      return getAnswerTools(allTools);
    default:
      // Unknown agent type gets full tools (general-purpose)
      return allTools;
  }
}

/**
 * Check if a tool is read-only filesystem tool
 *
 * Useful for middleware configuration - planner should only have read-only filesystem
 *
 * @param toolName Name of the tool
 * @returns True if tool is read-only filesystem operation
 */
export function isReadOnlyFilesystemTool(toolName: string): boolean {
  return READ_ONLY_FILESYSTEM_TOOLS.includes(toolName);
}

/**
 * Check if a tool is a write filesystem tool
 *
 * @param toolName Name of the tool
 * @returns True if tool is a write filesystem operation
 */
export function isWriteFilesystemTool(toolName: string): boolean {
  const writeTools = FILESYSTEM_TOOLS.filter(
    (t) => !READ_ONLY_FILESYSTEM_TOOLS.includes(t),
  );
  return writeTools.includes(toolName);
}
