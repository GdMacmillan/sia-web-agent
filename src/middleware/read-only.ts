/**
 * Read-only middleware for sub-agents that must not change anything.
 *
 * A sub-agent described as "read-only" is only read-only if no write tool
 * can reach it. The sub-agent stack shares its middleware with every other
 * sub-agent, and several of those middleware inject write-capable tools of
 * their own (the filesystem's `write_file` / `edit_file`, `execute_code`,
 * the opt-in `eval` interpreter), so filtering the base tool set is not
 * enough. This middleware closes both doors:
 *
 * - `wrapModelCall` drops the write tools from what the model is shown, so
 *   it never plans around them;
 * - `wrapToolCall` refuses a call to one anyway, so a model that names a
 *   tool it was never shown still changes nothing.
 *
 * It is appended after the shared sub-agent middleware, so it sees every
 * tool those middleware inject.
 */
import { createMiddleware, ToolMessage, type AgentMiddleware } from "langchain";
import { isToolExcluded } from "./tool_exclusion.js";

/**
 * Tools a read-only sub-agent never gets: file writes, memory writes, and
 * code execution (which can write files and memory through its tool API).
 */
export const READ_ONLY_EXCLUDED_TOOLS: ReadonlySet<string> = Object.freeze(
  new Set([
    "write_file",
    "edit_file",
    "store_entity",
    "update_entity",
    "update_entity_status",
    "promote_entities",
    "execute_code",
    "eval",
  ]),
) as ReadonlySet<string>;

export const READ_ONLY_MIDDLEWARE_NAME = "_ReadOnlyMiddleware";

function hasToolName(tool: unknown): tool is { name: string } {
  return (
    tool !== null &&
    typeof tool === "object" &&
    "name" in tool &&
    typeof tool.name === "string"
  );
}

/**
 * Create the read-only middleware.
 *
 * @param excluded - Tool names to withhold and refuse. Defaults to
 *   {@link READ_ONLY_EXCLUDED_TOOLS}.
 */
export function createReadOnlyMiddleware(
  excluded: ReadonlySet<string> = READ_ONLY_EXCLUDED_TOOLS,
): AgentMiddleware {
  return createMiddleware({
    name: READ_ONLY_MIDDLEWARE_NAME,
    wrapModelCall(request, handler) {
      return handler({
        ...request,
        tools: request.tools?.filter(
          (tool) => !hasToolName(tool) || !isToolExcluded(tool.name, excluded),
        ),
      });
    },
    wrapToolCall(request, handler) {
      const name = request.toolCall?.name;
      if (name && isToolExcluded(name, excluded)) {
        return new ToolMessage({
          content: `Error: ${name} is not available to you. You are read-only: report what should change instead of changing it.`,
          tool_call_id: request.toolCall.id ?? "",
          name,
          status: "error",
        });
      }
      return handler(request);
    },
  });
}
