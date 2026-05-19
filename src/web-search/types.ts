/**
 * Web Search Types
 *
 * TypeScript interfaces for Tavily API operations:
 * - Search: Web search with optional answer generation
 * - Extract: Content extraction from specific URLs
 * - Crawl: Site crawling with depth/breadth controls
 */

/**
 * Search operation options
 */
export interface WebSearchOptions {
  /** Maximum number of results (1-20, default: 5) */
  maxResults?: number;
  /** Search depth: "basic" (faster) or "advanced" (more thorough) */
  searchDepth?: "basic" | "advanced";
  /** Topic category for specialized results */
  topic?: "general" | "news" | "finance";
  /** Whether to include an AI-generated answer summary */
  includeAnswer?: boolean;
  /** Domains to include in search results */
  includeDomains?: string[];
  /** Domains to exclude from search results */
  excludeDomains?: string[];
  /** Time range filter for results */
  timeRange?: "day" | "week" | "month" | "year";
}

/**
 * Individual search result
 */
export interface WebSearchResult {
  /** Page title */
  title: string;
  /** Page URL */
  url: string;
  /** Extracted content snippet */
  content: string;
  /** Relevance score (0-1) */
  score: number;
  /** Publication date if available */
  publishedDate?: string;
}

/**
 * Search operation response
 */
export interface WebSearchResponse {
  /** Original query */
  query: string;
  /** AI-generated answer (if includeAnswer was true) */
  answer?: string;
  /** Search results */
  results: WebSearchResult[];
  /** Response time in seconds */
  responseTime: number;
}

/**
 * Extract operation options
 */
export interface WebExtractOptions {
  /** Extraction depth: "basic" (faster) or "advanced" (more thorough) */
  extractDepth?: "basic" | "advanced";
  /** Output format */
  format?: "markdown" | "text";
  /** Whether to include images */
  includeImages?: boolean;
}

/**
 * Individual extraction result
 */
export interface WebExtractResult {
  /** Source URL */
  url: string;
  /** Page title */
  title: string | null;
  /** Extracted content */
  rawContent: string;
  /** Extracted images if requested */
  images?: string[];
}

/**
 * Failed extraction result
 */
export interface WebExtractFailedResult {
  /** Source URL that failed */
  url: string;
  /** Error message */
  error: string;
}

/**
 * Extract operation response
 */
export interface WebExtractResponse {
  /** Successful extractions */
  results: WebExtractResult[];
  /** Failed extractions */
  failedResults: WebExtractFailedResult[];
  /** Response time in seconds */
  responseTime: number;
}

/**
 * Crawl operation options
 */
export interface WebCrawlOptions {
  /** Maximum link depth to crawl (default: 1) */
  maxDepth?: number;
  /** Maximum links per page (default: 10) */
  maxBreadth?: number;
  /** Maximum total pages to crawl (default: 10) */
  limit?: number;
  /** Natural language instructions to guide crawling */
  instructions?: string;
  /** Extraction depth for page content */
  extractDepth?: "basic" | "advanced";
  /** Output format */
  format?: "markdown" | "text";
  /** Whether to include images */
  includeImages?: boolean;
  /** Paths to include (regex patterns) */
  selectPaths?: string[];
  /** Paths to exclude (regex patterns) */
  excludePaths?: string[];
  /** Whether to follow external links */
  allowExternal?: boolean;
}

/**
 * Individual crawl page result
 */
export interface WebCrawlPageResult {
  /** Page URL */
  url: string;
  /** Extracted content */
  rawContent: string;
  /** Extracted images */
  images: string[];
}

/**
 * Crawl operation response
 */
export interface WebCrawlResponse {
  /** Base URL that was crawled */
  baseUrl: string;
  /** Crawled page results */
  results: WebCrawlPageResult[];
  /** Response time in seconds */
  responseTime: number;
}

/**
 * Unified web search tool input
 * Supports search, extract, and crawl modes
 */
export interface WebSearchToolInput {
  /** Search query (for search mode) */
  query?: string;
  /** URL to extract content from or crawl (for extract/crawl modes) */
  url?: string;
  /** Mode when URL is provided: "extract" or "crawl" */
  mode?: "extract" | "crawl";
  /** Search options */
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  topic?: "general" | "news" | "finance";
  includeAnswer?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  timeRange?: "day" | "week" | "month" | "year";
  /** Crawl-specific options */
  crawlInstructions?: string;
  maxDepth?: number;
  limit?: number;
}

/**
 * Error thrown by web search operations
 */
export class WebSearchError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}
