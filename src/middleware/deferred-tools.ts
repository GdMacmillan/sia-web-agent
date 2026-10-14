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
 * One static line in the system message names each group and its skill. It
 * depends only on which group tools are registered, never on whether a group
 * is revealed, so revealing a group does not change the system message.
 */
import { createMiddleware, type AgentMiddleware } from "langchain";
import type { BaseMessage } from "@langchain/core/messages";
import { appendToSystemMessage } from "./utils.js";

export const DEFERRED_TOOLS_MIDDLEWARE_NAME = "DeferredToolsMiddleware";

export interface DeferredToolGroup {
  /** The skill whose `load_skill` call reveals the group. */
  skill: string;
  /** How the system line refers to the group. */
  label: string;
  /** Tool names in the group. */
  tools: readonly string[];
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
 * `undefined` when none do.
 */
export function deferredToolsNotice(
  groups: readonly DeferredToolGroup[],
): string | undefined {
  if (groups.length === 0) return undefined;
  const parts = groups.map((g) => `${g.label} with "${g.skill}"`);
  return `Some tools appear only after you load their skill with load_skill: ${parts.join("; ")}.`;
}

/**
 * Create the deferred-tools middleware.
 *
 * @param groups Groups to defer. Defaults to {@link DEFAULT_DEFERRED_TOOL_GROUPS}.
 */
export function createDeferredToolsMiddleware(
  groups: readonly DeferredToolGroup[] = DEFAULT_DEFERRED_TOOL_GROUPS,
): AgentMiddleware {
  return createMiddleware({
    name: DEFERRED_TOOLS_MIDDLEWARE_NAME,
    wrapModelCall(request, handler) {
      const tools = request.tools ?? [];
      const registered = new Set(
        tools.map(toolName).filter((n): n is string => n !== undefined),
      );
      const present = groups.filter((g) =>
        g.tools.some((t) => registered.has(t)),
      );
      if (present.length === 0) return handler(request);

      const hidden = new Set<string>();
      for (const group of present) {
        if (!isGroupRevealed(group, request.messages ?? [])) {
          for (const t of group.tools) hidden.add(t);
        }
      }

      const notice = deferredToolsNotice(present) as string;
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
