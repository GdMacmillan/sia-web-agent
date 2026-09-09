---
name: web-search
description: |
  Web search, content extraction, site crawling, and site mapping via Tavily API.
  Use when "search the web", "find documentation", "get current info",
  "extract from URL", "crawl website", or "what pages does this site have".
license: MIT
metadata:
  author: self-improving-agent
  version: "2.0.0"
---

# Web Search Skill

Deep web research using the Tavily API, exposed as four tools — one per
operation. Each takes exactly the arguments it needs; there is no mode switch.

| Tool          | Required | Answers                              |
| ------------- | -------- | ------------------------------------ |
| `web_search`  | `query`  | "What is out there about X?"         |
| `web_extract` | `urls`   | "What does this page actually say?"  |
| `web_crawl`   | `url`    | "Give me everything under this path" |
| `web_map`     | `url`    | "What pages does this site have?"    |

## Choosing a tool

**Search first, extract second, crawl or map only when the site's structure is
the question.** Most research is one `web_search` followed by one `web_extract`
over the two or three URLs that matter.

- Reach for `web_map` when you need to know _what exists_ on a site — it returns
  URLs only, so it is cheap to read and cheap to reason over. Then extract the
  handful of pages you actually want.
- Reach for `web_crawl` only when you need the _content_ of a whole section and
  cannot name the pages in advance. It is the most expensive of the four in both
  credits and output size.

## Tool: `web_search`

Find pages matching a query. Returns ranked results with snippets, publication
dates, and an AI-generated answer.

```json
{
  "query": "LangGraph state management patterns",
  "maxResults": 5,
  "searchDepth": "basic",
  "includeAnswer": true
}
```

| Parameter            | Type                                            | Default   | Description                                                |
| -------------------- | ----------------------------------------------- | --------- | ---------------------------------------------------------- |
| `query`              | string                                          | required  | Search query                                               |
| `maxResults`         | number                                          | 5         | Results to return (1-20)                                   |
| `searchDepth`        | "basic" \| "advanced" \| "fast" \| "ultra-fast" | "basic"   | Thoroughness; "advanced" costs 2 credits                   |
| `topic`              | "general" \| "news" \| "finance"                | "general" | Index to query                                             |
| `includeAnswer`      | boolean \| "basic" \| "advanced"                | true      | AI summary of the results                                  |
| `chunksPerSource`    | number                                          | 3         | Snippets per result (1-3)                                  |
| `includeDomains`     | string[]                                        | -         | Only these domains (max 300)                               |
| `excludeDomains`     | string[]                                        | -         | Never these domains (max 150)                              |
| `includeDomainsMode` | "filter" \| "boost"                             | -         | How `includeDomains` applies; needs `includeDomains`       |
| `language`           | string                                          | -         | ISO 639-1 code or English name; boosts that language       |
| `filterByLanguage`   | boolean                                         | false     | Drop other languages instead of boosting; needs `language` |
| `timeRange`          | "day" \| "week" \| "month" \| "year"            | -         | Recency filter                                             |
| `startDate`          | string                                          | -         | Earliest publication date, `YYYY-MM-DD`                    |
| `endDate`            | string                                          | -         | Latest publication date, `YYYY-MM-DD`                      |
| `country`            | string                                          | -         | Boost a country's results (`general` topic only)           |
| `exactMatch`         | boolean                                         | false     | Require query terms verbatim                               |
| `autoParameters`     | boolean                                         | false     | Let the API pick parameters; costs 2 credits               |

## Tool: `web_extract`

Read the full content of URLs you already have. Batch up to 20 per call.

```json
{
  "urls": [
    "https://react.dev/reference/react/useEffect",
    "https://react.dev/reference/react/useLayoutEffect"
  ],
  "query": "cleanup function semantics",
  "extractDepth": "basic"
}
```

| Parameter         | Type                  | Default    | Description                                             |
| ----------------- | --------------------- | ---------- | ------------------------------------------------------- |
| `urls`            | string[]              | required   | URLs to read (1-20)                                     |
| `query`           | string                | -          | Intent used to rerank content into matching chunks      |
| `chunksPerSource` | number                | 3          | Chunks per page (1-5); only applies when `query` is set |
| `extractDepth`    | "basic" \| "advanced" | "basic"    | "advanced" recovers tables and embedded content         |
| `format`          | "markdown" \| "text"  | "markdown" | Output format                                           |
| `timeout`         | number                | 10 / 30    | Seconds to wait (1-60); 30 at `advanced` depth          |

Passing `query` is the way to read a long page without paying for all of it —
you get the chunks that answer the question rather than the whole document.

## Tool: `web_crawl`

Follow links from a starting URL and return the content of every page visited.

```json
{
  "url": "https://docs.anthropic.com/en/api",
  "instructions": "Focus on request/response schemas and authentication",
  "maxDepth": 2,
  "limit": 20
}
```

