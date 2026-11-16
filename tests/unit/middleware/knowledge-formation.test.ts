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
    findSimilarEntities: noop,
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

/** One stored entity as it arrives in a search wire response. */
function searchHit(id: string, title: string, content: string) {
  return {
    id,
    type: "Conversation",
    properties: {
      user_input: `[learning] ${title}`,
      agent_output: content,
      metadata: { entity_type: "learning", title, status: "active" },
    },
  };
}

/** A model reply carrying one learning that clears the confidence bar. */
function extractionResponse(learning: {
  title: string;
  content: string;
  confidence?: number;
}) {
  return {
    content: JSON.stringify({
      learnings: [
        {
          entity_type: "learning",
          tags: ["test"],
          priority: "medium",
          confidence: 0.9,
          ...learning,
        },
      ],
    }),
  };
}

/** A store mock that answers with a well-formed stored entity. */
function storedResponseMock(): jest.Mock {
  return jest.fn(async () => ({
    id: "conv_new",
    agent_id: "memory_agent",
    user_input: "[learning] stored",
    agent_output: "stored",
    timestamp: "2026-01-01T00:00:00Z",
    metadata: {},
  })) as unknown as jest.Mock;
}

const TASK_MESSAGES = [
  new HumanMessage("How do I fix this bug?"),
  new AIMessage("Update the config"),
  new ToolMessage("Config updated", "tool_1"),
  new AIMessage("Fixed"),
];

