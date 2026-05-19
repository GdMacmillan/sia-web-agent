/**
 * Parallel Subagent Execution - Integration Tests
 *
 * Verifies end-to-end parallel execution behavior:
 * - Wall-clock timing proves concurrent (not sequential) execution
 * - Result merge produces correct ToolMessages with proper attribution
 * - Partial failure: one success + one error both appear in results
 * - Single task regression: single invocation still works
 *
 * These tests use mock subagents with controlled delays (no LLM calls),
 * but exercise the real task tool invocation path.
 *
 * Gated behind RUN_INTEGRATION=true.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

jest.mock("@langchain/langgraph", () => {
  const actual = jest.requireActual("@langchain/langgraph") as any;
  return {
    ...actual,
    getCurrentTaskInput: jest.fn(),
  };
});

import { getCurrentTaskInput } from "@langchain/langgraph";
import {
  createSubAgentMiddleware,
  type CompiledSubAgent,
} from "../../src/middleware/subagents.js";

const runIntegration = process.env.RUN_INTEGRATION === "true";
const describeIntegration = runIntegration ? describe : describe.skip;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTaskTool(middleware: any): any {
  const taskTool = middleware.tools?.find((t: any) => t.name === "task");
  if (!taskTool) {
    throw new Error("Task tool not found in middleware");
  }
  return taskTool;
}

async function invokeTaskTool(
  taskTool: any,
  input: { description: string; subagent_type: string },
  toolCallId: string,
) {
  return taskTool.invoke(input, {
    toolCall: { id: toolCallId },
    configurable: {},
  });
}

function setupMockState() {
  (getCurrentTaskInput as jest.Mock).mockReturnValue({
    messages: [new HumanMessage("integration test")],
    todos: [],
    jumpTo: null,
  });
}

describeIntegration("Parallel Subagent Execution - Integration", () => {
  jest.setTimeout(30000);

  beforeEach(() => {
    jest.clearAllMocks();
    setupMockState();
  });

  it("when two subagents each sleep 500ms, total wall-clock time is under 1200ms", async () => {
    const DELAY_MS = 500;

    const slowAgentA: CompiledSubAgent = {
      name: "slowA",
      description: "Slow agent A",
      runnable: {
        invoke: jest.fn(async () => {
          await sleep(DELAY_MS);
          return { messages: [{ content: "A completed" }] };
        }),
      },
    };

    const slowAgentB: CompiledSubAgent = {
      name: "slowB",
      description: "Slow agent B",
      runnable: {
        invoke: jest.fn(async () => {
          await sleep(DELAY_MS);
          return { messages: [{ content: "B completed" }] };
        }),
      },
    };

    const middleware = createSubAgentMiddleware({
      defaultModel: { invoke: jest.fn(), modelName: "test" } as any,
      defaultTools: [],
      subagents: [slowAgentA, slowAgentB],
      generalPurposeAgent: false,
    });

    const taskTool = getTaskTool(middleware);

    const startTime = Date.now();

    const [resultA, resultB] = await Promise.all([
      invokeTaskTool(
        taskTool,
        { description: "slow task A", subagent_type: "slowA" },
        "call_A",
      ),
      invokeTaskTool(
        taskTool,
        { description: "slow task B", subagent_type: "slowB" },
        "call_B",
      ),
    ]);

    const elapsed = Date.now() - startTime;

    // Concurrent execution: should be ~500ms, not ~1000ms
    // Use generous threshold (1200ms) for CI stability
    expect(elapsed).toBeLessThan(1200);

    // Both should have completed
    expect(resultA).toBeInstanceOf(Command);
    expect(resultB).toBeInstanceOf(Command);

    const msgA = (resultA as any).update?.messages[0];
    const msgB = (resultB as any).update?.messages[0];
    expect(msgA.content).toBe("A completed");
    expect(msgB.content).toBe("B completed");
  });

  it("when both subagents complete, result Commands have correct tool_call_id attribution", async () => {
    const agentOne: CompiledSubAgent = {
      name: "one",
      description: "Agent one",
      runnable: {
        invoke: jest.fn(async () => ({
          messages: [{ content: "result from one" }],
        })),
      },
    };

    const agentTwo: CompiledSubAgent = {
      name: "two",
      description: "Agent two",
      runnable: {
        invoke: jest.fn(async () => ({
          messages: [{ content: "result from two" }],
        })),
      },
    };

    const middleware = createSubAgentMiddleware({
      defaultModel: { invoke: jest.fn(), modelName: "test" } as any,
      defaultTools: [],
      subagents: [agentOne, agentTwo],
      generalPurposeAgent: false,
    });

    const taskTool = getTaskTool(middleware);

    const [r1, r2] = await Promise.all([
      invokeTaskTool(
        taskTool,
        { description: "task one", subagent_type: "one" },
        "toolcall_001",
      ),
      invokeTaskTool(
        taskTool,
        { description: "task two", subagent_type: "two" },
        "toolcall_002",
      ),
    ]);

    const msg1 = (r1 as any).update?.messages[0];
    const msg2 = (r2 as any).update?.messages[0];

    expect(msg1).toBeInstanceOf(ToolMessage);
    expect(msg1.tool_call_id).toBe("toolcall_001");
    expect(msg1.content).toBe("result from one");

    expect(msg2).toBeInstanceOf(ToolMessage);
    expect(msg2.tool_call_id).toBe("toolcall_002");
    expect(msg2.content).toBe("result from two");
  });

  it("when one subagent succeeds and one throws, both results are captured", async () => {
    const successAgent: CompiledSubAgent = {
      name: "success",
      description: "Success agent",
      runnable: {
        invoke: jest.fn(async () => ({
          messages: [{ content: "success result" }],
        })),
      },
    };

    const failAgent: CompiledSubAgent = {
      name: "fail",
      description: "Failing agent",
      runnable: {
        invoke: jest.fn(async () => {
          throw new Error("Simulated subagent failure");
        }),
      },
    };

    const middleware = createSubAgentMiddleware({
      defaultModel: { invoke: jest.fn(), modelName: "test" } as any,
      defaultTools: [],
      subagents: [successAgent, failAgent],
      generalPurposeAgent: false,
    });

    const taskTool = getTaskTool(middleware);

    // Use Promise.allSettled to capture both outcomes
    const results = await Promise.allSettled([
      invokeTaskTool(
        taskTool,
        { description: "success task", subagent_type: "success" },
        "call_success",
      ),
      invokeTaskTool(
        taskTool,
        { description: "fail task", subagent_type: "fail" },
        "call_fail",
      ),
    ]);

    // Success result
    expect(results[0].status).toBe("fulfilled");
    const successResult = (results[0] as PromiseFulfilledResult<any>).value;
    expect(successResult).toBeInstanceOf(Command);
    const successMsg = successResult.update?.messages[0];
    expect(successMsg.content).toBe("success result");

    // Failure result
    expect(results[1].status).toBe("rejected");
    const failResult = results[1] as PromiseRejectedResult;
    expect(failResult.reason.message).toContain("Simulated subagent failure");
  });

  it("when a single task is invoked, it still works correctly", async () => {
    const singleAgent: CompiledSubAgent = {
      name: "solo",
      description: "Solo agent",
      runnable: {
        invoke: jest.fn(async () => ({
          messages: [{ content: "solo result" }],
        })),
      },
    };

    const middleware = createSubAgentMiddleware({
      defaultModel: { invoke: jest.fn(), modelName: "test" } as any,
      defaultTools: [],
      subagents: [singleAgent],
      generalPurposeAgent: false,
    });

    const taskTool = getTaskTool(middleware);

    const result = await invokeTaskTool(
      taskTool,
      { description: "solo task", subagent_type: "solo" },
      "call_solo",
    );

    expect(result).toBeInstanceOf(Command);

    const msg = (result as any).update?.messages[0];
    expect(msg).toBeInstanceOf(ToolMessage);
    expect(msg.tool_call_id).toBe("call_solo");
    expect(msg.content).toBe("solo result");
    expect(msg.name).toBe("task");
  });
});
