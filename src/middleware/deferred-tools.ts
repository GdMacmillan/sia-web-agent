/**
 * Deferred tool groups.
 *
 * Every tool definition is re-sent on every model call, so a family of tools
 * that only one workflow uses costs its full size on every turn of every
 * conversation. A deferred group stays out of the advertised tool list until
 * the conversation shows it is needed:
 *
 * - the model loads the group's skill (`load_skill` with that `skill_name`), or
 * - any earlier message already calls or answers one of the group's tools.
 *
 * Only the advertised list is filtered. The tools stay registered, so a call
 * to a hidden tool still executes normally.
 *
 * A group marked `selfTaskOnly` (the component-building tools) is never
 * revealed in a thread known not to be a self-task: building or changing a
 * component happens in a self-task, so there the line says that instead of
 * "load the skill" (see `../tools/self-task-context.ts`). Each thread is
 * classified once — preamble first, then its metadata — and the answer is
 * kept, because a thread never stops or starts being a self-task, and a long
 * self-task may have had its opening message summarised away. A thread
 * whose kind is unknown keeps the reveal-on-load behaviour, the same rule
 * the component tools' own refusals follow.
 *
 * One static line in the system message names each group and its skill. It
 * depends only on which group tools are registered and on the thread's kind,
 * never on whether a group is revealed, so revealing a group does not change
 * the system message and the line is fixed for the life of a thread.
 */
import { createMiddleware, type AgentMiddleware } from "langchain";
import type { BaseMessage } from "@langchain/core/messages";
import { getConfig } from "../config/loader.js";
import {
  COMPONENT_WORK_IN_SELF_TASK,
  isSelfTaskThread,
  opensAsSelfTask,
  readThreadMetadata,
} from "../tools/self-task-context.js";
import { appendToSystemMessage } from "./utils.js";

export const DEFERRED_TOOLS_MIDDLEWARE_NAME = "DeferredToolsMiddleware";

export interface DeferredToolGroup {
  /** The skill whose `load_skill` call reveals the group. */
  skill: string;
  /** How the system line refers to the group. */
  label: string;
  /** Tool names in the group. */
  tools: readonly string[];
  /**
   * Revealed only in a self-task thread. In a thread known not to be one,
   * the group stays hidden and the line says where its work happens.
   */
  selfTaskOnly?: boolean;
}

export const DEFAULT_DEFERRED_TOOL_GROUPS: readonly DeferredToolGroup[] = [
  {
    skill: "checklist",
    label: "the checklist tools",
    tools: [
      "create_checklist",
      "check_item",
      "uncheck_item",
      "get_checklist",
      "get_ready_items",
      "set_dependencies",
      "delete_checklist",
    ],
  },
  {
    skill: "iterate-component",
    label:
      "the component-building tools (create_component, prepare_component_version, run_component_contract, announce_component_version)",
    tools: [
      "create_component",
      "prepare_component_version",
      "run_component_contract",
      "announce_component_version",
    ],
    selfTaskOnly: true,
  },
];