| Parameter         | Type                  | Default    | Description                                             |
| ----------------- | --------------------- | ---------- | ------------------------------------------------------- |
| `url`             | string                | required   | Starting URL                                            |
| `instructions`    | string                | -          | Natural-language guidance; doubles credit cost          |
| `maxDepth`        | number                | 1          | Link depth from the start URL (1-5)                     |
| `maxBreadth`      | number                | 20         | Links followed per page (1-500)                         |
| `limit`           | number                | 20         | Total pages visited (1-100)                             |
| `chunksPerSource` | number                | 3          | Chunks per page (1-5); only applies with `instructions` |
| `extractDepth`    | "basic" \| "advanced" | "basic"    | Content extraction depth per page                       |
| `format`          | "markdown" \| "text"  | "markdown" | Output format                                           |
| `selectPaths`     | string[]              | -          | Only paths matching these regexes                       |
| `selectDomains`   | string[]              | -          | Only domains matching these regexes                     |
| `excludePaths`    | string[]              | -          | Skip paths matching these regexes                       |
| `excludeDomains`  | string[]              | -          | Skip domains matching these regexes                     |
| `allowExternal`   | boolean               | false      | Follow links off the starting domain                    |
| `timeout`         | number                | 45         | Seconds to wait (10-150)                                |

## Tool: `web_map`

Follow links from a starting URL and return only the URLs found — no content.

```json
{
  "url": "https://docs.anthropic.com/en/api",
  "maxDepth": 2,
  "limit": 100
}
```

| Parameter        | Type     | Default  | Description                                    |
| ---------------- | -------- | -------- | ---------------------------------------------- |
| `url`            | string   | required | Starting URL                                   |
| `instructions`   | string   | -        | Natural-language guidance; doubles credit cost |
| `maxDepth`       | number   | 1        | Link depth from the start URL (1-5)            |
| `maxBreadth`     | number   | 20       | Links followed per page (1-500)                |
| `limit`          | number   | 50       | Total URLs collected (1-500)                   |
| `selectPaths`    | string[] | -        | Only paths matching these regexes              |
| `selectDomains`  | string[] | -        | Only domains matching these regexes            |
| `excludePaths`   | string[] | -        | Skip paths matching these regexes              |
| `excludeDomains` | string[] | -        | Skip domains matching these regexes            |
| `allowExternal`  | boolean  | false    | Follow links off the starting domain           |
| `timeout`        | number   | 150      | Seconds to wait (10-150)                       |

## Answer Sub-Agent

For complex web research, delegate to the `answer` sub-agent:

```
Delegate to answer agent: "Research the latest updates to the LangGraph SDK and summarize the breaking changes in version 0.2"
```

The answer agent will search, extract from authoritative sources, and
synthesize an answer with citations.

## Use Cases

| Scenario               | Tool          | Example                                                    |
| ---------------------- | ------------- | ---------------------------------------------------------- |
| Find API docs          | `web_search`  | `query: "React useEffect cleanup function"`                |
| Read specific docs     | `web_extract` | `urls: ["https://react.dev/reference/react/useEffect"]`    |
| See what a site covers | `web_map`     | `url: "https://react.dev/reference/"`                      |
| Read a whole section   | `web_crawl`   | `url: "https://react.dev/reference/", maxDepth: 2`         |
| Recent news            | `web_search`  | `query: "AI regulation", topic: "news", timeRange: "week"` |
| Financial data         | `web_search`  | `query: "AAPL earnings Q4", topic: "finance"`              |

## Best Practices

1. **Be specific in queries** - Include context like library version, language, or framework
2. **Batch extractions** - Pass several URLs to one `web_extract` call, not one call each
3. **Map before crawling** - `web_map` returns no content to wade through
4. **Use domain filters** - Target authoritative sources with `includeDomains`
5. **Match depth to need** - `advanced` costs twice as much; reach for it when `basic` has failed
6. **Use `query` on long pages** - Intent-based extraction beats reading the whole document
7. **Verify with multiple sources** - Cross-reference important information
8. **Note dates** - Check `Published:` on results for recency

## Cost

Free tier: 1,000 credits per month. Get a key at https://tavily.com and set
`TAVILY_API_KEY`.

| Operation                               | Credits        |
| --------------------------------------- | -------------- |
| Search, `basic` / `fast` / `ultra-fast` | 1 per search   |
| Search, `advanced` or `autoParameters`  | 2 per search   |
| Extract, `basic`                        | 1 per 5 URLs   |
| Extract, `advanced`                     | 2 per 5 URLs   |
| Crawl or map                            | 1 per 10 pages |
| Crawl or map with `instructions`        | 2 per 10 pages |

Every tool result reports the credits the call consumed.

## Examples

### Find documentation

```json
{
  "query": "Zod discriminated union TypeScript",
  "maxResults": 5,
  "includeDomains": ["zod.dev", "github.com"]
}
```

### Get release notes

```json
{
  "query": "Next.js 14 release notes breaking changes",
  "searchDepth": "advanced",
  "timeRange": "month"
}
```

### Map an API reference, then read the pages that matter

```json
{
  "url": "https://docs.anthropic.com/en/api",
  "maxDepth": 2,
  "limit": 100,
  "selectPaths": ["/en/api/.*"]
}
```

then

```json
{
  "urls": [
    "https://docs.anthropic.com/en/api/messages",
    "https://docs.anthropic.com/en/api/errors"
  ],
  "query": "authentication headers and error codes"
}
```

### Recent industry news

```json
{
  "query": "AI safety developments",
  "topic": "news",
  "timeRange": "week",
  "maxResults": 10
}
```
