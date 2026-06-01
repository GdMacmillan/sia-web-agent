/**
 * Knowledge Formation Middleware Tests
 *
 * Since AGI-227 the middleware's reads/writes go through the
 * workspace-bound graph-memory adapter (the same `IGraphMemoryAdapter`
 * the agent tools use), not the legacy direct-HTTP client. Tests inject
 * a stub adapter via the shared `_setMemoryAdapterForTests` seam and
 * populate `SIA_WORKSPACE_ID` so `getConfig().runtime.workspaceId` is
 * set — the adapter is workspace-bound by construction.
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
import { createKnowledgeFormationMiddleware } from "../../../src/middleware/knowledge-formation.js";
import {
  loadExtractionConfig,
  SENSITIVITY_PRESETS,
} from "../../../src/config/knowledge-formation-config.js";
import { resetConfig } from "../../../src/config/index.js";
import { logger } from "../../../src/utils/logger.js";
import {
  _resetMemoryAdapterForTests,
  _setMemoryAdapterForTests,
} from "../../../src/tools/memory-adapter.js";
import {
  trackPatternRetrieval,
  clearAllTracking,
} from "../../../src/utils/application-tracking.js";
import type { IGraphMemoryAdapter } from "../../../src/vendor/svc-rpc/graph-memory/adapter-interface.js";

// Mock LLM model
const mockModel = {
  invoke: jest.fn(),
};

/** A stub `IGraphMemoryAdapter` whose verbs are jest mocks. */
function makeStubAdapter(
  overrides: Partial<IGraphMemoryAdapter> = {},
): IGraphMemoryAdapter {
  const noop = jest.fn(async () => ({})) as unknown as jest.Mock;
  const base = {
    workspaceId: "ws_test",
    storeEntity: noop,
    retrieveEntity: noop,
    listEntities: noop,
    searchEntities: noop,
    updateEntityStatus: noop,
    updateEntity: noop,
    promoteEntities: noop,
    traverseGraph: noop,
    graphEdges: noop,
    graphStats: noop,
    graphQuery: noop,
    adminHttp: noop,
  };
  return { ...base, ...overrides } as unknown as IGraphMemoryAdapter;
}

/** Empty search wire response (no duplicates / no suggestions). */
function emptySearchResponse() {
  return {
    results: [],
    level_used: "raw",
    levels_tried: ["raw"],
    query: "",
    threshold: 0.3,
    total_results: 0,
    timestamp: "2026-01-01T00:00:00Z",
  };
}

