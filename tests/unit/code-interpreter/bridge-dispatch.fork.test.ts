/**
 * Fork-specific test for the code-interpreter subagent bridge.
 *
 * Upstream's session/bridge tests use a synthetic dispatch callback. This test
 * drives `createCodeInterpreterMiddleware` end-to-end against a `task` tool that
 * matches THIS fork's real task-tool contract (src/middleware/subagents.ts):
 *   - name "task"
 *   - schema { description: string, subagent_type: string }  (snake_case)
 *   - resolves to a LangGraph `Command` envelope
 *
 * It asserts the bridge: (a) registers the task tool from request.tools,
 * (b) translates the in-REPL `task({ description, subagentType })` call to the
 * fork's snake_case `subagent_type` schema, (c) unwraps the Command envelope to
 * the subagent's content, and (d) threads `responseSchema` through
 * `config.configurable` under the shared response-format key.
 *
 * Runs the real QuickJS WASM runtime; executed via the flagged interpreter
 * config (yarn test:interpreter), not the default suite.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { tool } from "langchain";
import { z } from "zod/v4";
import { Command } from "@langchain/langgraph";
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createCodeInterpreterMiddleware } from "../../../src/code-interpreter/index.js";
import { ReplSession } from "../../../src/code-interpreter/session.js";
import { SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY } from "../../../src/code-interpreter/constants.js";

const TIMEOUT = 8000;
let nextThread = 0;

/**
 * A task tool with the fork's real schema. Records the input + config it was
 * invoked with and resolves to a Command envelope (like the real one does).
 */
function createForkTaskTool(content: string) {
  const calls: { input: any; config: any }[] = [];
  const taskTool = tool(
    async (input: { description: string; subagent_type: string }, config) => {
      calls.push({ input, config });
      return new Command({
        update: {
          messages: [
            new ToolMessage({ content, tool_call_id: "task-call-1" }),
          ],
        },
      });
    },
    {
      name: "task",
      description: "Delegate a task to a configured subagent",
      // Mirrors src/middleware/subagents.ts taskSchema.
      schema: z.object({
        description: z.string(),
        subagent_type: z.string(),
      }),
    },
  ) as unknown as StructuredToolInterface;
  return { taskTool, calls };
}

/**
 * Register `task` on the middleware (populates the internal taskTool) and
 * return the middleware's `eval` tool.
 */
async function wireEvalTool(
  middleware: ReturnType<typeof createCodeInterpreterMiddleware>,
  taskTool: StructuredToolInterface,
) {
  let injectedPrompt = "";
  await middleware.wrapModelCall!(
    { tools: [taskTool], systemPrompt: "" } as any,
    (async (req: { systemPrompt?: string }) => {
      injectedPrompt = req.systemPrompt || "";
      return { content: "mock" };
    }) as any,
  );
  const evalTool = (middleware.tools || []).find((t) => t.name === "eval");
  if (!evalTool) throw new Error("eval tool not found on middleware");
  return { evalTool: evalTool as StructuredToolInterface, injectedPrompt };
}

afterEach(() => {
  ReplSession.clearCache();
});

describe("code-interpreter bridge dispatch (fork task-tool contract)", () => {
  it("injects the subagent dispatch guidance when a task tool is present", async () => {
    const { taskTool } = createForkTaskTool("unused");
    const middleware = createCodeInterpreterMiddleware();
    const { injectedPrompt } = await wireEvalTool(middleware, taskTool);
    expect(injectedPrompt).toContain("task");
    expect(injectedPrompt).toContain("subagentType");
  });

  it("dispatches to the fork task tool with snake_case subagent_type and unwraps the Command", async () => {
    const { taskTool, calls } = createForkTaskTool("subagent findings here");
    const middleware = createCodeInterpreterMiddleware();
    const { evalTool } = await wireEvalTool(middleware, taskTool);

    const output = (await evalTool.invoke(
      {
        code: `await task({ description: "find bugs", subagentType: "research" })`,
      },
      { configurable: { thread_id: `fork-${++nextThread}` } },
    )) as string;

    // Bridge translated camelCase -> the fork's snake_case schema.
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({
      description: "find bugs",
      subagent_type: "research",
    });
    // Command envelope unwrapped to the subagent's message content.
    expect(output).toContain("subagent findings here");
  });

  it("threads responseSchema through config under the shared response-format key", async () => {
    const { taskTool, calls } = createForkTaskTool("ok");
    const middleware = createCodeInterpreterMiddleware();
    const { evalTool } = await wireEvalTool(middleware, taskTool);

    const schema = {
      type: "object",
      properties: { bugs: { type: "array" } },
    };

    await evalTool.invoke(
      {
        code: `await task({
          description: "analyze",
          subagentType: "research",
          responseSchema: ${JSON.stringify(schema)},
        })`,
      },
      { configurable: { thread_id: `fork-${++nextThread}` } },
    );

    expect(calls).toHaveLength(1);
    const passedConfig = calls[0].config;
    expect(passedConfig?.configurable?.[SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY]).toEqual(
      schema,
    );
  });

  it("rejects exposing the reserved task tool via ptc", async () => {
    // Construction is fine; the guard fires when ptc tools resolve in wrapModelCall.
    const { taskTool } = createForkTaskTool("x");
    const middleware = createCodeInterpreterMiddleware({ ptc: ["task"] });
    await expect(
      middleware.wrapModelCall!(
        { tools: [taskTool], systemPrompt: "" } as any,
        (async (r: any) => ({ content: "", ...r })) as any,
      ),
    ).rejects.toThrow(/task/);
  });
});
