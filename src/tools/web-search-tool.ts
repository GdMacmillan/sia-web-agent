/**
 * Web Tools - Tavily-powered Search, Extract, Crawl, and Map
 *
 * Four separate tools, one per upstream operation:
 * - `web_search`  — find pages matching a query (requires `query`)
 * - `web_extract` — read the content of URLs you already have (requires `urls`)
 * - `web_crawl`   — follow links from a URL and return page content (requires `url`)
 * - `web_map`     — follow links from a URL and return only the URL list (requires `url`)
 *
 * Splitting them means each tool's schema enforces exactly the arguments that
 * operation needs. The previous single tool multiplexed all four behind an
 * optional `mode` parameter whose enum omitted "search", so naming the mode you
 * wanted for the most common operation was a validation error.
 *
 * Requires TAVILY_API_KEY environment variable.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import {
  search,
  extract,
  crawl,
  map,
  isConfigured,
} from "../web-search/tavily-client.js";
import { WebSearchError } from "../web-search/types.js";
import type { WebUsage } from "../web-search/types.js";

/**
 * Upstream parameters deliberately NOT exposed on any of these tools:
 *
 * - `includeImages` / `includeImageDescriptions` — nothing downstream consumes
 *   image URLs, and they inflate the result payload.
 * - `includeFavicon` — same; presentation-only, and there is no UI reading it.
 * - `maxTokens` — output size is bounded here instead (see MAX_OUTPUT_CHARS),
 *   so the two budgets cannot disagree.
 * - `safeSearch` — a real API parameter, but still absent from the SDK's typed
 *   options. It is reachable only through the `[key: string]: any` index
 *   signature, and that path spreads keys verbatim with no camelCase→snake_case
 *   conversion, so it would have to be sent as the literal `safe_search`.
 *   Sending an unvalidated key is not worth it; revisit when the SDK types it.
 * - `research` / `getResearch` — a separate long-running product surface with
 *   its own polling lifecycle, not a variant of these calls.
 * - `humanId` — an end-user identifier. Deliberately never sent.
 *
 * `includeUsage` is set by the tool rather than the model: it is free, and the
 * credit count is reported back so the cost of a call is visible.
 */

/**
 * Models routinely serialize booleans as the strings "true" / "false" — most
 * often for a field whose JSON Schema is an `anyOf`, where the boolean branch
 * is only one of several and the model hedges toward a string.
 *
 * Coerce instead of rejecting. A rejected tool call costs the model a whole
 * turn to discover and retry, which is precisely the failure this tool split
 * exists to remove; there is nothing to be gained by being strict about the
 * spelling of a boolean.
 */
function boolish<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess(
    (v) => (v === "true" ? true : v === "false" ? false : v),
    inner,
  );
}

/**
 * Coerce a stringified number and clamp it into the API's accepted range.
 *
 * Same reasoning as `boolish`: models emit `"5"` as readily as `5`, and a
 * model that asks for more results than the API allows meant "as many as I can
 * get" — clamping answers that, while rejecting spends a turn teaching it a
 * bound the description already states.
 */
function intish(min: number, max: number) {
  return z.preprocess((v) => clampNumeric(v, min, max, true), z.number().int());
}

/** `intish` for the float-valued timeouts. */
function numish(min: number, max: number) {
  return z.preprocess((v) => clampNumeric(v, min, max, false), z.number());
}

function clampNumeric(
  value: unknown,
  min: number,
  max: number,
  round: boolean,
): unknown {
  const n =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return value;
  return Math.min(max, Math.max(min, round ? Math.round(n) : n));
}

/**
 * Accept a bare host (`docs.example.com`) as well as a full URL. Models drop
 * the scheme routinely, and rejecting one costs the same turn as any other
 * validation failure.
 */
const urlish = z.preprocess(
  (v) =>
    typeof v === "string" &&
    v.trim() !== "" &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v.trim())
      ? `https://${v.trim()}`
      : v,
  z.string().url(),
);

/** Overall backstop on a tool's output. Per-result clipping normally binds first. */
const MAX_OUTPUT_CHARS = 32000;
/** Character budget shared across the results of a single call. */
const RESULT_CHAR_BUDGET = 24000;
/** Floor for a single result's share, so a wide result set still says something useful. */
const MIN_RESULT_CHARS = 500;
/** Ceiling for a single result's share, so one long page cannot crowd out the rest. */
const MAX_RESULT_CHARS = 8000;

