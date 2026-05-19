/**
 * Sample state objects for testing
 *
 * Provides reusable state objects with various configurations
 * to test agent behavior without making real LLM calls.
 */

import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

/**
 * Empty state with no messages
 */
export const emptyMessagesState = {
  messages: [] as BaseMessage[],
};

/**
 * Simple conversation with one user message and one AI response
 */
export const simpleConversationState = {
  messages: [
    new HumanMessage("Hello, can you help me write a function?"),
    new AIMessage(
      "Of course! I'd be happy to help you write a function. What kind of function do you need?",
    ),
  ] as BaseMessage[],
};

/**
 * Multi-turn conversation with several exchanges
 */
export const multiTurnConversationState = {
  messages: [
    new HumanMessage("I need to build a calculator"),
    new AIMessage(
      "I can help you build a calculator. What operations should it support?",
    ),
    new HumanMessage("Add, subtract, multiply, and divide"),
    new AIMessage(
      "Great! I'll create a calculator with those four basic operations.",
    ),
  ] as BaseMessage[],
};

/**
 * State with tool call messages
 */
export const stateWithToolCalls = {
  messages: [
    new HumanMessage("Read the config file"),
    new AIMessage({
      content: "",
      tool_calls: [
        {
          name: "read_file",
          args: { path: "config.json" },
          id: "call_001",
          type: "tool_call" as const,
        },
      ],
    }),
  ] as BaseMessage[],
};

/**
 * Manager agent state with planning phase
 */
export const managerState = {
  messages: [
    new HumanMessage("Create a new authentication feature"),
    new AIMessage(
      "I'll help you create an authentication feature. Let me break this down into a plan.",
    ),
  ] as BaseMessage[],
};

/**
 * Planner agent state with detailed plan
 */
export const plannerState = {
  messages: [
    new HumanMessage("Plan the authentication feature"),
    new AIMessage(`Here's the implementation plan: 1. Create user schema with email and password fields 2. Implement
password hashing using bcrypt 3. Create login endpoint with JWT token generation 4. Add middleware
for protected routes 5. Write unit tests for authentication logic`),
  ] as BaseMessage[],
};

/**
 * Programmer agent state with code generation
 */
export const programmerState = {
  messages: [
    new HumanMessage("Implement the user schema"),
    new AIMessage({
      content: "",
      tool_calls: [
        {
          name: "write_file",
          args: {
            path: "src/models/User.ts",
            content:
              "export interface User { id: string; email: string; passwordHash: string; }",
          },
          id: "call_002",
          type: "tool_call" as const,
        },
      ],
    }),
  ] as BaseMessage[],
};
