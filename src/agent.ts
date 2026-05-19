/**
 * Multi-Agent System Implementation
 *
 * Based on DeepAgents pattern from langchain package.
 * Creates a main orchestrator agent with task tool for delegating to sub-agents.
 */

import {
  createAgent,
  humanInTheLoopMiddleware,
  anthropicPromptCachingMiddleware,
  todoListMiddleware,
  summarizationMiddleware,
  type AgentMiddleware,
  type ReactAgent,
  type InterruptOnConfig,
} from "langchain";
import type { StructuredTool } from "@langchain/core/tools";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import { MessagesAnnotation } from "@langchain/langgraph";

import {
  createFilesystemMiddleware,
  createFilesystemTools,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createSkillsMiddleware,
  createKnowledgeFormationMiddleware,
  createCodeExecutionMiddleware,
  createAutoContinueMiddleware,
  createUsageEventsMiddleware,
  createCapExhaustionMiddleware,
  type SubAgent,
  type CompiledSubAgent,
} from "./middleware/index.js";
import type { BackendProtocol } from "./backends/index.js";
import { InteropZodObject } from "@langchain/core/utils/types";
import { AnnotationRoot } from "@langchain/langgraph";
import { getSystemPrompt } from "./system-prompts.js";
import { defaultBackendFactory } from "./backend-config.js";
import { getConfig, resolveModelEndpoint } from "./config/index.js";

/**
 * Configuration parameters for creating a Deep Agent
 * Matches Deepagentsjs's CreateDeepAgentParams parameters
 */
export interface CreateDeepAgentParams<
  ContextSchema extends AnnotationRoot<any> | InteropZodObject =
    AnnotationRoot<any>,
> {
  /** The model to use (must be a BaseLanguageModel instance, e.g., ChatOpenAI). Use createOpenRouterModel() to instantiate. */
  model: BaseLanguageModel;
  /** Tools the agent should have access to */
  tools?: StructuredTool[];
  /** Custom system prompt for the agent. This will be combined with the base agent prompt */
  systemPrompt?: string;
  /** Custom middleware to apply after standard middleware */
  middleware?: AgentMiddleware[];
  /** List of subagent specifications for task delegation */
  subagents?: (SubAgent | CompiledSubAgent)[];
  /** Structured output response format for the agent */
  responseFormat?: any; // ResponseFormat type is complex, using any for now
  /**
   * Optional schema for agent state (not persisted between invocations).
   * Defaults to MessagesAnnotation which properly deduplicates messages by ID.
   * This ensures multi-turn conversations stream correctly without duplicate messages
   * when using modes like ['values', 'updates'].
   * Only override if you need a custom state schema.
   */
  contextSchema?: ContextSchema;
  /** Optional checkpointer for persisting agent state between runs */
  checkpointer?: BaseCheckpointSaver | boolean;
  /** Optional store for persisting longterm memories */
  store?: BaseStore;
  /**
   * Optional backend for filesystem operations.
   * Can be either a backend instance or a factory function that creates one.
   * The factory receives a config object with state and store.
   *
   * Default: FilesystemBackend with the project root as root directory.
   * The agent can read and modify files within the project.
   * Virtual mode is enabled to prevent directory traversal.
   */
  backend?:
    | BackendProtocol
    | ((config: { state: unknown; store?: BaseStore }) => BackendProtocol);
  /** Optional interrupt configuration mapping tool names to interrupt configs */
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
  /** The name of the agent */
  name?: string;
  /** Optional project root directory for skills loading */
  projectRoot?: string;
}

/**
 * Base prompt cache - lazily loaded on first use
 */
let basePromptPromise: Promise<string> | null = null;

async function getBasePrompt(): Promise<string> {
  if (!basePromptPromise) {
    basePromptPromise = getSystemPrompt("manager");
  }
  return basePromptPromise;
}

/**
 * Get summarization configuration from environment variables
 */
function getSummarizationConfig() {
  const config = getConfig();
  return {
    triggerTokens: config.middleware.summarization.triggerTokens,
    keepMessages: config.middleware.summarization.keepMessages,
  };
}

