import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import {
  shouldUseHyDE,
  processQueryWithHyDE,
  generateHypotheticalDocument,
  clearHyDECache,
  getHyDECacheStats,
  getHyDEConfig,
  resetHyDE,
} from "../../../src/utils/hyde.js";
import { HYDE_CONFIG } from "../../../src/utils/hyde.js";

// Shared mock invoke function that can be configured per-test
const mockInvoke = jest.fn();

// Mock the model creation with shared mockInvoke
jest.mock("../../../src/config/model-config.js", () => ({
  createMemoryModel: jest.fn(async () => ({
    invoke: mockInvoke,
  })),
}));

describe("HyDE", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset HyDE module state before each test
    resetHyDE();
    clearHyDECache();
    jest.resetModules();
    process.env = { ...originalEnv };

    // Default mock: successful LLM response
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (prompt: string) => ({
      content: `Hypothetical document for: ${prompt.substring(0, 50)}...`,
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    resetHyDE();
  });

  describe("shouldUseHyDE", () => {
    const config = HYDE_CONFIG;

    describe("Query length heuristics", () => {
      it("should skip short queries below min word count", () => {
        const result = shouldUseHyDE("short query", config);
        expect(result.shouldUse).toBe(false);
        expect(result.reason).toContain("too short");
      });

      it("should consider queries at or above min word count", () => {
        const result = shouldUseHyDE(
          "how to implement data validation",
          config,
        );
        expect(result.shouldUse).toBe(true);
        expect(result.reason).toContain("trigger pattern");
      });
    });

    describe("Skip patterns", () => {
      it("should skip technical specifics with function names", () => {
        const queries = [
          "error TypeError in the module",
          "function createAgent is not working",
          "class MemoryClient has a bug",
          "api endpoint authenticate is failing",
        ];

        for (const query of queries) {
          const result = shouldUseHyDE(query, config);
          expect(result.shouldUse).toBe(false);
          expect(result.reason).toContain("skip pattern");
        }
      });

      it("should skip entity IDs", () => {
        // Entity ID pattern only matches exact format: conv_xxxxx
        const result = shouldUseHyDE("conv_123456789", config);
        expect(result.shouldUse).toBe(false);
        expect(result.reason).toContain("too short");
      });

      it("should skip function signatures", () => {
        // Function signature pattern only matches exact format: func_name()
        const queries = [
          "createAgent()",
          "process_data(input)",
          "authenticate_user(token)",
        ];

        for (const query of queries) {
          const result = shouldUseHyDE(query, config);
          expect(result.shouldUse).toBe(false);
          expect(result.reason).toContain("too short");
        }
      });
    });

    describe("Trigger patterns", () => {
      it("should trigger on question words at start", () => {
        const queries = [
          "how to implement authentication",
          "what is the best approach",
          "why does caching fail",
          "when should I use HyDE",
          "where is the config stored",
          "which pattern should I use",
        ];

        for (const query of queries) {
          const result = shouldUseHyDE(query, config);
          expect(result.shouldUse).toBe(true);
          expect(result.reason).toContain("trigger pattern");
        }
      });

      it("should trigger on abstract concept keywords", () => {
        const queries = [
          "authentication pattern for backend services",
          "best approach to data validation",
          "caching strategy for database queries",
          "best practice for testing components",
          "way to implement middleware layers",
          "testing strategy in production systems",
        ];

        for (const query of queries) {
          const result = shouldUseHyDE(query, config);
          expect(result.shouldUse).toBe(true);
          expect(result.reason).toContain("trigger pattern");
        }
      });

      it("should be case-insensitive for triggers", () => {
        const queries = [
          "HOW to implement caching correctly",
          "WHAT is the best pattern",
          "Pattern for authentication in apps",
        ];

        for (const query of queries) {
          const result = shouldUseHyDE(query, config);
          expect(result.shouldUse).toBe(true);
        }
      });
    });

    describe("Default behavior", () => {
      it("should skip queries that don't match any patterns", () => {
        const result = shouldUseHyDE("implement the new feature", config);
        expect(result.shouldUse).toBe(false);
        expect(result.reason).toContain("does not match");
      });
    });

    describe("Priority: skip over trigger", () => {
      it("should skip even if trigger pattern matches when skip pattern also matches", () => {
        // This has both "how" (trigger) and "error" (skip)
        const result = shouldUseHyDE("how to fix error TypeError", config);
        expect(result.shouldUse).toBe(false);
        expect(result.reason).toContain("skip pattern");
      });
    });
  });

  describe("generateHypotheticalDocument", () => {
    const config = HYDE_CONFIG;

    it("should generate a hypothetical document using LLM", async () => {
      const query = "how to implement caching";
      const result = await generateHypotheticalDocument(query, config);

      expect(result.document).toBeDefined();
      expect(result.document).toContain("Hypothetical document");
      expect(result.cached).toBe(false);

      // AGI-312: the usage-envelope callback handler is attached so this
      // side-channel call emits a raw usage row.
      const config0 = mockInvoke.mock.calls[0]?.[1] as
        | { callbacks?: Array<{ name?: string }> }
        | undefined;
      expect(config0?.callbacks?.[0]?.name).toBe(
        "usageEnvelopeCallbackHandler",
      );
    });

    it("should cache the generated document", async () => {
      const query = "how to implement authentication";

      // First call - not cached
      const result1 = await generateHypotheticalDocument(query, config);
      expect(result1.cached).toBe(false);

      // Second call - should be cached
      const result2 = await generateHypotheticalDocument(query, config);
      expect(result2.cached).toBe(true);
      expect(result2.document).toBe(result1.document);
    });

    it("should update cache stats", async () => {
      clearHyDECache();
      const query = "what is the best pattern";

      await generateHypotheticalDocument(query, config);
      await generateHypotheticalDocument(query, config); // Cache hit

      const stats = getHyDECacheStats();
      expect(stats).toBeDefined();
      expect(stats!.hits).toBe(1);
      expect(stats!.misses).toBe(1);
    });
  });

  describe("processQueryWithHyDE", () => {
    it("should respect explicit opt-out via useHyde=false", async () => {
      const query = "how to implement caching";
      const result = await processQueryWithHyDE(query, { useHyde: false });

      expect(result.applied).toBe(false);
      expect(result.searchQuery).toBe(query);
      expect(result.reason).toContain("Explicitly disabled");
    });

    it("should respect explicit opt-in via useHyde=true", async () => {
      const query = "short"; // Would normally be skipped
      const result = await processQueryWithHyDE(query, { useHyde: true });

      expect(result.applied).toBe(true);
      expect(result.searchQuery).not.toBe(query);
      expect(result.reason).toContain("Explicitly enabled");
    });

    it("should auto-detect and apply HyDE for question queries", async () => {
      const query = "how to implement authentication patterns properly";
      const result = await processQueryWithHyDE(query);

      expect(result.applied).toBe(true);
      expect(result.searchQuery).not.toBe(query);
      expect(result.reason).toContain("Auto-detected");
    });

    it("should auto-detect and skip HyDE for technical queries", async () => {
      const query = "error TypeError in authentication";
      const result = await processQueryWithHyDE(query);

      expect(result.applied).toBe(false);
      expect(result.searchQuery).toBe(query);
      expect(result.reason).toContain("Auto-skipped");
    });

    it("should auto-detect and skip HyDE for short queries", async () => {
      const query = "auth error";
      const result = await processQueryWithHyDE(query);

      expect(result.applied).toBe(false);
      expect(result.searchQuery).toBe(query);
      expect(result.reason).toContain("too short");
    });

    it("should include cached flag when using cached hypothetical doc", async () => {
      const query = "what is the best caching strategy";

      // First call - not cached
      const result1 = await processQueryWithHyDE(query);
      expect(result1.cached).toBe(false);

      // Second call - cached
      const result2 = await processQueryWithHyDE(query);
      expect(result2.cached).toBe(true);
      expect(result2.searchQuery).toBe(result1.searchQuery);
    });

    it("should fallback to original query on LLM error", async () => {
      // Reset the HyDE state to clear cache
      resetHyDE();

      // Configure mockInvoke to throw an error for this test
      mockInvoke.mockRejectedValue(new Error("LLM API error"));

      const query = "how to implement authentication patterns";
      const result = await processQueryWithHyDE(query, { useHyde: true });

      expect(result.applied).toBe(false);
      expect(result.searchQuery).toBe(query);
      expect(result.reason).toContain("Failed to generate");
    });
  });

  describe("Cache Management", () => {
    it("should clear the cache", async () => {
      const query = "how to implement testing patterns";
      await processQueryWithHyDE(query);

      let stats = getHyDECacheStats();
      expect(stats!.size).toBeGreaterThan(0);

      clearHyDECache();

      stats = getHyDECacheStats();
      expect(stats!.size).toBe(0);
      expect(stats!.hits).toBe(0);
      expect(stats!.misses).toBe(0);
    });

    it("should get cache statistics", async () => {
      clearHyDECache();
      const query1 = "how to implement authentication";
      const query2 = "what is the best caching pattern";

      await processQueryWithHyDE(query1); // Miss, then set
      await processQueryWithHyDE(query1); // Hit
      await processQueryWithHyDE(query2); // Miss, then set

      const stats = getHyDECacheStats();
      expect(stats).toBeDefined();
      expect(stats!.size).toBe(2);
      expect(stats!.hits).toBeGreaterThanOrEqual(1);
      expect(stats!.misses).toBeGreaterThanOrEqual(2);
    });

    it("should return null stats when cache not initialized", () => {
      resetHyDE();
      const stats = getHyDECacheStats();
      expect(stats).toBeNull();
    });
  });

  describe("Configuration", () => {
    it("should load default configuration", () => {
      const config = getHyDEConfig();
      expect(config.enabled).toBe(true);
      expect(config.autoDetectEnabled).toBe(true);
      expect(config.cache.maxSize).toBe(100);
    });

    it("should accept custom config in processQueryWithHyDE", async () => {
      const customConfig = {
        ...HYDE_CONFIG,
        heuristics: {
          ...HYDE_CONFIG.heuristics,
          minWordCount: 10,
        },
      };

      const query = "how to do this"; // 4 words - would pass with default, fail with custom
      const result = await processQueryWithHyDE(query, {
        config: customConfig,
      });

      expect(result.applied).toBe(false);
      expect(result.reason).toContain("too short");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty query", async () => {
      const result = await processQueryWithHyDE("");
      expect(result.applied).toBe(false);
      expect(result.searchQuery).toBe("");
    });

    it("should handle query with only whitespace", async () => {
      const result = await processQueryWithHyDE("   ");
      expect(result.applied).toBe(false);
    });

    it("should trim query for word count", () => {
      const query = "  how to implement caching strategies  ";
      const result = shouldUseHyDE(query, HYDE_CONFIG);

      // After trimming, the query should have 5 words and match the "how" trigger pattern
      expect(result.shouldUse).toBe(true);
      expect(result.reason).toContain("trigger pattern");
    });
  });
});
