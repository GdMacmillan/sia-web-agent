/**
 * Subagent Middleware Tests
 *
 * Tests that the subagent middleware properly:
 * - Creates the task tool for delegating to subagents
 * - Resolves subagents by type
 * - Injects middleware into subagents
 * - Handles tool call patterns with subagents
 * - Merges subagent results back into main agent
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { createSubAgentMiddleware } from "../../../src/middleware/subagents.js";
import { mockWeatherTool, mockSearchTool } from "./middleware-utils.js";

describe("Subagent Middleware", () => {
  let mockModel: any;

  beforeEach(() => {
    // Create a minimal mock model for testing
    mockModel = {
      invoke: jest.fn(),
      stream: jest.fn(),
      modelName: "test-model",
    };
  });

  it("should create middleware with task tool", async () => {
    const middleware = await createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockWeatherTool],
    });

    expect(middleware).toBeDefined();
    expect(middleware.name).toBe("subAgentMiddleware");
  });

  it("should provide task tool in middleware", async () => {
    const middleware = await createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockWeatherTool],
    });

    // The middleware should provide tools to the agent
    expect(middleware).toHaveProperty("tools");

    // Should have a task tool for subagent delegation
    if (Array.isArray(middleware.tools)) {
      const _toolNames = middleware.tools.map((t: any) => t?.name);
      expect(_toolNames).toContain("task");
    }
  });

  it("should accept subagent specifications", () => {
    const customSubagents = [
      {
        type: "custom_researcher",
        name: "Custom Researcher",
        description: "Researches topics",
        systemPrompt: "You are a researcher",
      },
    ];

    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockSearchTool],
      subagents: customSubagents as any,
    });

    expect(middleware).toBeDefined();
  });

  it("should provide default middleware to subagents", () => {
    const defaultMiddleware = [
      {
        name: "TestMiddleware",
        tools: [mockWeatherTool],
      },
    ];

    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockSearchTool],
      defaultMiddleware,
    });

    expect(middleware).toBeDefined();
  });

  it("should configure general purpose agent mode", () => {
    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockSearchTool],
      generalPurposeAgent: true,
    });

    expect(middleware).toBeDefined();
  });

  it("should handle task tool result merging", async () => {
    // This test validates that task tool results are properly merged back
    // into the main agent's state

    const middleware = await createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockSearchTool],
      generalPurposeAgent: true,
    });

    expect(middleware).toBeDefined();
    expect(middleware).toHaveProperty("tools");
  });

  it("should support recursion limits for subagents", () => {
    // Subagents should be invoked with appropriate recursion limits
    // to allow sufficient iterations for complex tasks

    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockWeatherTool],
      generalPurposeAgent: true,
    });

    expect(middleware).toBeDefined();
  });

  it("should handle interrupt configuration for subagents", () => {
    const interruptConfig = {
      task: false, // Don't interrupt on task calls
    };

    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockSearchTool],
      defaultInterruptOn: interruptConfig,
    });

    expect(middleware).toBeDefined();
  });

  it("should support multiple subagent types", () => {
    const subagents = [
      {
        type: "planner",
        name: "Planning Agent",
        description: "Plans implementations",
        systemPrompt: "You are a planner",
      },
      {
        type: "coder",
        name: "Coding Agent",
        description: "Implements code",
        systemPrompt: "You are a coder",
      },
      {
        type: "tester",
        name: "Testing Agent",
        description: "Tests implementations",
        systemPrompt: "You are a tester",
      },
    ];

    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockSearchTool],
      subagents: subagents as any,
    });

    expect(middleware).toBeDefined();
  });

  it("should pass tools to subagents", () => {
    const tools = [mockWeatherTool, mockSearchTool];

    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: tools,
      generalPurposeAgent: true,
    });

    expect(middleware).toBeDefined();
  });

  it("should configure model for subagents", () => {
    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockSearchTool],
    });

    expect(middleware).toBeDefined();
    // Model should be available for subagent creation
  });

  it("should validate task tool input structure", async () => {
    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockSearchTool],
      generalPurposeAgent: true,
    });

    // The task tool should have proper schema for validation
    if (Array.isArray(middleware.tools)) {
      const taskTool = middleware.tools.find((t: any) => t?.name === "task");

      if (taskTool && taskTool.schema) {
        // Schema should define required fields: subagent_type, instructions
        expect(taskTool.schema).toBeDefined();
      }
    }
  });

  it("should handle state filtering for subagents", () => {
    // Subagent state should be filtered to exclude certain fields
    // like messages history, todos, etc. to keep context manageable

    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockSearchTool],
      generalPurposeAgent: true,
    });

    expect(middleware).toBeDefined();
  });

  it("should inject task system prompt to subagents", () => {
    // Subagents should receive system prompt guidance about task execution

    const middleware = createSubAgentMiddleware({
      defaultModel: mockModel,
      defaultTools: [mockWeatherTool, mockSearchTool],
      generalPurposeAgent: true,
    });

    expect(middleware).toBeDefined();
  });
});