/**
 * Per-result character budget for a call returning `count` results.
 *
 * Clipping each result *before* joining is what makes the output stable: the
 * previous implementation clipped the joined string, so the trailing results
 * disappeared with no indication they had ever been returned.
 */
function perResultBudget(count: number): number {
  if (count <= 0) return MAX_RESULT_CHARS;
  return Math.min(
    MAX_RESULT_CHARS,
    Math.max(MIN_RESULT_CHARS, Math.floor(RESULT_CHAR_BUDGET / count)),
  );
}

/**
 * Clip one result's content, marking the truncation inline.
 */
function clipResult(content: string, budget: number): string {
  if (content.length <= budget) return content;
  const dropped = content.length - budget;
  return `${content.slice(0, budget)}\n...[truncated ${dropped} more characters of this result]...`;
}

/**
 * Backstop clip applied to the fully assembled output.
 */
function clipOutput(
  content: string,
  maxChars: number = MAX_OUTPUT_CHARS,
): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n...[truncated]...";
}

/**
 * Render the credit usage line, when the API reported it.
 */
function usageLine(usage: WebUsage | undefined): string[] {
  return usage ? [`Credits used: ${usage.credits}`] : [];
}

/**
 * The LangGraph thread id, forwarded to Tavily as a session id so calls made
 * within one conversation are grouped upstream.
 */
function sessionIdFrom(config?: RunnableConfig): string | undefined {
  const threadId = config?.configurable?.thread_id;
  return typeof threadId === "string" && threadId.length > 0
    ? threadId
    : undefined;
}

/**
 * Guard shared by every tool: a missing key is reported once, in the tool
 * result, rather than as a thrown error.
 */
function missingKeyMessage(): string {
  return (
    "Error: TAVILY_API_KEY environment variable is not set. " +
    "Get an API key at https://tavily.com (free tier: 1000 credits/month)"
  );
}

/**
 * Map a thrown value onto the string a tool returns. Tool errors are results,
 * not exceptions, per the codebase-wide convention.
 */
