/**
 * Tavily Client Wrapper
 *
 * Thin wrapper around @tavily/core providing:
 * - Simplified interface for search, extract, crawl, and map operations
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
  WebMapOptions,
  WebMapResponse,
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
 * Validate a URL, throwing a WebSearchError rather than a TypeError.
 */
function assertValidUrl(url: string): void {
  try {
    new URL(url);
  } catch {
    throw new WebSearchError(`Invalid URL: ${url}`, "INVALID_URL");
  }
}

/**
 * Wrap an unknown thrown value in a WebSearchError with an operation code.
 */
function toWebSearchError(
  error: unknown,
  label: string,
  code: string,
): WebSearchError {
  if (error instanceof WebSearchError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new WebSearchError(
    `${label}: ${message}`,
    code,
    (error as { response?: { status?: number } }).response?.status,
  );
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
      chunksPerSource: options.chunksPerSource,
      includeRawContent: options.includeRawContent,
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
      includeDomainsMode: options.includeDomainsMode,
      language: options.language,
      filterByLanguage: options.filterByLanguage,
      timeRange: options.timeRange,
      days: options.days,
      startDate: options.startDate,
      endDate: options.endDate,
      country: options.country,
      exactMatch: options.exactMatch,
      autoParameters: options.autoParameters,
      includeFavicon: options.includeFavicon,
      includeUsage: options.includeUsage,
      timeout: options.timeout,
      sessionId: options.sessionId,
    });

    return {
      query: response.query,
      answer: response.answer,
      results: response.results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        rawContent: r.rawContent,
        score: r.score,
        publishedDate: r.publishedDate,
        favicon: r.favicon,
      })),
      responseTime: response.responseTime,
      usage: response.usage,
    };
  } catch (error: unknown) {
    throw toWebSearchError(error, "Search failed", "SEARCH_FAILED");
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

  for (const url of urlArray) {
    assertValidUrl(url);
  }

  try {
    const client = getClient();
    const response = await client.extract(urlArray, {
      extractDepth: options.extractDepth ?? "basic",
      format: options.format ?? "markdown",
      query: options.query,
      chunksPerSource: options.chunksPerSource,
      timeout: options.timeout,
      includeImages: options.includeImages ?? false,
      includeFavicon: options.includeFavicon,
      includeUsage: options.includeUsage,
      sessionId: options.sessionId,
    });

    return {
      results: response.results.map((r) => ({
        url: r.url,
        title: r.title,
        rawContent: r.rawContent,
        images: r.images,
        favicon: r.favicon,
      })),
      failedResults: response.failedResults.map((r) => ({
        url: r.url,
        error: r.error,
      })),
      responseTime: response.responseTime,
      usage: response.usage,
    };
  } catch (error: unknown) {
    throw toWebSearchError(error, "Extraction failed", "EXTRACT_FAILED");
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

  assertValidUrl(url);

  try {
    const client = getClient();
    const response = await client.crawl(url, {
      maxDepth: options.maxDepth ?? 1,
      maxBreadth: options.maxBreadth ?? 20,
      limit: options.limit ?? 20,
      instructions: options.instructions,
      extractDepth: options.extractDepth ?? "basic",
      format: options.format ?? "markdown",
      chunksPerSource: options.chunksPerSource,
      includeImages: options.includeImages ?? false,
      selectPaths: options.selectPaths,
      selectDomains: options.selectDomains,
      excludePaths: options.excludePaths,
      excludeDomains: options.excludeDomains,
      allowExternal: options.allowExternal ?? false,
      timeout: options.timeout,
      includeFavicon: options.includeFavicon,
      includeUsage: options.includeUsage,
      sessionId: options.sessionId,
    });

    return {
      baseUrl: response.baseUrl,
      results: response.results.map((r) => ({
        url: r.url,
        rawContent: r.rawContent,
        images: r.images,
        favicon: r.favicon,
      })),
      responseTime: response.responseTime,
      usage: response.usage,
    };
  } catch (error: unknown) {
    throw toWebSearchError(error, "Crawl failed", "CRAWL_FAILED");
  }
}

/**
 * Map a website's URL structure starting from a URL
 *
 * Same traversal controls as `crawl`, but returns only the discovered URLs —
 * no page content — which makes it the cheap way to answer "what is on this
 * site?" before deciding what to extract.
 *
 * @param url - Starting URL for the map
 * @param options - Map options
 * @returns Discovered URLs
 */
export async function map(
  url: string,
  options: WebMapOptions = {},
): Promise<WebMapResponse> {
  if (!url || url.trim().length === 0) {
    throw new WebSearchError("URL cannot be empty", "INVALID_URL");
  }

  assertValidUrl(url);

  try {
    const client = getClient();
    const response = await client.map(url, {
      maxDepth: options.maxDepth ?? 1,
      maxBreadth: options.maxBreadth ?? 20,
      limit: options.limit ?? 50,
      instructions: options.instructions,
      selectPaths: options.selectPaths,
      selectDomains: options.selectDomains,
      excludePaths: options.excludePaths,
      excludeDomains: options.excludeDomains,
      allowExternal: options.allowExternal ?? false,
      timeout: options.timeout,
      includeUsage: options.includeUsage,
      sessionId: options.sessionId,
    });

    return {
      baseUrl: response.baseUrl,
      results: response.results,
      responseTime: response.responseTime,
      usage: response.usage,
    };
  } catch (error: unknown) {
    throw toWebSearchError(error, "Map failed", "MAP_FAILED");
  }
}