/**
 * Create a Deep Agent with middleware-based architecture.
 *
 * Matches Deepagentsjs's createDeepAgent function, using middleware for all features:
 * - Todo management (todoListMiddleware)
 * - Filesystem tools (createFilesystemMiddleware)
 * - Subagent delegation (createSubAgentMiddleware)
 * - Conversation summarization (summarizationMiddleware)
 * - Prompt caching (anthropicPromptCachingMiddleware)
 * - Tool call patching (createPatchToolCallsMiddleware)
 * - Human-in-the-loop (humanInTheLoopMiddleware) - optional
 *
 * @param params Configuration parameters for the agent. The `model` field is required and must be a BaseLanguageModel instance.
 *               Create it with `createOpenRouterModel()` or another LangChain chat model factory.
 * @returns ReactAgent instance ready for invocation
 */
export async function createDeepAgent<
  ContextSchema extends AnnotationRoot<any> | InteropZodObject =
    AnnotationRoot<any>,
>(params: CreateDeepAgentParams<ContextSchema>): Promise<ReactAgent> {
  const {
    model,
    tools = [],
    systemPrompt,
    middleware: customMiddleware = [],
    subagents = [],
    responseFormat,
    contextSchema,
    checkpointer,
    store,
    backend,
    interruptOn,
    name,
    projectRoot,
  } = params;

  // Use MessagesAnnotation by default for proper message deduplication in multi-turn conversations
  // MessagesAnnotation uses a reducer that merges messages by ID, preventing duplicates when streaming
  const finalContextSchema =
    contextSchema ?? (MessagesAnnotation as unknown as ContextSchema);

  // Combine system prompt with base prompt like Python implementation
  const basePrompt = await getBasePrompt();
  const finalSystemPrompt = systemPrompt
    ? `${systemPrompt}\n\n${basePrompt}`
    : basePrompt;

  // Create backend configuration for filesystem middleware
  // If no backend is provided, use the default FilesystemBackend with project root
  const filesystemBackend = backend ?? defaultBackendFactory;

  // Create filesystem tools once and share between filesystem middleware and code execution
  const filesystemTools = createFilesystemTools(filesystemBackend);

  // Get summarization configuration from environment
  const summarizationConfig = getSummarizationConfig();

  // Create a small/fast model for summarization — it's a lightweight compression
  // task that doesn't need the main agent's reasoning capabilities.
  const llmConfig = getConfig().llm;
  const smallFastEndpoint = resolveModelEndpoint(llmConfig, "memory");
  let summarizationModel: BaseLanguageModel;
  if (llmConfig.provider === "openrouter") {
    const { ChatOpenRouter } = await import("@langchain/openrouter");
    summarizationModel = new ChatOpenRouter({
      apiKey: smallFastEndpoint.apiKey,
      model: smallFastEndpoint.model,
      baseURL: smallFastEndpoint.baseUrl,
    }) as unknown as BaseLanguageModel;
  } else {
    const { ChatOpenAI } = await import("@langchain/openai");
    summarizationModel = new ChatOpenAI({
      apiKey: smallFastEndpoint.apiKey,
      model: smallFastEndpoint.model,
      configuration: { baseURL: smallFastEndpoint.baseUrl },
    });
  }

  // Surface OR's 429 + key_limit as a `cap_exhausted` SSE event so the web
  // UI can render the global banner. Re-throws the original error so retry /
  // abort paths still see it.
  const capExhaustionMiddleware = createCapExhaustionMiddleware();

  // Create auto-continue middleware (shared between main agent and sub-agents)
  // Retries transient LLM errors with exponential backoff before cost tracking sees them
  const autoContinueMiddleware = createAutoContinueMiddleware();

  // Emit raw token-usage events to siad for host-side cost computation (AGI-268)
  const usageEventsMiddleware = createUsageEventsMiddleware();

  const middleware: AgentMiddleware[] = [
    // Retry transient LLM errors (first so retries are invisible to cost tracking)
    autoContinueMiddleware,
    // Detect OR cap exhaustion (429+key_limit) and dispatch cap_exhausted
    capExhaustionMiddleware,
    // Emit raw token-usage events to siad for host-side cost computation (AGI-268)
    usageEventsMiddleware,
    // Provides todo list management capabilities for tracking tasks
    todoListMiddleware(),
    // Enables filesystem operations and optional long-term memory storage
    createFilesystemMiddleware({
      backend: filesystemBackend,
      tools: filesystemTools,
    }),
    // Loads skills from /skills directory and injects summaries into system prompt
    ...(projectRoot
      ? [
          createSkillsMiddleware({
            skillsDir: `${projectRoot}/skills`,
          }),
        ]
      : []),
    // Enables code execution with tool API access for efficient data processing
    ...(projectRoot
      ? [
          createCodeExecutionMiddleware({
            projectRoot,
            tools: [...tools, ...filesystemTools],
            maxExecutionTime: 120000,
          }),
        ]
      : []),
    // Enables delegation to specialized subagents for complex tasks
    createSubAgentMiddleware({
      defaultModel: model,
      defaultTools: tools,
      defaultMiddleware: [
        // Subagent middleware: Retry transient LLM errors before cost tracking
        autoContinueMiddleware,
        // Subagent middleware: Detect OR cap exhaustion
        capExhaustionMiddleware,
        // Subagent middleware: Emit raw token-usage events to siad (AGI-268)
        usageEventsMiddleware,
        // Subagent middleware: Todo list management
        todoListMiddleware(),
        // Subagent middleware: Filesystem operations
        createFilesystemMiddleware({
          backend: filesystemBackend,
          tools: filesystemTools,
        }),
        // Subagent middleware: Skills system for sub-agents (allows reading skill files)
        ...(projectRoot
          ? [
              createSkillsMiddleware({
                skillsDir: `${projectRoot}/skills`,
              }),
            ]
          : []),
        // Subagent middleware: Code execution with tool API access
        ...(projectRoot
          ? [
              createCodeExecutionMiddleware({
                projectRoot,
                tools: [...tools, ...filesystemTools],
                maxExecutionTime: 120000,
              }),
            ]
          : []),
        // Subagent middleware: Automatic conversation summarization when token limits are approached
        summarizationMiddleware({
          model: summarizationModel,
          trigger: { tokens: summarizationConfig.triggerTokens },
          keep: { messages: summarizationConfig.keepMessages },
        }),
        // Subagent middleware: Anthropic prompt caching for improved performance
        anthropicPromptCachingMiddleware({
          unsupportedModelBehavior: "ignore",
        }),
        // Subagent middleware: Patches tool calls for compatibility
        createPatchToolCallsMiddleware(),
      ],
      defaultInterruptOn: interruptOn,
      subagents,
      generalPurposeAgent: true,
    }),
    // Automatically summarizes conversation history when token limits are approached
    summarizationMiddleware({
      model,
      trigger: { tokens: summarizationConfig.triggerTokens },
      keep: { messages: summarizationConfig.keepMessages },
    }),
    // Enables Anthropic prompt caching for improved performance and reduced costs
    anthropicPromptCachingMiddleware({
      unsupportedModelBehavior: "ignore",
    }),
    // Patches tool calls to ensure compatibility across different model providers
    createPatchToolCallsMiddleware(),
    // Automatically extracts and stores learnings from task completions
    createKnowledgeFormationMiddleware({
      model: model as any,
      agentType: name || "main",
    }),
  ];

  // Add human-in-the-loop middleware if interrupt config provided
  if (interruptOn) {
    middleware.push(humanInTheLoopMiddleware({ interruptOn }));
  }

  // Add custom middleware last (after all built-in middleware)
  middleware.push(...customMiddleware);

  return createAgent({
    model,
    systemPrompt: finalSystemPrompt,
    tools,
    middleware,
    responseFormat,
    contextSchema: finalContextSchema,
    checkpointer,
    store,
    name,
  }) as unknown as ReactAgent;
}
