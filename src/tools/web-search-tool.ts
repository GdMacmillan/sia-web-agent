/**
 * Web Search Tool - Tavily-powered Web Search, Extract, and Crawl
 *
 * Provides web search capabilities through the Tavily API:
 * - Search: Find web pages matching a query with optional AI answers
 * - Extract: Get content from specific URLs
 * - Crawl: Explore a website following links
 *
 * Requires TAVILY_API_KEY environment variable.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  search,
  extract,
  crawl,
  isConfigured,
} from "../web-search/tavily-client.js";
import { WebSearchError } from "../web-search/types.js";

/**
 * Clip long strings to prevent token overflow
 */
function clipOutput(content: string, maxChars: number = 24000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n...[truncated]...";
}

/**
 * Format search results for display
 */
function formatSearchResults(
  query: string,
  answer: string | undefined,
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
  }>,
  responseTime: number,
): string {
  const lines: string[] = [];

  lines.push(`# Web Search Results for: "${query}"`);
  lines.push(`Response time: ${responseTime.toFixed(2)}s`);
  lines.push("");

  if (answer) {
    lines.push("## AI-Generated Answer");
    lines.push(answer);
    lines.push("");
  }

  if (results.length === 0) {
    lines.push("No results found.");
  } else {
    lines.push(`## Search Results (${results.length})`);
    lines.push("");
    for (const result of results) {
      lines.push(`### ${result.title}`);
      lines.push(`URL: ${result.url}`);
      lines.push(`Relevance: ${(result.score * 100).toFixed(0)}%`);
      lines.push("");
      lines.push(result.content);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Format extraction results for display
 */
function formatExtractResults(
  url: string,
  results: Array<{ url: string; title: string | null; rawContent: string }>,
  failedResults: Array<{ url: string; error: string }>,
  responseTime: number,
): string {
  const lines: string[] = [];

  lines.push(`# Content Extracted from: ${url}`);
  lines.push(`Response time: ${responseTime.toFixed(2)}s`);
  lines.push("");

  if (results.length > 0) {
    for (const result of results) {
      if (result.title) {
        lines.push(`## ${result.title}`);
      }
      lines.push(`Source: ${result.url}`);
      lines.push("");
      lines.push(result.rawContent);
      lines.push("");
    }
  }

  if (failedResults.length > 0) {
    lines.push("## Extraction Failures");
    for (const failed of failedResults) {
      lines.push(`- ${failed.url}: ${failed.error}`);
    }
    lines.push("");
  }

  if (results.length === 0 && failedResults.length === 0) {
    lines.push("No content extracted.");
  }

  return lines.join("\n");
}

/**
 * Format crawl results for display
 */
function formatCrawlResults(
  baseUrl: string,
  results: Array<{ url: string; rawContent: string }>,
  responseTime: number,
): string {
  const lines: string[] = [];

  lines.push(`# Crawl Results for: ${baseUrl}`);
  lines.push(`Pages crawled: ${results.length}`);
  lines.push(`Response time: ${responseTime.toFixed(2)}s`);
  lines.push("");

  if (results.length === 0) {
    lines.push("No pages crawled.");
  } else {
    for (const result of results) {
      lines.push(`## ${result.url}`);
      lines.push("");
      lines.push(result.rawContent);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Create the web search tool
 */
export function createWebSearchTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "web_search",
    description: `Search the web, extract content from URLs, or crawl websites using Tavily API.

MODES: 1. SEARCH (provide 'query'): Search the web for information - Returns ranked results with
optional AI-generated answer - Good for: finding information, news, documentation

2. EXTRACT (provide 'url' with mode='extract'): Get content from a specific URL
- Extracts and returns page content as markdown
- Good for: reading specific pages, getting full article content

3. CRAWL (provide 'url' with mode='crawl'): Explore a website
- Follows links and extracts content from multiple pages
- Good for: understanding site structure, getting documentation

WHEN TO USE: - Need current/recent information not in your knowledge - Researching external APIs,
libraries, or documentation - Finding news or recent developments - Getting content from specific
web pages

REQUIRES: TAVILY_API_KEY environment variable`,

    schema: z
      .object({
        // Mode selection
        query: z
          .string()
          .optional()
          .describe(
            "Search query (required for search mode). Be specific and include relevant context.",
          ),
        url: z
          .string()
          .optional()
          .describe(
            "URL to extract content from or crawl (required for extract/crawl modes)",
          ),
        mode: z
          .enum(["extract", "crawl"])
          .optional()
          .default("extract")
          .describe(
            "Mode when URL is provided: 'extract' for single page, 'crawl' for site exploration",
          ),

        // Search options
        maxResults: z
          .number()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe("Number of search results to return (1-20)"),
        searchDepth: z
          .enum(["basic", "advanced"])
          .optional()
          .default("basic")
          .describe(
            "'basic' for fast results, 'advanced' for more thorough search",
          ),
        topic: z
          .enum(["general", "news", "finance"])
          .optional()
          .default("general")
          .describe("Topic category for specialized results"),
        includeAnswer: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include AI-generated answer summary in results"),
        includeDomains: z
          .array(z.string())
          .optional()
          .describe(
            "Only include results from these domains (e.g., ['github.com', 'docs.example.com'])",
          ),
        excludeDomains: z
          .array(z.string())
          .optional()
          .describe("Exclude results from these domains"),
        timeRange: z
          .enum(["day", "week", "month", "year"])
          .optional()
          .describe("Filter results by recency"),

        // Crawl options
        crawlInstructions: z
          .string()
          .optional()
          .describe(
            "Natural language instructions for crawl (e.g., 'Focus on API documentation')",
          ),
        maxDepth: z
          .number()
          .min(1)
          .max(5)
          .optional()
          .default(1)
          .describe("Maximum link depth for crawl (1-5)"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Maximum pages to crawl (1-50)"),
      })
      .refine((data) => data.query || data.url, {
        message:
          "Either 'query' (for search) or 'url' (for extract/crawl) must be provided",
      }),

    func: async ({
      query,
      url,
      mode,
      maxResults,
      searchDepth,
      topic,
      includeAnswer,
      includeDomains,
      excludeDomains,
      timeRange,
      crawlInstructions,
      maxDepth,
      limit,
    }) => {
      // Check if API is configured
      if (!isConfigured()) {
        return (
          "Error: TAVILY_API_KEY environment variable is not set. " +
          "Get an API key at https://tavily.com (free tier: 1000 searches/month)"
        );
      }

      try {
        // SEARCH mode
        if (query) {
          const result = await search(query, {
            maxResults,
            searchDepth,
            topic,
            includeAnswer,
            includeDomains,
            excludeDomains,
            timeRange,
          });

          const output = formatSearchResults(
            result.query,
            result.answer,
            result.results,
            result.responseTime,
          );
          return clipOutput(output);
        }

        // EXTRACT or CRAWL mode
        if (url) {
          if (mode === "crawl") {
            const result = await crawl(url, {
              maxDepth,
              limit,
              instructions: crawlInstructions,
            });

            const output = formatCrawlResults(
              result.baseUrl,
              result.results,
              result.responseTime,
            );
            return clipOutput(output);
          } else {
            // Default: extract
            const result = await extract(url);

            const output = formatExtractResults(
              url,
              result.results,
              result.failedResults,
              result.responseTime,
            );
            return clipOutput(output);
          }
        }

        return "Error: Either 'query' or 'url' must be provided";
      } catch (error: unknown) {
        if (error instanceof WebSearchError) {
          return `Error (${error.code}): ${error.message}`;
        }
        const message = error instanceof Error ? error.message : String(error);
        return `Error: ${message}`;
      }
    },
  });
}
