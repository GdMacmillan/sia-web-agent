/**
 * Memory-augmentation middleware.
 *
 * Drives `wrapToolCall` directly with a stub adapter. The contract under
 * test: search-type tool results gain a `[Graph memory context]` block
 * when memory has something related; everything else — other tools,
 * unextractable queries, empty results, non-string content, adapter
 * failures, adapter hangs, the disabled flag, and a deployment with no
 * graph memory at all — leaves the tool's own result byte-identical and
 * never throws.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { ToolMessage } from "langchain";
import { Command } from "@langchain/langgraph";

import { createMemoryAugmentationMiddleware } from "../../../src/middleware/memory-augmentation.js";
import { MEMORY_CONTEXT_HEADER } from "../../../src/middleware/memory-augmentation.js";
import { resetConfig } from "../../../src/config/index.js";
import {
  _resetMemoryAdapterForTests,
  _setMemoryAdapterForTests,
} from "../../../src/tools/memory-adapter.js";
import {
  clearAllTracking,
  getOrCreateTaskId,
  getTrackedEntities,
} from "../../../src/utils/application-tracking.js";
import type { IGraphMemoryAdapter } from "../../../src/vendor/svc-rpc/graph-memory/adapter-interface.js";

function makeStubAdapter(
  searchEntities: jest.Mock = jest.fn(async () => ({ results: [] })),
): IGraphMemoryAdapter {
  const noop = jest.fn(async () => ({})) as unknown as jest.Mock;
  return {
    workspaceId: "ws_test",
    storeEntity: noop,
    retrieveEntity: noop,
    listEntities: noop,
    searchEntities,
    updateEntityStatus: noop,
    updateEntity: noop,
    promoteEntities: noop,
    traverseGraph: noop,
    graphEdges: noop,
    graphStats: noop,
    graphQuery: noop,
    adminHttp: noop,
  } as unknown as IGraphMemoryAdapter;
}

const HIT = {
  id: "learn_1",
  properties: {
    user_input: "[learning] NATS auth callout goes to the bare subject",
    agent_output: "body",
    metadata: { context: "nats", tags: [] },
  },
};

const RUN_CONFIG = { configurable: { thread_id: "thread-abc" } };

function request(name: string, args: Record<string, unknown>) {
  return {
    toolCall: { id: "call_1", name, args, type: "tool_call" },
    tool: undefined,
    state: {},
    runtime: { configurable: RUN_CONFIG.configurable },
  } as any;
}

function toolResult(content: string | unknown[] = "3 matches in 2 files") {
  return new ToolMessage({ content: content as any, tool_call_id: "call_1" });
}

async function run(
  mw: ReturnType<typeof createMemoryAugmentationMiddleware>,
  req: any,
  result: unknown = toolResult(),
) {
  const handler = jest.fn(async () => result);
  const out = await mw.wrapToolCall!(req, handler as any);
  return { out, handler };
}

beforeEach(() => {
  process.env.SIA_WORKSPACE_ID = "ws_test";
  delete process.env.MEMORY_AUGMENTATION_ENABLED;
  delete process.env.MEMORY_AUGMENTATION_BUDGET_MS;
  resetConfig();
  _resetMemoryAdapterForTests();
  clearAllTracking();
});

afterEach(() => {
  _resetMemoryAdapterForTests();
  clearAllTracking();
});

describe("createMemoryAugmentationMiddleware", () => {
  it("appends a graph-memory block to a grep result and tracks the entities", async () => {
    const search = jest.fn(async () => ({ results: [HIT] }));
    _setMemoryAdapterForTests(makeStubAdapter(search));
    const mw = createMemoryAugmentationMiddleware();

    const { out, handler } = await run(
      mw,
      request("grep", { pattern: "auth callout", path: "/repo" }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(out).toBeInstanceOf(ToolMessage);
    const content = (out as ToolMessage).content as string;
    expect(content.startsWith("3 matches in 2 files")).toBe(true);
    expect(content).toContain(`\n\n${MEMORY_CONTEXT_HEADER}\n`);
    expect(content).toContain(
      "[learning] NATS auth callout goes to the bare subject",
    );
    expect(content).toContain("Next:");
    expect(search).toHaveBeenCalledWith({
      query: "auth callout",
      limit: 5,
      threshold: 0.3,
    });
    expect(getTrackedEntities(getOrCreateTaskId(RUN_CONFIG))).toEqual([
      "learn_1",
    ]);
  });

  it("covers glob, search, and bash-with-rg, but not other tools", async () => {
    const search = jest.fn(async () => ({ results: [HIT] }));
    _setMemoryAdapterForTests(makeStubAdapter(search));
    const mw = createMemoryAugmentationMiddleware();

    // Distinct queries on purpose — identical ones would be cache hits.
    for (const req of [
      request("glob", { pattern: "src/**/auth*.ts", path: "/repo" }),
      request("search", { pattern: "auth callout" }),
      request("bash", { command: "rg 'callout subject' src" }),
    ]) {
      const { out } = await run(mw, req);
      expect((out as ToolMessage).content).toContain(MEMORY_CONTEXT_HEADER);
    }
    expect(search).toHaveBeenCalledTimes(3);

    const original = toolResult("file body");
    const { out } = await run(
      mw,
      request("read_file", { file_path: "/repo/x" }),
      original,
    );
    expect(out).toBe(original);
    expect((out as ToolMessage).content).toBe("file body");
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("leaves the result untouched when no query can be extracted or nothing matches", async () => {
    const search = jest.fn(async () => ({ results: [] }));
    _setMemoryAdapterForTests(makeStubAdapter(search));
    const mw = createMemoryAugmentationMiddleware();

    const a = toolResult();
    const { out: outA } = await run(mw, request("bash", { command: "yarn test" }), a);
    expect(outA).toBe(a);
    expect(search).not.toHaveBeenCalled();

    const b = toolResult();
    const { out: outB } = await run(mw, request("grep", { pattern: "nothing here" }), b);
    expect(outB).toBe(b);
    expect((outB as ToolMessage).content).toBe("3 matches in 2 files");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("passes Command results and non-string content through unchanged", async () => {
    const search = jest.fn(async () => ({ results: [HIT] }));
    _setMemoryAdapterForTests(makeStubAdapter(search));
    const mw = createMemoryAugmentationMiddleware();

    const cmd = new Command({ update: { messages: [toolResult()] } });
    const { out } = await run(mw, request("grep", { pattern: "auth callout" }), cmd);
    expect(out).toBe(cmd);

    const blocks = toolResult([{ type: "text", text: "x" }]);
    const { out: out2 } = await run(mw, request("grep", { pattern: "auth callout" }), blocks);
    expect(out2).toBe(blocks);
    expect((out2 as ToolMessage).content).toEqual([{ type: "text", text: "x" }]);
  });

  it("tolerates a transient adapter failure after a first success", async () => {
    let calls = 0;
    const search = jest.fn(async () => {
      calls++;
      if (calls === 2) throw new Error("blip");
      return { results: [HIT] };
    });
    _setMemoryAdapterForTests(makeStubAdapter(search));
    const mw = createMemoryAugmentationMiddleware();

    const first = await run(mw, request("grep", { pattern: "first query" }));
    expect((first.out as ToolMessage).content).toContain(MEMORY_CONTEXT_HEADER);

    const plain = toolResult();
    const second = await run(mw, request("grep", { pattern: "second query" }), plain);
    expect(second.out).toBe(plain);
    expect((second.out as ToolMessage).content).toBe("3 matches in 2 files");

    const third = await run(mw, request("grep", { pattern: "third query" }));
    expect((third.out as ToolMessage).content).toContain(MEMORY_CONTEXT_HEADER);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("latches off when the very first lookup fails (graph memory not reachable)", async () => {
    const search = jest.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7700");
    });
    _setMemoryAdapterForTests(makeStubAdapter(search));
    const mw = createMemoryAugmentationMiddleware();

    const a = toolResult();
    const { out } = await run(mw, request("grep", { pattern: "auth callout" }), a);
    expect(out).toBe(a);
    expect(search).toHaveBeenCalledTimes(1);

    await run(mw, request("grep", { pattern: "auth callout again" }));
    expect(search).toHaveBeenCalledTimes(1); // no retry: latched
  });

  it("does not delay the tool past the budget when the adapter hangs", async () => {
    const search = jest.fn(() => new Promise(() => undefined));
    _setMemoryAdapterForTests(makeStubAdapter(search));
    const mw = createMemoryAugmentationMiddleware({ budgetMs: 40 });

    const a = toolResult();
    const started = Date.now();
    const { out } = await run(mw, request("grep", { pattern: "slow lookup" }), a);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toBe(a);
  });

  it("is a pure pass-through when disabled by flag or env", async () => {
    const search = jest.fn(async () => ({ results: [HIT] }));
    _setMemoryAdapterForTests(makeStubAdapter(search));

    const byFlag = createMemoryAugmentationMiddleware({ enabled: false });
    const a = toolResult();
    expect((await run(byFlag, request("grep", { pattern: "auth callout" }), a)).out).toBe(a);

    process.env.MEMORY_AUGMENTATION_ENABLED = "false";
    resetConfig();
    const byEnv = createMemoryAugmentationMiddleware();
    const b = toolResult();
    expect((await run(byEnv, request("grep", { pattern: "auth callout" }), b)).out).toBe(b);
    expect(search).not.toHaveBeenCalled();
  });

  it("standalone: with no workspace and no adapter, results are untouched and nothing throws", async () => {
    delete process.env.SIA_WORKSPACE_ID;
    resetConfig();
    _resetMemoryAdapterForTests(); // real getMemoryAdapter() will throw
    const mw = createMemoryAugmentationMiddleware();

    const a = toolResult();
    const first = await run(mw, request("grep", { pattern: "auth callout" }), a);
    expect(first.out).toBe(a);
    expect((first.out as ToolMessage).content).toBe("3 matches in 2 files");

    // Second call must not retry the adapter either.
    const getAdapter = jest.fn(() => {
      throw new Error("should not be called");
    });
    const mw2 = createMemoryAugmentationMiddleware({ getAdapter });
    await run(mw2, request("grep", { pattern: "one" }));
    await run(mw2, request("grep", { pattern: "two" }));
    expect(getAdapter).toHaveBeenCalledTimes(1);
  });

  it("never lets a memory rejection surface as the tool's rejection", async () => {
    const getAdapter = jest.fn(() => {
      throw new Error("boom");
    });
    const mw = createMemoryAugmentationMiddleware({ getAdapter });
    const a = toolResult();
    await expect(
      run(mw, request("grep", { pattern: "auth callout" }), a),
    ).resolves.toMatchObject({ out: a });
  });
});
