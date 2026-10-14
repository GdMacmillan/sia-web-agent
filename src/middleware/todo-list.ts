/**
 * Todo-list middleware with a compact `write_todos` description.
 *
 * The upstream description runs to ~11k characters of examples, and every
 * tool definition is re-sent on every model call. The guidance it carried
 * lives in the `task-management` skill instead, which the agent loads when
 * it wants the detail. Registered under the upstream middleware's own name,
 * so it replaces the default entry in place in both the main and the
 * sub-agent stacks.
 */
import { todoListMiddleware, type AgentMiddleware } from "langchain";

export const WRITE_TODOS_DESCRIPTION = `Create or update your todo list. Each call replaces the whole list; never call it in parallel.

Use it for work with 3+ distinct steps or when the user lists several tasks. Skip it for trivial or purely conversational requests.

States: pending, in_progress, completed. Mark the first item in_progress when you write the list; mark each item completed as soon as it is fully done, never while errors or blockers remain. Load the "task-management" skill for examples.`;

/** `todoListMiddleware` with the compact description above. */
export function createTodoListMiddleware(): AgentMiddleware {
  return todoListMiddleware({ toolDescription: WRITE_TODOS_DESCRIPTION });
}
