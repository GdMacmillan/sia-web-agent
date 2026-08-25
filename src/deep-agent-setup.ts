/**
 * Deep Agent Setup & Factory
 *
 * Provides reusable configuration and factory functions for creating
 * DeepAgent instances with standard tooling, models, and middleware.
 *
 * Used by:
 * - Integration tests
 * - Web UI for conversational chat interface
 */

import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { StructuredTool } from "@langchain/core/tools";
import type { ReactAgent } from "langchain";
import type { AnnotationRoot } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";

import { createDeepAgent, type CreateDeepAgentParams } from "./agent.js";
import { createChatModel } from "./config/model-config.js";
import { getConfig, resolveModelEndpoint } from "./config/index.js";
import {
  createSearchTool,
  createBashTool,
  createWebSearchTool,
  storeEntityTool,
  retrieveEntityTool,
  searchEntitiesTool,
  listEntitiesTool,
  updateEntityStatusTool,
  updateEntityTool,
  promoteEntitiesTool,
  traverseGraphTool,
  createChecklistTools,
} from "./tools/index.js";
import { isConfigured as isWebSearchConfigured } from "./web-search/tavily-client.js";
import { getProjectRoot } from "./backend-config.js";
import {
  getPlanSubAgent,
  getResearchSubAgent,
  getAnswerSubAgent,
} from "./sub-agents.js";
import type { InteropZodObject } from "@langchain/core/utils/types";

/**
 * Configuration for creating a standard Deep Agent
 */
export interface DeepAgentConfig<
  ContextSchema extends AnnotationRoot<any> | InteropZodObject =
    AnnotationRoot<any>,
> {
  /** Override the model (defaults to active LLM provider's model) */
  model?: BaseLanguageModel;

  /** Override custom tools (defaults to search + context tools) */
  tools?: StructuredTool[];

  /** Override the project root (defaults to getProjectRoot()) */
  projectRoot?: string;

  /** Custom system prompt to prepend to manager prompt */
  systemPrompt?: string;

  /** Additional configuration for createDeepAgent */
  agentConfig?: Partial<CreateDeepAgentParams<ContextSchema>>;
}

/**
 * Create standard tools for the agent: search, codebase context, and memory tools
 *
 * Available tools:
 * - search: Search the codebase
 * - web_search: Search the web, extract content from URLs, or crawl websites.
 *   Present ONLY when TAVILY_API_KEY is configured; omitted entirely otherwise.
 * - store_entity: Store any type of entity in memory (ideas, notes, learnings, tasks, etc.)
 * - retrieve_entity: Get full details of a specific entity by ID
 * - search_entities: Find entities using natural language semantic search
 * - list_entities: List all entities with optional filtering
 * - update_entity_status: Update entity status and track lifecycle
 * - create_checklist: Create a dependency-aware checklist from requirements
 * - get_checklist: Retrieve checklist state with computed statuses
 * - check_item: Mark a checklist item as completed (enforces dependency blocking)
 * - uncheck_item: Mark a checklist item as incomplete (warns about downstream impacts)
 * - set_dependencies: Set or update dependencies for a checklist item
 * - get_ready_items: Get all items ready to work on (not blocked or completed)
 * - delete_checklist: Delete a checklist
 *
 * NOTE: Memory tools require the Graph-Memory API to be running:
 * - yarn graph-db:compile (build Go backend)
 * - yarn graph-db:start (start API server on :8080)
 */
export function createStandardTools(projectRoot: string): StructuredTool[] {
  return [
    createSearchTool(projectRoot),
    createBashTool(projectRoot),
    // `web_search` is registered ONLY when a Tavily API key is configured.
    // Without one, every call it can make fails, so advertising it in the
    // schema just invites the model to spend a turn discovering that.
    // Withholding it is the honest signal, and `getSystemPrompt()` appends
    // a matching capability notice so the prompts don't plan around a tool
    // that isn't there.
    //
    // This is the single choke point: `filterToolsByName` in
    // `tools/tool-sets.ts` drops names missing from its source array, so
    // the sub-agent tool sets cascade from here automatically.
    ...(isWebSearchConfigured() ? [createWebSearchTool()] : []),
    // Generic entity management tools for long-term knowledge storage
    storeEntityTool,
    retrieveEntityTool,
    searchEntitiesTool,
    listEntitiesTool,
    updateEntityStatusTool,
    updateEntityTool,
    promoteEntitiesTool,
    traverseGraphTool,
    // Dependency-aware checklist tools for workflow coordination
    ...createChecklistTools(),
  ];
}