function errorMessage(error: unknown): string {
  if (error instanceof WebSearchError) {
    return `Error (${error.code}): ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${message}`;
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
    publishedDate?: string;
  }>,
  responseTime: number,
  usage?: WebUsage,
): string {
  const lines: string[] = [];

  lines.push(`# Web Search Results for: "${query}"`);
  lines.push(`Response time: ${responseTime.toFixed(2)}s`);
  lines.push(...usageLine(usage));
  lines.push("");

  if (answer) {
    lines.push("## AI-Generated Answer");
    lines.push(clipResult(answer, MAX_RESULT_CHARS));
    lines.push("");
  }

  if (results.length === 0) {
    lines.push("No results found.");
    return lines.join("\n");
  }

  const budget = perResultBudget(results.length);
  lines.push(`## Search Results (${results.length})`);
  lines.push("");
  for (const result of results) {
    lines.push(`### ${result.title}`);
    lines.push(`URL: ${result.url}`);
    lines.push(`Relevance: ${(result.score * 100).toFixed(0)}%`);
    if (result.publishedDate) {
      lines.push(`Published: ${result.publishedDate}`);
    }
    lines.push("");
    lines.push(clipResult(result.content, budget));
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format extraction results for display
 */
function formatExtractResults(
  results: Array<{ url: string; title: string | null; rawContent: string }>,
  failedResults: Array<{ url: string; error: string }>,
  responseTime: number,
  usage?: WebUsage,
): string {
  const lines: string[] = [];

  lines.push(
    `# Extracted Content (${results.length} of ${results.length + failedResults.length} URLs)`,
  );
  lines.push(`Response time: ${responseTime.toFixed(2)}s`);
  lines.push(...usageLine(usage));
  lines.push("");

  if (results.length > 0) {
    const budget = perResultBudget(results.length);
    for (const result of results) {
      if (result.title) {
        lines.push(`## ${result.title}`);
      }
      lines.push(`Source: ${result.url}`);
      lines.push("");
      lines.push(clipResult(result.rawContent, budget));
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
  usage?: WebUsage,
): string {
  const lines: string[] = [];

  lines.push(`# Crawl Results for: ${baseUrl}`);
  lines.push(`Pages crawled: ${results.length}`);
  lines.push(`Response time: ${responseTime.toFixed(2)}s`);
  lines.push(...usageLine(usage));
  lines.push("");

  if (results.length === 0) {
    lines.push(
      "No pages crawled. The start URL may block crawlers, or the path/domain filters may exclude everything reachable from it.",
    );
    return lines.join("\n");
  }

  const budget = perResultBudget(results.length);
  for (const result of results) {
    lines.push(`## ${result.url}`);
    lines.push("");
    lines.push(clipResult(result.rawContent, budget));
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format map results for display
 */
function formatMapResults(
  baseUrl: string,
  results: string[],
  responseTime: number,
  usage?: WebUsage,
): string {
  const lines: string[] = [];

  lines.push(`# Site Map for: ${baseUrl}`);
  lines.push(`URLs discovered: ${results.length}`);
  lines.push(`Response time: ${responseTime.toFixed(2)}s`);
  lines.push(...usageLine(usage));
  lines.push("");

  if (results.length === 0) {
    lines.push(
      "No URLs discovered. The start URL may block crawlers, or the path/domain filters may exclude everything reachable from it.",
    );
    return lines.join("\n");
  }

  for (const url of results) {
    lines.push(`- ${url}`);
  }

  return lines.join("\n");
}

/** Shared schema fragment: regex path/domain filters used by crawl and map. */
const traversalFilterSchema = {
  selectPaths: z
    .array(z.string())
    .optional()
    .describe(
      "Only visit URLs whose path matches one of these regexes (e.g. ['/docs/.*'])",
    ),
  selectDomains: z
    .array(z.string())
    .optional()
    .describe(
      "Only visit URLs whose domain matches one of these regexes (e.g. ['^docs\\\\.example\\\\.com$'])",
    ),
  excludePaths: z
    .array(z.string())
    .optional()
    .describe("Skip URLs whose path matches one of these regexes"),
  excludeDomains: z
    .array(z.string())
    .optional()
    .describe("Skip URLs whose domain matches one of these regexes"),
  allowExternal: boolish(z.boolean())
    .optional()
    .default(false)
    .describe(
      "Follow links off the starting domain. Defaults to false to keep the traversal on one site.",
    ),
};

/**
 * Create the `web_search` tool
 */
export function createWebSearchTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "web_search",
    description: `Search the web for pages matching a query. This is the tool to reach for first when you need information from the internet.

Returns ranked results — title, URL, relevance, publication date, and a content snippet — plus an AI-generated answer summarising them.

USE WHEN: you need current information not in your knowledge, are researching an external API or library, or are looking for news and recent developments.

FOLLOW UP WITH: 'web_extract' on the URLs whose full text you actually need — search snippets are excerpts, not whole pages.

COST: 'basic', 'fast' and 'ultra-fast' depths cost 1 credit per search; 'advanced' and 'autoParameters' cost 2. The free tier is 1,000 credits per month, so prefer the default 'basic'.

REQUIRES: TAVILY_API_KEY environment variable`,

    schema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "The search query. Be specific and include relevant context (e.g. 'LangGraph interrupt() resume semantics' rather than 'langgraph').",
        ),
      maxResults: intish(1, 20)
        .optional()
        .default(5)
        .describe("Number of results to return (1-20)"),
      searchDepth: z
        .enum(["basic", "advanced", "fast", "ultra-fast"])
        .optional()
        .default("basic")
        .describe(
          "'basic' (1 credit) suits most queries; 'fast'/'ultra-fast' trade recall for latency at the same price; 'advanced' (2 credits) digs deeper for hard queries.",
        ),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .default("general")
        .describe(
          "Search index to query. Use 'news' for current events and 'finance' for markets.",
        ),
      includeAnswer: boolish(
        z.union([z.boolean(), z.enum(["basic", "advanced"])]),
      )
        .optional()
        .default(true)
        .describe(
          "Include an AI-generated answer. 'advanced' produces a longer synthesis; false skips it.",
        ),
      chunksPerSource: intish(1, 3)
        .optional()
        .describe(
          "Content snippets returned per result (1-3, default 3). Lower it to keep the output small. Not available at 'ultra-fast' depth.",
        ),
      includeDomains: z
        .array(z.string())
        .max(300)
        .optional()
        .describe(
          "Only return results from these domains (e.g. ['github.com', 'docs.python.org'])",
        ),
      excludeDomains: z
        .array(z.string())
        .max(150)
        .optional()
        .describe("Never return results from these domains"),
      includeDomainsMode: z
        .enum(["filter", "boost"])
        .optional()
        .describe(
          "How includeDomains applies: 'filter' returns only those domains, 'boost' merely ranks them higher. Ignored unless includeDomains is set.",
        ),
      language: z
        .string()
        .optional()
        .describe(
          "Preferred result language — ISO 639-1 code ('en', 'fr', 'zh-cn') or English name ('french'). Boosts that language in the ranking. Write the query in the same language.",
        ),
      filterByLanguage: boolish(z.boolean())
        .optional()
        .describe(
          "Drop results not in 'language' rather than merely boosting them. Ignored unless 'language' is set.",
        ),
      timeRange: z
        .enum(["day", "week", "month", "year", "d", "w", "m", "y"])
        .optional()
        .describe(
          "Only return results published within this window. 'd'/'w'/'m'/'y' are the API's own aliases for the long forms and are accepted too.",
        ),
      startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          "Earliest publication date, YYYY-MM-DD. Use with endDate for an explicit window instead of timeRange.",
        ),
      endDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Latest publication date, YYYY-MM-DD"),
      country: z
        .string()
        .optional()
        .describe(
          "Boost results from this country, lowercase English name (e.g. 'united kingdom'). Only applies when topic is 'general'.",
        ),
      exactMatch: boolish(z.boolean())
        .optional()
        .describe(
          "Require the query terms to appear verbatim. Useful for error strings and exact identifiers.",
        ),
      autoParameters: boolish(z.boolean())
        .optional()
        .describe(
          "Let the API choose search parameters for the query. Costs 2 credits and overrides some of your choices — use only when a plain search has already failed.",
        ),
    }),

    // `days` is omitted: it duplicates `timeRange` for the news topic, and
    // startDate/endDate cover explicit windows unambiguously.
    // `includeRawContent` is omitted: full page text belongs to `web_extract`,
    // where it can be budgeted per URL rather than multiplied by result count.
    // `timeout` is omitted: search is the fast path and the SDK default holds.
    func: async (input, _runManager, config?: RunnableConfig) => {
      if (!isConfigured()) {
        return missingKeyMessage();
      }

      try {
        const result = await search(input.query, {
          maxResults: input.maxResults,
          searchDepth: input.searchDepth,
          topic: input.topic,
          includeAnswer: input.includeAnswer,
          chunksPerSource: input.chunksPerSource,
          includeDomains: input.includeDomains,
          excludeDomains: input.excludeDomains,
          // The API 400s on a dependent flag whose partner is absent, so these
          // two are dropped rather than forwarded alone. Enforcing the pairing
          // in the schema instead would turn a recoverable omission into the
          // kind of validation error this tool split exists to remove.
          includeDomainsMode: input.includeDomains?.length
            ? input.includeDomainsMode
            : undefined,
          language: input.language,
          filterByLanguage: input.language ? input.filterByLanguage : undefined,
          timeRange: input.timeRange,
          startDate: input.startDate,
          endDate: input.endDate,
          country: input.country,
          exactMatch: input.exactMatch,
          autoParameters: input.autoParameters,
          includeUsage: true,
          sessionId: sessionIdFrom(config),
        });

        return clipOutput(
          formatSearchResults(
            result.query,
            result.answer,
            result.results,
            result.responseTime,
            result.usage,
          ),
        );
      } catch (error: unknown) {
        return errorMessage(error);
      }
    },
  });
}

