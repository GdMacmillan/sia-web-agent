/**
 * memory-tools.ts thin-shell wiring tests (AGI-228).
 *
 * After the cutover, all the substantive behavior (pre-search, edge
 * creation, suggestion shaping, error surfacing) lives in the vendored
 * `tool-handlers` module — `packages/svc-rpc/.../tool-handlers.test.ts`
 * in the monorepo exercises every branch with a mock adapter.
 *
 * The tests below only verify the agent-side shell: that
 * `storeEntityTool` reads the cached adapter, calls the handler with
 * the right input shape, and JSON-serializes the result.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  storeEntityTool,
  retrieveEntityTool,
  _resetMemoryAdapterForTests,
  _setMemoryAdapterForTests,
} from "../../../src/tools/memory-tools.js";
import type { IGraphMemoryAdapter } from "../../../src/vendor/svc-rpc/graph-memory/adapter-interface.js";

function makeStubAdapter(
  overrides: Partial<IGraphMemoryAdapter> = {},
): IGraphMemoryAdapter {
  const noop = jest.fn(async () => ({})) as unknown as jest.Mock;
  const base = {
    workspaceId: "ws_test",
    storeEntity: noop,
    retrieveEntity: noop,
    listEntities: noop,
    searchEntities: noop,
    updateEntityStatus: noop,
    updateEntity: noop,
    promoteEntities: noop,
    traverseGraph: noop,
    graphEdges: noop,
    graphStats: noop,
    graphQuery: noop,
    adminHttp: noop,
  };
  return { ...base, ...overrides } as unknown as IGraphMemoryAdapter;
}

describe("memory-tools — thin-shell wiring", () => {
  beforeEach(() => {
    _resetMemoryAdapterForTests();
  });

  it("storeEntityTool feeds input through the vendored handler and JSON-serializes", async () => {
    const storeMock = jest.fn(async () => ({
      id: "conv_123",
      agent_id: "memory_agent",
      user_input: "[learning] Test",
      agent_output: "Body",
      timestamp: "2026-01-01T00:00:00Z",
    })) as any;
    const searchMock = jest.fn(async () => ({
      results: [],
      level_used: "raw",
      levels_tried: ["raw"],
      query: "Test",
      threshold: 0.5,
      total_results: 0,
      timestamp: "2026-01-01T00:00:00Z",
    })) as any;
    const adapter = makeStubAdapter({
      storeEntity: storeMock,
      searchEntities: searchMock,
    });
    _setMemoryAdapterForTests(adapter);

    const raw = await storeEntityTool.func({
      entity_type: "learning",
      title: "Test",
      content: "Body",
      status: "active",
    });

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(storeMock).toHaveBeenCalledTimes(1);
    const response = JSON.parse(raw);
    expect(response.id).toBe("conv_123");
    expect(response.entity_type).toBe("learning");
    expect(response.title).toBe("Test");
    expect(response.status).toBe("created");
  });

  it("retrieveEntityTool calls the handler and returns JSON", async () => {
    const retrieveMock = jest.fn(async () => ({
      id: "n_1",
      type: "Conversation",
      properties: {
        metadata: { entity_type: "note", title: "Hello" },
      },
    })) as any;
    const adapter = makeStubAdapter({ retrieveEntity: retrieveMock });
    _setMemoryAdapterForTests(adapter);

    const raw = await retrieveEntityTool.func({ entity_id: "n_1" });
    expect(retrieveMock).toHaveBeenCalledWith({ nodeId: "n_1" });
    const response = JSON.parse(raw);
    expect(response.entity.id).toBe("n_1");
    expect(response.entity.title).toBe("Hello");
  });

  it("fails fast when SIA_WORKSPACE_ID is unset", async () => {
    _resetMemoryAdapterForTests();
    const savedWs = process.env.SIA_WORKSPACE_ID;
    delete process.env.SIA_WORKSPACE_ID;
    // The config singleton has already been read with the env var set
    // (other tests rely on it). Force a fresh load by importing the
    // loader and resetting.
    const { resetConfig } = await import("../../../src/config/index.js");
    resetConfig();

    try {
      await expect(
        retrieveEntityTool.func({ entity_id: "x" }),
      ).rejects.toThrow(/SIA_WORKSPACE_ID is required/);
    } finally {
      if (savedWs !== undefined) process.env.SIA_WORKSPACE_ID = savedWs;
      resetConfig();
    }
  });
});
