/**
 * SubAgent Graph Factory
 *
 * Abstracts subagent graph creation using ReAct pattern.
 * This enables consistent graph implementations across all sub-agents.
 *
 * All sub-agents use the ReAct pattern (Reasoning, Acting, Observing) via createAgent.
 */

import type { StructuredTool } from "@langchain/core/tools";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { AgentMiddleware, ReactAgent } from "langchain";
import type { InterruptOnConfig } from "langchain";
import { createAgent } from "langchain";

/**
 * Interface that all subagent graphs must implement.
 * This is the contract for any graph type.
 */
export interface SubAgentGraph {
  name: string;
  invoke(state: any, config?: any): Promise<any>;
  stream(state: any, config?: any): any; // Stream return type varies by implementation
}

/**
 * Configuration for creating a subagent graph.
 * Defines everything needed to create a subagent.
 */
export interface SubAgentGraphConfig {
  // Identity
  name: string;
  description: string;

  // Capabilities
  tools: StructuredTool[];
  model: LanguageModelLike | string;
  systemPrompt: string;

  // Behavior
  middleware?: AgentMiddleware[];
  interruptOn?: Record<string, boolean | InterruptOnConfig>;

  // Graph-specific configuration options
  graphOptions?: Record<string, any>;
}

/**
 * Factory function: Create a subagent graph using ReAct pattern.
 *
 * Creates a ReAct agent using LangChain's createAgent function.
 * This is the standard agentic loop: Reasoning, Acting, Observing.
 *
 * @param config Configuration for the subagent graph
 * @returns SubAgentGraph instance ready for invocation
 *
 * @example
 * ```typescript * const researchGraph = await createSubAgentGraph({ * name: "research", * tools:
researchTools, * systemPrompt: "...", * model: modelInstance, * }); * * const result = await
researchGraph.invoke(state, config); *```
 */
export async function createSubAgentGraph(
  config: SubAgentGraphConfig,
): Promise<SubAgentGraph> {
  const agent = createAgent({
    model: config.model,
    tools: config.tools,
    systemPrompt: config.systemPrompt,
    middleware: config.middleware ?? [],
  }) as ReactAgent;

  return {
    name: config.name,
    invoke: (state, runtimeConfig) => agent.invoke(state, runtimeConfig),
    stream: (state, runtimeConfig) => agent.stream(state, runtimeConfig),
  };
}

/**
 * Type guard to check if something is a SubAgentGraph
 */
export function isSubAgentGraph(value: any): value is SubAgentGraph {
  return (
    value &&
    typeof value.name === "string" &&
    typeof value.invoke === "function" &&
    typeof value.stream === "function"
  );
}
