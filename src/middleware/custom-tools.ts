/**
 * Middleware for custom tools like search
 *
 * Wraps custom tools with logging and makes them available to the agent.
 * Adds custom tools to the agent's tool set so the LLM model can invoke them.
 */

import { createMiddleware } from "langchain";
import type { StructuredTool } from "@langchain/core/tools";

/**
 * Create middleware that provides custom tools to the agent.
 * Exposes tools to the agent with logging to confirm invocation.
 */
export function createCustomToolsMiddleware(customTools: StructuredTool[]) {
  return createMiddleware({
    name: "CustomToolsMiddleware",
    tools: customTools,
    wrapToolCall: async (params: any, toolCall: any) => {
      const result = await params(toolCall);
      return result;
    },
  });
}
