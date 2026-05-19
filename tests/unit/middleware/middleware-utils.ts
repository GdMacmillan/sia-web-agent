/**
 * Middleware Testing Utilities
 *
 * Provides helpers and mock tools for testing middleware functionality
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Mock tools for middleware testing
 */

export const mockWeatherTool = new DynamicStructuredTool({
  name: "get_weather",
  description: "Get the weather for a location",
  schema: z.object({
    location: z.string().describe("City or location name"),
  }),
  func: async ({ location }) => {
    return `The weather in ${location} is sunny, 72°F`;
  },
});

export const mockSearchTool = new DynamicStructuredTool({
  name: "search",
  description: "Search for information",
  schema: z.object({
    query: z.string().describe("Search query"),
  }),
  func: async ({ query }) => {
    return `Search results for "${query}": Found 42 results`;
  },
});

export const mockDatabaseTool = new DynamicStructuredTool({
  name: "query_database",
  description: "Query a database",
  schema: z.object({
    sql: z.string().describe("SQL query"),
  }),
  func: async ({ sql }) => {
    return `Query result: ${sql.substring(0, 50)}...`;
  },
});

/**
 * Extract tools from agent graph for assertion
 *
 * This helper inspects the compiled agent graph to find tools
 * that were added by middleware or directly provided.
 *
 * @param agent The compiled agent to inspect
 * @returns Array of tool names found in the agent
 */
export function extractToolsFromAgent(agent: any): string[] {
  // Try various paths where tools might be stored in the agent graph
  const tools =
    agent?.graph?.nodes?.tools?.bound?.tools || // LangGraph compiled format
    agent?.graph?.nodes?.tools?.tools || // Alternative path
    agent?.tools || // Direct property
    [];

  if (Array.isArray(tools)) {
    return tools.map((t: any) => t?.name || String(t)).filter(Boolean);
  }

  return [];
}

/**
 * Assert that middleware added expected tools to agent
 *
 * @param agent The compiled agent to check
 * @param expectedToolNames Tools that should be present
 * @throws Error if expected tools are missing
 */
export function assertMiddlewareTools(
  agent: any,
  expectedToolNames: string[],
): void {
  const toolNames = extractToolsFromAgent(agent);

  for (const expectedTool of expectedToolNames) {
    if (!toolNames.includes(expectedTool)) {
      throw new Error(
        `Expected tool '${expectedTool}' not found in agent. Found: ${toolNames.join(", ")}`,
      );
    }
  }
}

/**
 * Assert that middleware added required channels to agent state schema
 *
 * @param agent The compiled agent to check
 * @param expectedChannels State channels that should be present
 * @throws Error if expected channels are missing
 */
export function assertMiddlewareChannels(
  agent: any,
  expectedChannels: string[],
): void {
  const channels = Object.keys(agent?.graph?.channels || {});

  for (const expectedChannel of expectedChannels) {
    if (!channels.includes(expectedChannel)) {
      throw new Error(
        `Expected channel '${expectedChannel}' not found in agent state. Found: ${channels.join(", ")}`,
      );
    }
  }
}

/**
 * Get all channels from agent state schema
 *
 * @param agent The compiled agent to inspect
 * @returns Array of channel names
 */
export function getAgentChannels(agent: any): string[] {
  return Object.keys(agent?.graph?.channels || {});
}

/**
 * Mock Middleware Factories
 */

/**
 * Create a simple middleware with tools for testing
 * This helps test middleware composition patterns
 */
export function createMockMiddleware(tools: DynamicStructuredTool[] = []) {
  return {
    name: "MockMiddleware",
    tools: tools.length > 0 ? tools : [mockWeatherTool],
  };
}

/**
 * Create a middleware with custom channels for testing state management
 */
export function createMockMiddlewareWithChannels(
  channels: Record<string, any>,
) {
  return {
    name: "MockChannelMiddleware",
    channels: channels,
  };
}

/**
 * Test fixtures for tool schemas
 */

export const validToolSchemas = {
  simpleString: z.object({
    input: z.string().describe("Simple string input"),
  }),

  withOptional: z.object({
    required: z.string().describe("Required field"),
    optional: z.string().optional().describe("Optional field"),
  }),

  complex: z.object({
    name: z.string().describe("Name"),
    age: z.number().describe("Age"),
    tags: z.array(z.string()).describe("Tags"),
  }),
};

/**
 * Utility to create a mock tool with custom schema
 */
export function createMockTool(
  name: string,
  schema: z.ZodSchema = validToolSchemas.simpleString,
  description = `Mock tool: ${name}`,
) {
  return new DynamicStructuredTool({
    name,
    description,
    schema,
    func: async (input: any) => {
      return `${name} executed with input: ${JSON.stringify(input)}`;
    },
  });
}

/**
 * Verify tool has valid schema and properties
 */
export function validateTool(tool: any): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!tool) {
    errors.push("Tool is null or undefined");
  }

  if (!tool?.name) {
    errors.push("Tool missing required 'name' property");
  }

  if (!tool?.description) {
    errors.push("Tool missing required 'description' property");
  }

  if (!tool?.schema) {
    errors.push("Tool missing required 'schema' property");
  }

  if (!tool?.func) {
    errors.push("Tool missing required 'func' (function) property");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Constants for testing
 */

export const SAMPLE_MODEL = "gpt-4o-mini";

export const STANDARD_MIDDLEWARE_TOOLS = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
];

export const STANDARD_MIDDLEWARE_CHANNELS = ["files", "todos"];