/** Run one agent turn through the middleware and flush its async work. */
async function runOnce(
  middleware: ReturnType<typeof createKnowledgeFormationMiddleware>,
  messages: unknown[],
  before: unknown[] = messages,
): Promise<void> {
  await middleware.beforeAgent?.({ messages: before } as any);
  await middleware.afterAgent?.({ messages } as any);
  await jest.runAllTimersAsync();
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

  describe("duplicate check", () => {
    it("stores a learning when search returns an unrelated entity", async () => {
      // A search hit only says some entity shares a word with the query.
      // It is not evidence that this learning is already stored.
      mockModel.invoke.mockResolvedValue(
        extractionResponse({
          title: "Release train leaves on Thursdays",
          content: "The team agreed in the room to ship every Thursday.",
        }),
      );
      const storeMock = storedResponseMock();
      _setMemoryAdapterForTests(
        makeStubAdapter({
          searchEntities: jest.fn(async () => ({
            ...emptySearchResponse(),
            results: [
              searchHit("conv_other", "Thursday standup notes", "Standup."),
            ],
          })) as any,
          storeEntity: storeMock as any,
        }),
      );

      await runOnce(
        createKnowledgeFormationMiddleware({ model: mockModel as any }),
        TASK_MESSAGES,
      );

      expect(storeMock).toHaveBeenCalledTimes(1);
    });

    it("skips a learning whose title is already stored, without scoring it", async () => {
      mockModel.invoke.mockResolvedValue(
        extractionResponse({
          title: "Release train: leaves on Thursdays!",
          content: "The team ships every Thursday.",
        }),
      );
      const storeMock = storedResponseMock();
      const similarMock = jest.fn(async () => ({ results: [] }));
      const loggerInfo = jest.spyOn(logger, "info").mockImplementation();
      _setMemoryAdapterForTests(
        makeStubAdapter({
          // Same title apart from case, punctuation and spacing.
          searchEntities: jest.fn(async () => ({
            ...emptySearchResponse(),
            results: [
              searchHit("conv_other", "Unrelated", "Other."),
              searchHit(
                "conv_same",
                "release train  leaves on thursdays",
                "Old.",
              ),
            ],
          })) as any,
          findSimilarEntities: similarMock as any,
          storeEntity: storeMock as any,
        }),
      );

      await runOnce(
        createKnowledgeFormationMiddleware({ model: mockModel as any }),
        TASK_MESSAGES,
      );

      expect(storeMock).not.toHaveBeenCalled();
      expect(similarMock).not.toHaveBeenCalled();
      expect(loggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "same-title",
          matchedId: "conv_same",
        }),
        "[KnowledgeFormation] Skipped learning",
      );
      loggerInfo.mockRestore();
    });

    it("skips a learning scored at or above the threshold", async () => {
      mockModel.invoke.mockResolvedValue(
        extractionResponse({ title: "A new title", content: "Same fact." }),
      );
      const storeMock = storedResponseMock();
      const similarMock = jest.fn(async () => ({
        results: [
          {
            id: "conv_close",
            title: "Old title",
            similarity: 0.9,
            similarity_type: "embedding",
            lexical_overlap: 0.6,
          },
        ],
      }));
      const loggerInfo = jest.spyOn(logger, "info").mockImplementation();
      _setMemoryAdapterForTests(
        makeStubAdapter({
          searchEntities: jest.fn(async () => emptySearchResponse()) as any,
          findSimilarEntities: similarMock as any,
          storeEntity: storeMock as any,
        }),
      );

      await runOnce(
        createKnowledgeFormationMiddleware({
          model: mockModel as any,
          config: { deduplicationThreshold: 0.9 },
        }),
        TASK_MESSAGES,
      );

      expect(similarMock).toHaveBeenCalledWith({
        title: "A new title",
        content: "Same fact.",
      });
      expect(storeMock).not.toHaveBeenCalled();
      expect(loggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "similar-content",
          matchedId: "conv_close",
          similarity: 0.9,
        }),
        "[KnowledgeFormation] Skipped learning",
      );
      loggerInfo.mockRestore();
    });

    it("stores a learning scored below the threshold", async () => {
      mockModel.invoke.mockResolvedValue(
        extractionResponse({ title: "A new title", content: "A new fact." }),
      );
      const storeMock = storedResponseMock();
      const loggerInfo = jest.spyOn(logger, "info").mockImplementation();
      _setMemoryAdapterForTests(
        makeStubAdapter({
          searchEntities: jest.fn(async () => emptySearchResponse()) as any,
          findSimilarEntities: jest.fn(async () => ({
            results: [
              {
                id: "conv_far",
                title: "Old title",
                similarity: 0.89,
                similarity_type: "embedding",
                lexical_overlap: 0.2,
              },
            ],
          })) as any,
          storeEntity: storeMock as any,
        }),
      );

      await runOnce(
        createKnowledgeFormationMiddleware({
          model: mockModel as any,
          config: { deduplicationThreshold: 0.9 },
        }),
        TASK_MESSAGES,
      );

      expect(storeMock).toHaveBeenCalledTimes(1);
      expect(loggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "A new title",
          entityId: "conv_new",
          duplicateCheck: "scored",
        }),
        "[KnowledgeFormation] Stored learning",
      );
      loggerInfo.mockRestore();
    });

    it("stores a learning when memory cannot score it", async () => {
      // An older host does not know the scoring call. The title
      // comparison is then the whole check, and the learning is kept.
      mockModel.invoke.mockResolvedValue(
        extractionResponse({ title: "A new title", content: "A new fact." }),
      );
      const storeMock = storedResponseMock();
      const loggerInfo = jest.spyOn(logger, "info").mockImplementation();
      _setMemoryAdapterForTests(
        makeStubAdapter({
          searchEntities: jest.fn(async () => emptySearchResponse()) as any,
          findSimilarEntities: jest.fn(async () => {
            throw new Error("unknown verb");
          }) as any,
          storeEntity: storeMock as any,
        }),
      );

      await runOnce(
        createKnowledgeFormationMiddleware({ model: mockModel as any }),
        TASK_MESSAGES,
      );

      expect(storeMock).toHaveBeenCalledTimes(1);
      expect(loggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ duplicateCheck: "title-only" }),
        "[KnowledgeFormation] Stored learning",
      );
      loggerInfo.mockRestore();
    });

    it("stores a fact once when the same thread runs twice", async () => {
      mockModel.invoke.mockResolvedValue(
        extractionResponse({
          title: "Release train leaves on Thursdays",
          content: "The team ships every Thursday.",
        }),
      );
      // A memory that holds what was stored into it.
      const held: ReturnType<typeof searchHit>[] = [];
      const storeMock = jest.fn(async () => {
        held.push(
          searchHit(
            "conv_new",
            "Release train leaves on Thursdays",
            "The team ships every Thursday.",
          ),
        );
        return { id: "conv_new", metadata: {} };
      });
      _setMemoryAdapterForTests(
        makeStubAdapter({
          searchEntities: jest.fn(async () => ({
            ...emptySearchResponse(),
            results: [...held],
          })) as any,
          findSimilarEntities: jest.fn(async () => ({ results: [] })) as any,
          storeEntity: storeMock as any,
        }),
      );
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      await runOnce(middleware, TASK_MESSAGES);
      await runOnce(middleware, [
        ...TASK_MESSAGES,
        new HumanMessage("And when do we ship?"),
        new AIMessage("Thursdays."),
      ]);

      expect(mockModel.invoke).toHaveBeenCalledTimes(2);
      expect(storeMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("outcome logging", () => {
    it("logs at info when nothing was extracted", async () => {
      mockModel.invoke.mockResolvedValue({
        content: JSON.stringify({ learnings: [] }),
      });
      const loggerInfo = jest.spyOn(logger, "info").mockImplementation();
      _setMemoryAdapterForTests(makeStubAdapter());

      await runOnce(
        createKnowledgeFormationMiddleware({ model: mockModel as any }),
        TASK_MESSAGES,
      );

      expect(loggerInfo).toHaveBeenCalledWith(
        expect.any(Object),
        "[KnowledgeFormation] No learnings extracted",
      );
      loggerInfo.mockRestore();
    });

    it("logs at info when a learning is below the confidence bar", async () => {
      mockModel.invoke.mockResolvedValue(
        extractionResponse({
          title: "A weak guess",
          content: "Maybe.",
          confidence: 0.2,
        }),
      );
      const storeMock = storedResponseMock();
      const loggerInfo = jest.spyOn(logger, "info").mockImplementation();
      _setMemoryAdapterForTests(
        makeStubAdapter({ storeEntity: storeMock as any }),
      );

      await runOnce(
        createKnowledgeFormationMiddleware({ model: mockModel as any }),
        TASK_MESSAGES,
      );

      expect(storeMock).not.toHaveBeenCalled();
      expect(loggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "A weak guess",
          reason: "below-confidence",
          confidence: 0.2,
        }),
        "[KnowledgeFormation] Skipped learning",
      );
      loggerInfo.mockRestore();
    });
  });

  describe("extraction input", () => {
    /** The user prompt handed to the extraction model. */
    function extractionPrompt(): string {
      const sent = mockModel.invoke.mock.calls[0]![0] as { content: string }[];
      return sent[1]!.content;
    }

    it("covers the current run, not the start of a long thread", async () => {
      mockModel.invoke.mockResolvedValue({
        content: JSON.stringify({ learnings: [] }),
      });
      _setMemoryAdapterForTests(makeStubAdapter());

      const history = [
        new HumanMessage({ content: "OLD TOPIC from last week", id: "h1" }),
        new AIMessage({ content: "OLD REPLY", id: "a1" }),
      ];
      const arrived = new HumanMessage({
        id: "h2",
        content:
          '<room-message from="dana" source="member" requested-by="member">\n' +
          "A member of this room. Help them.\n" +
          "The launch moved to March 3.\n" +
          "</room-message>",
      });
      const reply = new AIMessage({
        id: "a2",
        content: [{ type: "text", text: "Noted, March 3." }],
      });

      await runOnce(
        createKnowledgeFormationMiddleware({ model: mockModel as any }),
        [...history, arrived, reply],
        [...history, arrived],
      );

      const prompt = extractionPrompt();
      expect(prompt).toContain("dana (member): The launch moved to March 3.");
      expect(prompt).toContain("[ai]: Noted, March 3.");
      expect(prompt).not.toContain("OLD TOPIC");
      expect(prompt).not.toContain("OLD REPLY");
      // The envelope and its fixed first line are not conversation.
      expect(prompt).not.toContain("room-message");
      expect(prompt).not.toContain("A member of this room");
    });

    it("leaves out context the host attached to a tool result", async () => {
      mockModel.invoke.mockResolvedValue({
        content: JSON.stringify({ learnings: [] }),
      });
      _setMemoryAdapterForTests(makeStubAdapter());

      await runOnce(
        createKnowledgeFormationMiddleware({ model: mockModel as any }),
        [
          new HumanMessage("Find the retry setting"),
          new AIMessage("Searching"),
          new ToolMessage(
            '2 matches\n\n<host-context source="memory" kind="memory">\n' +
              "Retrieved from shared memory.\nAN OLD MEMORY ENTRY\n</host-context>",
            "tool_1",
          ),
          new AIMessage("It is in config.ts"),
        ],
      );

      const prompt = extractionPrompt();
      expect(prompt).toContain("[tool]: 2 matches");
      expect(prompt).not.toContain("AN OLD MEMORY ENTRY");
    });

    it("falls back to the whole thread when the run start is unknown", async () => {
      mockModel.invoke.mockResolvedValue({
        content: JSON.stringify({ learnings: [] }),
      });
      _setMemoryAdapterForTests(makeStubAdapter());
      const middleware = createKnowledgeFormationMiddleware({
        model: mockModel as any,
      });

      // No beforeAgent call: nothing marked where the run began.
      await middleware.afterAgent?.({ messages: TASK_MESSAGES } as any);
      await jest.runAllTimersAsync();

      expect(extractionPrompt()).toContain("How do I fix this bug?");
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
