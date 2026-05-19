/**
 * Tavily Client Wrapper
 *
 * Thin wrapper around @tavily/core providing:
 * - Simplified interface for search, extract, and crawl operations
 * - Consistent error handling
 * - Type-safe responses
 *
 * Requires TAVILY_API_KEY environment variable.
 */

import { tavily } from "@tavily/core";
import type {
  WebSearchOptions,
  WebSearchResponse,
  WebExtractOptions,
  WebExtractResponse,
  WebCrawlOptions,
  WebCrawlResponse,
} from "./types.js";
import { WebSearchError } from "./types.js";
import { getConfig } from "../config/index.js";

/**
 * Tavily client instance (lazy initialized)
 */
let clientInstance: ReturnType<typeof tavily> | null = null;

/**
 * Get or create Tavily client instance
 *
 * @throws WebSearchError if TAVILY_API_KEY is not configured
 */
function getClient(): ReturnType<typeof tavily> {
  if (!clientInstance) {
    const apiKey = getConfig().services.tavily.apiKey;
    if (!apiKey) {
      throw new WebSearchError(
        "TAVILY_API_KEY environment variable is not set. " +
          "Get an API key at https://tavily.com",
        "MISSING_API_KEY",
      );
    }
    clientInstance = tavily({ apiKey });
  }
  return clientInstance;
}

/**
 * Reset client instance (for testing)
 */
export function resetClient(): void {
  clientInstance = null;
}

/**
 * Check if Tavily API is configured
 */
export function isConfigured(): boolean {
  return !!getConfig().services.tavily.apiKey;
}

/**
 * Perform a web search
 *
 * @param query - Search query
 * @param options - Search options
 * @returns Search results with optional AI-generated answer
 */
export async function search(
  query: string,
  options: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  if (!query || query.trim().length === 0) {
    throw new WebSearchError("Search query cannot be empty", "INVALID_QUERY");
  }

  try {
    const client = getClient();
    const response = await client.search(query, {
      maxResults: options.maxResults ?? 5,
      searchDepth: options.searchDepth ?? "basic",
      topic: options.topic ?? "general",
      includeAnswer: options.includeAnswer ?? true,
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
      timeRange: options.timeRange,
    });

    return {
      query: response.query,
      answer: response.answer,
      results: response.results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        publishedDate: r.publishedDate,
      })),
      responseTime: response.responseTime,
    };
  } catch (error: unknown) {
    if (error instanceof WebSearchError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new WebSearchError(
      `Search failed: ${message}`,
      "SEARCH_FAILED",
      (error as { response?: { status?: number } }).response?.status,
    );
  }
}

/**
 * Extract content from one or more URLs
 *
 * @param urls - URLs to extract content from
 * @param options - Extraction options
 * @returns Extracted content and any failures
 */
export async function extract(
  urls: string | string[],
  options: WebExtractOptions = {},
): Promise<WebExtractResponse> {
  const urlArray = Array.isArray(urls) ? urls : [urls];

  if (urlArray.length === 0) {
    throw new WebSearchError(
      "At least one URL is required for extraction",
      "INVALID_URLS",
    );
  }

  // Validate URLs
  for (const url of urlArray) {
    try {
      new URL(url);
    } catch {
      throw new WebSearchError(`Invalid URL: ${url}`, "INVALID_URL");
    }
  }

  try {
    const client = getClient();
    const response = await client.extract(urlArray, {
      extractDepth: options.extractDepth ?? "basic",
      format: options.format ?? "markdown",
      includeImages: options.includeImages ?? false,
    });

    return {
      results: response.results.map((r) => ({
        url: r.url,
        title: r.title,
        rawContent: r.rawContent,
        images: r.images,
      })),
      failedResults: response.failedResults.map((r) => ({
        url: r.url,
        error: r.error,
      })),
      responseTime: response.responseTime,
    };
  } catch (error: unknown) {
    if (error instanceof WebSearchError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new WebSearchError(
      `Extraction failed: ${message}`,
      "EXTRACT_FAILED",
      (error as { response?: { status?: number } }).response?.status,
    );
  }
}

/**
 * Crawl a website starting from a URL
 *
 * @param url - Starting URL for the crawl
 * @param options - Crawl options
 * @returns Crawled pages with extracted content
 */
export async function crawl(
  url: string,
  options: WebCrawlOptions = {},
): Promise<WebCrawlResponse> {
  if (!url || url.trim().length === 0) {
    throw new WebSearchError("URL cannot be empty", "INVALID_URL");
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    throw new WebSearchError(`Invalid URL: ${url}`, "INVALID_URL");
  }

  try {
    const client = getClient();
    const response = await client.crawl(url, {
      maxDepth: options.maxDepth ?? 1,
      maxBreadth: options.maxBreadth ?? 10,
      limit: options.limit ?? 10,
      instructions: options.instructions,
      extractDepth: options.extractDepth ?? "basic",
      format: options.format ?? "markdown",
      includeImages: options.includeImages ?? false,
      selectPaths: options.selectPaths,
      excludePaths: options.excludePaths,
      allowExternal: options.allowExternal ?? false,
    });

    return {
      baseUrl: response.baseUrl,
      results: response.results.map((r) => ({
        url: r.url,
        rawContent: r.rawContent,
        images: r.images,
      })),
      responseTime: response.responseTime,
    };
  } catch (error: unknown) {
    if (error instanceof WebSearchError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new WebSearchError(
      `Crawl failed: ${message}`,
      "CRAWL_FAILED",
      (error as { response?: { status?: number } }).response?.status,
    );
  }
}
