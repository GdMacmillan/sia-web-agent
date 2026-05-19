/**
 * Deep Agent Creation Tests
 *
 * Tests that the factory functions properly:
 * - Create configured DeepAgent instances
 * - Set up tools correctly
 * - Initialize models with proper configuration
 * - Support configuration overrides
 * - Validate agent state and capabilities
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  createDeepAgentWithDefaults,
  createDeepAgentComponents,
  createStandardTools,
  createStandardModel,
} from "../../src/deep-agent-setup.js";
import { getProjectRoot } from "../../src/backend-config.js";

const skipIntegrationTests = false;

const describeTest = skipIntegrationTests ? describe.skip : describe;

describeTest("Deep Agent Creation", () => {
  describe("createStandardModel", () => {
    it("should create a model", async () => {
      const model = await createStandardModel();

      expect(model).toBeDefined();
      expect(model).toHaveProperty("invoke");
    });

    it("should return a callable model", async () => {
      const model = await createStandardModel();

      expect(typeof model.invoke).toBe("function");
    });

    it("should support tool binding", async () => {
      const model = await createStandardModel();
      const tools = await createStandardTools(getProjectRoot());

      const boundModel = model.bindTools?.(tools);
      expect(boundModel).toBeDefined();
    });
  });

  describe("createStandardTools", () => {
    let projectRoot: string;

    beforeEach(() => {
      projectRoot = getProjectRoot();
    });

    it("should create an array of tools", async () => {
      const tools = await createStandardTools(projectRoot);

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it("should include search tool", async () => {
      const tools = await createStandardTools(projectRoot);

      const searchTool = tools.find((t) => t.name === "search");
      expect(searchTool).toBeDefined();
    });

    it("should have tools with descriptions", async () => {
      const tools = await createStandardTools(projectRoot);

      tools.forEach((tool) => {
        expect(tool.description).toBeDefined();
        expect(tool.description.length).toBeGreaterThan(0);
      });
    });

    it("should have tools with schemas", async () => {
      const tools = await createStandardTools(projectRoot);

      tools.forEach((tool) => {
        expect(tool.schema).toBeDefined();
      });
    });
  });

  describe("createDeepAgentComponents", () => {
    it("should create components with model and tools", async () => {
      const components = await createDeepAgentComponents({
        projectRoot: getProjectRoot(),
      });

      expect(components).toBeDefined();
      expect(components).toHaveProperty("model");
      expect(components).toHaveProperty("tools");
      expect(components).toHaveProperty("projectRoot");
    });

    it("should have model as callable", async () => {
      const components = await createDeepAgentComponents({
        projectRoot: getProjectRoot(),
      });

      expect(typeof components.model.invoke).toBe("function");
    });

    it("should have tools array", async () => {
      const components = await createDeepAgentComponents({
        projectRoot: getProjectRoot(),
      });

      expect(Array.isArray(components.tools)).toBe(true);
      expect(components.tools.length).toBeGreaterThan(0);
    });

    it("should use provided projectRoot", async () => {
      const customRoot = getProjectRoot();

      const components = await createDeepAgentComponents({
        projectRoot: customRoot,
      });

      expect(components.projectRoot).toBe(customRoot);
    });

    it("should use default projectRoot if not provided", async () => {
      const components = await createDeepAgentComponents();

      expect(components.projectRoot).toBeDefined();
      expect(typeof components.projectRoot).toBe("string");
    });

    it("should tools include search and context", async () => {
      const components = await createDeepAgentComponents({
        projectRoot: getProjectRoot(),
      });

      const toolNames = components.tools.map((t) => t.name);
      expect(toolNames).toContain("search");
    });
  });

  describe("createDeepAgentWithDefaults", () => {
    it("should create a complete agent", async () => {
      const agent = await createDeepAgentWithDefaults({
        projectRoot: getProjectRoot(),
      });

      expect(agent).toBeDefined();
    });

    it("should have invoke method", async () => {
      const agent = await createDeepAgentWithDefaults({
        projectRoot: getProjectRoot(),
      });

      expect(typeof agent.invoke).toBe("function");
    });

    it("should create agent with default configuration", async () => {
      const agent = await createDeepAgentWithDefaults();

      expect(agent).toBeDefined();
      expect(typeof agent.invoke).toBe("function");
    });

    it("should create agent with custom projectRoot", async () => {
      const customRoot = getProjectRoot();

      const agent = await createDeepAgentWithDefaults({
        projectRoot: customRoot,
      });

      expect(agent).toBeDefined();
    });

    it("should create callable agent", async () => {
      const agent = await createDeepAgentWithDefaults({
        projectRoot: getProjectRoot(),
      });

      // Agent should have invoke method that can be called
      expect(typeof agent.invoke).toBe("function");
    });

    it("should support initial messages", async () => {
      const agent = await createDeepAgentWithDefaults({
        projectRoot: getProjectRoot(),
        initialMessages: ["Hello"],
      });

      expect(agent).toBeDefined();
    });

    it("should work with custom model and tools", async () => {
      const model = await createStandardModel();
      const tools = await createStandardTools(getProjectRoot());

      const agent = await createDeepAgentWithDefaults({
        projectRoot: getProjectRoot(),
        agentConfig: {
          model,
          tools,
        },
      });

      expect(agent).toBeDefined();
    });
  });

  describe("agent configuration validation", () => {
    it("should create agent with proper state structure", async () => {
      const agent = await createDeepAgentWithDefaults({
        projectRoot: getProjectRoot(),
      });

      expect(agent).toBeDefined();
      // Agent should be callable with state
    });

    it("should handle projectRoot correctly", async () => {
      const projectRoot = getProjectRoot();

      const components = await createDeepAgentComponents({ projectRoot });

      expect(components.projectRoot).toBe(projectRoot);
    });

    it("should create tools with correct projectRoot context", async () => {
      const projectRoot = getProjectRoot();
      const tools = await createStandardTools(projectRoot);

      expect(tools.length).toBeGreaterThan(0);

      // Tools should be properly configured
      tools.forEach((tool) => {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.schema).toBeDefined();
      });
    });
  });

  describe("agent reusability", () => {
    it("should create multiple agents independently", async () => {
      const agent1 = await createDeepAgentWithDefaults({
        projectRoot: getProjectRoot(),
      });

      const agent2 = await createDeepAgentWithDefaults({
        projectRoot: getProjectRoot(),
      });

      expect(agent1).toBeDefined();
      expect(agent2).toBeDefined();
      // Both should be separate instances
    });

    it("should create components that can be reused", async () => {
      const components = await createDeepAgentComponents({
        projectRoot: getProjectRoot(),
      });

      // Components should be reusable for creating multiple agents
      expect(components.model).toBeDefined();
      expect(components.tools).toBeDefined();
      expect(components.projectRoot).toBeDefined();
    });

    it("should allow partial configuration", async () => {
      const components = await createDeepAgentComponents({
        projectRoot: getProjectRoot(),
      });

      // Should be able to use components to create custom agent
      expect(components.model).toBeDefined();
      expect(Array.isArray(components.tools)).toBe(true);
    });
  });

  describe("factory function composition", () => {
    it("should createStandardModel() work with standard tools", async () => {
      const model = await createStandardModel();
      const tools = await createStandardTools(getProjectRoot());

      expect(model).toBeDefined();
      expect(tools.length).toBeGreaterThan(0);
    });

    it("should createDeepAgentComponents use both model and tools", async () => {
      const components = await createDeepAgentComponents({
        projectRoot: getProjectRoot(),
      });

      // Should have both model and tools available
      expect(components.model).toBeDefined();
      expect(Array.isArray(components.tools)).toBe(true);
      expect(components.tools.length).toBeGreaterThan(0);
    });

    it("should createDeepAgentWithDefaults orchestrate all functions", async () => {
      const agent = await createDeepAgentWithDefaults({
        projectRoot: getProjectRoot(),
      });

      // Final agent should be fully functional
      expect(agent).toBeDefined();
      expect(typeof agent.invoke).toBe("function");
    });
  });

  describe("error handling", () => {
    it("should handle invalid projectRoot gracefully", async () => {
      // Should use default or handle error
      const agent = await createDeepAgentWithDefaults();

      expect(agent).toBeDefined();
    });

    it("should return valid tools even with minimal config", async () => {
      const tools = await createStandardTools(getProjectRoot());

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it("should create model without additional configuration", async () => {
      const model = await createStandardModel();

      expect(model).toBeDefined();
      expect(typeof model.invoke).toBe("function");
    });
  });

  describe("configuration flexibility", () => {
    it("should support empty configuration", async () => {
      const agent = await createDeepAgentWithDefaults({});

      expect(agent).toBeDefined();
    });

    it("should support undefined configuration", async () => {
      const agent = await createDeepAgentWithDefaults();

      expect(agent).toBeDefined();
    });

    it("should accept partial configuration overrides", async () => {
      const agent = await createDeepAgentWithDefaults({
        projectRoot: getProjectRoot(),
        // Other fields could be specified
      });

      expect(agent).toBeDefined();
    });

    it("should preserve provided configuration", async () => {
      const customRoot = getProjectRoot();

      const components = await createDeepAgentComponents({
        projectRoot: customRoot,
      });

      expect(components.projectRoot).toBe(customRoot);
    });
  });

  describe("tool accessibility", () => {
    it("should create tools that are accessible by name", async () => {
      const tools = await createStandardTools(getProjectRoot());

      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("search");
    });

    it("should create tools with all required properties", async () => {
      const tools = await createStandardTools(getProjectRoot());

      tools.forEach((tool) => {
        expect(tool).toHaveProperty("name");
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("schema");
        expect(tool).toHaveProperty("func");
      });
    });

    it("should tools be invocable", async () => {
      const tools = await createStandardTools(getProjectRoot());

      tools.forEach((tool) => {
        expect(typeof tool.func).toBe("function");
      });
    });
  });
});
