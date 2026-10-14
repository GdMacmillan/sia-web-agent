import { z } from "zod/v3";
import {
  createMiddleware,
  AgentMiddleware,
  tool,
  ToolMessage,
  humanInTheLoopMiddleware,
  type InterruptOnConfig,
  StructuredTool,
  createAgent,
  type ReactAgent,
} from "langchain";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { getSubagentTools } from "../tools/tool-sets.js";
import { type TaskInput } from "../schemas/index.js";

export type { AgentMiddleware };

// Constants
const DEFAULT_SUBAGENT_PROMPT =
  "In order to complete the objective that the user asks of you, you have access to a number of standard tools.";

// State keys that should be excluded when passing state to subagents
const EXCLUDED_STATE_KEYS = ["messages", "todos", "jumpTo"] as const;

const DEFAULT_GENERAL_PURPOSE_DESCRIPTION =
  "Has every tool the main agent has. Use it to isolate heavy multi-step work (broad searches, long analyses, independent investigations) so only the result comes back to this thread.";

// Task tool description with subagent capabilities. Kept short: tool
// definitions are re-sent on every model call. This is the one home of the
// when/when-not guidance; TASK_SYSTEM_PROMPT below carries only what a tool
// description cannot.
function getTaskToolDescription(subagentDescriptions: string[]): string {
  return `Launch a sub-agent to handle a self-contained task in its own context. Each call is stateless and returns a single result; you see only that result, not its intermediate steps.

Available agents:
${subagentDescriptions.join("\n")}

Use it for complex multi-step work that can be fully delegated, for independent tasks that can run in parallel (several task calls in one response run concurrently), or for work that would flood this thread with context. The sub-agent sees nothing but your description, so make it complete: the goal, relevant paths, and what to return. Synthesize the result for the user.

Do not use it for simple work you can finish in a few tool calls, such as reading one file and editing it.

<example>
User: "Compare the middleware in package A and package B"
Assistant: launches two research tasks in parallel, one per package, then compares their findings.
</example>`.trim();
}

// When and how to delegate lives in the `task` description, and general
// advice on parallel tool calls lives in the model profile; this prompt adds
// only the one fact neither can state.
const TASK_SYSTEM_PROMPT = `## Sub-agents

A sub-agent's result comes back to you alone. The person you are working with sees none of it until you relay what they need from it.`;

/**
 * Type definitions for subagents
 */
export interface SubAgent {
  /** The name of the agent */
  name: string;
  /** The description of the agent */
  description: string;
  /** The system prompt to use for the agent */
  systemPrompt: string;
  /** The tools to use for the agent (tool instances, not names). Defaults to defaultTools */
  tools?: StructuredTool[];
  /** The model for the agent. Defaults to default_model */
  model?: LanguageModelLike | string;
  /** Additional middleware to append after default_middleware */
  middleware?: AgentMiddleware[];
  /** The tool configs to use for the agent */
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
}

/**
 * Type definitions for pre-compiled agents.
 */
export interface CompiledSubAgent {
  /** The name of the agent */
  name: string;
  /** The description of the agent */
  description: string;
  /** The agent instance */
  runnable: ReactAgent | Runnable;
}

/**
 * Filter state to exclude certain keys when passing to subagents
 */
