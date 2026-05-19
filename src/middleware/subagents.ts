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
import { HumanMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { getSubagentTools } from "../tools/tool-sets.js";
import {
  type TaskInput,
  type ResearchInput,
  type PlanInput,
} from "../schemas/index.js";

export type { AgentMiddleware };

// Constants
const DEFAULT_SUBAGENT_PROMPT =
  "In order to complete the objective that the user asks of you, you have access to a number of standard tools.";

// State keys that should be excluded when passing state to subagents
const EXCLUDED_STATE_KEYS = ["messages", "todos", "jumpTo"] as const;

const DEFAULT_GENERAL_PURPOSE_DESCRIPTION =
  "General-purpose agent for tasks requiring isolated context and deep investigation that don't fit specialized agent categories (planner/programmer/researcher/memory). Primary benefit: context isolation - delegates heavy exploration, analysis, or multi-step workflows to keep the main thread clean and efficient. Use when you need comprehensive codebase search, complex analysis requiring many tool calls, or parallel investigation of independent topics. Has access to all tools as the main agent.";

// Task tool description with subagent capabilities
function getTaskToolDescription(subagentDescriptions: string[]): string {
  return `Launch an ephemeral subagent to handle complex, multi-step independent tasks with isolated context.
Each subagent invocation is stateless and returns a single result.

Available subagents: ${subagentDescriptions.join("\n")}

## When to use the Task tool:
- Complex multi-step tasks that can be fully delegated in isolation
- Independent tasks that can run in parallel
- Tasks requiring focused reasoning or heavy token/context usage
- When you only need the final output, not intermediate reasoning steps

## Key notes:
- Specify a subagent_type parameter to select which agent to use
- Launch multiple subagents in parallel to maximize performance
- Provide detailed task descriptions so subagents can work autonomously
- The result returned is for your synthesis—integrate it back to the user
- Be explicit about what you expect: analysis, research, code changes, etc.

## Examples of When to Use

<example> User: "Analyze the directory structure of this project and explain the main components"
Assistant: *Launches researcher subagent to explore codebase* <commentary> Repository-wide
exploration requires reading many files and understanding relationships. The researcher agent
isolates this heavy context work, then returns a concise summary. Main thread stays clean and saves
tokens on the synthesis conversation. </commentary> </example>

<example> User: "Compare middleware implementation in packages/agent vs. Python DeepAgents"
Assistant: *Launches TWO researcher subagents in PARALLEL - one for TypeScript, one for Python*
<commentary> Each research task is independent and context-heavy. Parallel delegation completes both
faster while each subagent focuses on one codebase. Results are synthesized by main agent for
comparison. </commentary> </example>

<example> User: "Add a comment to the getProjectRoot function explaining what it does" Assistant:
*Uses read_file and edit_file directly* <commentary> Did NOT use task tool because this is a simple,
single-file operation. Reading one file and adding a comment is straightforward enough for direct
handling. No need for delegation overhead or context isolation. </commentary> </example>

<example> User: "Find all places where we call the task tool and check if they're using it
correctly" Assistant: *Launches general-purpose subagent to search, analyze patterns, and report*
<commentary> This requires comprehensive codebase search, pattern analysis, and synthesis. Using
general-purpose agent isolates the heavy analysis work. Main thread receives just the final findings
without all the search history bloating context. </commentary> </example>`.trim();
}

const TASK_SYSTEM_PROMPT = `## \`task\` (subagent spawner)

You have access to a \`task\` tool to launch short-lived subagents that handle isolated tasks. These
agents are ephemeral — they live only for the duration of the task and return a single result.

When to use the task tool: - When a task is complex and multi-step, and can be fully delegated in
isolation - When a task is independent of other tasks and can run in parallel - When a task requires
focused reasoning or heavy token/context usage that would bloat the orchestrator thread - When
sandboxing improves reliability (e.g. code execution, structured searches, data formatting) - When
you only care about the output of the subagent, and not the intermediate steps (ex. performing a lot
of research and then returned a synthesized report, performing a series of computations or lookups
to achieve a concise, relevant answer.)

Subagent lifecycle: 1. **Spawn** → Provide clear role, instructions, and expected output 2. **Run**
→ The subagent completes the task autonomously 3. **Return** → The subagent provides a single
structured result 4. **Reconcile** → Incorporate or synthesize the result into the main thread

When NOT to use the task tool: - If you need to see the intermediate reasoning or steps after the
subagent has completed (the task tool hides them) - If the task is trivial (a few tool calls or
simple lookup) - If delegating does not reduce token usage, complexity, or context switching - If
splitting would add latency without benefit

## Important Task Tool Usage Notes to Remember
- Whenever possible, parallelize the work that you do. This is true for both tool_calls, and for tasks. Whenever you have independent steps to complete - make tool_calls, or kick off tasks (subagents) in parallel to accomplish them faster. This saves time for the user, which is incredibly important.
- Remember to use the \`task\` tool to silo independent tasks within a multi-part objective.
- You should use the \`task\` tool whenever you have a complex task that will take multiple steps, and is independent from other tasks that the agent needs to complete. These agents are highly competent and efficient.`;

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
 * Format structured task input as a message for the sub-agent.
 * Converts typed parameters into a clear, structured prompt.
 */
function formatTaskInputAsMessage(input: TaskInput): string {
  if (input.subagent_type === "research") {
    const researchInput = input as ResearchInput & {
      subagent_type: "research";
    };
    const parts = [
      `## Research Task`,
      ``,
      `**Description:** ${researchInput.description}`,
      `**Depth:** ${researchInput.depth || "medium"}`,
      `**Task Type:** ${researchInput.taskType}`,
    ];

    if (researchInput.focusAreas && researchInput.focusAreas.length > 0) {
      parts.push(`**Focus Areas:** ${researchInput.focusAreas.join(", ")}`);
    }

    parts.push(
      ``,
      `## Instructions`,
      `Perform systematic investigation based on the parameters above.`,
      `Return your findings as structured JSON matching the ResearchOutputSchema:`,
      `- summary: Executive summary (2-3 sentences)`,
      `- codebaseStructure: { relevantPaths, keyComponents, dependencies }`,
      `- recommendations: Actionable suggestions`,
      `- findings: Detailed findings with evidence, file paths, and line numbers`,
      `- issues: Any problems discovered (optional)`,
    );

    return parts.join("\n");
  }

  if (input.subagent_type === "plan") {
    const planInput = input as PlanInput & { subagent_type: "plan" };
    const parts = [
      `## Planning Task`,
      ``,
      `**Description:** ${planInput.description}`,
      `**Requirements:** ${planInput.requirements}`,
    ];

    if (planInput.constraints && planInput.constraints.length > 0) {
      parts.push(`**Constraints:** ${planInput.constraints.join("; ")}`);
    }

    if (planInput.targetFiles && planInput.targetFiles.length > 0) {
      parts.push(`**Target Files:** ${planInput.targetFiles.join(", ")}`);
    }

    parts.push(
      ``,
      `## Instructions`,
      `Create a structured implementation plan based on the parameters above.`,
      `Return your plan as structured JSON matching the PlanOutputSchema:`,
      `- summary: High-level plan summary (1-2 sentences)`,
      `- steps: Array of { id, description, expectedOutcome, fileChanges, dependencies }`,
      `- risks: Potential challenges or risks`,
      `- assumptions: Assumptions made in this plan`,
    );

    return parts.join("\n");
  }

  // general-purpose or legacy format
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
      const subagentState = filterStateForSubagent(currentState);
      subagentState.messages = [new HumanMessage({ content: message })];

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
