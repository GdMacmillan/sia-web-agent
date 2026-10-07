/**
 * Tool-exclusion middleware.
 *
 * Removes excluded tools from the request AFTER all tool-injecting middleware
 * have run, so it catches both caller-provided and middleware-provided tools.
 * Driven by a harness profile's `excludedTools`. Ported from upstream
 * deepagents (`middleware/tool_exclusion.ts`), widened with a server-level
 * grammar for remote tools (see {@link isToolExcluded}).
 */
import { createMiddleware, type AgentMiddleware } from "langchain";

function hasToolName(tool: unknown): tool is { name: string } {
  return (
    tool !== null &&
    typeof tool === "object" &&
    "name" in tool &&
    typeof tool.name === "string"
  );
}

/** Prefix every remote tool name carries: `mcp__<server>__<tool>`. */
const REMOTE_PREFIX = "mcp__";

/**
 * Whether `name` is excluded by the `excluded` set.
 *
 * Grammar of an exclusion entry:
 * - `tool` or `mcp__<server>__<tool>` — exactly that tool;
 * - `mcp__<server>` or `mcp__<server>__*` — every tool of that server.
 *
 * Server matching is by whole segment: `mcp__s` never matches `mcp__s2__x`.
 */
export function isToolExcluded(
  name: string,
  excluded: ReadonlySet<string>,
): boolean {
  if (excluded.has(name)) return true;
  if (!name.startsWith(REMOTE_PREFIX)) return false;
  const sep = name.indexOf("__", REMOTE_PREFIX.length);
  if (sep <= REMOTE_PREFIX.length) return false;
  const server = name.slice(0, sep); // "mcp__<server>"
  return excluded.has(server) || excluded.has(`${server}__*`);
}

/**
 * Create middleware that filters out excluded tools at the model-call boundary.
 *
 * @internal
 */
export function createToolExclusionMiddleware(
  excludedTools: ReadonlySet<string>,
): AgentMiddleware {
  return createMiddleware({
    name: "_ToolExclusionMiddleware",
    wrapModelCall(request, handler) {
      return handler({
        ...request,
        tools: request.tools?.filter(
          (tool) =>
            !hasToolName(tool) || !isToolExcluded(tool.name, excludedTools),
        ),
      });
    },
  });
}
