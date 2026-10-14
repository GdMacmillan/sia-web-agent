/**
 * The compact `write_todos` description replaces the upstream one, under the
 * upstream middleware's name, so it swaps in place in every stack.
 */
import { describe, it, expect } from "@jest/globals";
import {
  createTodoListMiddleware,
  WRITE_TODOS_DESCRIPTION,
} from "../../../src/middleware/todo-list.js";
import {
  budgetFor,
  serializeToolDefinition,
} from "../../../src/tools/tool-budget.js";

type WithTools = {
  name: string;
  tools?: Array<{ name: string; description: string }>;
};

describe("createTodoListMiddleware", () => {
  const middleware = createTodoListMiddleware() as unknown as WithTools;
  const tool = middleware.tools?.find((t) => t.name === "write_todos");

  it("keeps the upstream middleware name, so it replaces it in place", () => {
    expect(middleware.name).toBe("todoListMiddleware");
  });

  it("carries write_todos with the compact description", () => {
    expect(tool).toBeDefined();
    expect(tool!.description).toBe(WRITE_TODOS_DESCRIPTION);
  });

  it("points at the skill that holds the detail", () => {
    expect(WRITE_TODOS_DESCRIPTION).toContain('"task-management"');
  });

  it("fits the tool budget", () => {
    expect(serializeToolDefinition(tool as never).length).toBeLessThanOrEqual(
      budgetFor("write_todos"),
    );
  });
});
