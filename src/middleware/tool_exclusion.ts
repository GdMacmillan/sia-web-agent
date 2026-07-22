/**
 * Tool-exclusion middleware.
 *
 * Removes excluded tools from the request AFTER all tool-injecting middleware
 * have run, so it catches both caller-provided and middleware-provided tools.
 * Driven by a harness profile's `excludedTools`. Ported verbatim from upstream
 * deepagents (`middleware/tool_exclusion.ts`).
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
          (tool) => !hasToolName(tool) || !excludedTools.has(tool.name),
        ),
      });
    },
  });
}
