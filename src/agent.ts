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
  createMemoryAugmentationMiddleware,
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
import { mergeMiddlewareStack } from "./middleware/utils.js";
import { createToolExclusionMiddleware } from "./middleware/tool_exclusion.js";
import {
  resolveHarnessProfile,
  mergeHarnessProfile,
  REQUIRED_MIDDLEWARE_NAMES,
  type HarnessProfile,
} from "./profiles/index.js";
import { readReplaces } from "./components/replaces-tag.js";
import { COMPONENTS_MIDDLEWARE_NAME } from "./components/names.js";
import { logger } from "./utils/logger.js";
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
  /**
   * Custom system prompt for the agent. A string is placed before the base
   * agent prompt (legacy behavior). For more control — replacing/removing the
   * base prompt or appending a suffix — pass a {@link SystemPromptConfig}.
   */
  systemPrompt?: string | SystemPromptConfig;
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
  /**
   * Harness-profile overlays folded into the resolved profile at assembly,
   * in order. Component manifests supply these (`docs/COMPONENTS.md` §3).
   */
  profileOverlays?: HarnessProfile[];
}

/** The `subAgentMiddleware` name, as registered by `createSubAgentMiddleware`. */
const SUBAGENT_MIDDLEWARE_NAME = "subAgentMiddleware";

/**
 * Every middleware name `createDeepAgent` can register, across both the main
 * and the sub-agent stack and every feature gate. The component loader uses
 * it as a coarse pre-check of a manifest's `replaces`; the precise check —
 * against the stack actually assembled — happens in `createDeepAgent`.
 */
export const KNOWN_MIDDLEWARE_NAMES: ReadonlySet<string> = new Set([
  "autoContinueMiddleware",
  "capExhaustionMiddleware",
  "usageEventsMiddleware",
  "todoListMiddleware",
  "FilesystemMiddleware",
  "memoryAugmentationMiddleware",
  "skillsMiddleware",
  "CodeExecutionMiddleware",
  "CodeInterpreterMiddleware",
  SUBAGENT_MIDDLEWARE_NAME,
  "SummarizationMiddleware",
  "patchToolCallsMiddleware",
  "PromptCachingMiddleware",
  "knowledgeFormationMiddleware",
  "HumanInTheLoopMiddleware",
]);

/**
 * Structured system-prompt configuration.
 *
 * Ported (string-adapted) from upstream deepagents' `SystemPromptConfig`. Lets
 * a caller compose the final system prompt around the built-in base prompt
 * instead of only prepending to it. `prefix` goes before the base, `suffix`
 * after; `base` replaces the built-in base prompt (or `null` omits it).
 * Phase 5's harness profiles drive `base`/`suffix` through this.
 */
export interface SystemPromptConfig {
  /** Content placed before the base prompt. */
  prefix?: string | null;
  /**
   * Replacement for the base prompt. Omit to keep the built-in base prompt;
   * set to `null` to omit the base prompt entirely.
   */
  base?: string | null;
  /** Content placed after the base prompt. */
  suffix?: string | null;
}

const PROMPT_SEPARATOR = "\n\n";

/** Normalize a legacy string system prompt into the structured form. */
export function normalizeSystemPrompt(
  systemPrompt: string | SystemPromptConfig | undefined,
): SystemPromptConfig {
  if (systemPrompt === undefined) {
    return {};
  }
  if (typeof systemPrompt === "string") {
    return { prefix: systemPrompt };
  }
  return systemPrompt;
}

