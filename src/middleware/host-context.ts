/**
 * Host context middleware.
 *
 * Keeps the system prompt byte-stable across turns by moving everything that
 * changes out of it and into ordinary messages on the outgoing request:
 *
 * - Today's date is appended as the LAST message of every model request,
 *   after the latest human or tool message. Placing it last means a provider
 *   prompt cache can reuse everything before it, and a day rollover changes
 *   only this one message.
 * - A system-role message found inside the conversation history (context the
 *   host wrote into state, such as a chat-room briefing) is re-sent as a
 *   tagged user-role context message in the same position. Mid-conversation
 *   system messages are not portable across providers, and the history is
 *   where changing context belongs.
 *
 * Both are request-only: nothing here is written back to graph state, so the
 * checkpointed conversation is unchanged.
 */

import { createMiddleware, type AgentMiddleware } from "langchain";
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { wrapHostContext } from "../utils/host-context.js";

export const HOST_CONTEXT_MIDDLEWARE_NAME = "hostContextMiddleware";

export interface HostContextMiddlewareOptions {
  /** Clock override for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Format a date as `YYYY-MM-DD` in the process's local time zone — the
 * machine the agent runs on, which is where its user is.
 */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The tagged date message appended to every request. */
export function buildDateContextMessage(date: Date): HumanMessage {
  return new HumanMessage({
    content: wrapHostContext("date", `Today's date: ${formatLocalDate(date)}`),
  });
}

function rewrapSystemMessage(message: BaseMessage): BaseMessage {
  if (!SystemMessage.isInstance(message)) return message;
  return new HumanMessage({
    content: wrapHostContext("conversation", message.text),
    ...(message.id ? { id: message.id } : {}),
  });
}

/**
 * Create the host context middleware.
 *
 * The date is computed per model call (not per run, and not in a shared
 * closure) so concurrent runs on one process can't observe each other's
 * value, and a run that spans midnight sees the new day on its next call.
 */
export function createHostContextMiddleware(
  options: HostContextMiddlewareOptions = {},
): AgentMiddleware {
  const now = options.now ?? (() => new Date());

  return createMiddleware({
    name: HOST_CONTEXT_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const messages = [
        ...request.messages.map(rewrapSystemMessage),
        buildDateContextMessage(now()),
      ];
      return handler({ ...request, messages });
    },
  });
}
