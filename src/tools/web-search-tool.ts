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
 * Models routinely serialize scalars as strings — `"true"` for a boolean, `"5"`
 * for a number — and hand a lone string where an array is declared. Every one
 * of those is understandable, and rejecting one costs the model a whole turn to
 * discover and retry, which is the failure this tool split exists to remove.
 *
 * The leniency lives in two halves that must stay separate:
 *
 *   - the SCHEMA below accepts the loose shapes, using only constructs that can
 *     be represented in JSON Schema;
 *   - the NORMALIZERS below convert them before the client call.
 *
 * A tool schema must contain NO transform of any kind — neither `z.preprocess`
 * nor `.transform()`. The schema is converted to JSON Schema to be advertised
 * to the model, and a transform cannot be represented there. `z.preprocess`
 * throws outright. `.transform()` throws conditionally: the converter strips a
 * trailing transform from an object property, an array item, `.optional()` and
 * `.nullable()`, but not from inside `.default()`, `.catch()`, a union, a
 * record or a tuple — and nearly every field here ends in one of those, so a
 * transform placed in this schema throws in practice. Either way the failure
 * is fatal at bind time: the whole run dies, not just the one call.
 *
 * Do not check this with Zod's own `z.toJSONSchema()`. The two converters
 * disagree in opposite directions — Zod throws on `.transform()` and accepts
 * `z.preprocess`, the LangChain converter does the reverse — so Zod passing
 * says nothing about the one the runtime actually uses.
 *
 * DEFAULTS live in the `func` body too, never as `.default()` in the schema.
 * A field carrying a default is advertised as `required`, which tells the
 * model to fill in every optional parameter on every call — and a value it was
 * told to invent is a value it can get wrong.
 *
 * `tests/unit/tools/web-search-schema.test.ts` pins both rules against the
 * converter the runtime uses.
 */

/** An integer the model may have spelled as a string. */
const looseInt = z.union([z.number().int(), z.string().regex(/^\d+$/)]);
/** A number (possibly fractional) the model may have spelled as a string. */
const looseNumber = z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/)]);
/** A boolean the model may have spelled as a string. */
const looseBoolean = z.union([z.boolean(), z.enum(["true", "false"])]);

/** Normalize a loose integer/number and clamp it into the API's range. */
function toNumber(
  value: unknown,
  min: number,
  max: number,
  round = true,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, round ? Math.round(n) : n));
}

/** Normalize a loose boolean. */
function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Normalize `includeAnswer`, which is a boolean OR an answer depth. */
function toIncludeAnswer(
  value: unknown,
): boolean | "basic" | "advanced" | undefined {
  if (value === "basic" || value === "advanced") return value;
  return toBoolean(value);
}

/**
 * Treat a bare host as https, the way a browser address bar would, and reject
 * a string that is not a URL under either reading.
 *
 * The schema can only require a non-empty string here — a `.url()` in the
 * schema would reject the bare host this is meant to accept — so this is where
 * the check has to live. Throwing is caught by the caller's try/catch and
 * returned as a tool-result string, per the codebase-wide convention.
 */
function toUrl(value: string): string {
  const trimmed = value.trim();
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  if (!URL.canParse(candidate)) {
    throw new Error(
      `"${value}" is not a URL. Pass a full URL ("https://example.com/page") ` +
        `or a bare host ("example.com").`,
    );
  }
  return candidate;
}

/**
 * Read the `urls` argument as the list of URLs it means.
 *
 * A single URL string is the one-element list it plainly is. Beyond that,
 * models routinely hand back a *string containing a list* rather than a list —
 * observed live, repeatedly, in both of these shapes:
 *
 *   "[\"https://a.example\", \"https://b.example\"]"   (JSON, the common one)
 *   "https://a.example https://b.example"            (whitespace / comma)
 *
 * This is the predictable consequence of declaring the parameter as a union:
 * the model is shown `anyOf: [string, array]`, hedges toward the string
 * branch, and then has to put the list somewhere. Treating that blob as one
 * URL fails the call and costs a turn — the exact failure the loose shapes
 * exist to remove — so it is unpacked here.
 *
 * Splitting on whitespace is lossless: a URL cannot contain a raw space. A
 * trailing or leading comma is stripped per token so a comma-and-space list
 * works too, while a comma *inside* a single URL (legal, if uncommon) is left
 * alone because that string never gets split in the first place.
 */