/**
 * Create the LLM model using the active provider configuration
 */
export async function createStandardModel(): Promise<BaseLanguageModel> {
  const endpoint = resolveModelEndpoint(getConfig().llm, "orchestrator");
  return createChatModel(endpoint.model, endpoint.apiKey, endpoint.baseUrl);
}

/**
 * Factory for creating a fully configured DeepAgent
 *
 * Creates a complete deep agent with:
 * - LLM model from active provider (configurable via LLM_PROVIDER)
 * - Standard tools (search + codebase context)
 * - Filesystem middleware (write_file, read_file, etc.)
 * - Todo list middleware
 * - Sub-agent delegation capability (planner, researcher)
 * - Summarization and prompt caching
 *
 * @param config Optional configuration overrides
 * @returns Configured ReactAgent ready for use
 *
 * @example
 * ```typescript * // Basic usage with defaults * const agent = await createDeepAgentWithDefaults(); *
await agent.invoke({ messages: [new HumanMessage("Search for middleware patterns")] }); * * //
Custom configuration * const agent = await createDeepAgentWithDefaults({ * systemPrompt: "You are a
helpful assistant focused on testing.", * projectRoot: "/custom/path" * }); *```
 */
export async function createDeepAgentWithDefaults<
  ContextSchema extends AnnotationRoot<any> | InteropZodObject =
    AnnotationRoot<any>,
>(config?: DeepAgentConfig<ContextSchema>): Promise<ReactAgent> {
  // Resolve configuration with defaults
  const projectRoot = config?.projectRoot ?? getProjectRoot();
  const model = config?.model ?? (await createStandardModel());
  const tools = config?.tools ?? createStandardTools(projectRoot);

  // Load sub-agents for delegation
  const planSubAgent = await getPlanSubAgent();
  const researchSubAgent = await getResearchSubAgent();
  const answerSubAgent = await getAnswerSubAgent();

  // Create checkpointer for persisting conversation state between requests
  const checkpointer = new MemorySaver();

  // Create the agent with resolved configuration
  return createDeepAgent<ContextSchema>({
    model,
    tools,
    systemPrompt: config?.systemPrompt,
    subagents: [planSubAgent, researchSubAgent, answerSubAgent],
    checkpointer,
    projectRoot,
    ...config?.agentConfig,
  });
}

/**
 * Advanced factory for manual control over agent creation
 *
 * Useful when you need to:
 * - Create components separately for testing
 * - Customize model creation
 * - Inject different tools
 * - Build agent with custom middleware
 */
export interface DeepAgentComponents {
  model: BaseLanguageModel;
  tools: StructuredTool[];
  projectRoot: string;
}

/**
 * Create agent components separately
 *
 * Allows granular control over model creation, tool setup, and configuration.
 *
 * @example
 * ```typescript * // Create components with custom configuration * const components = await
createDeepAgentComponents({ * projectRoot: "/my/project" * }); * * // Inspect or modify components
before creating agent * console.log("Tools available:", components.tools.map(t => t.name)); * * //
Create agent with components * const agent = createDeepAgent({ * model: components.model, * tools:
components.tools, * }); *```
 */
export async function createDeepAgentComponents(
  config?: Omit<DeepAgentConfig, "agentConfig">,
): Promise<DeepAgentComponents> {
  const projectRoot = config?.projectRoot ?? getProjectRoot();
  const model = config?.model ?? (await createStandardModel());
  const tools = config?.tools ?? createStandardTools(projectRoot);

  return {
    model,
    tools,
    projectRoot,
  };
}