function toolName(tool: unknown): string | undefined {
  if (tool !== null && typeof tool === "object" && "name" in tool) {
    const name = (tool as { name: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

interface ToolCallLike {
  name?: unknown;
  args?: unknown;
}

function toolCallsOf(message: BaseMessage): ToolCallLike[] {
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(calls) ? (calls as ToolCallLike[]) : [];
}

function messageType(message: BaseMessage): string | undefined {
  const m = message as { getType?: () => string; type?: unknown };
  if (typeof m.getType === "function") return m.getType();
  return typeof m.type === "string" ? m.type : undefined;
}

function skillNameOf(args: unknown): unknown {
  if (args !== null && typeof args === "object" && "skill_name" in args) {
    return (args as { skill_name: unknown }).skill_name;
  }
  return undefined;
}

/** Whether the conversation so far has revealed `group`. */
export function isGroupRevealed(
  group: DeferredToolGroup,
  messages: readonly BaseMessage[],
): boolean {
  const names = new Set(group.tools);
  for (const message of messages) {
    for (const call of toolCallsOf(message)) {
      if (
        call.name === "load_skill" &&
        skillNameOf(call.args) === group.skill
      ) {
        return true;
      }
      if (typeof call.name === "string" && names.has(call.name)) return true;
    }
    if (messageType(message) === "tool") {
      const name = (message as { name?: unknown }).name;
      if (typeof name === "string" && names.has(name)) return true;
    }
  }
  return false;
}

/**
 * The system line for the groups that have at least one registered tool, or
 * `undefined` when none do. `selfTask` is the thread's kind (`undefined` when
 * unknown); only `false` changes the line, for `selfTaskOnly` groups.
 */
export function deferredToolsNotice(
  groups: readonly DeferredToolGroup[],
  selfTask?: boolean,
): string | undefined {
  const withheld = (g: DeferredToolGroup) => g.selfTaskOnly === true && selfTask === false;
  const loadable = groups.filter((g) => !withheld(g));
  const held = groups.filter(withheld);
  const sentences: string[] = [];
  if (loadable.length > 0) {
    const parts = loadable.map((g) => `${g.label} with "${g.skill}"`);
    sentences.push(
      `Some tools appear only after you load their skill with load_skill: ${parts.join("; ")}.`,
    );
  }
  if (held.length > 0) {
    const labels = held.map((g) => g.label).join(" and ");
    sentences.push(
      `${labels.charAt(0).toUpperCase()}${labels.slice(1)} are not available in this conversation. ${COMPONENT_WORK_IN_SELF_TASK}`,
    );
  }
  return sentences.length > 0 ? sentences.join(" ") : undefined;
}

export interface DeferredToolsOptions {
  /** Sent as `X-SIA-Agent-Id` on the thread read (default: the configured agent id). */
  agentId?: string;
  /** The agent's own server (default: resolved like `start_self_task`). */
  serverUrl?: string;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Most threads whose kind is remembered; the oldest is forgotten first. */
const THREAD_KIND_MEMO_LIMIT = 1024;

function threadIdOf(request: unknown): string | undefined {
  const configurable = (request as { runtime?: { configurable?: { thread_id?: unknown } } })
    ?.runtime?.configurable;
  const threadId = configurable?.thread_id;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
}

/**
 * Create the deferred-tools middleware.
 *
 * @param groups Groups to defer. Defaults to {@link DEFAULT_DEFERRED_TOOL_GROUPS}.
 * @param options How a thread's kind is read; every field is injectable for tests.
 */
export function createDeferredToolsMiddleware(
  groups: readonly DeferredToolGroup[] = DEFAULT_DEFERRED_TOOL_GROUPS,
  options: DeferredToolsOptions = {},
): AgentMiddleware {
  /** Thread id → self-task (`true`), not (`false`) or unknown (`undefined`). */
  const threadKinds = new Map<string, boolean | undefined>();

  const remember = (threadId: string, kind: boolean | undefined): boolean | undefined => {
    if (threadKinds.size >= THREAD_KIND_MEMO_LIMIT) {
      const oldest = threadKinds.keys().next().value;
      if (oldest !== undefined) threadKinds.delete(oldest);
    }
    threadKinds.set(threadId, kind);
    return kind;
  };

  const threadKind = async (
    threadId: string | undefined,
    messages: readonly BaseMessage[],
  ): Promise<boolean | undefined> => {
    if (threadId === undefined) return isSelfTaskThread(undefined, messages);
    if (threadKinds.has(threadId)) return threadKinds.get(threadId);
    if (opensAsSelfTask(messages)) return remember(threadId, true);
    const metadata = await readThreadMetadata({
      threadId,
      agentId: options.agentId ?? getConfig().runtime.agentId,
      serverUrl: options.serverUrl,
      env: options.env,
      argv: options.argv,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    return remember(threadId, isSelfTaskThread(metadata, messages));
  };

  return createMiddleware({
    name: DEFERRED_TOOLS_MIDDLEWARE_NAME,
    async wrapModelCall(request, handler) {
      const tools = request.tools ?? [];
      const registered = new Set(
        tools.map(toolName).filter((n): n is string => n !== undefined),
      );
      const present = groups.filter((g) =>
        g.tools.some((t) => registered.has(t)),
      );
      if (present.length === 0) return handler(request);

      const messages = request.messages ?? [];
      const selfTask = present.some((g) => g.selfTaskOnly === true)
        ? await threadKind(threadIdOf(request), messages)
        : undefined;

      const hidden = new Set<string>();
      for (const group of present) {
        const withheld = group.selfTaskOnly === true && selfTask === false;
        if (withheld || !isGroupRevealed(group, messages)) {
          for (const t of group.tools) hidden.add(t);
        }
      }

      const notice = deferredToolsNotice(present, selfTask) as string;
      return handler({
        ...request,
        tools: tools.filter((tool) => {
          const name = toolName(tool);
          return name === undefined || !hidden.has(name);
        }),
        systemMessage: appendToSystemMessage(request.systemMessage, notice),
      });
    },
  });
}
