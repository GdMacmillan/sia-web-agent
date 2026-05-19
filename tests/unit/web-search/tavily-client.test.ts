/**
 * Tavily Client Unit Tests
 *
 * Tests for the Tavily client wrapper with mocked API responses.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { WebSearchError } from "../../../src/web-search/types.js";

// Store original env
const originalEnv = process.env;

// Mock @tavily/core at the top level
jest.mock("@tavily/core", () => ({
  tavily: jest.fn(() => ({
    search: jest.fn(),
    extract: jest.fn(),
    crawl: jest.fn(),
  })),
}));

// Import after setting up mock
import { tavily } from "@tavily/core";
import {
  search,
  extract,
  crawl,
  isConfigured,
  resetClient,
} from "../../../src/web-search/tavily-client.js";
import { resetConfig } from "../../../src/config/index.js";

const mockTavily = tavily as jest.MockedFunction<typeof tavily>;

describe("Tavily Client", () => {
  let mockSearch: jest.Mock;
  let mockExtract: jest.Mock;
  let mockCrawl: jest.Mock;

  beforeEach(() => {
    // Create fresh mocks for each test
    mockSearch = jest.fn();
    mockExtract = jest.fn();
    mockCrawl = jest.fn();

    mockTavily.mockReturnValue({
      search: mockSearch,
      extract: mockExtract,
      crawl: mockCrawl,
    } as unknown as ReturnType<typeof tavily>);

    // Reset mocks, client, and config cache
    jest.clearAllMocks();
    resetClient();
    resetConfig();

    // Set API key for tests
    process.env = { ...originalEnv, TAVILY_API_KEY: "test-api-key" };
  });

  afterEach(() => {
    process.env = originalEnv;
    resetClient();
    resetConfig();
  });

  describe("isConfigured", () => {
    it("should return true when API key is set", () => {
      expect(isConfigured()).toBe(true);
    });

    it("should return false when API key is not set", () => {
      delete process.env.TAVILY_API_KEY;
      expect(isConfigured()).toBe(false);
    });
  });

  describe("search", () => {
    it("should search with default options", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "test query",
        answer: "Test answer",
        results: [
          {
            title: "Test Result",
            url: "https://example.com",
            content: "Test content",
            score: 0.95,
            publishedDate: "2024-01-01",
          },
        ],
        responseTime: 0.5,
      });

      const result = await search("test query");

      expect(mockTavily).toHaveBeenCalledWith({ apiKey: "test-api-key" });
      expect(mockSearch).toHaveBeenCalledWith("test query", {
        maxResults: 5,
        searchDepth: "basic",
        topic: "general",
        includeAnswer: true,
        includeDomains: undefined,
        excludeDomains: undefined,
        timeRange: undefined,
      });
      expect(result.query).toBe("test query");
      expect(result.answer).toBe("Test answer");
      expect(result.results).toHaveLength(1);
      expect(result.results[0].title).toBe("Test Result");
    });

    it("should search with custom options", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "news query",
        results: [],
        responseTime: 0.3,
      });

      await search("news query", {
        maxResults: 10,
        searchDepth: "advanced",
        topic: "news",
        includeAnswer: false,
        includeDomains: ["example.com"],
        excludeDomains: ["spam.com"],
        timeRange: "week",
      });

      expect(mockSearch).toHaveBeenCalledWith("news query", {
        maxResults: 10,
        searchDepth: "advanced",
        topic: "news",
        includeAnswer: false,
        includeDomains: ["example.com"],
        excludeDomains: ["spam.com"],
        timeRange: "week",
      });
    });

    it("should throw error for empty query", async () => {
      await expect(search("")).rejects.toThrow(WebSearchError);
      await expect(search("   ")).rejects.toThrow("cannot be empty");
    });

    it("should throw error when API key is missing", async () => {
      delete process.env.TAVILY_API_KEY;
      resetClient();

      await expect(search("test")).rejects.toThrow(WebSearchError);
      await expect(search("test")).rejects.toThrow("TAVILY_API_KEY");
    });

    it("should wrap API errors", async () => {
      mockSearch.mockRejectedValueOnce(new Error("API rate limit exceeded"));

      try {
        await search("test");
        fail("Expected error to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WebSearchError);
        expect((error as WebSearchError).message).toContain("rate limit");
      }
    });
  });

  describe("extract", () => {
    it("should extract from single URL", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [
          {
            url: "https://example.com",
            title: "Example Page",
            rawContent: "Page content here",
            images: [],
          },
        ],
        failedResults: [],
        responseTime: 0.4,
      });

      const result = await extract("https://example.com");

      expect(mockExtract).toHaveBeenCalledWith(["https://example.com"], {
        extractDepth: "basic",
        format: "markdown",
        includeImages: false,
      });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].rawContent).toBe("Page content here");
    });

    it("should extract from multiple URLs", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [
          { url: "https://a.com", title: "A", rawContent: "A content" },
          { url: "https://b.com", title: "B", rawContent: "B content" },
        ],
        failedResults: [],
        responseTime: 0.6,
      });

      const result = await extract(["https://a.com", "https://b.com"]);

      expect(result.results).toHaveLength(2);
    });

    it("should handle extraction failures", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [],
        failedResults: [{ url: "https://blocked.com", error: "Access denied" }],
        responseTime: 0.2,
      });

      const result = await extract("https://blocked.com");

      expect(result.results).toHaveLength(0);
      expect(result.failedResults).toHaveLength(1);
      expect(result.failedResults[0].error).toBe("Access denied");
    });

    it("should throw error for invalid URL", async () => {
      await expect(extract("not-a-url")).rejects.toThrow(WebSearchError);
      await expect(extract("not-a-url")).rejects.toThrow("Invalid URL");
    });

    it("should throw error for empty URL array", async () => {
      await expect(extract([])).rejects.toThrow(WebSearchError);
      await expect(extract([])).rejects.toThrow("At least one URL");
    });

    it("should use custom options", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [],
        failedResults: [],
        responseTime: 0.3,
      });

      await extract("https://example.com", {
        extractDepth: "advanced",
        format: "text",
        includeImages: true,
      });

      expect(mockExtract).toHaveBeenCalledWith(["https://example.com"], {
        extractDepth: "advanced",
        format: "text",
        includeImages: true,
      });
    });
  });

  describe("crawl", () => {
    it("should crawl with default options", async () => {
      mockCrawl.mockResolvedValueOnce({
        baseUrl: "https://example.com",
        results: [
          {
            url: "https://example.com",
            rawContent: "Main page",
            images: [],
          },
          {
            url: "https://example.com/about",
            rawContent: "About page",
            images: [],
          },
        ],
        responseTime: 1.5,
      });

      const result = await crawl("https://example.com");

      expect(mockCrawl).toHaveBeenCalledWith("https://example.com", {
        maxDepth: 1,
        maxBreadth: 10,
        limit: 10,
        instructions: undefined,
        extractDepth: "basic",
        format: "markdown",
        includeImages: false,
        selectPaths: undefined,
        excludePaths: undefined,
        allowExternal: false,
      });
      expect(result.baseUrl).toBe("https://example.com");
      expect(result.results).toHaveLength(2);
    });

    it("should crawl with custom options", async () => {
      mockCrawl.mockResolvedValueOnce({
        baseUrl: "https://docs.example.com",
        results: [],
        responseTime: 2.0,
      });

      await crawl("https://docs.example.com", {
        maxDepth: 3,
        maxBreadth: 20,
        limit: 50,
        instructions: "Focus on API documentation",
        extractDepth: "advanced",
        format: "text",
        includeImages: true,
        selectPaths: ["/api/.*"],
        excludePaths: ["/blog/.*"],
        allowExternal: true,
      });

      expect(mockCrawl).toHaveBeenCalledWith("https://docs.example.com", {
        maxDepth: 3,
        maxBreadth: 20,
        limit: 50,
        instructions: "Focus on API documentation",
        extractDepth: "advanced",
        format: "text",
        includeImages: true,
        selectPaths: ["/api/.*"],
        excludePaths: ["/blog/.*"],
        allowExternal: true,
      });
    });

    it("should throw error for empty URL", async () => {
      await expect(crawl("")).rejects.toThrow(WebSearchError);
      await expect(crawl("")).rejects.toThrow("cannot be empty");
    });

    it("should throw error for invalid URL", async () => {
      await expect(crawl("not-a-url")).rejects.toThrow(WebSearchError);
      await expect(crawl("not-a-url")).rejects.toThrow("Invalid URL");
    });

    it("should wrap API errors", async () => {
      mockCrawl.mockRejectedValueOnce(new Error("Timeout"));

      try {
        await crawl("https://example.com");
        fail("Expected error to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WebSearchError);
        expect((error as WebSearchError).message).toContain("Timeout");
      }
    });
  });
});
