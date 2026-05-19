/**
 * Sample message objects for testing
 *
 * Provides reusable message instances for constructing test scenarios.
 */

import {
  HumanMessage,
  AIMessage,
  ToolMessage,
  BaseMessage,
} from "@langchain/core/messages";

/**
 * Basic user message
 */
export const simpleHumanMessage = new HumanMessage(
  "Hello, how can you help me?",
);

/**
 * Basic AI response
 */
export const simpleAIMessage = new AIMessage(
  "I can help you with coding tasks, planning, and implementation.",
);

/**
 * AI message with tool call
 */
export const toolCallMessage = new AIMessage({
  content: "",
  tool_calls: [
    {
      name: "execute_bash",
      args: { command: "ls -la" },
      id: "call_123",
      type: "tool_call" as const,
    },
  ],
});

/**
 * Tool execution result message
 */
export const toolResultMessage = new ToolMessage({
  content:
    "total 8\ndrwxr-xr-x  5 user  staff  160 Jan  1 12:00 .\ndrwxr-xr-x  3 user  staff   96 Jan  1 11:00 ..",
  tool_call_id: "call_123",
});

/**
 * Conversation history with multiple turns
 */
export const conversationHistory: BaseMessage[] = [
  new HumanMessage("I need to add error handling to my API"),
  new AIMessage(
    "I can help you add error handling. What type of errors are you concerned about?",
  ),
  new HumanMessage("Database connection errors and validation errors"),
  new AIMessage(
    "Let me create error handling for both database and validation errors.",
  ),
];

/**
 * Planning conversation
 */
export const planningConversation: BaseMessage[] = [
  new HumanMessage("Create a REST API for managing tasks"),
  new AIMessage({
    content: `I'll create a plan for the task management API:

**Requirements:**
1. CRUD operations for tasks
2. User authentication
3. Task assignment and status tracking

**Implementation Steps:**
1. Set up Express server with TypeScript
2. Create Task model with Mongoose
3. Implement authentication middleware
4. Build CRUD endpoints
5. Add validation and error handling`,
  }),
];

/**
 * Code implementation conversation
 */
export const implementationConversation: BaseMessage[] = [
  new HumanMessage("Implement the Task model"),
  new AIMessage({
    content: "",
    tool_calls: [
      {
        name: "write_file",
        args: {
          path: "src/models/Task.ts",
          content: `export interface Task { id: string; title: string; description: string; status: 'pending' |
'in_progress' | 'completed'; assignedTo?: string; createdAt: Date; updatedAt: Date; }`,
        },
        id: "call_456",
        type: "tool_call" as const,
      },
    ],
  }),
  new ToolMessage({
    content: "File written successfully: src/models/Task.ts",
    tool_call_id: "call_456",
  }),
];
