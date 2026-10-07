/**
 * Tool-exclusion middleware (Phase 5).
 */
import { describe, it, expect } from "@jest/globals";
import {
  createToolExclusionMiddleware,
  isToolExcluded,
} from "../../../src/middleware/tool_exclusion.js";

describe("isToolExcluded", () => {
  const cases: Array<[string, string[], boolean]> = [
    ["grep", ["grep"], true],
    ["grep", ["glob"], false],
    ["mcp__docs__search", ["mcp__docs__search"], true],
    ["mcp__docs__fetch", ["mcp__docs__search"], false],
    ["mcp__docs__search", ["mcp__docs"], true],
    ["mcp__docs__search", ["mcp__docs__*"], true],
    // Whole-segment server match: a prefix of a server name is not a match.
    ["mcp__docs2__search", ["mcp__docs"], false],
    ["mcp__docs2__search", ["mcp__docs__*"], false],
    ["mcp__docs__search", ["mcp__doc"], false],
    // Names with no server segment are only ever matched exactly.
    ["mcp__lonely", ["mcp__"], false],
    ["mcp____x", ["mcp__"], false],
    // Server-level entries never reach built-ins.
    ["docs_search", ["mcp__docs"], false],
  ];

  it.each(cases)("%s with %j -> %s", (name, excluded, expected) => {
    expect(isToolExcluded(name, new Set(excluded))).toBe(expected);
  });
});

describe("createToolExclusionMiddleware with remote tools", () => {
  async function filtered(excluded: string[], tools: string[]) {
    const mw = createToolExclusionMiddleware(new Set(excluded));
    let seen: unknown[] | undefined;
    await mw.wrapModelCall!(
      { tools: tools.map((name) => ({ name })) } as any,
      (async (req: { tools?: unknown[] }) => {
        seen = req.tools;
        return { content: "" };
      }) as any,
    );
    return (seen ?? []).map((t: any) => t.name);
  }

  const tools = [
    "read_file",
    "mcp__docs__search",
    "mcp__docs__fetch",
    "mcp__docs2__search",
  ];

  it("strips every tool of a server by bare server name", async () => {
    expect(await filtered(["mcp__docs"], tools)).toEqual([
      "read_file",
      "mcp__docs2__search",
    ]);
  });

  it("strips every tool of a server by the __* form", async () => {
    expect(await filtered(["mcp__docs__*"], tools)).toEqual([
      "read_file",
      "mcp__docs2__search",
    ]);
  });

  it("strips one remote tool by exact name", async () => {
    expect(await filtered(["mcp__docs__fetch"], tools)).toEqual([
      "read_file",
      "mcp__docs__search",
      "mcp__docs2__search",
    ]);
  });
});

describe("createToolExclusionMiddleware", () => {
  it("filters excluded tools out of the request at the model-call boundary", async () => {
    const mw = createToolExclusionMiddleware(new Set(["execute_code", "grep"]));
    let seen: unknown[] | undefined;
    const request = {
      tools: [
        { name: "read_file" },
        { name: "execute_code" },
        { name: "grep" },
        { name: "write_file" },
      ],
    };
    await mw.wrapModelCall!(request as any, (async (req: { tools?: unknown[] }) => {
      seen = req.tools;
      return { content: "" };
    }) as any);

    const names = (seen ?? []).map((t: any) => t.name);
    expect(names).toEqual(["read_file", "write_file"]);
  });

  it("keeps tools that have no name", async () => {
    const mw = createToolExclusionMiddleware(new Set(["x"]));
    let seen: unknown[] | undefined;
    const request = { tools: [{ name: "x" }, {}, { name: "keep" }] };
    await mw.wrapModelCall!(request as any, (async (req: { tools?: unknown[] }) => {
      seen = req.tools;
      return { content: "" };
    }) as any);
    expect(seen).toHaveLength(2); // the nameless one + "keep"
  });

  it("is named so it can be targeted/inspected", () => {
    expect(createToolExclusionMiddleware(new Set()).name).toBe(
      "_ToolExclusionMiddleware",
    );
  });
});
