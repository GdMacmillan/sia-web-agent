/**
 * `start_self_task`: own-server URL resolution, the exact thread and run
 * requests it sends, the acknowledge-then-drain behaviour on the run
 * stream, and every guard that must send nothing.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  DEFAULT_SERVER_URL,
  _activeSelfTasksForTests,
  _resetSelfTaskStateForTests,
  buildSelfTaskMessage,
  createSelfTaskTool,
  resolveOwnServerUrl,
} from "../../../src/tools/self-task-tool.js";

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";

function sse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
}

/** A body that yields `chunks` one read at a time and reports when fully read. */
function chunkedBody(chunks: string[]): {
  stream: ReadableStream<Uint8Array>;
  drained: Promise<void>;
} {
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      } else {
        controller.close();
        resolveDrained();
      }
    },
  });
  return { stream, drained };
}

interface FakeServerOptions {
  parent?: { status: number; metadata?: Record<string, unknown> };
  create?: { status: number; body?: unknown };
  run?: { status: number; body?: ReadableStream<Uint8Array> | null };
}

function fakeServer(options: FakeServerOptions = {}) {
  const captured: Captured[] = [];
  const fetchImpl = jest.fn(async (url: unknown, init: unknown): Promise<Response> => {
    const req = (init ?? {}) as RequestInit;
    captured.push({
      method: String(req.method ?? "GET"),
      url: String(url),
      headers: { ...(req.headers as Record<string, string>) },
      body: typeof req.body === "string" ? JSON.parse(req.body) : undefined,
    });
    const u = String(url);
    if (req.method === "GET") {
      const parent = options.parent ?? { status: 200, metadata: {} };
      return new Response(
        JSON.stringify({ thread_id: PARENT, metadata: parent.metadata ?? {} }),
        { status: parent.status },
      );
    }
    if (u.endsWith("/threads")) {
      const create = options.create ?? { status: 201, body: { thread_id: CHILD } };
      return new Response(JSON.stringify(create.body ?? {}), { status: create.status });
    }
    if (u.endsWith("/runs/stream")) {
      const run = options.run ?? {
        status: 200,
        body: chunkedBody([sse([{ event: "metadata", data: { run_id: "run-1" } }])]).stream,
      };
      // A plain object: wrapping the stream in a Response would re-pipe it
      // and blur chunk boundaries, which the acknowledge-then-drain
      // behaviour under test depends on.
      return {
        ok: run.status < 400,
        status: run.status,
        body: run.body ?? null,
      } as unknown as Response;
    }
    throw new Error(`unexpected request ${u}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, captured };
}

const config = { configurable: { thread_id: PARENT } };

describe("resolveOwnServerUrl", () => {
  it("prefers SIA_SERVER_URL, trimmed of trailing slashes", () => {
    expect(
      resolveOwnServerUrl({ env: { SIA_SERVER_URL: "http://localhost:9999/" }, argv: ["--port", "1"] }),
    ).toBe("http://localhost:9999");
  });

  it("reads the port from argv in its three forms", () => {
    expect(resolveOwnServerUrl({ env: {}, argv: ["node", "cli.js", "serve", "--port", "2025"] })).toBe(
      "http://127.0.0.1:2025",
    );
    expect(resolveOwnServerUrl({ env: {}, argv: ["node", "cli.js", "--port=2026"] })).toBe(
      "http://127.0.0.1:2026",
    );
    expect(resolveOwnServerUrl({ env: {}, argv: ["node", "cli.js", "-p", "2027"] })).toBe(
      "http://127.0.0.1:2027",
    );
  });

  it("falls back to the default", () => {
    expect(resolveOwnServerUrl({ env: {}, argv: ["node", "cli.js", "serve"] })).toBe(DEFAULT_SERVER_URL);
    expect(resolveOwnServerUrl({ env: {}, argv: ["--port", "not-a-port"] })).toBe(DEFAULT_SERVER_URL);
  });
});

describe("buildSelfTaskMessage", () => {
  it("prefixes the skill instruction only when a skill is given", () => {
    expect(buildSelfTaskMessage("do it")).toBe("do it");
    expect(buildSelfTaskMessage("do it", "iterate-component")).toBe(
      'Load the skill "iterate-component" with load_skill before anything else. Then: do it',
    );
  });
});

describe("start_self_task", () => {
  beforeEach(() => {
    _resetSelfTaskStateForTests();
  });

  it("creates an attributed thread, starts the run and returns after the first event", async () => {
    const { stream, drained } = chunkedBody([
      sse([{ event: "metadata", data: { run_id: "run-1" } }]),
      sse([{ event: "updates", data: { step: 1 } }]),
      sse([{ event: "updates", data: { step: 2 } }]),
    ]);
    const { fetchImpl, captured } = fakeServer({
      parent: { status: 200, metadata: { channel: "general", type: "chatroom" } },
      run: { status: 200, body: stream },
    });
    const tool = createSelfTaskTool({
      fetchImpl,
      baseUrl: "http://127.0.0.1:2024/",
      agentId: "agent-1",
    });

    const result = await tool.invoke({ task: "improve execute_code", skill: "iterate-component" }, config);
    expect(result).toBe(
      `Started self-task thread ${CHILD} (run run-1). It runs in the background; the thread is visible on the thread list.`,
    );

    expect(captured.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET http://127.0.0.1:2024/threads/${PARENT}`,
      "POST http://127.0.0.1:2024/threads",
      `POST http://127.0.0.1:2024/threads/${CHILD}/runs/stream`,
    ]);
    for (const call of captured) {
      expect(call.headers["X-SIA-Agent-Id"]).toBe("agent-1");
    }

    const create = captured[1].body as { metadata: Record<string, unknown> };
    expect(create.metadata).toEqual({
      self_task: true,
      type: "self_task",
      agent_id: "agent-1",
      sia_agent_id: "agent-1",
      parent_thread_id: PARENT,
      channel: "general",
      skill: "iterate-component",
      task: "improve execute_code",
    });

    expect(captured[2].body).toEqual({
      assistant_id: "agent",
      input: {
        messages: [
          {
            role: "user",
            content:
              'Load the skill "iterate-component" with load_skill before anything else. Then: improve execute_code',
          },
        ],
      },
      config: { configurable: { thread_id: CHILD } },
      stream_mode: ["updates"],
    });

    // The remaining events are consumed in the background, and the child
    // is released once the stream ends.
    expect(_activeSelfTasksForTests().get(PARENT)).toBe(CHILD);
    await drained;
    await new Promise((resolve) => setImmediate(resolve));
    expect(_activeSelfTasksForTests().has(PARENT)).toBe(false);
  });

  it("truncates long task text in the metadata and omits optional keys", async () => {
    const { fetchImpl, captured } = fakeServer({ parent: { status: 404 } });
    const tool = createSelfTaskTool({ fetchImpl, baseUrl: "http://x", agentId: "agent-1" });
    const long = "x".repeat(700);
    const result = await tool.invoke({ task: long }, config);
    expect(result).toMatch(/^Started self-task thread/);
    const create = captured[1].body as { metadata: Record<string, string | boolean> };
    expect(create.metadata.task).toHaveLength(500);
    expect(create.metadata).not.toHaveProperty("channel");
    expect(create.metadata).not.toHaveProperty("skill");
    expect(create.metadata.parent_thread_id).toBe(PARENT);
    const run = captured[2].body as { input: { messages: Array<{ content: string }> } };
    expect(run.input.messages[0].content).toBe(long);
  });

  it("refuses to nest inside a self-task, sending nothing further", async () => {
    const { fetchImpl, captured } = fakeServer({
      parent: { status: 200, metadata: { self_task: true } },
    });
    const tool = createSelfTaskTool({ fetchImpl, baseUrl: "http://x", agentId: "agent-1" });
    const result = await tool.invoke({ task: "again" }, config);
    expect(result).toMatch(/already a self-task/);
    expect(captured.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(_activeSelfTasksForTests().size).toBe(0);
  });

  it("refuses without an agent id, sending nothing", async () => {
    const { fetchImpl, captured } = fakeServer();
    const tool = createSelfTaskTool({ fetchImpl, baseUrl: "http://x", env: {} });
    const result = await tool.invoke({ task: "x" }, config);
    expect(result).toMatch(/SIA_AGENT_ID/);
    expect(captured).toHaveLength(0);
  });

  it("collapses parallel calls from one thread to a single child", async () => {
    const { stream } = chunkedBody([sse([{ event: "metadata", data: { run_id: "run-1" } }])]);
    const { fetchImpl, captured } = fakeServer({ run: { status: 200, body: stream } });
    const tool = createSelfTaskTool({ fetchImpl, baseUrl: "http://x", agentId: "agent-1" });
    const [a, b] = await Promise.all([
      tool.invoke({ task: "one" }, config),
      tool.invoke({ task: "two" }, config),
    ]);
    const results = [a, b].sort();
    expect(results[0]).toMatch(/already being started/);
    expect(results[1]).toMatch(/^Started self-task thread/);
    expect(captured.filter((c) => c.url.endsWith("/threads") && c.method === "POST")).toHaveLength(1);
  });

  it("refuses a second start while the first child is still running", async () => {
    // A stream that never ends keeps the child in flight.
    const open = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(sse([{ event: "metadata", data: { run_id: "run-1" } }])),
        );
      },
    });
    const { fetchImpl, captured } = fakeServer({ run: { status: 200, body: open } });
    const tool = createSelfTaskTool({ fetchImpl, baseUrl: "http://x", agentId: "agent-1" });
    expect(await tool.invoke({ task: "one" }, config)).toMatch(/^Started/);
    const second = await tool.invoke({ task: "two" }, config);
    expect(second).toMatch(new RegExp(`still running \\(thread ${CHILD}\\)`));
    expect(captured.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("reports a failed run start instead of a fake success", async () => {
    const { fetchImpl } = fakeServer({ run: { status: 500, body: null } });
    const tool = createSelfTaskTool({ fetchImpl, baseUrl: "http://x", agentId: "agent-1" });
    const result = await tool.invoke({ task: "x" }, config);
    expect(result).toMatch(/run failed to start \(500\)/);
    expect(_activeSelfTasksForTests().size).toBe(0);
  });

  it("reports a body-less run response and a stream that ends unacknowledged", async () => {
    const noBody = fakeServer({ run: { status: 200, body: null } });
    const tool = createSelfTaskTool({ fetchImpl: noBody.fetchImpl, baseUrl: "http://x", agentId: "a" });
    expect(await tool.invoke({ task: "x" }, config)).toMatch(/no run stream/);

    _resetSelfTaskStateForTests();
    const empty = fakeServer({ run: { status: 200, body: chunkedBody([]).stream } });
    const tool2 = createSelfTaskTool({ fetchImpl: empty.fetchImpl, baseUrl: "http://x", agentId: "a" });
    expect(await tool2.invoke({ task: "x" }, config)).toMatch(/ended before the run was acknowledged/);
    expect(_activeSelfTasksForTests().size).toBe(0);
  });

  it("reports a failed thread create and a transport error, never throwing", async () => {
    const created = fakeServer({ create: { status: 500, body: { error: "boom" } } });
    const tool = createSelfTaskTool({ fetchImpl: created.fetchImpl, baseUrl: "http://x", agentId: "a" });
    expect(await tool.invoke({ task: "x" }, config)).toMatch(/creating the thread failed \(500\)/);

    _resetSelfTaskStateForTests();
    const failing = jest.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const tool2 = createSelfTaskTool({ fetchImpl: failing, baseUrl: "http://x", agentId: "a" });
    expect(await tool2.invoke({ task: "x" }, config)).toMatch(/connection refused/);
    expect(_activeSelfTasksForTests().size).toBe(0);
  });

  it("tolerates a parent that cannot be read (404) but not a server error", async () => {
    const missing = fakeServer({ parent: { status: 404 } });
    const tool = createSelfTaskTool({ fetchImpl: missing.fetchImpl, baseUrl: "http://x", agentId: "a" });
    expect(await tool.invoke({ task: "x" }, config)).toMatch(/^Started/);

    _resetSelfTaskStateForTests();
    const broken = fakeServer({ parent: { status: 503 } });
    const tool2 = createSelfTaskTool({ fetchImpl: broken.fetchImpl, baseUrl: "http://x", agentId: "a" });
    expect(await tool2.invoke({ task: "x" }, config)).toMatch(/reading the current thread failed \(503\)/);
    expect(broken.captured.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("survives a stream that errors mid-drain", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            new TextEncoder().encode(sse([{ event: "metadata", data: { run_id: "run-1" } }])),
          );
        } else {
          controller.error(new Error("socket reset"));
        }
      },
    });
    const { fetchImpl } = fakeServer({ run: { status: 200, body: stream } });
    const tool = createSelfTaskTool({ fetchImpl, baseUrl: "http://x", agentId: "a" });
    expect(await tool.invoke({ task: "x" }, config)).toMatch(/^Started/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(_activeSelfTasksForTests().size).toBe(0);
  });
});
