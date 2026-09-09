/**
 * Web Tool Unit Tests
 *
 * Tests for web_search / web_extract / web_crawl / web_map with a mocked
 * Tavily client.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import {
  createWebSearchTool,
  createWebExtractTool,
  createWebCrawlTool,
  createWebMapTool,
  createWebTools,
} from "../../../src/tools/web-search-tool.js";
import * as tavilyClient from "../../../src/web-search/tavily-client.js";
import { WebSearchError } from "../../../src/web-search/types.js";

// Store original env
const originalEnv = process.env;

// Mock the tavily-client module functions
jest.mock("../../../src/web-search/tavily-client", () => ({
  search: jest.fn(),
  extract: jest.fn(),
  crawl: jest.fn(),
  map: jest.fn(),
  isConfigured: jest.fn(),
}));

const mockSearch = tavilyClient.search as jest.MockedFunction<
  typeof tavilyClient.search
>;
const mockExtract = tavilyClient.extract as jest.MockedFunction<
  typeof tavilyClient.extract
>;
const mockCrawl = tavilyClient.crawl as jest.MockedFunction<
  typeof tavilyClient.crawl
>;
const mockMap = tavilyClient.map as jest.MockedFunction<
  typeof tavilyClient.map
>;
const mockIsConfigured = tavilyClient.isConfigured as jest.MockedFunction<
  typeof tavilyClient.isConfigured
>;

describe("Web Tools", () => {
  let searchTool: ReturnType<typeof createWebSearchTool>;
  let extractTool: ReturnType<typeof createWebExtractTool>;
  let crawlTool: ReturnType<typeof createWebCrawlTool>;
  let mapTool: ReturnType<typeof createWebMapTool>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
    searchTool = createWebSearchTool();
    extractTool = createWebExtractTool();
    crawlTool = createWebCrawlTool();
    mapTool = createWebMapTool();
    process.env = { ...originalEnv, TAVILY_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("registration", () => {
    it("should expose exactly the four web tools", () => {
      expect(createWebTools().map((t) => t.name)).toEqual([
        "web_search",
        "web_extract",
        "web_crawl",
        "web_map",
      ]);
    });

    it("should give each tool a name matching its operation", () => {
      expect(searchTool.name).toBe("web_search");
      expect(extractTool.name).toBe("web_extract");
      expect(crawlTool.name).toBe("web_crawl");
      expect(mapTool.name).toBe("web_map");
    });

    it("should describe each tool's own operation, not a mode switch", () => {
      expect(searchTool.description).toContain("Search the web");
      expect(extractTool.description).toContain("full content");
      expect(crawlTool.description).toContain("Follow links");
      expect(mapTool.description).toContain("URL structure");

      for (const tool of createWebTools()) {
        expect(tool.description).not.toContain("MODES");
      }
    });
  });

  describe("web_search", () => {
    /**
     * Regression: these were the exact kwargs the model produced on its first
     * search of the acceptance run. Under the old single-tool schema the
     * accompanying `mode: "search"` failed validation, because the enum only
     * admitted "extract" and "crawl" — search was reachable only by omitting
     * the mode entirely. A query alone must simply search.
     */
    it("should search when given only a query", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "Reuters top headline today",
        answer: "The top headline is ...",
        results: [
          {
            title: "Reuters",
            url: "https://reuters.com/story",
            content: "Headline body",
            score: 0.91,
          },
        ],
        responseTime: 0.6,
      });

      const result = await searchTool.invoke({
        query: "Reuters top headline today",
      });

      expect(mockSearch).toHaveBeenCalledTimes(1);
      expect(mockSearch.mock.calls[0][0]).toBe("Reuters top headline today");
      expect(mockExtract).not.toHaveBeenCalled();
      expect(mockCrawl).not.toHaveBeenCalled();
      expect(result).not.toContain("Error");
      expect(result).toContain(
        'Web Search Results for: "Reuters top headline today"',
      );
      expect(result).toContain("The top headline is ...");
      expect(result).toContain("https://reuters.com/story");
    });

    it("should ignore a stray mode argument rather than rejecting the call", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "test",
        results: [],
        responseTime: 0.1,
      });

      const result = await searchTool.invoke({
        query: "test",
        mode: "search",
      } as never);

      expect(mockSearch).toHaveBeenCalledTimes(1);
      expect(result).not.toContain("Invalid");
    });

    it("should apply defaults and request usage", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "test query",
        results: [],
        responseTime: 0.5,
      });

      await searchTool.invoke({ query: "test query" });

      expect(mockSearch).toHaveBeenCalledWith(
        "test query",
        expect.objectContaining({
          maxResults: 5,
          searchDepth: "basic",
          topic: "general",
          includeAnswer: true,
          includeUsage: true,
        }),
      );
    });

    it("should pass through the widened option set", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "news",
        results: [],
        responseTime: 0.3,
      });

      await searchTool.invoke({
        query: "news",
        maxResults: 10,
        searchDepth: "ultra-fast",
        topic: "news",
        includeAnswer: "advanced",
        chunksPerSource: 2,
        includeDomains: ["cnn.com"],
        excludeDomains: ["spam.com"],
        timeRange: "day",
        startDate: "2026-01-01",
        endDate: "2026-02-01",
        country: "united kingdom",
        exactMatch: true,
        autoParameters: false,
      });

      expect(mockSearch).toHaveBeenCalledWith(
        "news",
        expect.objectContaining({
          maxResults: 10,
          searchDepth: "ultra-fast",
          topic: "news",
          includeAnswer: "advanced",
          chunksPerSource: 2,
          includeDomains: ["cnn.com"],
          excludeDomains: ["spam.com"],
          timeRange: "day",
          startDate: "2026-01-01",
          endDate: "2026-02-01",
          country: "united kingdom",
          exactMatch: true,
          autoParameters: false,
        }),
      );
    });

    it("should pass language and domain-mode options once typed by the SDK", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "q",
        results: [],
        responseTime: 0.1,
      });

      await searchTool.invoke({
        query: "q",
        includeDomains: ["lemonde.fr"],
        includeDomainsMode: "boost",
        language: "fr",
        filterByLanguage: true,
      });

      expect(mockSearch).toHaveBeenCalledWith(
        "q",
        expect.objectContaining({
          includeDomainsMode: "boost",
          language: "fr",
          filterByLanguage: true,
        }),
      );
    });

    it("should drop dependent flags whose partner option is absent", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "q",
        results: [],
        responseTime: 0.1,
      });

      // The API 400s on either flag alone. Dropping them keeps a recoverable
      // omission from becoming a failed turn.
      await searchTool.invoke({
        query: "q",
        includeDomainsMode: "filter",
        filterByLanguage: true,
      });

      expect(mockSearch).toHaveBeenCalledWith(
        "q",
        expect.objectContaining({
          includeDomainsMode: undefined,
          filterByLanguage: undefined,
        }),
      );
    });

    it("should reject a malformed date", async () => {
      await expect(
        searchTool.invoke({ query: "x", startDate: "01/02/2026" }),
      ).rejects.toThrow();
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it("should surface publication dates and credit usage", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "test",
        results: [
          {
            title: "Dated",
            url: "https://a.com",
            content: "A",
            score: 0.5,
            publishedDate: "2026-03-04",
          },
        ],
        responseTime: 0.4,
        usage: { credits: 2 },
      });

      const result = await searchTool.invoke({ query: "test" });

      expect(result).toContain("Published: 2026-03-04");
      expect(result).toContain("Credits used: 2");
    });

    it("should handle no results", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "obscure query",
        results: [],
        responseTime: 0.2,
      });

      const result = await searchTool.invoke({ query: "obscure query" });

      expect(result).toContain("No results found");
    });

    it("should format search results with scores", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "test",
        results: [
          {
            title: "High Score",
            url: "https://a.com",
            content: "A",
            score: 0.95,
          },
          {
            title: "Low Score",
            url: "https://b.com",
            content: "B",
            score: 0.6,
          },
        ],
        responseTime: 0.4,
      });

      const result = await searchTool.invoke({ query: "test" });

      expect(result).toContain("Relevance: 95%");
      expect(result).toContain("Relevance: 60%");
    });
  });

  describe("web_extract", () => {
    it("should extract a batch of URLs in one call", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [
          {
            url: "https://example.com/a",
            title: "Page A",
            rawContent: "# A\n\nfirst page",
          },
          {
            url: "https://example.com/b",
            title: "Page B",
            rawContent: "# B\n\nsecond page",
          },
        ],
        failedResults: [],
        responseTime: 0.4,
      });

      const result = await extractTool.invoke({
        urls: ["https://example.com/a", "https://example.com/b"],
      });

      expect(mockExtract).toHaveBeenCalledWith(
        ["https://example.com/a", "https://example.com/b"],
        expect.objectContaining({
          extractDepth: "basic",
          format: "markdown",
          includeUsage: true,
        }),
      );
      expect(result).toContain("Page A");
      expect(result).toContain("Page B");
      expect(result).toContain("first page");
      expect(result).toContain("second page");
    });

    it("should pass intent-based extraction options", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [],
        failedResults: [],
        responseTime: 0.2,
      });

      await extractTool.invoke({
        urls: ["https://example.com"],
        query: "pricing tiers",
        chunksPerSource: 5,
        extractDepth: "advanced",
        format: "text",
        timeout: 30,
      });

      expect(mockExtract).toHaveBeenCalledWith(
        ["https://example.com"],
        expect.objectContaining({
          query: "pricing tiers",
          chunksPerSource: 5,
          extractDepth: "advanced",
          format: "text",
          timeout: 30,
        }),
      );
    });

    it("should handle extraction failures", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [],
        failedResults: [{ url: "https://blocked.com", error: "Access denied" }],
        responseTime: 0.2,
      });

      const result = await extractTool.invoke({
        urls: ["https://blocked.com"],
      });

      expect(result).toContain("Extraction Failures");
      expect(result).toContain("Access denied");
    });

    it("should require urls", async () => {
      await expect(extractTool.invoke({} as never)).rejects.toThrow();
      expect(mockExtract).not.toHaveBeenCalled();
    });

    it("should reject more than 20 URLs", async () => {
      const urls = Array.from(
        { length: 21 },
        (_, i) => `https://example.com/${i}`,
      );

      await expect(extractTool.invoke({ urls })).rejects.toThrow();
      expect(mockExtract).not.toHaveBeenCalled();
    });

    it("should reject a non-URL string", async () => {
      await expect(
        extractTool.invoke({ urls: ["not a url"] }),
      ).rejects.toThrow();
      expect(mockExtract).not.toHaveBeenCalled();
    });
  });

  describe("web_crawl", () => {
    it("should crawl with bounded defaults", async () => {
      mockCrawl.mockResolvedValueOnce({
        baseUrl: "https://docs.example.com",
        results: [
          {
            url: "https://docs.example.com",
            rawContent: "Main docs",
            images: [],
          },
          {
            url: "https://docs.example.com/api",
            rawContent: "API docs",
            images: [],
          },
        ],
        responseTime: 2.0,
      });

      const result = await crawlTool.invoke({
        url: "https://docs.example.com",
      });

      expect(mockCrawl).toHaveBeenCalledWith(
        "https://docs.example.com",
        expect.objectContaining({
          maxDepth: 1,
          maxBreadth: 20,
          limit: 20,
          allowExternal: false,
          // Explicit, rather than inheriting the API's 150s default, which
          // outlives our tool budgets.
          timeout: 45,
          includeUsage: true,
        }),
      );
      expect(result).toContain("Crawl Results for: https://docs.example.com");
      expect(result).toContain("Pages crawled: 2");
      expect(result).toContain("Main docs");
      expect(result).toContain("API docs");
    });

    it("should pass through filters and instructions", async () => {
      mockCrawl.mockResolvedValueOnce({
        baseUrl: "https://example.com",
        results: [],
        responseTime: 1.5,
      });

      await crawlTool.invoke({
        url: "https://example.com",
        instructions: "Focus on documentation pages",
        maxDepth: 3,
        maxBreadth: 50,
        limit: 25,
        chunksPerSource: 4,
        selectPaths: ["/docs/.*"],
        selectDomains: ["^example\\.com$"],
        excludePaths: ["/blog/.*"],
        excludeDomains: ["^ads\\.example\\.com$"],
        allowExternal: true,
        timeout: 90,
      });

      expect(mockCrawl).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({
          instructions: "Focus on documentation pages",
          maxDepth: 3,
          maxBreadth: 50,
          limit: 25,
          chunksPerSource: 4,
          selectPaths: ["/docs/.*"],
          selectDomains: ["^example\\.com$"],
          excludePaths: ["/blog/.*"],
          excludeDomains: ["^ads\\.example\\.com$"],
          allowExternal: true,
          timeout: 90,
        }),
      );
    });

    it("should explain an empty crawl rather than reporting nothing", async () => {
      mockCrawl.mockResolvedValueOnce({
        baseUrl: "https://example.com",
        results: [],
        responseTime: 1.0,
      });

      const result = await crawlTool.invoke({ url: "https://example.com" });

      expect(result).toContain("No pages crawled");
      expect(result).toContain("filters");
    });

    it("should require a url", async () => {
      await expect(crawlTool.invoke({} as never)).rejects.toThrow();
      expect(mockCrawl).not.toHaveBeenCalled();
    });

    it("should reject a maxDepth above the API's ceiling", async () => {
      await expect(
        crawlTool.invoke({ url: "https://example.com", maxDepth: 9 }),
      ).rejects.toThrow();
      expect(mockCrawl).not.toHaveBeenCalled();
    });
  });

  describe("web_map", () => {
    it("should list discovered URLs", async () => {
      mockMap.mockResolvedValueOnce({
        baseUrl: "https://docs.example.com",
        results: [
          "https://docs.example.com/",
          "https://docs.example.com/api",
          "https://docs.example.com/guides",
        ],
        responseTime: 1.1,
        usage: { credits: 1 },
      });

      const result = await mapTool.invoke({ url: "https://docs.example.com" });

      expect(mockMap).toHaveBeenCalledWith(
        "https://docs.example.com",
        expect.objectContaining({
          maxDepth: 1,
          maxBreadth: 20,
          limit: 50,
          allowExternal: false,
          includeUsage: true,
        }),
      );
      expect(result).toContain("Site Map for: https://docs.example.com");
      expect(result).toContain("URLs discovered: 3");
      expect(result).toContain("- https://docs.example.com/api");
      expect(result).toContain("Credits used: 1");
    });

    it("should pass through traversal filters", async () => {
      mockMap.mockResolvedValueOnce({
        baseUrl: "https://example.com",
        results: [],
        responseTime: 0.9,
      });

      await mapTool.invoke({
        url: "https://example.com",
        instructions: "Focus on the API reference",
        maxDepth: 2,
        maxBreadth: 100,
        limit: 200,
        selectPaths: ["/api/.*"],
        excludePaths: ["/api/legacy/.*"],
        allowExternal: false,
        timeout: 60,
      });

      expect(mockMap).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({
          instructions: "Focus on the API reference",
          maxDepth: 2,
          maxBreadth: 100,
          limit: 200,
          selectPaths: ["/api/.*"],
          excludePaths: ["/api/legacy/.*"],
          timeout: 60,
        }),
      );
    });

    it("should explain an empty map", async () => {
      mockMap.mockResolvedValueOnce({
        baseUrl: "https://example.com",
        results: [],
        responseTime: 0.5,
      });

      const result = await mapTool.invoke({ url: "https://example.com" });

      expect(result).toContain("No URLs discovered");
    });

    it("should require a url", async () => {
      await expect(mapTool.invoke({} as never)).rejects.toThrow();
      expect(mockMap).not.toHaveBeenCalled();
    });
  });

  describe("session id", () => {
    it("should forward the LangGraph thread id as the session id", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "test",
        results: [],
        responseTime: 0.1,
      });

      await searchTool.invoke(
        { query: "test" },
        { configurable: { thread_id: "thread-abc" } },
      );

      expect(mockSearch).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({ sessionId: "thread-abc" }),
      );
    });

    it("should send no session id when there is no thread", async () => {
      mockMap.mockResolvedValueOnce({
        baseUrl: "https://example.com",
        results: [],
        responseTime: 0.1,
      });

      await mapTool.invoke({ url: "https://example.com" });

      expect(mockMap).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({ sessionId: undefined }),
      );
    });
  });

  describe("error handling", () => {
    it("should report a missing API key from every tool", async () => {
      mockIsConfigured.mockReturnValue(false);

      const results = await Promise.all([
        searchTool.invoke({ query: "test" }),
        extractTool.invoke({ urls: ["https://example.com"] }),
        crawlTool.invoke({ url: "https://example.com" }),
        mapTool.invoke({ url: "https://example.com" }),
      ]);

      for (const result of results) {
        expect(result).toContain("TAVILY_API_KEY");
        expect(result).toContain("not set");
      }
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockExtract).not.toHaveBeenCalled();
      expect(mockCrawl).not.toHaveBeenCalled();
      expect(mockMap).not.toHaveBeenCalled();
    });

    it("should return a WebSearchError as a result, not throw", async () => {
      mockSearch.mockRejectedValueOnce(
        new WebSearchError("Rate limit exceeded", "RATE_LIMIT", 429),
      );

      const result = await searchTool.invoke({ query: "test" });

      expect(result).toContain("Error");
      expect(result).toContain("RATE_LIMIT");
      expect(result).toContain("Rate limit exceeded");
    });

    it("should return a generic error as a result", async () => {
      mockMap.mockRejectedValueOnce(new Error("Network error"));

      const result = await mapTool.invoke({ url: "https://example.com" });

      expect(result).toContain("Error");
      expect(result).toContain("Network error");
    });
  });

  describe("output formatting", () => {
    it("should clip each result rather than dropping the tail", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [
          {
            url: "https://example.com/first",
            title: "FIRST_PAGE",
            rawContent: "a".repeat(40000),
          },
          {
            url: "https://example.com/last",
            title: "LAST_PAGE",
            rawContent: "b".repeat(40000),
          },
        ],
        failedResults: [],
        responseTime: 1.0,
      });

      const result = await extractTool.invoke({
        urls: ["https://example.com/first", "https://example.com/last"],
      });

      // The old whole-output clip cut the tail off silently; the last result
      // must still be present and its truncation must be marked inline.
      expect(result).toContain("FIRST_PAGE");
      expect(result).toContain("LAST_PAGE");
      expect(result).toContain("more characters of this result");
      expect(result).not.toContain("a".repeat(40000));
    });

    it("should be deterministic for the same input", async () => {
      const payload = {
        results: [
          {
            url: "https://example.com",
            title: "T",
            rawContent: "c".repeat(30000),
          },
        ],
        failedResults: [],
        responseTime: 1.0,
      };
      mockExtract.mockResolvedValueOnce(payload).mockResolvedValueOnce(payload);

      const first = await extractTool.invoke({
        urls: ["https://example.com"],
      });
      const second = await extractTool.invoke({
        urls: ["https://example.com"],
      });

      expect(first).toBe(second);
    });

    it("should apply the overall backstop to a single huge field", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "test",
        answer: "x".repeat(60000),
        results: [],
        responseTime: 0.5,
      });

      const result = await searchTool.invoke({ query: "test" });

      expect(result.length).toBeLessThan(33000);
      expect(result).toContain("more characters of this result");
    });
  });
});
