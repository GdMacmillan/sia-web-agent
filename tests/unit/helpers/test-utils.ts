/**
 * Test Utilities for Agent Testing
 *
 * Provides mock factories and helper functions for testing LangGraph agents
 * without making real LLM API calls.
 */

import { AIMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Creates a mock ChatModel that returns predefined responses
 * Note: GenericFakeChatModel requires additional packages not in dependencies
 * For now, this is a placeholder for future implementation
 */
export function createMockModel(responses: Array<string | AIMessage>) {
  // Placeholder - would use GenericFakeChatModel when available
  return {
    invoke: async () => responses[0] || new AIMessage("mock response"),
  };
}

/**
 * Creates a mock checkpointer for stateful testing
 * Note: InMemorySaver requires @langchain/checkpoint package
 * For now, this is a placeholder for future implementation
 */
export function createMockCheckpointer() {
  // Placeholder - would use InMemorySaver when available
  return {
    get: async () => null,
    put: async () => {},
    list: async () => [],
  };
}

/**
 * Creates mock tools for testing tool-calling agents
 */
export function createMockTools(): DynamicStructuredTool[] {
  return [
    new DynamicStructuredTool({
      name: "mock_tool_1",
      description: "A mock tool for testing",
      schema: z.object({
        input: z.string().describe("Input parameter"),
      }),
      func: async ({ input }) => `Mock response for: ${input}`,
    }),
    new DynamicStructuredTool({
      name: "mock_tool_2",
      description: "Another mock tool for testing",
      schema: z.object({
        value: z.number().describe("Numeric value"),
      }),
      func: async ({ value }) => `Received value: ${value}`,
    }),
  ];
}

/**
 * Validates that a state object has the correct shape
 */
export function assertStateShape(state: any, expectedKeys: string[]) {
  for (const key of expectedKeys) {
    if (!(key in state)) {
      throw new Error(`State missing expected key: ${key}`);
    }
  }
  return true;
}

/**
 * Creates a mock MCP client response
 */
export function mockMCPClient(
  tools: Array<{ name: string; description: string }>,
) {
  return {
    getTools: async () =>
      tools.map(
        (t) =>
          new DynamicStructuredTool({
            name: t.name,
            description: t.description,
            schema: z.object({}),
            func: async () => "mock response",
          }),
      ),
    close: async () => {},
  };
}

/**
 * Helper to create AIMessage with tool calls
 */
export function createToolCallMessage(
  toolName: string,
  args: Record<string, any>,
  callId = "call_1",
) {
  return new AIMessage({
    content: "",
    tool_calls: [
      {
        name: toolName,
        args,
        id: callId,
        type: "tool_call" as const,
      },
    ],
  });
}

/**
 * Helper to create a sequence of messages for testing
 */
export function createMessageSequence(
  messages: Array<{ role: "human" | "ai"; content: string }>,
): BaseMessage[] {
  return messages.map((msg) =>
    msg.role === "human"
      ? new HumanMessage(msg.content)
      : new AIMessage(msg.content),
  );
}

/**
 * Waits for an async condition to be true (useful for testing async state changes)
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Extracts the last message from a state
 */
export function getLastMessage(state: {
  messages: BaseMessage[];
}): BaseMessage | undefined {
  return state.messages[state.messages.length - 1];
}

/**
 * Counts messages of a specific type in state
 */
export function countMessagesByType(
  state: { messages: BaseMessage[] },
  type: "human" | "ai" | "system",
): number {
  const typeMap = {
    human: HumanMessage,
    ai: AIMessage,
    system: "system", // SystemMessage check by getType?.()
  };

  return state.messages.filter((msg) => {
    if (type === "system") {
      return (msg as any).getType?.() === "system";
    }
    return msg instanceof typeMap[type];
  }).length;
}
