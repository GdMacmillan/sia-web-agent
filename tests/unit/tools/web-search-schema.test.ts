/**
 * Tool-schema conversion gate.
 *
 * Every tool schema is converted to JSON Schema before it is advertised to the
 * model. That conversion is the failure surface these tests exist to cover, and
 * nothing else in the suite touches it: the interpreter's `safeToJsonSchema`
 * swallows a throw, and the one test that binds real tools to a model lives in
 * the integration tier (which CI does not run) behind an API-key gate that
 * removes the web tools before it can look at them.
 *
 * So this file converts with `toJsonSchema` from `@langchain/core` — the exact
 * function the runtime uses, not Zod's own `z.toJSONSchema`, which disagrees
 * with it in both directions — and builds the web tools through
 * `createWebTools()` directly so no key gate can hide them.
 *
 * Three properties are pinned:
 *
 *   1. the conversion does not throw (a throw is fatal at bind time — the run
 *      dies, not just the call);
 *   2. only genuinely required fields are advertised as `required` (a field
 *      carrying a schema-level default is listed as required, which orders the
 *      model to invent a value for every optional parameter);
 *   3. the loose argument shapes a model actually emits reach the client as
 *      real values — coercion happens in the tool body, so parsing alone
 *      proves nothing.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  jest,
} from "@jest/globals";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

jest.mock("../../../src/config/model-config.js", () => ({
  createChatModel: jest.fn(),
}));

jest.mock("../../../src/backend-config.js", () => ({
  getProjectRoot: jest.fn().mockReturnValue("/mock/project/root"),
}));

jest.mock("../../../src/web-search/tavily-client", () => ({
  search: jest.fn(),
  extract: jest.fn(),
  crawl: jest.fn(),
  map: jest.fn(),
  isConfigured: jest.fn(),
}));

import { createWebTools } from "../../../src/tools/web-search-tool.js";
import { createStandardTools } from "../../../src/deep-agent-setup.js";
import * as tavilyClient from "../../../src/web-search/tavily-client.js";
import { resetConfig } from "../../../src/config/index.js";

const mockSearch = tavilyClient.search as jest.MockedFunction<
  typeof tavilyClient.search
>;
const mockExtract = tavilyClient.extract as jest.MockedFunction<
  typeof tavilyClient.extract
>;
const mockCrawl = tavilyClient.crawl as jest.MockedFunction<
  typeof tavilyClient.crawl
>;
const mockMap = tavilyClient.map as jest.MockedFunction<
  typeof tavilyClient.map
>;
const mockIsConfigured = tavilyClient.isConfigured as jest.MockedFunction<
  typeof tavilyClient.isConfigured
>;

const WEB_TOOL_NAMES = ["web_search", "web_extract", "web_crawl", "web_map"];

const originalTavilyKey = process.env.TAVILY_API_KEY;

/** The converted schema, as the model is shown it. */
function advertisedSchema(schema: unknown): {
  required?: string[];
  properties?: Record<string, unknown>;
} {
  return toJsonSchema(schema as Parameters<typeof toJsonSchema>[0]) as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
}

function webTool(name: string) {
  const tool = createWebTools().find((t) => t.name === name);
  if (!tool) throw new Error(`no such web tool: ${name}`);
  return tool;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsConfigured.mockReturnValue(true);
  process.env.TAVILY_API_KEY = "tvly-test-key";
  resetConfig();
});

afterAll(() => {
  if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalTavilyKey;
  resetConfig();
});

describe("tool schemas convert to JSON Schema", () => {
  it("converts every web tool with the converter the runtime uses", () => {
    const tools = createWebTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...WEB_TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(() => advertisedSchema(tool.schema)).not.toThrow();
    }
  });

  /**
   * The bug class is not Tavily-specific: any tool whose schema will not
   * convert kills the run for every other tool bound alongside it.
   */
  it("converts every tool the agent is actually built with", () => {
    const tools = createStandardTools("/test/project");
    const names = tools.map((t) => t.name);

    // The key gate is what hid this surface from the only test that could
    // have caught it; assert the web tools are genuinely in the list.
    for (const name of WEB_TOOL_NAMES) expect(names).toContain(name);

    for (const tool of tools) {
      expect(() => advertisedSchema(tool.schema)).not.toThrow();
    }
  });

  it("produces a usable object schema for each web tool", () => {
    for (const tool of createWebTools()) {
      const json = advertisedSchema(tool.schema);
      expect(Object.keys(json.properties ?? {}).length).toBeGreaterThan(0);
    }
  });
});