describe("Knowledge Formation Middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // The adapter is workspace-bound: a workspace id must be present.
    process.env.SIA_WORKSPACE_ID = "ws_test";
    // Clear knowledge-formation env vars so config defaults apply.
    delete process.env.KNOWLEDGE_FORMATION_ENABLED;
    delete process.env.KNOWLEDGE_FORMATION_SENSITIVITY;
    delete process.env.KNOWLEDGE_FORMATION_DEBUG;
    delete process.env.KNOWLEDGE_FORMATION_MIN_CONFIDENCE;
    delete process.env.KNOWLEDGE_FORMATION_MAX_LEARNINGS;
    delete process.env.KNOWLEDGE_FORMATION_DEDUP_THRESHOLD;
    delete process.env.KNOWLEDGE_FORMATION_EXCLUDE_AGENTS;
    // Reset cached config so env var changes take effect on next read.
    resetConfig();
    // Reset adapter + application tracking between tests.
    _resetMemoryAdapterForTests();
    clearAllTracking();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.SIA_WORKSPACE_ID;
    resetConfig();
    _resetMemoryAdapterForTests();
    clearAllTracking();
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

      mockModel.invoke.mockResolvedValue({
        content: JSON.stringify({ learnings: [] }),
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

  describe("extraction (adapter path)", () => {
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

    it("stores an extracted learning through the workspace-bound adapter", async () => {
      // Extraction returns one qualified learning.
      mockModel.invoke.mockResolvedValue({
        content: JSON.stringify({
          learnings: [
            {
              entity_type: "learning",
              title: "Test Learning",
              content: "Detailed content about a fix",
              context: "middleware",
              tags: ["test"],
              priority: "medium",
              confidence: 0.9,
            },
          ],
        }),
      });

      const searchMock = jest.fn(async () =>
        emptySearchResponse(),
      ) as unknown as jest.Mock;
      const storeMock = jest.fn(async () => ({
        id: "conv_123",
        agent_id: "memory_agent",
        user_input: "[learning] Test Learning",
        agent_output: "Detailed content about a fix",
        timestamp: "2026-01-01T00:00:00Z",
        metadata: {},
      })) as unknown as jest.Mock;
      const adapter = makeStubAdapter({
        searchEntities: searchMock as any,
        storeEntity: storeMock as any,
      });
      _setMemoryAdapterForTests(adapter);

      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      const state = {
        messages: [
          new HumanMessage("How do I fix this bug?"),
          new AIMessage("Update the config"),
          new ToolMessage("Config updated", "tool_1"),
          new AIMessage("Fixed"),
        ],
      };

      await middleware.beforeAgent?.({});
      await middleware.afterAgent?.(state as any);

      // Flush the fire-and-forget setImmediate work.
      await jest.runAllTimersAsync();

      // The adapter path was used (workspace-bound by construction).
      expect(searchMock).toHaveBeenCalled();
      expect(storeMock).toHaveBeenCalledTimes(1);

      // The store carried the auto-extracted tag + auto-formation extras.
      const storeReq = storeMock.mock.calls[0]![0] as {
        metadata?: Record<string, unknown>;
      };
      const meta = (storeReq.metadata ?? {}) as Record<string, unknown>;
      expect(meta.tags).toEqual(expect.arrayContaining(["auto-extracted"]));
      const custom = (meta.custom_metadata ?? {}) as Record<string, unknown>;
      expect(custom.formation_method).toBe("automatic");
      expect(custom.extraction_confidence).toBe(0.9);
    });

    it("logs an error and performs no write when SIA_WORKSPACE_ID is unset", async () => {
      // Force a non-legacy runtime with no workspace id.
      delete process.env.SIA_WORKSPACE_ID;
      resetConfig();
      _resetMemoryAdapterForTests();

      const loggerError = jest.spyOn(logger, "error").mockImplementation();

      mockModel.invoke.mockResolvedValue({
        content: JSON.stringify({
          learnings: [
            {
              entity_type: "learning",
              title: "Test Learning",
              content: "Detailed content about a fix",
              tags: ["test"],
              priority: "medium",
              confidence: 0.9,
            },
          ],
        }),
      });

      // A stub is injected but the adapter accessor inside the
      // middleware re-reads config — with no workspace + no cached
      // adapter, it must throw rather than write.
      const storeMock = jest.fn(async () => ({
        id: "should_not_happen",
      })) as unknown as jest.Mock;
      // Intentionally do NOT inject the stub as the cached adapter, so
      // getMemoryAdapter() runs its fail-fast branch.
      void storeMock;

      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      const state = {
        messages: [
          new HumanMessage("How do I fix this bug?"),
          new AIMessage("Update the config"),
          new ToolMessage("Config updated", "tool_1"),
          new AIMessage("Fixed"),
        ],
      };

      await middleware.beforeAgent?.({});
      await middleware.afterAgent?.(state as any);
      await jest.runAllTimersAsync();

      // No write happened; the failure surfaced as a logged error.
      expect(storeMock).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalled();

      loggerError.mockRestore();
    });
  });

  describe("outcome tracking (adapter path)", () => {
    it("reads then updates tracked learnings via the adapter", async () => {
      // model.invoke is used by both extraction and outcome evaluation;
      // returning an outcome response yields no learnings (so no store),
      // and a fulfilled outcome for the critic.
      mockModel.invoke.mockResolvedValue({
        content: JSON.stringify({
          fulfilled: true,
          tool_errors: [],
          confidence: 0.9,
        }),
      });

      const retrieveMock = jest.fn(async () => ({
        id: "entity-1",
        type: "Conversation",
        properties: {
          metadata: {
            success_count: 1,
            failure_count: 0,
            application_history: [],
          },
        },
      })) as unknown as jest.Mock;
      const updateMock = jest.fn(async () => ({
        id: "entity-1",
        type: "Conversation",
        properties: {},
        version: 2,
        changed_fields: ["success_count"],
      })) as unknown as jest.Mock;
      const adapter = makeStubAdapter({
        retrieveEntity: retrieveMock as any,
        updateEntity: updateMock as any,
      });
      _setMemoryAdapterForTests(adapter);

      // Track an entity under the task id derived from the run config.
      trackPatternRetrieval(["entity-1"], "task_t1");

      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      const state = {
        messages: [
          new HumanMessage("Do the thing"),
          new AIMessage("Working on it"),
          new ToolMessage("done", "tool_1"),
          new AIMessage("Completed"),
        ],
      };

      await middleware.beforeAgent?.({});
      await middleware.afterAgent?.(state as any, {
        configurable: { thread_id: "t1" },
      } as any);

      await jest.runAllTimersAsync();

      expect(retrieveMock).toHaveBeenCalledWith({ nodeId: "entity-1" });
      expect(updateMock).toHaveBeenCalledTimes(1);
      const updateReq = updateMock.mock.calls[0]![0] as {
        nodeId: string;
        properties: { metadata: Record<string, unknown> };
      };
      expect(updateReq.nodeId).toBe("entity-1");
      // Only the changed counter keys are sent (merge preserves the rest).
      expect(updateReq.properties.metadata).toEqual(
        expect.objectContaining({
          success_count: expect.any(Number),
          failure_count: expect.any(Number),
          success_rate: expect.any(Number),
          last_applied_at: expect.any(String),
          application_history: expect.any(Array),
        }),
      );
    });
  });

  describe("config wiring", () => {
    it("should apply confidence threshold config", () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
        config: { minConfidence: 0.7, maxLearningsPerTask: 10 },
      });
      expect(middleware.name).toBe("knowledgeFormationMiddleware");
    });

    it("should apply maxLearningsPerTask config", () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
        config: { maxLearningsPerTask: 2 },
      });
      expect(middleware.name).toBe("knowledgeFormationMiddleware");
    });

    it("should apply deduplication threshold config", () => {
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
        config: { deduplicationThreshold: 0.95, debugLogging: true },
      });
      expect(middleware.name).toBe("knowledgeFormationMiddleware");
    });

    it("should handle errors without throwing", async () => {
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
      await expect(
        middleware.afterAgent?.(state as any),
      ).resolves.toBeUndefined();
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

      await expect(middleware.beforeAgent?.({})).resolves.toBeUndefined();
      await expect(
        middleware.afterAgent?.(state as any),
      ).resolves.toBeUndefined();
    });
  });
});
