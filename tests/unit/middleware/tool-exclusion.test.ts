/**
 * Tool-exclusion middleware (Phase 5).
 */
import { describe, it, expect } from "@jest/globals";
import { createToolExclusionMiddleware } from "../../../src/middleware/tool_exclusion.js";

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
