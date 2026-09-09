/**
 * Web Search Types
 *
 * TypeScript interfaces for the four Tavily operations exposed as tools:
 * - Search: web search with optional answer generation
 * - Extract: content extraction from a list of URLs
 * - Crawl: site traversal that returns page content
 * - Map: site traversal that returns only the URL structure
 */

/** Credit usage reported by the API when `includeUsage` is requested. */
export interface WebUsage {
  /** Credits consumed by the request */
  credits: number;
}

/**
 * Options shared by every operation.
 */
interface WebCommonOptions {
  /**
   * Opaque session identifier forwarded as the `X-Session-Id` header so the
   * provider can group the calls made within one conversation. Callers pass
   * the LangGraph thread id.
   */
  sessionId?: string;
}

/**
 * Search operation options
 */
export interface WebSearchOptions extends WebCommonOptions {
  /** Maximum number of results (1-20, default: 5) */
  maxResults?: number;
  /**
   * Search depth. "basic", "fast" and "ultra-fast" cost 1 credit;
   * "advanced" costs 2.
   */
  searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
  /** Topic category for specialized results */
  topic?: "general" | "news" | "finance";
  /** Whether to include an AI-generated answer summary (or its depth) */
  includeAnswer?: boolean | "basic" | "advanced";
  /** Content chunks returned per source (1-3) */
  chunksPerSource?: number;
  /** Whether to return the full page content alongside each result */
  includeRawContent?: false | "markdown" | "text";
  /** Domains to include in search results */
  includeDomains?: string[];
  /** Domains to exclude from search results */
  excludeDomains?: string[];
  /** Whether includeDomains filters results or merely boosts them */
  includeDomainsMode?: "filter" | "boost";
  /** Preferred result language: ISO 639-1 code or English name */
  language?: string;
  /** Drop results not in `language` instead of merely boosting them */
  filterByLanguage?: boolean;
  /** Time range filter for results (long or short form) */
  timeRange?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  /** Number of days back to search (news topic) */
  days?: number;
  /** Earliest publication date, YYYY-MM-DD */
  startDate?: string;
  /** Latest publication date, YYYY-MM-DD */
  endDate?: string;
  /** Boost results from a country (general topic only) */
  country?: string;
  /** Require the query terms to appear verbatim */
  exactMatch?: boolean;
  /** Let the API pick search parameters for the query (costs 2 credits) */
  autoParameters?: boolean;
  /** Whether to return each result's favicon */
  includeFavicon?: boolean;
  /** Whether to return credit usage */
  includeUsage?: boolean;
  /** Request timeout in seconds */
  timeout?: number;
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
  /** Full page content, when includeRawContent was requested */
  rawContent?: string;
  /** Relevance score (0-1) */
  score: number;
  /** Publication date if available */
  publishedDate?: string;
  /** Favicon URL, when includeFavicon was requested */
  favicon?: string;
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
  /** Credit usage, when includeUsage was requested */
  usage?: WebUsage;
}

/**
 * Extract operation options
 */
export interface WebExtractOptions extends WebCommonOptions {
  /** Extraction depth: "basic" (faster) or "advanced" (tables, embedded content) */
  extractDepth?: "basic" | "advanced";
  /** Output format */
  format?: "markdown" | "text";
  /** User intent used to rerank the extracted chunks */
  query?: string;
  /** Content chunks returned per source (1-5, requires `query`) */
  chunksPerSource?: number;
  /** Request timeout in seconds (1-60) */
  timeout?: number;
  /** Whether to include images */
  includeImages?: boolean;
  /** Whether to return each page's favicon */
  includeFavicon?: boolean;
  /** Whether to return credit usage */
  includeUsage?: boolean;
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
  /** Favicon URL, when includeFavicon was requested */
  favicon?: string;
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
  /** Credit usage, when includeUsage was requested */
  usage?: WebUsage;
}

/**
 * Options shared by the two site-traversal operations (crawl and map).
 */
interface WebTraversalOptions extends WebCommonOptions {
  /** Maximum link depth to traverse (1-5) */
  maxDepth?: number;
  /** Maximum links followed per page (1-500) */
  maxBreadth?: number;
  /** Maximum total pages to visit */
  limit?: number;
  /** Natural language instructions to guide the traversal */
  instructions?: string;
  /** Paths to include (regex patterns) */
  selectPaths?: string[];
  /** Domains to include (regex patterns) */
  selectDomains?: string[];
  /** Paths to exclude (regex patterns) */
  excludePaths?: string[];
  /** Domains to exclude (regex patterns) */
  excludeDomains?: string[];
  /** Whether to follow links off the starting domain */
  allowExternal?: boolean;
  /** Request timeout in seconds (10-150) */
  timeout?: number;
  /** Whether to return credit usage */
  includeUsage?: boolean;
}

/**
 * Crawl operation options
 */
export interface WebCrawlOptions extends WebTraversalOptions {
  /** Extraction depth for page content */
  extractDepth?: "basic" | "advanced";
  /** Output format */
  format?: "markdown" | "text";
  /** Content chunks returned per page (1-5, requires `instructions`) */
  chunksPerSource?: number;
  /** Whether to include images */
  includeImages?: boolean;
  /** Whether to return each page's favicon */
  includeFavicon?: boolean;
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
  /** Favicon URL, when includeFavicon was requested */
  favicon?: string;
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
  /** Credit usage, when includeUsage was requested */
  usage?: WebUsage;
}

/**
 * Map operation options
 *
 * Map takes the same traversal controls as crawl but returns only URLs, so it
 * has no content-extraction options.
 */
export type WebMapOptions = WebTraversalOptions;

/**
 * Map operation response
 */
export interface WebMapResponse {
  /** Base URL that was mapped */
  baseUrl: string;
  /** Discovered URLs */
  results: string[];
  /** Response time in seconds */
  responseTime: number;
  /** Credit usage, when includeUsage was requested */
  usage?: WebUsage;
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
