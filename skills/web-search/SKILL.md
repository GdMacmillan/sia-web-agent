---
name: web-search
description: |
  Web search, content extraction, and site crawling via Tavily API.
  Use when "search the web", "find documentation", "get current info",
  "extract from URL", or "crawl website".
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
---

# Web Search Skill

Deep web research capabilities using the Tavily API.

## Tool: `web_search`

A unified tool supporting three modes: search, extract, and crawl.

## Modes

### 1. Search Mode

Search the web for information with optional AI-generated answers.

```json
{
  "query": "LangGraph state management patterns",
  "maxResults": 5,
  "searchDepth": "basic",
  "includeAnswer": true
}
```

| Parameter      | Type                                 | Default   | Description              |
| -------------- | ------------------------------------ | --------- | ------------------------ |
| query          | string                               | required  | Search query             |
| maxResults     | number                               | 5         | Results to return (1-20) |
| searchDepth    | "basic" \| "advanced"                | "basic"   | Search thoroughness      |
| topic          | "general" \| "news" \| "finance"     | "general" | Topic category           |
| includeAnswer  | boolean                              | true      | Include AI summary       |
| includeDomains | string[]                             | -         | Only these domains       |
| excludeDomains | string[]                             | -         | Exclude these domains    |
| timeRange      | "day" \| "week" \| "month" \| "year" | -         | Recency filter           |

### 2. Extract Mode

Get full content from a specific URL.

```json
{
  "url": "https://docs.langchain.com/docs/introduction",
  "mode": "extract"
}
```

| Parameter | Type      | Default   | Description         |
| --------- | --------- | --------- | ------------------- |
| url       | string    | required  | URL to extract from |
| mode      | "extract" | "extract" | Extraction mode     |

### 3. Crawl Mode

Explore a website following links.

```json
{
  "url": "https://js.langchain.com/docs/",
  "mode": "crawl",
  "maxDepth": 2,
  "limit": 10,
  "crawlInstructions": "Focus on API reference pages"
}
```

| Parameter         | Type    | Default  | Description               |
| ----------------- | ------- | -------- | ------------------------- |
| url               | string  | required | Starting URL              |
| mode              | "crawl" | -        | Crawl mode                |
| maxDepth          | number  | 1        | Link depth (1-5)          |
| limit             | number  | 10       | Max pages (1-50)          |
| crawlInstructions | string  | -        | Natural language guidance |

## Answer Sub-Agent

For complex web research, use the `answer` sub-agent via task delegation:

```
Delegate to answer agent: "Research the latest updates to the LangGraph SDK and summarize the breaking changes in version 0.2"
```

The answer agent will:

1. Search for relevant information
2. Extract full content from authoritative sources
3. Synthesize a comprehensive answer with citations

## Use Cases

| Scenario          | Mode    | Example                                                    |
| ----------------- | ------- | ---------------------------------------------------------- |
| Find API docs     | search  | `query: "React useEffect cleanup function"`                |
| Read specific doc | extract | `url: "https://react.dev/reference/react/useEffect"`       |
| Explore docs site | crawl   | `url: "https://react.dev/reference/"`                      |
| Recent news       | search  | `query: "AI regulation", topic: "news", timeRange: "week"` |
| Financial data    | search  | `query: "AAPL earnings Q4", topic: "finance"`              |

## Best Practices

1. **Be specific in queries** - Include context like library version, language, or framework
2. **Use domain filters** - Target authoritative sources with `includeDomains`
3. **Match depth to need** - Use `advanced` searchDepth for complex topics
4. **Crawl documentation** - For comprehensive understanding, crawl docs sites
5. **Verify with multiple sources** - Cross-reference important information
6. **Note dates** - Check when information was published for recency

## Configuration

Requires `TAVILY_API_KEY` environment variable.

- Free tier: 1,000 searches/month
- Get API key: https://tavily.com

## Examples

### Find documentation

```json
{
  "query": "Zod discriminated union TypeScript",
  "maxResults": 5,
  "includeDomains": ["zod.dev", "github.com/colinhacks/zod"]
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

### Crawl API reference

```json
{
  "url": "https://docs.anthropic.com/en/api",
  "mode": "crawl",
  "maxDepth": 2,
  "limit": 20,
  "crawlInstructions": "Focus on request/response schemas and authentication"
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
