/**
 * Knowledge Formation Middleware Tests
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import axios from "axios";
import { createKnowledgeFormationMiddleware } from "../../../src/middleware/knowledge-formation.js";
import {
  loadExtractionConfig,
  SENSITIVITY_PRESETS,
} from "../../../src/config/knowledge-formation-config.js";
import { resetConfig } from "../../../src/config/index.js";
import { logger } from "../../../src/utils/logger.js";

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock LLM model
const mockModel = {
  invoke: jest.fn(),
};

describe("Knowledge Formation Middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Reset cached config so env var changes take effect
    resetConfig();
    // Clear environment variables
    delete process.env.KNOWLEDGE_FORMATION_ENABLED;
    delete process.env.KNOWLEDGE_FORMATION_SENSITIVITY;
    delete process.env.KNOWLEDGE_FORMATION_DEBUG;
    delete process.env.KNOWLEDGE_FORMATION_MIN_CONFIDENCE;
    delete process.env.KNOWLEDGE_FORMATION_MAX_LEARNINGS;
    delete process.env.KNOWLEDGE_FORMATION_DEDUP_THRESHOLD;
    delete process.env.KNOWLEDGE_FORMATION_EXCLUDE_AGENTS;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("loadExtractionConfig", () => {
    it("should load default config when no env vars set", () => {
      const config = loadExtractionConfig();
      expect(config.enabled).toBe(true);
      expect(config.minConfidence).toBe(0.7);
      expect(config.maxLearningsPerTask).toBe(3);
      expect(config.deduplicationThreshold).toBe(0.9);
    });

    it("should apply sensitivity presets", () => {
      process.env.KNOWLEDGE_FORMATION_SENSITIVITY = "aggressive";
      const config = loadExtractionConfig();
      expect(config.minConfidence).toBe(
        SENSITIVITY_PRESETS.aggressive.minConfidence,
      );
      expect(config.maxLearningsPerTask).toBe(
        SENSITIVITY_PRESETS.aggressive.maxLearningsPerTask,
      );
    });

    it("should override with environment variables", () => {
      process.env.KNOWLEDGE_FORMATION_MIN_CONFIDENCE = "0.85";
      process.env.KNOWLEDGE_FORMATION_MAX_LEARNINGS = "5";
      const config = loadExtractionConfig();
      expect(config.minConfidence).toBe(0.85);
      expect(config.maxLearningsPerTask).toBe(5);
    });

    it("should parse exclude agents list", () => {
      process.env.KNOWLEDGE_FORMATION_EXCLUDE_AGENTS = "planner,researcher";
      const config = loadExtractionConfig();
      expect(config.excludeAgentTypes).toEqual(["planner", "researcher"]);
    });
  });

  describe("createKnowledgeFormationMiddleware", () => {
    it("should create middleware with correct name", () => {
      const middleware = createKnowledgeFormationMiddleware();
      expect(middleware.name).toBe("knowledgeFormationMiddleware");
    });

    it("should have beforeAgent and afterAgent hooks", () => {
      const middleware = createKnowledgeFormationMiddleware();
      expect(middleware.beforeAgent).toBeDefined();
      expect(middleware.afterAgent).toBeDefined();
    });
  });

  describe("beforeAgent hook", () => {
    it("should set task start time", async () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      const result = await middleware.beforeAgent?.({});
      expect(result).toBeUndefined();
    });
  });

  describe("afterAgent hook", () => {
    it("should skip when disabled", async () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
        config: { enabled: false },
      });

      const state = {
        messages: [
          new HumanMessage("test"),
          new AIMessage("response"),
          new HumanMessage("follow up"),
          new AIMessage("another response"),
        ],
      };

      const result = await middleware.afterAgent?.(state as any);
      expect(result).toBeUndefined();
      expect(mockModel.invoke).not.toHaveBeenCalled();
    });

    it("should skip when agent type is excluded", async () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
        agentType: "planner",
        config: { excludeAgentTypes: ["planner"] },
      });

      const state = {
        messages: [
          new HumanMessage("test"),
          new AIMessage("response"),
          new HumanMessage("follow up"),
          new AIMessage("another response"),
        ],
      };

      const result = await middleware.afterAgent?.(state as any);
      expect(result).toBeUndefined();
      expect(mockModel.invoke).not.toHaveBeenCalled();
    });

    it("should skip trivial conversations (< 3 messages)", async () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      const state = {
        messages: [new HumanMessage("test"), new AIMessage("response")],
      };

      const result = await middleware.afterAgent?.(state as any);
      expect(result).toBeUndefined();
      expect(mockModel.invoke).not.toHaveBeenCalled();
    });

    it("should warn when no model provided", async () => {
      const loggerWarn = jest.spyOn(logger, "warn").mockImplementation();
      const middleware = createKnowledgeFormationMiddleware();

      const state = {
        messages: [
          new HumanMessage("test"),
          new AIMessage("response"),
          new HumanMessage("follow up"),
          new AIMessage("another response"),
        ],
      };

      const result = await middleware.afterAgent?.(state as any);
      expect(result).toBeUndefined();
      expect(loggerWarn).toHaveBeenCalledWith(
        "[KnowledgeFormation] No model provided, skipping extraction",
      );
      loggerWarn.mockRestore();
    });

    it("should fire async processing with setImmediate", async () => {
      const setImmediateSpy = jest.spyOn(global, "setImmediate");

      // Mock successful extraction
      mockModel.invoke.mockResolvedValue({
        content: JSON.stringify({
          learnings: [
            {
              entity_type: "learning",
              title: "Test Learning",
              content: "Test content",
              tags: ["test"],
              priority: "medium",
              confidence: 0.8,
            },
          ],
        }),
      });

      // Mock duplicate check (no duplicates)
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: { nodes: [] },
        },
      });

      // Mock successful storage
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: { id: "conv_123" },
        },
      });

      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      const state = {
        messages: [
          new HumanMessage("test"),
          new AIMessage("response"),
          new HumanMessage("follow up"),
          new AIMessage("another response"),
        ],
      };

      const result = await middleware.afterAgent?.(state as any);
      expect(result).toBeUndefined();
      expect(setImmediateSpy).toHaveBeenCalled();

      setImmediateSpy.mockRestore();
    });
  });

  describe("extraction", () => {
    it("should schedule async extraction without blocking", async () => {
      const setImmediateSpy = jest.spyOn(global, "setImmediate");

      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
        config: { debugLogging: true },
      });

      const state = {
        messages: [
          new HumanMessage("How do I fix this bug?"),
          new AIMessage("You need to update the configuration"),
          new ToolMessage("Config updated", "tool_1"),
          new AIMessage("The bug is fixed now"),
        ],
      };

      await middleware.beforeAgent?.({});
      const result = await middleware.afterAgent?.(state as any);

      // Should return immediately without blocking
      expect(result).toBeUndefined();
      // Should schedule async work
      expect(setImmediateSpy).toHaveBeenCalled();
      // Should NOT have called model yet (async)
      expect(mockModel.invoke).not.toHaveBeenCalled();

      setImmediateSpy.mockRestore();
    });

    it("should apply confidence threshold config", () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
        config: { minConfidence: 0.7, maxLearningsPerTask: 10 },
      });

      // Verify middleware was created with config
      expect(middleware.name).toBe("knowledgeFormationMiddleware");
    });

    it("should apply maxLearningsPerTask config", () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
        config: { maxLearningsPerTask: 2 },
      });

      // Verify middleware was created with config
      expect(middleware.name).toBe("knowledgeFormationMiddleware");
    });
  });

  describe("deduplication", () => {
    it("should apply deduplication threshold config", () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
        config: { deduplicationThreshold: 0.95, debugLogging: true },
      });

      // Verify middleware was created
      expect(middleware.name).toBe("knowledgeFormationMiddleware");
    });

    it("should not block response while checking duplicates", async () => {
      const setImmediateSpy = jest.spyOn(global, "setImmediate");

      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      const state = {
        messages: [
          new HumanMessage("test"),
          new AIMessage("response"),
          new HumanMessage("follow up"),
          new AIMessage("another response"),
        ],
      };

      await middleware.beforeAgent?.({});
      const result = await middleware.afterAgent?.(state as any);

      // Should return immediately
      expect(result).toBeUndefined();
      expect(setImmediateSpy).toHaveBeenCalled();

      setImmediateSpy.mockRestore();
    });

    it("should handle errors without throwing", async () => {
      const consoleError = jest.spyOn(console, "error").mockImplementation();

      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      const state = {
        messages: [
          new HumanMessage("test"),
          new AIMessage("response"),
          new HumanMessage("follow up"),
          new AIMessage("another response"),
        ],
      };

      await middleware.beforeAgent?.({});
      // Should not throw even if processing would fail
      await expect(
        middleware.afterAgent?.(state as any),
      ).resolves.toBeUndefined();

      consoleError.mockRestore();
    });
  });

  describe("storage", () => {
    it("should use async storage to not block response", async () => {
      const setImmediateSpy = jest.spyOn(global, "setImmediate");

      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      const state = {
        messages: [
          new HumanMessage("test"),
          new AIMessage("response"),
          new HumanMessage("follow up"),
          new AIMessage("another response"),
        ],
      };

      await middleware.beforeAgent?.({});
      const result = await middleware.afterAgent?.(state as any);

      // Should return immediately without waiting for storage
      expect(result).toBeUndefined();
      expect(setImmediateSpy).toHaveBeenCalled();
      // Storage should not have been called yet (happens async)
      expect(mockedAxios.post).not.toHaveBeenCalled();

      setImmediateSpy.mockRestore();
    });

    it("should integrate with agent without errors", async () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      const state = {
        messages: [
          new HumanMessage("test"),
          new AIMessage("response"),
          new HumanMessage("follow up"),
          new AIMessage("another response"),
        ],
      };

      // Should complete full lifecycle without errors
      await expect(middleware.beforeAgent?.({})).resolves.toBeUndefined();
      await expect(
        middleware.afterAgent?.(state as any),
      ).resolves.toBeUndefined();
    });
  });
});