function toUrlList(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.map(toUrl);

  const trimmed = value.trim();

  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((u): u is string => typeof u === "string")
      ) {
        return parsed.map(toUrl);
      }
    } catch {
      // Not JSON after all — fall through and read it as a plain string.
    }
  }

  const tokens = trimmed
    .split(/\s+/)
    .map((t) => t.replace(/^,+|,+$/g, ""))
    .filter((t) => t.length > 0);

  return (tokens.length > 1 ? tokens : [trimmed]).map(toUrl);
}

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
 *
 * The content is typed `string`, but the API returns null for a page it
 * reached and could not extract — about one page in thirty of a documentation
 * crawl, in practice. Every formatter funnels through here, so guarding this
 * one place is what stops a single unextractable page from throwing and taking
 * the entire crawl's output with it. Reporting the gap per page is also more
 * useful than losing the other twenty-nine.
 */
function clipResult(content: string, budget: number): string {
  if (typeof content !== "string") {
    return "(no content was returned for this result)";
  }
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
  allowExternal: looseBoolean
    .optional()
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
      maxResults: looseInt
        .optional()
        .describe("Number of results to return (1-20). Defaults to 5."),
      searchDepth: z
        .enum(["basic", "advanced", "fast", "ultra-fast"])
        .optional()
        .describe(
          "'basic' (1 credit, the default) suits most queries; 'fast'/'ultra-fast' trade recall for latency at the same price; 'advanced' (2 credits) digs deeper for hard queries.",
        ),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .describe(
          "Search index to query. Defaults to 'general'; use 'news' for current events and 'finance' for markets.",
        ),
      includeAnswer: z
        .union([z.boolean(), z.enum(["basic", "advanced", "true", "false"])])
        .optional()
        .describe(
          "Include an AI-generated answer. Defaults to true; 'advanced' produces a longer synthesis, false skips it.",
        ),
      chunksPerSource: looseInt
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
      filterByLanguage: looseBoolean
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
      exactMatch: looseBoolean
        .optional()
        .describe(
          "Require the query terms to appear verbatim. Useful for error strings and exact identifiers.",
        ),
      autoParameters: looseBoolean
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
          maxResults: toNumber(input.maxResults, 1, 20) ?? 5,
          searchDepth: input.searchDepth ?? "basic",
          topic: input.topic ?? "general",
          includeAnswer: toIncludeAnswer(input.includeAnswer) ?? true,
          chunksPerSource: toNumber(input.chunksPerSource, 1, 3),
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
          filterByLanguage: input.language
            ? toBoolean(input.filterByLanguage)
            : undefined,
          timeRange: input.timeRange,
          startDate: input.startDate,
          endDate: input.endDate,
          country: input.country,
          exactMatch: toBoolean(input.exactMatch),
          autoParameters: toBoolean(input.autoParameters),
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
        .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(20)])
        .describe("URLs to read (1-20 per call)"),
      query: z
        .string()
        .optional()
        .describe(
          "What you are looking for on these pages. Supplying it reranks the content and returns matching chunks instead of the whole page.",
        ),
      chunksPerSource: looseInt
        .optional()
        .describe(
          "Chunks returned per page (1-5, default 3). Only takes effect when 'query' is supplied.",
        ),
      extractDepth: z
        .enum(["basic", "advanced"])
        .optional()
        .describe(
          "'basic' (1 credit / 5 URLs, the default) for ordinary pages; 'advanced' (2 credits / 5 URLs) when you need tables or embedded content.",
        ),
      format: z
        .enum(["markdown", "text"])
        .optional()
        .describe(
          "'markdown' (the default) preserves headings, lists and links; 'text' is plain prose.",
        ),
      timeout: looseNumber
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
        const result = await extract(toUrlList(input.urls), {
          query: input.query,
          chunksPerSource: toNumber(input.chunksPerSource, 1, 5),
          extractDepth: input.extractDepth ?? "basic",
          format: input.format ?? "markdown",
          timeout: toNumber(input.timeout, 1, 60, false),
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
      url: z.string().min(1).describe("The URL to start crawling from"),
      instructions: z
        .string()
        .optional()
        .describe(
          "Natural-language guidance for which pages matter (e.g. 'Find pages about authentication and rate limits'). Doubles the credit cost but sharply improves relevance.",
        ),
      maxDepth: looseInt
        .optional()
        .describe(
          "How many links deep to follow from the start URL (1-5, default 1). Each level multiplies the pages visited.",
        ),
      maxBreadth: looseInt
        .optional()
        .describe("Maximum links followed per page (1-500). Defaults to 20."),
      limit: looseInt
        .optional()
        .describe(
          "Total pages to visit before stopping (1-100, default 20). Kept below the API's own default to bound both cost and output size.",
        ),
      chunksPerSource: looseInt
        .optional()
        .describe(
          "Chunks returned per page (1-5, default 3). Only takes effect when 'instructions' are supplied.",
        ),
      extractDepth: z
        .enum(["basic", "advanced"])
        .optional()
        .describe(
          "Content extraction depth for each page crawled. Defaults to 'basic'; 'advanced' recovers tables and embedded content.",
        ),
      format: z
        .enum(["markdown", "text"])
        .optional()
        .describe("Output format for page content. Defaults to 'markdown'."),
      ...traversalFilterSchema,
      timeout: looseNumber
        .optional()
        .describe(
          "Seconds to wait before giving up (10-150). Defaults to 45; the API's own 150s default outlives most tool budgets.",
        ),
    }),

    func: async (input, _runManager, config?: RunnableConfig) => {
      if (!isConfigured()) {
        return missingKeyMessage();
      }

      try {
        const result = await crawl(toUrl(input.url), {
          instructions: input.instructions,
          maxDepth: toNumber(input.maxDepth, 1, 5) ?? 1,
          maxBreadth: toNumber(input.maxBreadth, 1, 500) ?? 20,
          limit: toNumber(input.limit, 1, 100) ?? 20,
          chunksPerSource: toNumber(input.chunksPerSource, 1, 5),
          extractDepth: input.extractDepth ?? "basic",
          format: input.format ?? "markdown",
          selectPaths: input.selectPaths,
          selectDomains: input.selectDomains,
          excludePaths: input.excludePaths,
          excludeDomains: input.excludeDomains,
          allowExternal: toBoolean(input.allowExternal) ?? false,
          timeout:
            toNumber(input.timeout, 10, 150, false) ??
            TRAVERSAL_DEFAULT_TIMEOUT_SECONDS,
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
      url: z.string().min(1).describe("The URL to start mapping from"),
      instructions: z
        .string()
        .optional()
        .describe(
          "Natural-language guidance for which parts of the site matter (e.g. 'Focus on the API reference'). Doubles the credit cost.",
        ),
      maxDepth: looseInt
        .optional()
        .describe(
          "How many links deep to follow from the start URL (1-5). Defaults to 1.",
        ),
      maxBreadth: looseInt
        .optional()
        .describe("Maximum links followed per page (1-500). Defaults to 20."),
      limit: looseInt
        .optional()
        .describe(
          "Total URLs to collect before stopping (1-500, default 50). Higher limits are affordable here because no page content is returned.",
        ),
      ...traversalFilterSchema,
      timeout: looseNumber
        .optional()
        .describe(
          "Seconds to wait before giving up (10-150). Defaults to 45, matching web_crawl; the API's own 150s default outlives most tool budgets.",
        ),
    }),

    func: async (input, _runManager, config?: RunnableConfig) => {
      if (!isConfigured()) {
        return missingKeyMessage();
      }

      try {
        const result = await map(toUrl(input.url), {
          instructions: input.instructions,
          maxDepth: toNumber(input.maxDepth, 1, 5) ?? 1,
          maxBreadth: toNumber(input.maxBreadth, 1, 500) ?? 20,
          limit: toNumber(input.limit, 1, 500) ?? 50,
          selectPaths: input.selectPaths,
          selectDomains: input.selectDomains,
          excludePaths: input.excludePaths,
          excludeDomains: input.excludeDomains,
          allowExternal: toBoolean(input.allowExternal) ?? false,
          timeout:
            toNumber(input.timeout, 10, 150, false) ??
            TRAVERSAL_DEFAULT_TIMEOUT_SECONDS,
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
