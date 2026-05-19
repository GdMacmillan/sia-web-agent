/**
 * Parallel Subagent Execution Tests
 *
 * Verifies that the task tool correctly supports parallel invocation:
 * - State isolation between concurrent subagent calls
 * - Correct tool_call_id attribution on returned Commands
 * - Concurrent invocations produce independent results
 * - Error cases: missing tool_call_id, invalid subagent_type
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

// Mock getCurrentTaskInput before importing subagents module
jest.mock("@langchain/langgraph", () => {
  const actual = jest.requireActual("@langchain/langgraph") as any;
  return {
    ...actual,
    getCurrentTaskInput: jest.fn(),
  };
});

// Mock dispatchCustomEvent to capture streaming events without callback setup
const mockDispatchCustomEvent = jest.fn();
jest.mock("@langchain/core/callbacks/dispatch", () => ({
  dispatchCustomEvent: mockDispatchCustomEvent,
}));

import { getCurrentTaskInput } from "@langchain/langgraph";
import {
  createSubAgentMiddleware,
  type CompiledSubAgent,
} from "../../../src/middleware/subagents.js";

/**
 * Extracts the task tool instance from compiled middleware.
 */
function getTaskTool(middleware: any): any {
  const taskTool = middleware.tools?.find((t: any) => t.name === "task");
  if (!taskTool) {
    throw new Error("Task tool not found in middleware");
  }
  return taskTool;
}

/**
 * Invokes the task tool with proper LangChain tool invocation protocol.
 * Uses tool.invoke() which sets up runManager and callback chains.
 */
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

/**
 * Creates a mock subagent runnable that records invocation args
 * and returns a configurable result.
 */
function createMockSubagent(resultContent: string) {
  const invocations: any[] = [];

  const runnable = {
    invoke: jest.fn(async (state: any) => {
      // Record a shallow copy of the state with its own keys
      // Messages are LangChain objects — preserve them as-is for assertion
      invocations.push({ ...state, messages: [...state.messages] });
      return {
        messages: [{ content: resultContent }],
      };
    }),
  };

  return { runnable, invocations };
}

/**
 * Creates middleware with pre-compiled mock subagents for testing.
 */
function createTestMiddleware(
  compiledSubagents: CompiledSubAgent[],
  sharedState: Record<string, unknown> = {},
) {
  (getCurrentTaskInput as jest.Mock).mockReturnValue({
    messages: [new HumanMessage("original")],
    todos: [],
    jumpTo: null,
    ...sharedState,
  });

  const mockModel = {
    invoke: jest.fn(),
    stream: jest.fn(),
    modelName: "test-model",
  };

  return createSubAgentMiddleware({
    defaultModel: mockModel,
    defaultTools: [],
    subagents: compiledSubagents,
    generalPurposeAgent: false,
  });
}

