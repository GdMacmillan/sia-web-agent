import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import {
  mightBeComplex,
  decomposeQuery,
  mergeAndRankResults,
  processQueryWithDecomposition,
  clearDecompositionCache,
  getDecompositionCacheStats,
  resetDecomposition,
  type SubQuerySearchResult,
} from "../../../src/utils/query-decomposition.js";
import { DECOMPOSITION_CONFIG } from "../../../src/utils/query-decomposition.js";

// Shared mock invoke function that can be configured per-test
const mockInvoke = jest.fn();

// Mock the model creation with shared mockInvoke
jest.mock("../../../src/config/model-config.js", () => ({
  createMemoryModel: jest.fn(async () => ({
    invoke: mockInvoke,
  })),
}));

describe("Query Decomposition", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset module state before each test
    resetDecomposition();
    clearDecompositionCache();
    jest.resetModules();
    process.env = { ...originalEnv };

    // Default mock: successful LLM response
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async () => ({
      content: JSON.stringify({
        is_complex: true,
        reasoning: "Query has multiple parts",
        sub_queries: ["part 1", "part 2"],
      }),
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    resetDecomposition();
  });

  describe("mightBeComplex", () => {
    const config = DECOMPOSITION_CONFIG;

    describe("Word count heuristics", () => {
      it("should skip short queries below min word count", () => {
        const result = mightBeComplex("short query", config);
        expect(result.mightBeComplex).toBe(false);
        expect(result.reason).toContain("too short");
      });

      it("should consider queries at or above min word count", () => {
        const result = mightBeComplex(
          "authentication patterns and error handling strategies",
          config,
        );
        expect(result.mightBeComplex).toBe(true);
        expect(result.reason).toContain("conjunction");
      });

      it("should always consider very long queries as complex", () => {
        const longQuery =
          "how to implement authentication patterns and error handling strategies with proper logging and monitoring capabilities across multiple services";
        const result = mightBeComplex(longQuery, config);
        expect(result.mightBeComplex).toBe(true);
        expect(result.reason).toContain("long query");
      });
    });

    describe("Conjunction detection", () => {
      it("should detect 'and' conjunctions", () => {
        const result = mightBeComplex(
          "authentication patterns and error handling for secure systems",
          config,
        );
        expect(result.mightBeComplex).toBe(true);
        expect(result.reason).toContain("conjunction");
      });

      it("should detect 'or' conjunctions", () => {
        const result = mightBeComplex(
          "caching strategies or memoization techniques for performance optimization",
          config,
        );
        expect(result.mightBeComplex).toBe(true);
        expect(result.reason).toContain("conjunction");
      });

      it("should detect various conjunction types", () => {
        const queries = [
          "authentication patterns also used in secure testing environments",
          "authentication patterns as well as authorization for systems",
          "caching strategies plus validation for better performance",
          "testing patterns additionally requires proper monitoring and logging",
          "logging strategies furthermore improves debugging and observability",
          "design patterns moreover help with long term maintainability",
        ];

        for (const query of queries) {
          const result = mightBeComplex(query, config);
          expect(result.mightBeComplex).toBe(true);
          expect(result.reason).toContain("conjunction");
        }
      });

      it("should be case-insensitive for conjunctions", () => {
        const result = mightBeComplex(
          "Authentication Patterns AND Error Handling For Systems",
          config,
        );
        expect(result.mightBeComplex).toBe(true);
        expect(result.reason).toContain("conjunction");
      });
    });

    describe("Multiple question words", () => {
      it("should detect multiple question words", () => {
        const result = mightBeComplex(
          "how to implement authentication and what are the best patterns",
          config,
        );
        expect(result.mightBeComplex).toBe(true);
        expect(result.reason).toContain("question words");
      });

      it("should handle various question word combinations", () => {
        const queries = [
          "what is caching and why is it important",
          "where are configs stored and how to access them",
          "when to use patterns and which ones are best",
        ];

        for (const query of queries) {
          const result = mightBeComplex(query, config);
          expect(result.mightBeComplex).toBe(true);
          expect(result.reason).toContain("question words");
        }
      });
    });

    describe("Comma detection", () => {
      it("should detect multiple commas indicating complex structure", () => {
        const result = mightBeComplex(
          "authentication patterns, error handling, logging strategies",
          config,
        );
        expect(result.mightBeComplex).toBe(true);
        expect(result.reason).toContain("commas");
      });

      it("should not trigger on single comma", () => {
        // Single comma alone isn't enough to trigger complexity
        // Test without conjunctions or other complexity signals
        const result = mightBeComplex("one part, another part", config);
        expect(result.mightBeComplex).toBe(false);
      });
    });

    describe("Simple queries", () => {
      it("should not flag simple queries as complex", () => {
        const queries = [
          "authentication patterns",
          "error handling",
          "caching strategies",
        ];

        for (const query of queries) {
          const result = mightBeComplex(query, config);
          expect(result.mightBeComplex).toBe(false);
        }
      });
    });

    describe("Edge cases", () => {
      it("should handle empty query", () => {
        const result = mightBeComplex("", config);
        expect(result.mightBeComplex).toBe(false);
      });

      it("should handle query with only whitespace", () => {
        const result = mightBeComplex("   ", config);
        expect(result.mightBeComplex).toBe(false);
      });

      it("should trim query before analysis", () => {
        const result = mightBeComplex(
          "  authentication patterns and error handling for systems  ",
          config,
        );
        expect(result.mightBeComplex).toBe(true);
      });
    });
  });

  describe("decomposeQuery", () => {
    const config = DECOMPOSITION_CONFIG;

    it("should decompose a complex query into sub-queries", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Query has multiple parts",
          sub_queries: ["authentication patterns", "error handling strategies"],
        }),
      });

      const { result, cached } = await decomposeQuery(
        "authentication patterns and error handling strategies",
        config,
      );

      expect(result.isComplex).toBe(true);
      expect(result.subQueries).toHaveLength(2);
      expect(result.subQueries).toContain("authentication patterns");
      expect(result.subQueries).toContain("error handling strategies");
      expect(cached).toBe(false);

      // AGI-312: the usage-envelope callback handler is attached so this
      // side-channel call emits a raw usage row.
      const config0 = mockInvoke.mock.calls[0]?.[1] as
        | { callbacks?: Array<{ name?: string }> }
        | undefined;
      expect(config0?.callbacks?.[0]?.name).toBe(
        "usageEnvelopeCallbackHandler",
      );
    });

    it("should return original query when not complex", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: false,
          reasoning: "Single topic query",
          sub_queries: ["authentication patterns"],
        }),
      });

      const { result } = await decomposeQuery(
        "authentication patterns",
        config,
      );

      expect(result.isComplex).toBe(false);
      expect(result.subQueries).toHaveLength(1);
      expect(result.subQueries[0]).toBe("authentication patterns");
    });

    it("should cache decomposition results", async () => {
      const query = "authentication and authorization patterns";

      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Multiple topics",
          sub_queries: ["authentication patterns", "authorization patterns"],
        }),
      });

      // First call - not cached
      const result1 = await decomposeQuery(query, config);
      expect(result1.cached).toBe(false);

      // Second call - should be cached
      const result2 = await decomposeQuery(query, config);
      expect(result2.cached).toBe(true);
      expect(result2.result.subQueries).toEqual(result1.result.subQueries);
    });

    it("should limit sub-queries to maxSubQueries", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Many parts",
          sub_queries: ["q1", "q2", "q3", "q4", "q5", "q6"],
        }),
      });

      const { result } = await decomposeQuery(
        "complex multi-part query",
        config,
      );

      expect(result.subQueries.length).toBeLessThanOrEqual(
        config.maxSubQueries,
      );
    });

    it("should handle LLM errors gracefully", async () => {
      mockInvoke.mockRejectedValue(new Error("LLM API error"));

      const { result } = await decomposeQuery(
        "authentication and authorization",
        config,
      );

      // Should fallback to treating as non-complex
      expect(result.isComplex).toBe(false);
      expect(result.subQueries).toHaveLength(1);
      expect(result.subQueries[0]).toBe("authentication and authorization");
    });

    it("should handle invalid JSON response", async () => {
      mockInvoke.mockResolvedValue({
        content: "This is not valid JSON",
      });

      const { result } = await decomposeQuery(
        "authentication and authorization",
        config,
      );

      expect(result.isComplex).toBe(false);
      expect(result.subQueries).toContain("authentication and authorization");
    });
  });

  describe("mergeAndRankResults", () => {
    const config = DECOMPOSITION_CONFIG;

    it("should deduplicate entities appearing in multiple results", () => {
      const mockResults: SubQuerySearchResult[] = [
        {
          subQuery: "authentication",
          hydeResult: {
            applied: false,
            reason: "test",
            searchQuery: "authentication",
          },
          entities: [
            {
              id: "entity1",
              title: "Auth Pattern",
              entity_type: "pattern",
              content: "...",
              tags: [],
              priority: "medium",
              status: "active",
              created_at: "2024-01-01",
            },
            {
              id: "entity2",
              title: "Login Flow",
              entity_type: "pattern",
              content: "...",
              tags: [],
              priority: "medium",
              status: "active",
              created_at: "2024-01-01",
            },
          ],
          success: true,
        },
        {
          subQuery: "authorization",
          hydeResult: {
            applied: false,
            reason: "test",
            searchQuery: "authorization",
          },
          entities: [
            {
              id: "entity1", // Duplicate
              title: "Auth Pattern",
              entity_type: "pattern",
              content: "...",
              tags: [],
              priority: "medium",
              status: "active",
              created_at: "2024-01-01",
            },
            {
              id: "entity3",
              title: "Permission Check",
              entity_type: "pattern",
              content: "...",
              tags: [],
              priority: "medium",
              status: "active",
              created_at: "2024-01-01",
            },
          ],
          success: true,
        },
      ];

      const merged = mergeAndRankResults(mockResults, config);

      // Should have 3 unique entities
      expect(merged).toHaveLength(3);

      // entity1 should appear first (matched 2 sub-queries)
      expect(merged[0].id).toBe("entity1");
      expect(merged[0].matchCount).toBe(2);
      expect(merged[0].matchedSubQueries).toEqual([
        "authentication",
        "authorization",
      ]);
    });

    it("should apply boost scoring to multi-match entities", () => {
      const mockResults: SubQuerySearchResult[] = [
        {
          subQuery: "q1",
          hydeResult: {
            applied: false,
            reason: "test",
            searchQuery: "q1",
          },
          entities: [
            {
              id: "multi",
              title: "Multi-match",
              entity_type: "pattern",
              content: "...",
              tags: [],
              priority: "medium",
              status: "active",
              created_at: "2024-01-01",
            },
          ],
          success: true,
        },
        {
          subQuery: "q2",
          hydeResult: {
            applied: false,
            reason: "test",
            searchQuery: "q2",
          },
          entities: [
            {
              id: "multi",
              title: "Multi-match",
              entity_type: "pattern",
              content: "...",
              tags: [],
              priority: "medium",
              status: "active",
              created_at: "2024-01-01",
            },
          ],
          success: true,
        },
        {
          subQuery: "q3",
          hydeResult: {
            applied: false,
            reason: "test",
            searchQuery: "q3",
          },
          entities: [
            {
              id: "single",
              title: "Single-match",
              entity_type: "pattern",
              content: "...",
              tags: [],
              priority: "medium",
              status: "active",
              created_at: "2024-01-01",
            },
          ],
          success: true,
        },
      ];

      const merged = mergeAndRankResults(mockResults, config);

      // Multi-match should be ranked higher
      expect(merged[0].id).toBe("multi");
      expect(merged[0].boostScore).toBeGreaterThan(1);
      expect(merged[1].id).toBe("single");
    });

    it("should handle empty results", () => {
      const merged = mergeAndRankResults([], config);
      expect(merged).toHaveLength(0);
    });

    it("should preserve entity metadata", () => {
      const mockResults: SubQuerySearchResult[] = [
        {
          subQuery: "test",
          hydeResult: {
            applied: false,
            reason: "test",
            searchQuery: "test",
          },
          entities: [
            {
              id: "entity1",
              title: "Test Entity",
              entity_type: "learning",
              content: "Test content",
              context: "testing",
              tags: ["test", "unit"],
              priority: "high",
              status: "active",
              created_at: "2024-01-01",
              metadata: { custom: "value" },
            },
          ],
          success: true,
        },
      ];

      const merged = mergeAndRankResults(mockResults, config);

      expect(merged[0].context).toBe("testing");
      expect(merged[0].tags).toEqual(["test", "unit"]);
      expect(merged[0].priority).toBe("high");
      expect(merged[0].created_at).toBe("2024-01-01");
      expect(merged[0].metadata).toEqual({ custom: "value" });
    });
  });

  describe("processQueryWithDecomposition", () => {
    const mockSearchFn = jest.fn();

    beforeEach(() => {
      mockSearchFn.mockReset();
      mockSearchFn.mockResolvedValue([
        {
          id: "entity1",
          title: "Test Entity",
          entity_type: "pattern",
          content: "...",
          tags: [],
          priority: "medium",
          status: "active",
          created_at: "2024-01-01",
        },
      ]);
    });

    it("should respect explicit opt-out via decompose=false", async () => {
      const result = await processQueryWithDecomposition(
        "authentication and authorization patterns",
        mockSearchFn,
        { decompose: false },
      );

      expect(result.applied).toBe(false);
      expect(result.reason).toContain("Explicitly disabled");
      expect(mockSearchFn).not.toHaveBeenCalled();
    });

    it("should respect explicit opt-in via decompose=true", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Multiple parts",
          sub_queries: ["authentication", "authorization"],
        }),
      });

      const result = await processQueryWithDecomposition(
        "auth", // Would normally be skipped as too short
        mockSearchFn,
        { decompose: true },
      );

      expect(result.applied).toBe(true);
      expect(result.reason).toContain("Decomposed into 2 sub-queries");
      expect(mockSearchFn).toHaveBeenCalled();
    });

    it("should auto-detect and skip simple queries", async () => {
      const result = await processQueryWithDecomposition(
        "simple query",
        mockSearchFn,
        {},
      );

      expect(result.applied).toBe(false);
      expect(result.reason).toContain("too short");
      expect(mockSearchFn).not.toHaveBeenCalled();
    });

    it("should auto-detect and decompose complex queries", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Multiple parts",
          sub_queries: ["authentication patterns", "authorization patterns"],
        }),
      });

      const result = await processQueryWithDecomposition(
        "authentication patterns and authorization strategies for secure apps",
        mockSearchFn,
        {},
      );

      expect(result.applied).toBe(true);
      expect(result.subQueries).toHaveLength(2);
      expect(mockSearchFn).toHaveBeenCalledTimes(2);
    });

    it("should execute searches in parallel", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Multiple parts",
          sub_queries: ["q1", "q2", "q3"],
        }),
      });

      const startTime = Date.now();

      mockSearchFn.mockImplementation(async () => {
        // Simulate async delay
        await new Promise((resolve) => setTimeout(resolve, 100));
        return [
          {
            id: "entity1",
            title: "Test",
            entity_type: "pattern",
            content: "...",
            tags: [],
            priority: "medium",
            status: "active",
            created_at: "2024-01-01",
          },
        ];
      });

      await processQueryWithDecomposition(
        "complex query with multiple parts",
        mockSearchFn,
        { decompose: true },
      );

      const duration = Date.now() - startTime;

      // If parallel, should take ~100ms. If sequential, would take ~300ms
      expect(duration).toBeLessThan(250);
      expect(mockSearchFn).toHaveBeenCalledTimes(3);
    });

    it("should handle search function errors gracefully", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Multiple parts",
          sub_queries: ["q1", "q2"],
        }),
      });

      mockSearchFn.mockImplementation(async (subQuery: string) => {
        if (subQuery === "q1") {
          throw new Error("Search failed");
        }
        return [
          {
            id: "entity1",
            title: "Test",
            entity_type: "pattern",
            content: "...",
            tags: [],
            priority: "medium",
            status: "active",
            created_at: "2024-01-01",
          },
        ];
      });

      const result = await processQueryWithDecomposition(
        "complex query",
        mockSearchFn,
        { decompose: true },
      );

      expect(result.failedSubQueries).toBe(1);
      expect(result.successfulSubQueries).toBe(1);
      expect(result.entities).toHaveLength(1);
    });

    it("should pass search options to search function", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Multiple parts",
          sub_queries: ["q1"],
        }),
      });

      const searchOptions = {
        entity_type: "pattern",
        tags: ["test"],
        limit: 5,
      };

      await processQueryWithDecomposition("complex query", mockSearchFn, {
        decompose: true,
        searchOptions,
      });

      expect(mockSearchFn).toHaveBeenCalledWith("q1", searchOptions);
    });

    it("should include timing information", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Multiple parts",
          sub_queries: ["q1"],
        }),
      });

      const result = await processQueryWithDecomposition(
        "complex query",
        mockSearchFn,
        { decompose: true },
      );

      expect(result.timing).toBeDefined();
      expect(result.timing!.decompositionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.timing!.searchTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.timing!.mergeTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.timing!.totalTimeMs).toBeGreaterThanOrEqual(0);
      // Verify timing structure is correct
      expect(typeof result.timing!.decompositionTimeMs).toBe("number");
      expect(typeof result.timing!.searchTimeMs).toBe("number");
      expect(typeof result.timing!.mergeTimeMs).toBe("number");
      expect(typeof result.timing!.totalTimeMs).toBe("number");
    });
  });

  describe("Cache Management", () => {
    it("should clear the cache", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Multiple parts",
          sub_queries: ["q1", "q2"],
        }),
      });

      await decomposeQuery("test query", DECOMPOSITION_CONFIG);

      let stats = getDecompositionCacheStats();
      expect(stats!.size).toBeGreaterThan(0);

      clearDecompositionCache();

      stats = getDecompositionCacheStats();
      expect(stats!.size).toBe(0);
      expect(stats!.hits).toBe(0);
      expect(stats!.misses).toBe(0);
    });

    it("should get cache statistics", async () => {
      clearDecompositionCache();

      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          is_complex: true,
          reasoning: "Multiple parts",
          sub_queries: ["q1", "q2"],
        }),
      });

      const query1 = "authentication patterns";
      const query2 = "error handling";

      await decomposeQuery(query1, DECOMPOSITION_CONFIG); // Miss
      await decomposeQuery(query1, DECOMPOSITION_CONFIG); // Hit
      await decomposeQuery(query2, DECOMPOSITION_CONFIG); // Miss

      const stats = getDecompositionCacheStats();
      expect(stats).toBeDefined();
      expect(stats!.size).toBe(2);
      expect(stats!.hits).toBeGreaterThanOrEqual(1);
      expect(stats!.misses).toBeGreaterThanOrEqual(2);
    });

    it("should return null stats when cache not initialized", () => {
      resetDecomposition();
      const stats = getDecompositionCacheStats();
      expect(stats).toBeNull();
    });
  });
});