/**
 * Create the `web_extract` tool
 */
export function createWebExtractTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "web_extract",
    description: `Read the full content of web pages whose URLs you already have. Returns each page as markdown or plain text.

USE WHEN: you have specific URLs — from 'web_search' results, from the user, or from a 'web_map' listing — and need what is actually on them rather than a snippet.

Pass up to 20 URLs in one call; batching is cheaper and faster than one call per URL.

INTENT-BASED EXTRACTION: supply 'query' to describe what you are looking for and the page is returned as the most relevant chunks instead of in full. Use it on long pages when you want one specific fact.

COST: 'basic' depth costs 1 credit per 5 URLs, 'advanced' costs 2 per 5. 'advanced' also recovers tables and embedded content.

REQUIRES: TAVILY_API_KEY environment variable`,

    schema: z.object({
      // A bare string is accepted and wrapped: the operation reads "one or
      // more pages", and a model handed a single URL naturally sends it alone.
      urls: z
        .preprocess(
          (v) => (typeof v === "string" ? [v] : v),
          z.array(urlish).min(1).max(20),
        )
        .describe("URLs to read (1-20 per call)"),
      query: z
        .string()
        .optional()
        .describe(
          "What you are looking for on these pages. Supplying it reranks the content and returns matching chunks instead of the whole page.",
        ),
      chunksPerSource: intish(1, 5)
        .optional()
        .describe(
          "Chunks returned per page (1-5, default 3). Only takes effect when 'query' is supplied.",
        ),
      extractDepth: z
        .enum(["basic", "advanced"])
        .optional()
        .default("basic")
        .describe(
          "'basic' (1 credit / 5 URLs) for ordinary pages; 'advanced' (2 credits / 5 URLs) when you need tables or embedded content.",
        ),
      format: z
        .enum(["markdown", "text"])
        .optional()
        .default("markdown")
        .describe(
          "'markdown' preserves headings, lists and links; 'text' is plain prose.",
        ),
      timeout: numish(1, 60)
        .optional()
        .describe(
          "Seconds to wait before giving up (1-60). Defaults to 10 for basic depth, 30 for advanced.",
        ),
    }),

    func: async (input, _runManager, config?: RunnableConfig) => {
      if (!isConfigured()) {
        return missingKeyMessage();
      }

      try {
        const result = await extract(input.urls, {
          query: input.query,
          chunksPerSource: input.chunksPerSource,
          extractDepth: input.extractDepth,
          format: input.format,
          timeout: input.timeout,
          includeUsage: true,
          sessionId: sessionIdFrom(config),
        });

        return clipOutput(
          formatExtractResults(
            result.results,
            result.failedResults,
            result.responseTime,
            result.usage,
          ),
        );
      } catch (error: unknown) {
        return errorMessage(error);
      }
    },
  });
}