function filterStateForSubagent(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!EXCLUDED_STATE_KEYS.includes(key as never)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Build the message a sub-agent starts from. The task tool's schema carries
 * only `description` and `subagent_type`, so the description is the whole
 * brief, passed through verbatim. The sub-agent's own system prompt decides
 * the shape of what it returns.
 *
 * @internal Exported for tests.
 */
export function formatTaskInputAsMessage(input: TaskInput): string {
  return input.description;
}

/**
 * Create Command with state update from subagent result.
 *
 * Only includes `messages` in the update — since the agent uses MessagesAnnotation
 * (messages-only state), spreading other state keys from subagent results is
 * unnecessary and could cause conflicts when parallel subagents both set
 * non-message keys.
 */
function returnCommandWithStateUpdate(
  result: Record<string, unknown>,
  toolCallId: string,
): Command {
  const messages = result.messages as Array<{ content: string }>;
  const lastMessage = messages?.[messages.length - 1];

  return new Command({
    update: {
      messages: [
        new ToolMessage({
          content: lastMessage?.content || "Task completed",
          tool_call_id: toolCallId,
          name: "task",
        }),
      ],
    },
  });
}

/**
 * Create subagent instances from specifications.
 *
 * Uses createAgent directly for synchronous construction (matching deepagentsjs pattern).
 */
function getSubagents(options: {
  defaultModel: LanguageModelLike | string;
  defaultTools: StructuredTool[];
  defaultMiddleware: AgentMiddleware[] | null;
  defaultInterruptOn: Record<string, boolean | InterruptOnConfig> | null;
  subagents: (SubAgent | CompiledSubAgent)[];
  generalPurposeAgent: boolean;
}): {
  agents: Record<string, ReactAgent | Runnable>;
  descriptions: string[];
} {
  const {
    defaultModel,
    defaultTools,
    defaultMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
  } = options;

  const defaultSubagentMiddleware = defaultMiddleware || [];
  const agents: Record<string, ReactAgent | Runnable> = {};
  const subagentDescriptions: string[] = [];

  // Create general-purpose agent if enabled
  if (generalPurposeAgent) {
    const generalPurposeMiddleware = [...defaultSubagentMiddleware];
    if (defaultInterruptOn) {
      generalPurposeMiddleware.push(
        humanInTheLoopMiddleware({ interruptOn: defaultInterruptOn }),
      );
    }

    const generalPurposeSubagent = createAgent({
      model: defaultModel,
      systemPrompt: DEFAULT_SUBAGENT_PROMPT,
      tools: defaultTools as any,
      middleware: generalPurposeMiddleware,
    });

    agents["general-purpose"] = generalPurposeSubagent;
    subagentDescriptions.push(
      `- general-purpose: ${DEFAULT_GENERAL_PURPOSE_DESCRIPTION}`,
    );
  }

  // Process custom subagents
  for (const agentParams of subagents) {
    subagentDescriptions.push(
      `- ${agentParams.name}: ${agentParams.description}`,
    );

    if ("runnable" in agentParams) {
      // Pre-compiled subagent - use the provided runnable directly
      agents[agentParams.name] = agentParams.runnable;
    } else {
      // Regular SubAgent - create using createAgent
      const middleware = agentParams.middleware
        ? [...defaultSubagentMiddleware, ...agentParams.middleware]
        : [...defaultSubagentMiddleware];

      const interruptOn = agentParams.interruptOn || defaultInterruptOn;
      if (interruptOn)
        middleware.push(humanInTheLoopMiddleware({ interruptOn }));

      // Get appropriate tool set for this subagent type
      // If tools are explicitly provided, use those (backward compat)
      // Otherwise, filter from defaultTools based on agent type
      const subagentTools =
        agentParams.tools ?? getSubagentTools(agentParams.name, defaultTools);

      agents[agentParams.name] = createAgent({
        model: agentParams.model ?? defaultModel,
        systemPrompt: agentParams.systemPrompt,
        tools: subagentTools,
        middleware,
      });
    }
  }

  return { agents, descriptions: subagentDescriptions };
}

/**
 * Create the task tool for invoking subagents
 */
function createTaskTool(options: {
  defaultModel: LanguageModelLike | string;
  defaultTools: StructuredTool[];
  defaultMiddleware: AgentMiddleware[] | null;
  defaultInterruptOn: Record<string, boolean | InterruptOnConfig> | null;
  subagents: (SubAgent | CompiledSubAgent)[];
  generalPurposeAgent: boolean;
  taskDescription: string | null;
}) {
  const {
    defaultModel,
    defaultTools,
    defaultMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
    taskDescription,
  } = options;

  const { agents: subagentGraphs, descriptions: subagentDescriptions } =
    getSubagents({
      defaultModel,
      defaultTools,
      defaultMiddleware,
      defaultInterruptOn,
      subagents,
      generalPurposeAgent,
    });

  const finalTaskDescription = taskDescription
    ? taskDescription
    : getTaskToolDescription(subagentDescriptions);

  // Simple schema - complex union schemas cause "400 Provider returned error" with GPT-5 via OpenRouter
  // The model will include structured parameters in the description field
  const taskSchema = z.object({
    description: z
      .string()
      .describe("The task to execute with the selected agent"),
    subagent_type: z
      .string()
      .describe(
        `Name of the agent to use. Available: ${Object.keys(subagentGraphs).join(", ")}`,
      ),
  });

  return tool(
    async (
      input: { description: string; subagent_type: string },
      config,
    ): Promise<Command | string> => {
      const subagent_type = input.subagent_type;
      const taskId = config.toolCall?.id;

      // Validate subagent type
      if (!(subagent_type in subagentGraphs)) {
        const allowedTypes = Object.keys(subagentGraphs)
          .map((k) => `\`${k}\``)
          .join(", ");
        throw new Error(
          `Error: invoked agent of type ${subagent_type}, the only allowed types are ${allowedTypes}`,
        );
      }

      if (!taskId) {
        throw new Error("Tool call ID is required for subagent invocation");
      }

      const subagent = subagentGraphs[subagent_type];

      // Format input as message based on subagent type
      const message = formatTaskInputAsMessage(input as TaskInput);

      // Get current state and filter it for subagent
      const currentState = getCurrentTaskInput<Record<string, unknown>>();
      // `messages` must be a declared property, not just an index-signature
      // key: langchain's `UserInput` requires it, and a bare
      // `Record<string, unknown>` does not satisfy that.
      const subagentState: Record<string, unknown> & {
        messages: BaseMessage[];
      } = {
        ...filterStateForSubagent(currentState),
        messages: [new HumanMessage({ content: message })],
      };

      // Emit started event for streaming clients
      await dispatchCustomEvent(
        "subagent_started",
        {
          taskId,
          subagentType: subagent_type,
          description: input.description,
          timestamp: Date.now(),
        },
        config,
      );

      try {
        // Invoke the subagent with recursion limit propagated
        const result = (await subagent.invoke(subagentState, {
          ...config,
          recursionLimit: 1000,
        })) as Record<string, unknown>;

        const command = returnCommandWithStateUpdate(result, taskId);

        // Emit completed event
        const resultMessages = result.messages as Array<{ content: string }>;
        const lastMessage = resultMessages?.[resultMessages.length - 1];
        await dispatchCustomEvent(
          "subagent_completed",
          {
            taskId,
            subagentType: subagent_type,
            content: lastMessage?.content || "Task completed",
            timestamp: Date.now(),
          },
          config,
        );

        return command;
      } catch (error) {
        // Emit error event, then re-throw so ToolNode's handleToolErrors
        // creates the proper error ToolMessage
        await dispatchCustomEvent(
          "subagent_error",
          {
            taskId,
            subagentType: subagent_type,
            error: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
          config,
        );

        throw error;
      }
    },
    {
      name: "task",
      description: finalTaskDescription,
      schema: taskSchema,
    },
  );
}

/**
 * Options for creating subagent middleware
 */
export interface SubAgentMiddlewareOptions {
  /** The model to use for subagents */
  defaultModel: LanguageModelLike | string;
  /** The tools to use for the default general-purpose subagent */
  defaultTools?: StructuredTool[];
  /** Default middleware to apply to all subagents */
  defaultMiddleware?: AgentMiddleware[] | null;
  /** The tool configs for the default general-purpose subagent */
  defaultInterruptOn?: Record<string, boolean | InterruptOnConfig> | null;
  /** A list of additional subagents to provide to the agent */
  subagents?: (SubAgent | CompiledSubAgent)[];
  /** Full system prompt override */
  systemPrompt?: string | null;
  /** Whether to include the general-purpose agent */
  generalPurposeAgent?: boolean;
  /** Custom description for the task tool */
  taskDescription?: string | null;
}

/**
 * Create subagent middleware with task tool
 */
export function createSubAgentMiddleware(
  options: SubAgentMiddlewareOptions,
): AgentMiddleware {
  const {
    defaultModel,
    defaultTools = [],
    defaultMiddleware = null,
    defaultInterruptOn = null,
    subagents = [],
    systemPrompt = TASK_SYSTEM_PROMPT,
    generalPurposeAgent = true,
    taskDescription = null,
  } = options;

  const taskTool = createTaskTool({
    defaultModel,
    defaultTools,
    defaultMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
    taskDescription,
  });

  return createMiddleware({
    name: "subAgentMiddleware",
    tools: [taskTool],
    wrapModelCall: async (request, handler) => {
      if (systemPrompt !== null) {
        const currentPrompt = request.systemPrompt || "";
        const newPrompt = currentPrompt
          ? `${currentPrompt}\n\n${systemPrompt}`
          : systemPrompt;

        return handler({
          ...request,
          systemPrompt: newPrompt,
        });
      }
      return handler(request);
    },
  });
}