/** Join non-empty prompt parts with the standard separator. */
export function assemblePromptParts(
  parts: readonly (string | null | undefined)[],
): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(
    PROMPT_SEPARATOR,
  );
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
    profileOverlays = [],
  } = params;

  // Use MessagesAnnotation by default for proper message deduplication in multi-turn conversations
  // MessagesAnnotation uses a reducer that merges messages by ID, preventing duplicates when streaming
  const finalContextSchema =
    contextSchema ?? (MessagesAnnotation as unknown as ContextSchema);

  // Resolve the harness profile from the orchestrator model string, honoring
  // the HARNESS_PROFILE override (off | <name>). A profile shapes prompt suffix,
  // tool visibility/descriptions, and middleware composition — orthogonal to
  // model selection. Empty profile (no match / "off") is a no-op.
  const runtimeConfig = getConfig();
  const orchestratorModel = resolveModelEndpoint(
    runtimeConfig.llm,
    "orchestrator",
  ).model;
  // Component manifests may carry profile overlays; fold them in, in order.
  const harnessProfile = profileOverlays.reduce(
    (profile, overlay) => mergeHarnessProfile(profile, overlay),
    resolveHarnessProfile(
      orchestratorModel,
      runtimeConfig.runtime.harnessProfile,
    ),
  );

  // Compose the system prompt from prefix / base / suffix, then append the
  // profile's suffix. A plain string systemPrompt stays before the base prompt
  // (legacy behavior); a SystemPromptConfig can replace/remove the base.
  const basePrompt = await getBasePrompt();
  const promptConfig = normalizeSystemPrompt(systemPrompt);
  const baseSection =
    promptConfig.base === null
      ? ""
      : (promptConfig.base ?? harnessProfile.baseSystemPrompt ?? basePrompt);
  const finalSystemPrompt = assemblePromptParts([
    promptConfig.prefix,
    baseSection,
    promptConfig.suffix,
    harnessProfile.systemPromptSuffix,
  ]);

  // Create backend configuration for filesystem middleware
  // If no backend is provided, use the default FilesystemBackend with project root
  const filesystemBackend = backend ?? defaultBackendFactory;

  // Create filesystem tools once and share between filesystem middleware and
  // code execution. Profile tool-description overrides apply to the fs tools.
  const filesystemTools = createFilesystemTools(filesystemBackend, {
    customToolDescriptions: harnessProfile.toolDescriptionOverrides,
  });

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

  // Opt-in QuickJS `eval` code interpreter (parallel subagent fan-out +
  // programmatic tool calling). The default tsx `execute_code` tool stays on
  // regardless; this adds a second, sandboxed surface when enabled.
  //
  // Loaded via dynamic import ONLY when enabled: the interpreter pulls in
  // heavy ESM/WASM deps (QuickJS WASM, prettier via json-schema-to-typescript)
  // that eagerly run dynamic imports at module-eval time. Keeping it out of the
  // static graph means the default (disabled) path — including the whole test
  // suite — never loads them. Call the factory once per stack so main and
  // subagent agents get distinct sessions (matches upstream registration).
  const codeInterpreterEnabled = getConfig().features.codeInterpreter.enabled;
  const makeCodeInterpreterMiddleware = codeInterpreterEnabled
    ? (await import("./code-interpreter/index.js"))
        .createCodeInterpreterMiddleware
    : null;

  // Core segment, up to (not including) the sub-agent middleware.
  const coreBeforeSubagents: AgentMiddleware[] = [
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
    // Attach related graph-memory entries to search-type tool results
    createMemoryAugmentationMiddleware(),
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
    // Opt-in sandboxed `eval` interpreter — enables parallel subagent
    // fan-out via the in-REPL `task()` global (gated by ENABLE_CODE_INTERPRETER)
    ...(makeCodeInterpreterMiddleware
      ? [makeCodeInterpreterMiddleware()]
      : []),
  ];

  // Core segment after the sub-agent middleware.
  const coreAfterSubagents: AgentMiddleware[] = [
    // Automatically summarizes conversation history when token limits are approached
    summarizationMiddleware({
      model,
      trigger: { tokens: summarizationConfig.triggerTokens },
      keep: { messages: summarizationConfig.keepMessages },
    }),
    // Patches tool calls to ensure compatibility across different model providers
    createPatchToolCallsMiddleware(),
  ];

  // The sub-agent stack. Same shape as the main core minus delegation, with
  // its own caching entry kept last (upstream PR #331 ordering).
  const subagentCoreMiddleware: AgentMiddleware[] = [
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
    // Attach related graph-memory entries to search-type tool results
    createMemoryAugmentationMiddleware(),
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
    // Subagent middleware: opt-in sandboxed `eval` interpreter
    ...(makeCodeInterpreterMiddleware
      ? [makeCodeInterpreterMiddleware()]
      : []),
    // Subagent middleware: Automatic conversation summarization when token limits are approached
    summarizationMiddleware({
      model: summarizationModel,
      trigger: { tokens: summarizationConfig.triggerTokens },
      keep: { messages: summarizationConfig.keepMessages },
    }),
    // Subagent middleware: Patches tool calls for compatibility
    createPatchToolCallsMiddleware(),
    // Subagent middleware: Anthropic prompt caching — kept last to mirror
    // the main stack's caching-in-tail order (upstream PR #331).
    anthropicPromptCachingMiddleware({
      unsupportedModelBehavior: "ignore",
    }),
  ];

  // Tail segment. Order per upstream deepagents PR #331: prompt caching, then
  // knowledge formation, then human-in-the-loop. Caching is inert under
  // OpenRouter today (unsupportedModelBehavior: "ignore") — zero-risk
  // future-proofing that keeps the tail deterministic.
  const tailMiddleware: AgentMiddleware[] = [
    anthropicPromptCachingMiddleware({
      unsupportedModelBehavior: "ignore",
    }),
    createKnowledgeFormationMiddleware({
      model: model as any,
      agentType: name || "main",
    }),
    ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : []),
  ];

  // The names the main stack will actually carry. The sub-agent middleware
  // itself is constructed below, once its custom list is known.
  const mainNames = new Set(
    [...coreBeforeSubagents, ...coreAfterSubagents, ...tailMiddleware].map(
      (m) => m.name,
    ),
  ).add(SUBAGENT_MIDDLEWARE_NAME);

  // A component replacement is re-validated against the stack actually
  // assembled: a target that is absent here (a feature-gated middleware that
  // is off, say) would otherwise merge as an addition instead of a swap.
  const effectiveCustom = customMiddleware.filter((entry) => {
    const target = readReplaces(entry);
    if (target !== undefined && !mainNames.has(target)) {
      logger.warn(
        { middleware: entry.name, replaces: target },
        "custom middleware dropped: its replacement target is not in the assembled stack",
      );
      return false;
    }
    return true;
  });

  // Custom entries reach the sub-agent stack too, except those whose name
  // exists only in the main stack (delegation, knowledge formation, the tail)
  // and the components manifest refresher — `mergeMiddlewareStack` would
  // append those as novel entries the sub-agents never had.
  const subagentNames = new Set(subagentCoreMiddleware.map((m) => m.name));
  const mainOnlyNames = new Set(
    [...mainNames].filter((entryName) => !subagentNames.has(entryName)),
  );
  const subagentCustom = effectiveCustom.filter(
    (entry) =>
      !mainOnlyNames.has(entry.name) &&
      entry.name !== COMPONENTS_MIDDLEWARE_NAME,
  );

  // Enables delegation to specialized subagents for complex tasks
  const subAgentMiddleware = createSubAgentMiddleware({
    defaultModel: model,
    defaultTools: tools,
    defaultMiddleware: mergeMiddlewareStack(
      subagentCoreMiddleware,
      subagentCustom,
      [],
    ),
    defaultInterruptOn: interruptOn,
    subagents,
    generalPurposeAgent: true,
    // Profile override for the `task` tool description, when provided.
    taskDescription: harnessProfile.toolDescriptionOverrides.task,
  });

  // The CORE segment.
  const middleware: AgentMiddleware[] = [
    ...coreBeforeSubagents,
    subAgentMiddleware,
    ...coreAfterSubagents,
  ];

  // Merge custom middleware by name: same-name entries replace the matching
  // default/tail entry in place; novel entries insert between the core and tail
  // segments. This name-addressable stack is what the genome operators
  // (swap/toggle/add/remove) build on.
  let mergedMiddleware = mergeMiddlewareStack(
    middleware,
    effectiveCustom,
    tailMiddleware,
  );

  // Apply the harness profile's middleware exclusions, protecting required
  // scaffolding regardless of the profile (belt-and-suspenders — the profile
  // factory already rejects required names at construction time).
  if (harnessProfile.excludedMiddleware.size > 0) {
    mergedMiddleware = mergedMiddleware.filter(
      (m) =>
        REQUIRED_MIDDLEWARE_NAMES.has(m.name) ||
        !harnessProfile.excludedMiddleware.has(m.name),
    );
  }

  // Remove excluded tools after every tool-injecting middleware has run.
  if (harnessProfile.excludedTools.size > 0) {
    mergedMiddleware = [
      ...mergedMiddleware,
      createToolExclusionMiddleware(harnessProfile.excludedTools),
    ];
  }

  return createAgent({
    model,
    systemPrompt: finalSystemPrompt,
    tools,
    middleware: mergedMiddleware,
    responseFormat,
    contextSchema: finalContextSchema,
    checkpointer,
    store,
    name,
  }) as unknown as ReactAgent;
}
