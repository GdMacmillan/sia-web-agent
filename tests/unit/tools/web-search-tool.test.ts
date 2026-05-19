/**
 * Web Search Tool Unit Tests
 *
 * Tests for the web_search tool with mocked Tavily client.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { createWebSearchTool } from "../../../src/tools/web-search-tool.js";
import * as tavilyClient from "../../../src/web-search/tavily-client.js";
import { WebSearchError } from "../../../src/web-search/types.js";

// Store original env
const originalEnv = process.env;

// Mock the tavily-client module functions
jest.mock("../../../src/web-search/tavily-client", () => ({
  search: jest.fn(),
  extract: jest.fn(),
  crawl: jest.fn(),
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
const mockIsConfigured = tavilyClient.isConfigured as jest.MockedFunction<
  typeof tavilyClient.isConfigured
>;

describe("Web Search Tool", () => {
  let tool: ReturnType<typeof createWebSearchTool>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
    tool = createWebSearchTool();
    process.env = { ...originalEnv, TAVILY_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("tool metadata", () => {
    it("should have correct name", () => {
      expect(tool.name).toBe("web_search");
    });

    it("should have description mentioning search, extract, and crawl", () => {
      expect(tool.description).toContain("Search");
      expect(tool.description).toContain("extract");
      expect(tool.description).toContain("crawl");
    });
  });

  describe("search mode", () => {
    it("should search with query", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "test query",
        answer: "Test answer from AI",
        results: [
          {
            title: "Result 1",
            url: "https://example.com/1",
            content: "Content 1",
            score: 0.9,
          },
        ],
        responseTime: 0.5,
      });

      const result = await tool.invoke({ query: "test query" });

      expect(mockSearch).toHaveBeenCalledWith("test query", {
        maxResults: 5,
        searchDepth: "basic",
        topic: "general",
        includeAnswer: true,
        includeDomains: undefined,
        excludeDomains: undefined,
        timeRange: undefined,
      });

      expect(result).toContain('Web Search Results for: "test query"');
      expect(result).toContain("AI-Generated Answer");
      expect(result).toContain("Test answer from AI");
      expect(result).toContain("Result 1");
    });

    it("should search with custom options", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "news",
        results: [],
        responseTime: 0.3,
      });

      await tool.invoke({
        query: "news",
        maxResults: 10,
        searchDepth: "advanced",
        topic: "news",
        includeAnswer: false,
        includeDomains: ["cnn.com"],
        excludeDomains: ["spam.com"],
        timeRange: "day",
      });

      expect(mockSearch).toHaveBeenCalledWith("news", {
        maxResults: 10,
        searchDepth: "advanced",
        topic: "news",
        includeAnswer: false,
        includeDomains: ["cnn.com"],
        excludeDomains: ["spam.com"],
        timeRange: "day",
      });
    });

    it("should handle no results", async () => {
      mockSearch.mockResolvedValueOnce({
        query: "obscure query",
        results: [],
        responseTime: 0.2,
      });

      const result = await tool.invoke({ query: "obscure query" });

      expect(result).toContain("No results found");
    });
  });

  describe("extract mode", () => {
    it("should extract content from URL", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [
          {
            url: "https://example.com",
            title: "Example Page",
            rawContent: "# Page Content\n\nThis is the extracted content.",
          },
        ],
        failedResults: [],
        responseTime: 0.4,
      });

      const result = await tool.invoke({
        url: "https://example.com",
        mode: "extract",
      });

      expect(mockExtract).toHaveBeenCalledWith("https://example.com");
      expect(result).toContain("Content Extracted from: https://example.com");
      expect(result).toContain("Example Page");
      expect(result).toContain("extracted content");
    });

    it("should handle extraction failures", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [],
        failedResults: [{ url: "https://blocked.com", error: "Access denied" }],
        responseTime: 0.2,
      });

      const result = await tool.invoke({
        url: "https://blocked.com",
        mode: "extract",
      });

      expect(result).toContain("Extraction Failures");
      expect(result).toContain("Access denied");
    });

    it("should default to extract mode when url is provided", async () => {
      mockExtract.mockResolvedValueOnce({
        results: [
          { url: "https://example.com", title: null, rawContent: "content" },
        ],
        failedResults: [],
        responseTime: 0.3,
      });

      await tool.invoke({ url: "https://example.com" });

      expect(mockExtract).toHaveBeenCalled();
      expect(mockCrawl).not.toHaveBeenCalled();
    });
  });

  describe("crawl mode", () => {
    it("should crawl website", async () => {
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

      const result = await tool.invoke({
        url: "https://docs.example.com",
        mode: "crawl",
      });

      expect(mockCrawl).toHaveBeenCalledWith("https://docs.example.com", {
        maxDepth: 1,
        limit: 10,
        instructions: undefined,
      });
      expect(result).toContain("Crawl Results for: https://docs.example.com");
      expect(result).toContain("Pages crawled: 2");
      expect(result).toContain("Main docs");
      expect(result).toContain("API docs");
    });

    it("should crawl with custom options", async () => {
      mockCrawl.mockResolvedValueOnce({
        baseUrl: "https://example.com",
        results: [],
        responseTime: 1.5,
      });

      await tool.invoke({
        url: "https://example.com",
        mode: "crawl",
        maxDepth: 3,
        limit: 25,
        crawlInstructions: "Focus on documentation pages",
      });

      expect(mockCrawl).toHaveBeenCalledWith("https://example.com", {
        maxDepth: 3,
        limit: 25,
        instructions: "Focus on documentation pages",
      });
    });
  });

  describe("error handling", () => {
    it("should handle missing API key", async () => {
      mockIsConfigured.mockReturnValue(false);

      const result = await tool.invoke({ query: "test" });

      expect(result).toContain("TAVILY_API_KEY");
      expect(result).toContain("not set");
    });

    it("should handle search errors", async () => {
      mockSearch.mockRejectedValueOnce(
        new WebSearchError("Rate limit exceeded", "RATE_LIMIT", 429),
      );

      const result = await tool.invoke({ query: "test" });

      expect(result).toContain("Error");
      expect(result).toContain("RATE_LIMIT");
      expect(result).toContain("Rate limit exceeded");
    });

    it("should handle generic errors", async () => {
      mockSearch.mockRejectedValueOnce(new Error("Network error"));

      const result = await tool.invoke({ query: "test" });

      expect(result).toContain("Error");
      expect(result).toContain("Network error");
    });
  });

  describe("output formatting", () => {
    it("should truncate long output", async () => {
      const longContent = "x".repeat(30000);
      mockSearch.mockResolvedValueOnce({
        query: "test",
        answer: longContent,
        results: [],
        responseTime: 0.5,
      });

      const result = await tool.invoke({ query: "test" });

      expect(result.length).toBeLessThan(25000);
      expect(result).toContain("...[truncated]...");
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

      const result = await tool.invoke({ query: "test" });

      expect(result).toContain("Relevance: 95%");
      expect(result).toContain("Relevance: 60%");
    });
  });
});