/**
 * Traversal timeout default. The API allows 150s and defaults to it, which
 * outlives our tool budgets — a crawl or map left on the API default can sit
 * pending long enough that the run looks hung.
 */
const TRAVERSAL_DEFAULT_TIMEOUT_SECONDS = 45;

/**
 * Create the `web_crawl` tool
 */
export function createWebCrawlTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "web_crawl",
    description: `Follow links from a starting URL and return the content of every page visited.

USE WHEN: you need a whole section of a site rather than known pages — reading a documentation tree, gathering every changelog entry, surveying an API reference.

DO NOT USE for a question a plain 'web_search' answers, or for pages you can already name — 'web_extract' is far cheaper for those. Crawling is the expensive option; reach for it when the site's structure is the point.

Consider 'web_map' first to see which URLs exist, then 'web_extract' on the ones that matter. That is usually cheaper than crawling and returns exactly the pages you want.

COST: 1 credit per 10 pages, or 2 per 10 when 'instructions' are supplied.

REQUIRES: TAVILY_API_KEY environment variable`,

    schema: z.object({
      url: urlish.describe("The URL to start crawling from"),
      instructions: z
        .string()
        .optional()
        .describe(
          "Natural-language guidance for which pages matter (e.g. 'Find pages about authentication and rate limits'). Doubles the credit cost but sharply improves relevance.",
        ),
      maxDepth: intish(1, 5)
        .optional()
        .default(1)
        .describe(
          "How many links deep to follow from the start URL (1-5). Each level multiplies the pages visited.",
        ),
      maxBreadth: intish(1, 500)
        .optional()
        .default(20)
        .describe("Maximum links followed per page (1-500)"),
      limit: intish(1, 100)
        .optional()
        .default(20)
        .describe(
          "Total pages to visit before stopping (1-100). Kept below the API's own default to bound both cost and output size.",
        ),
      chunksPerSource: intish(1, 5)
        .optional()
        .describe(
          "Chunks returned per page (1-5, default 3). Only takes effect when 'instructions' are supplied.",
        ),
      extractDepth: z
        .enum(["basic", "advanced"])
        .optional()
        .default("basic")
        .describe(
          "Content extraction depth for each page crawled. 'advanced' recovers tables and embedded content.",
        ),
      format: z
        .enum(["markdown", "text"])
        .optional()
        .default("markdown")
        .describe("Output format for page content"),
      ...traversalFilterSchema,
      timeout: numish(10, 150)
        .optional()
        .default(TRAVERSAL_DEFAULT_TIMEOUT_SECONDS)
        .describe(
          "Seconds to wait before giving up (10-150). Defaults to 45; the API's own 150s default outlives most tool budgets.",
        ),
    }),

    func: async (input, _runManager, config?: RunnableConfig) => {
      if (!isConfigured()) {
        return missingKeyMessage();
      }

      try {
        const result = await crawl(input.url, {
          instructions: input.instructions,
          maxDepth: input.maxDepth,
          maxBreadth: input.maxBreadth,
          limit: input.limit,
          chunksPerSource: input.chunksPerSource,
          extractDepth: input.extractDepth,
          format: input.format,
          selectPaths: input.selectPaths,
          selectDomains: input.selectDomains,
          excludePaths: input.excludePaths,
          excludeDomains: input.excludeDomains,
          allowExternal: input.allowExternal,
          timeout: input.timeout,
          includeUsage: true,
          sessionId: sessionIdFrom(config),
        });

        return clipOutput(
          formatCrawlResults(
            result.baseUrl,
            result.results,
            result.responseTime,
            result.usage,
          ),
        );
      } catch (error: unknown) {
        return errorMessage(error);
      }
    },
  });
}