describe("only genuinely required fields are advertised as required", () => {
  const REQUIRED: Record<string, string[]> = {
    web_search: ["query"],
    web_extract: ["urls"],
    web_crawl: ["url"],
    web_map: ["url"],
  };

  it.each(Object.entries(REQUIRED))(
    "%s requires exactly %p",
    (name, fields) => {
      const json = advertisedSchema(webTool(name).schema);
      expect((json.required ?? []).sort()).toEqual([...fields].sort());
    },
  );

  /**
   * A field is advertised as required if it carries a schema-level default,
   * even when it is also `.optional()`. Defaults therefore live in the tool
   * body; this asserts none crept back into a schema.
   */
  it("advertises no optional field as required", () => {
    for (const tool of createWebTools()) {
      const json = advertisedSchema(tool.schema);
      const required = json.required ?? [];
      expect(required.length).toBeLessThanOrEqual(1);
      for (const field of required) {
        expect(["query", "urls", "url"]).toContain(field);
      }
    }
  });
});

describe("the argument shapes models actually emit reach the client coerced", () => {
  describe("web_search", () => {
    beforeEach(() => {
      mockSearch.mockResolvedValue({
        query: "q",
        results: [],
        responseTime: 0.1,
      });
    });

    /**
     * The regression that shipped: a live model sent `includeAnswer: "true"`.
     */
    it.each([
      ["true", true],
      ["false", false],
      ["basic", "basic"],
      ["advanced", "advanced"],
      [true, true],
      [false, false],
    ])("normalizes includeAnswer %p to %p", async (sent, expected) => {
      await webTool("web_search").invoke({
        query: "q",
        includeAnswer: sent,
      } as never);

      expect(mockSearch).toHaveBeenCalledWith(
        "q",
        expect.objectContaining({ includeAnswer: expected }),
      );
    });

    it.each([
      ["5", 5],
      [5, 5],
      // Asking for more than the API allows means "as many as I can get";
      // clamping answers that, where rejecting spends a turn.
      [50, 20],
      ["50", 20],
      [0, 1],
    ])("normalizes maxResults %p to %p", async (sent, expected) => {
      await webTool("web_search").invoke({
        query: "q",
        maxResults: sent,
      } as never);

      expect(mockSearch).toHaveBeenCalledWith(
        "q",
        expect.objectContaining({ maxResults: expected }),
      );
    });

    it("applies the defaults the schema no longer carries", async () => {
      await webTool("web_search").invoke({ query: "q" });

      expect(mockSearch).toHaveBeenCalledWith(
        "q",
        expect.objectContaining({
          maxResults: 5,
          searchDepth: "basic",
          topic: "general",
          includeAnswer: true,
        }),
      );
    });

    it("normalizes the other stringified booleans", async () => {
      await webTool("web_search").invoke({
        query: "q",
        exactMatch: "true",
        autoParameters: "false",
        language: "fr",
        filterByLanguage: "true",
      } as never);

      expect(mockSearch).toHaveBeenCalledWith(
        "q",
        expect.objectContaining({
          exactMatch: true,
          autoParameters: false,
          filterByLanguage: true,
        }),
      );
    });
  });

  describe("web_extract", () => {
    beforeEach(() => {
      mockExtract.mockResolvedValue({
        results: [],
        failedResults: [],
        responseTime: 0.1,
      });
    });

    it("wraps a single URL string into the one-element list it means", async () => {
      await webTool("web_extract").invoke({
        urls: "https://example.com/a",
      } as never);

      expect(mockExtract).toHaveBeenCalledWith(
        ["https://example.com/a"],
        expect.anything(),
      );
    });

    it("reads a bare host as https, the way an address bar would", async () => {
      await webTool("web_extract").invoke({
        urls: ["docs.tavily.com", "https://example.com/a"],
      } as never);

      expect(mockExtract).toHaveBeenCalledWith(
        ["https://docs.tavily.com", "https://example.com/a"],
        expect.anything(),
      );
    });

    /**
     * Observed live, repeatedly: asked for two pages, the model sent the list
     * as a JSON string rather than an array — the predictable consequence of
     * showing it `anyOf: [string, array]`. It also happens with a single
     * element. Reading that blob as one URL failed the call and cost a turn.
     */
    it.each([
      [
        '["https://example.com/a", "https://example.com/b"]',
        ["https://example.com/a", "https://example.com/b"],
      ],
      ['["https://example.com/a"]', ["https://example.com/a"]],
      ['["docs.tavily.com"]', ["https://docs.tavily.com"]],
      [
        "https://example.com/a https://example.com/b",
        ["https://example.com/a", "https://example.com/b"],
      ],
      [
        "https://example.com/a, https://example.com/b",
        ["https://example.com/a", "https://example.com/b"],
      ],
    ])(
      "unpacks a list handed over as the string %p",
      async (sent, expected) => {
        await webTool("web_extract").invoke({ urls: sent } as never);

        expect(mockExtract).toHaveBeenCalledWith(expected, expect.anything());
      },
    );

    /**
     * A comma is legal inside a URL, so a lone URL is never split on one.
     */
    it("leaves a comma inside a single URL alone", async () => {
      await webTool("web_extract").invoke({
        urls: "https://maps.example.com/@1.25,3.75,14z",
      } as never);

      expect(mockExtract).toHaveBeenCalledWith(
        ["https://maps.example.com/@1.25,3.75,14z"],
        expect.anything(),
      );
    });

    it("normalizes stringified numbers", async () => {
      await webTool("web_extract").invoke({
        urls: "example.com",
        timeout: "30",
        chunksPerSource: "9",
      } as never);

      expect(mockExtract).toHaveBeenCalledWith(
        ["https://example.com"],
        // chunksPerSource clamps to the documented ceiling of 5.
        expect.objectContaining({ timeout: 30, chunksPerSource: 5 }),
      );
    });
  });

  describe("web_crawl and web_map", () => {
    beforeEach(() => {
      mockCrawl.mockResolvedValue({
        baseUrl: "https://example.com",
        results: [],
        responseTime: 0.1,
      });
      mockMap.mockResolvedValue({
        baseUrl: "https://example.com",
        results: [],
        responseTime: 0.1,
      });
    });

    it("reads a bare host and applies the traversal defaults", async () => {
      await webTool("web_crawl").invoke({ url: "example.com" });

      expect(mockCrawl).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({
          maxDepth: 1,
          maxBreadth: 20,
          limit: 20,
          allowExternal: false,
          timeout: 45,
        }),
      );
    });

    it("normalizes a stringified allowExternal", async () => {
      await webTool("web_crawl").invoke({
        url: "https://example.com",
        allowExternal: "true",
      } as never);

      expect(mockCrawl).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({ allowExternal: true }),
      );
    });

    it("clamps a limit above the map ceiling instead of rejecting", async () => {
      await webTool("web_map").invoke({
        url: "example.com",
        limit: "900",
      } as never);

      expect(mockMap).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({ limit: 500 }),
      );
    });
  });
});

describe("genuine garbage is still rejected", () => {
  it("rejects a non-numeric string where a number is declared", async () => {
    await expect(
      webTool("web_search").invoke({ query: "q", maxResults: "abc" } as never),
    ).rejects.toThrow();
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("rejects a missing required field", async () => {
    await expect(webTool("web_search").invoke({} as never)).rejects.toThrow();
    await expect(webTool("web_crawl").invoke({} as never)).rejects.toThrow();
  });

  it("reports a string that is not a URL, without calling the API", async () => {
    const result = await webTool("web_crawl").invoke({
      url: "not a url at all",
    });

    expect(result).toContain("Error");
    expect(result).toContain("not a URL");
    expect(mockCrawl).not.toHaveBeenCalled();
  });

  it("reports an unparseable URL in a list, without calling the API", async () => {
    const result = await webTool("web_extract").invoke({
      urls: ["https://example.com/a", "not a url"],
    } as never);

    expect(result).toContain("Error");
    expect(mockExtract).not.toHaveBeenCalled();
  });
});
