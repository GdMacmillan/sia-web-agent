import {
  createMiddleware,
  AgentMiddleware,
  ToolMessage,
  AIMessage,
} from "langchain";
import { BaseMessage } from "@langchain/core/messages";

/**
 * Create middleware that patches dangling tool calls in the messages history.
 *
 * When an AI message contains tool_calls but subsequent messages don't include
 * the corresponding ToolMessage responses, this middleware adds synthetic
 * ToolMessages saying the tool call was cancelled.
 *
 * @returns AgentMiddleware that patches dangling tool calls
 *
 * @example
 * ```typescript * import { createAgent } from "langchain"; * import { createPatchToolCallsMiddleware }
from "./middleware/patch_tool_calls"; * * const agent = createAgent({ * model:
"claude-sonnet-4-5-20250929", * middleware: [createPatchToolCallsMiddleware()], * }); *```
 */
export function createPatchToolCallsMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: "patchToolCallsMiddleware",
    beforeAgent: async (state) => {
      const messages = state.messages;

      if (!messages || messages.length === 0) {
        return;
      }

      const patchedMessages: any[] = [];

      // Iterate over the messages and add any dangling tool calls
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        patchedMessages.push(msg);

        // Check if this is an AI message with tool calls
        if (AIMessage.isInstance(msg) && msg.tool_calls != null) {
          for (const toolCall of msg.tool_calls) {
            // Look for a corresponding ToolMessage in the messages after this one
            const correspondingToolMsg = messages
              .slice(i)
              .find(
                (m: BaseMessage) =>
                  ToolMessage.isInstance(m) && m.tool_call_id === toolCall.id,
              );

            if (!correspondingToolMsg) {
              // We have a dangling tool call which needs a ToolMessage
              const toolMsg = `Tool call ${toolCall.name} with id ${toolCall.id} was cancelled - another message came in before it could be completed.`;
              patchedMessages.push(
                new ToolMessage({
                  content: toolMsg,
                  name: toolCall.name,
                  tool_call_id: toolCall.id!,
                }),
              );
            }
          }
        }
      }

      // Only return the synthetic ToolMessages that were added for dangling calls.
      // Do NOT use REMOVE_ALL_MESSAGES — it wipes the entire checkpoint history,
      // so navigating back to a thread would lose all prior messages.
      const syntheticMessages = patchedMessages.filter(
        (m) => !messages.includes(m),
      );

      if (syntheticMessages.length === 0) {
        // No dangling tool calls found — nothing to patch
        return;
      }

      return {
        messages: syntheticMessages,
      };
    },
  });
}