/**
 * Create the `web_map` tool
 */
export function createWebMapTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "web_map",
    description: `Discover a site's URL structure. Follows links from a starting URL and returns the list of URLs found — no page content.

USE WHEN: the site's shape is the question — which pages exist, how a documentation set is organised, whether a section you expect is there at all.

This is the cheap reconnaissance step. Map first to see what exists, then 'web_extract' the handful of URLs that matter. Only fall back to 'web_crawl' when you genuinely need the content of everything.

COST: 1 credit per 10 pages, or 2 per 10 when 'instructions' are supplied.

REQUIRES: TAVILY_API_KEY environment variable`,

    schema: z.object({
      url: urlish.describe("The URL to start mapping from"),
      instructions: z
        .string()
        .optional()
        .describe(
          "Natural-language guidance for which parts of the site matter (e.g. 'Focus on the API reference'). Doubles the credit cost.",
        ),
      maxDepth: intish(1, 5)
        .optional()
        .default(1)
        .describe("How many links deep to follow from the start URL (1-5)"),
      maxBreadth: intish(1, 500)
        .optional()
        .default(20)
        .describe("Maximum links followed per page (1-500)"),
      limit: intish(1, 500)
        .optional()
        .default(50)
        .describe(
          "Total URLs to collect before stopping (1-500). Higher limits are affordable here because no page content is returned.",
        ),
      ...traversalFilterSchema,
      timeout: numish(10, 150)
        .optional()
        .default(TRAVERSAL_DEFAULT_TIMEOUT_SECONDS)
        .describe(
          "Seconds to wait before giving up (10-150). Defaults to 45, matching web_crawl; the API's own 150s default outlives most tool budgets.",
        ),
    }),

    func: async (input, _runManager, config?: RunnableConfig) => {
      if (!isConfigured()) {
        return missingKeyMessage();
      }

      try {
        const result = await map(input.url, {
          instructions: input.instructions,
          maxDepth: input.maxDepth,
          maxBreadth: input.maxBreadth,
          limit: input.limit,
          selectPaths: input.selectPaths,
          selectDomains: input.selectDomains,
          excludePaths: input.excludePaths,
          excludeDomains: input.excludeDomains,
          allowExternal: input.allowExternal,
          timeout: input.timeout,
          includeUsage: true,
          sessionId: sessionIdFrom(config),
        });

        return clipOutput(
          formatMapResults(
            result.baseUrl,
            result.results,
            result.responseTime,
            result.usage,
          ),
        );
      } catch (error: unknown) {
        return errorMessage(error);
      }
    },
  });
}

/**
 * Create every web tool.
 *
 * Registration is all-or-nothing: the four tools share one API key, so a
 * caller that can register one can register all of them.
 */
export function createWebTools(): DynamicStructuredTool[] {
  return [
    createWebSearchTool(),
    createWebExtractTool(),
    createWebCrawlTool(),
    createWebMapTool(),
  ];
}