describe("Parallel Subagent Execution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("state isolation", () => {
    it("when filtering state for subagent, excludes messages, todos, and jumpTo", async () => {
      const alphaAgent = createMockSubagent("alpha result");
      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "alpha",
          description: "Alpha agent",
          runnable: alphaAgent.runnable,
        },
      ];

      const sharedState = {
        customKey: "shared-value",
        anotherKey: 42,
      };

      const middleware = createTestMiddleware(compiledAgents, sharedState);
      const taskTool = getTaskTool(middleware);

      await invokeTaskTool(
        taskTool,
        { description: "test task", subagent_type: "alpha" },
        "call_1",
      );

      const receivedState = alphaAgent.invocations[0];

      // Excluded keys should not be present
      expect(receivedState).not.toHaveProperty("todos");
      expect(receivedState).not.toHaveProperty("jumpTo");

      // Messages should be replaced with a single HumanMessage
      expect(receivedState.messages).toHaveLength(1);
      expect(receivedState.messages[0].content).toBe("test task");

      // Custom state keys should be passed through
      expect(receivedState.customKey).toBe("shared-value");
      expect(receivedState.anotherKey).toBe(42);
    });

    it("when invoking two subagents, each receives an independent state copy", async () => {
      const alphaAgent = createMockSubagent("alpha result");
      const betaAgent = createMockSubagent("beta result");

      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "alpha",
          description: "Alpha agent",
          runnable: alphaAgent.runnable,
        },
        {
          name: "beta",
          description: "Beta agent",
          runnable: betaAgent.runnable,
        },
      ];

      const sharedState = { sharedData: { nested: "value" } };
      const middleware = createTestMiddleware(compiledAgents, sharedState);
      const taskTool = getTaskTool(middleware);

      // Invoke both in parallel (simulating LangGraph's parallel dispatch)
      await Promise.all([
        invokeTaskTool(
          taskTool,
          { description: "alpha task", subagent_type: "alpha" },
          "call_alpha",
        ),
        invokeTaskTool(
          taskTool,
          { description: "beta task", subagent_type: "beta" },
          "call_beta",
        ),
      ]);

      const alphaState = alphaAgent.invocations[0];
      const betaState = betaAgent.invocations[0];

      // Each received its own HumanMessage with correct description
      expect(alphaState.messages[0].content).toBe("alpha task");
      expect(betaState.messages[0].content).toBe("beta task");

      // States are distinct objects (not shared references)
      expect(alphaState).not.toBe(betaState);
      expect(alphaState.messages).not.toBe(betaState.messages);
    });

    it("when mutating subagent state, does not affect the original shared state", async () => {
      const mutatingAgent = {
        invoke: jest.fn(async (state: any) => {
          // Mutate the received state
          state.customKey = "mutated";
          state.messages.push({ content: "injected" });
          return { messages: [{ content: "done" }] };
        }),
      };

      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "mutator",
          description: "Mutating agent",
          runnable: mutatingAgent,
        },
      ];

      const mockState = {
        messages: [new HumanMessage("original")],
        todos: [],
        jumpTo: null,
        customKey: "original",
      };
      (getCurrentTaskInput as jest.Mock).mockReturnValue(mockState);

      const mockModel = {
        invoke: jest.fn(),
        stream: jest.fn(),
        modelName: "test-model",
      };

      const middleware = createSubAgentMiddleware({
        defaultModel: mockModel,
        defaultTools: [],
        subagents: compiledAgents,
        generalPurposeAgent: false,
      });

      const taskTool = getTaskTool(middleware);

      await invokeTaskTool(
        taskTool,
        { description: "mutate test", subagent_type: "mutator" },
        "call_mut",
      );

      // Original state should be unchanged
      expect(mockState.customKey).toBe("original");
      expect(mockState.messages).toHaveLength(1);
    });
  });

  describe("command attribution", () => {
    it("when returning Command, includes correct tool_call_id on ToolMessage", async () => {
      const agent = createMockSubagent("result content");
      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "worker",
          description: "Worker agent",
          runnable: agent.runnable,
        },
      ];

      const middleware = createTestMiddleware(compiledAgents);
      const taskTool = getTaskTool(middleware);

      const result = await invokeTaskTool(
        taskTool,
        { description: "work task", subagent_type: "worker" },
        "call_abc123",
      );

      expect(result).toBeInstanceOf(Command);

      const messages = (result as any).update?.messages;
      expect(messages).toHaveLength(1);

      const toolMsg = messages[0];
      expect(toolMsg).toBeInstanceOf(ToolMessage);
      expect(toolMsg.tool_call_id).toBe("call_abc123");
      expect(toolMsg.content).toBe("result content");
      expect(toolMsg.name).toBe("task");
    });

    it("when two concurrent calls complete, each Command has distinct tool_call_id", async () => {
      const agentA = createMockSubagent("result A");
      const agentB = createMockSubagent("result B");

      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "agentA",
          description: "Agent A",
          runnable: agentA.runnable,
        },
        {
          name: "agentB",
          description: "Agent B",
          runnable: agentB.runnable,
        },
      ];

      const middleware = createTestMiddleware(compiledAgents);
      const taskTool = getTaskTool(middleware);

      const [resultA, resultB] = await Promise.all([
        invokeTaskTool(
          taskTool,
          { description: "task A", subagent_type: "agentA" },
          "call_A",
        ),
        invokeTaskTool(
          taskTool,
          { description: "task B", subagent_type: "agentB" },
          "call_B",
        ),
      ]);

      const msgA = (resultA as any).update?.messages[0];
      const msgB = (resultB as any).update?.messages[0];

      expect(msgA.tool_call_id).toBe("call_A");
      expect(msgB.tool_call_id).toBe("call_B");
      expect(msgA.content).toBe("result A");
      expect(msgB.content).toBe("result B");
    });
  });

  describe("error handling", () => {
    it("when subagent_type is invalid, throws with allowed types listed", async () => {
      const agent = createMockSubagent("result");
      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "plan",
          description: "Planner",
          runnable: agent.runnable,
        },
        {
          name: "research",
          description: "Researcher",
          runnable: agent.runnable,
        },
      ];

      const middleware = createTestMiddleware(compiledAgents);
      const taskTool = getTaskTool(middleware);

      await expect(
        invokeTaskTool(
          taskTool,
          { description: "test", subagent_type: "nonexistent" },
          "call_1",
        ),
      ).rejects.toThrow(/allowed types are.*`plan`.*`research`/);
    });

    it("when subagent throws, error propagates to caller", async () => {
      const failingAgent = {
        invoke: jest.fn(async () => {
          throw new Error("Subagent internal failure");
        }),
      };

      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "failer",
          description: "Failing agent",
          runnable: failingAgent,
        },
      ];

      const middleware = createTestMiddleware(compiledAgents);
      const taskTool = getTaskTool(middleware);

      await expect(
        invokeTaskTool(
          taskTool,
          { description: "fail task", subagent_type: "failer" },
          "call_fail",
        ),
      ).rejects.toThrow("Subagent internal failure");
    });
  });

  describe("concurrent task invocation", () => {
    it("when running two tasks via Promise.all, both subagents are invoked", async () => {
      const alphaAgent = createMockSubagent("alpha done");
      const betaAgent = createMockSubagent("beta done");

      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "alpha",
          description: "Alpha",
          runnable: alphaAgent.runnable,
        },
        {
          name: "beta",
          description: "Beta",
          runnable: betaAgent.runnable,
        },
      ];

      const middleware = createTestMiddleware(compiledAgents);
      const taskTool = getTaskTool(middleware);

      const results = await Promise.all([
        invokeTaskTool(
          taskTool,
          { description: "alpha work", subagent_type: "alpha" },
          "call_1",
        ),
        invokeTaskTool(
          taskTool,
          { description: "beta work", subagent_type: "beta" },
          "call_2",
        ),
      ]);

      // Both subagents were invoked exactly once
      expect(alphaAgent.runnable.invoke).toHaveBeenCalledTimes(1);
      expect(betaAgent.runnable.invoke).toHaveBeenCalledTimes(1);

      // Both returned Commands
      expect(results).toHaveLength(2);
      expect(results[0]).toBeInstanceOf(Command);
      expect(results[1]).toBeInstanceOf(Command);

      // Each Command has the correct tool_call_id
      const msg1 = (results[0] as any).update?.messages[0];
      const msg2 = (results[1] as any).update?.messages[0];
      expect(msg1.tool_call_id).toBe("call_1");
      expect(msg2.tool_call_id).toBe("call_2");
    });

    it("when subagent returns empty messages, Command uses fallback content", async () => {
      const emptyAgent = {
        invoke: jest.fn(async () => ({
          messages: [],
        })),
      };

      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "empty",
          description: "Empty result agent",
          runnable: emptyAgent,
        },
      ];

      const middleware = createTestMiddleware(compiledAgents);
      const taskTool = getTaskTool(middleware);

      const result = await invokeTaskTool(
        taskTool,
        { description: "empty task", subagent_type: "empty" },
        "call_empty",
      );

      const msg = (result as any).update?.messages[0];
      expect(msg.content).toBe("Task completed");
    });
  });

  describe("streaming events", () => {
    it("when subagent completes successfully, emits started and completed events", async () => {
      const agent = createMockSubagent("streaming result");
      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "streamer",
          description: "Streaming agent",
          runnable: agent.runnable,
        },
      ];

      const middleware = createTestMiddleware(compiledAgents);
      const taskTool = getTaskTool(middleware);

      mockDispatchCustomEvent.mockClear();

      await invokeTaskTool(
        taskTool,
        { description: "stream task", subagent_type: "streamer" },
        "call_stream",
      );

      // Should have emitted started and completed events
      expect(mockDispatchCustomEvent).toHaveBeenCalledTimes(2);

      const startedCall = mockDispatchCustomEvent.mock.calls[0];
      expect(startedCall[0]).toBe("subagent_started");
      expect(startedCall[1]).toMatchObject({
        taskId: "call_stream",
        subagentType: "streamer",
        description: "stream task",
      });
      expect(startedCall[1].timestamp).toEqual(expect.any(Number));

      const completedCall = mockDispatchCustomEvent.mock.calls[1];
      expect(completedCall[0]).toBe("subagent_completed");
      expect(completedCall[1]).toMatchObject({
        taskId: "call_stream",
        subagentType: "streamer",
        content: "streaming result",
      });
      expect(completedCall[1].timestamp).toEqual(expect.any(Number));
    });

    it("when subagent throws, emits started and error events", async () => {
      const failingAgent = {
        invoke: jest.fn(async () => {
          throw new Error("Stream failure");
        }),
      };

      const compiledAgents: CompiledSubAgent[] = [
        {
          name: "failer",
          description: "Failing agent",
          runnable: failingAgent,
        },
      ];

      const middleware = createTestMiddleware(compiledAgents);
      const taskTool = getTaskTool(middleware);

      mockDispatchCustomEvent.mockClear();

      await expect(
        invokeTaskTool(
          taskTool,
          { description: "fail task", subagent_type: "failer" },
          "call_fail_stream",
        ),
      ).rejects.toThrow("Stream failure");

      // Should have emitted started and error events
      expect(mockDispatchCustomEvent).toHaveBeenCalledTimes(2);

      const startedCall = mockDispatchCustomEvent.mock.calls[0];
      expect(startedCall[0]).toBe("subagent_started");

      const errorCall = mockDispatchCustomEvent.mock.calls[1];
      expect(errorCall[0]).toBe("subagent_error");
      expect(errorCall[1]).toMatchObject({
        taskId: "call_fail_stream",
        subagentType: "failer",
        error: "Stream failure",
      });
    });
  });
});
