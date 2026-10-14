/**
 * `callHostRpc`: the envelope it sends to the host's service-call endpoint
 * and how each kind of answer maps to a payload or a thrown error.
 */
import { describe, it, expect } from "@jest/globals";
import { callHostRpc } from "../../../src/utils/host-rpc.js";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fake(answer: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)),
    });
    return answer();
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const base = {
  url: "http://127.0.0.1:7700",
  token: "tok",
  workspaceId: "ws-1",
  service: "db",
  serviceVersion: "v1",
  verb: "knowledge.thing",
  schemaHash: "s".repeat(64),
  payload: { a: 1 },
  deadlineMs: 2_500,
  randomId: () => "req-1",
};

describe("callHostRpc", () => {
  it("posts the envelope with the bearer and the verb hash", async () => {
    const { seen, fetchImpl } = fake(
      () => new Response(JSON.stringify({ version: 1, id: "req-1", ok: true, payload: { x: 2 } })),
    );
    const before = Date.now();
    const out = await callHostRpc<{ a: number }, { x: number }>({
      ...base,
      verbHash: "v".repeat(64),
      fetchImpl,
    });

    expect(out).toEqual({ x: 2 });
    expect(seen[0].url).toBe("http://127.0.0.1:7700/rpc/call");
    expect(seen[0].headers.Authorization).toBe("Bearer tok");
    const { deadlineUnixMs, ...rest } = seen[0].body;
    expect(rest).toEqual({
      version: 1,
      id: "req-1",
      workspaceId: "ws-1",
      service: "db",
      serviceVersion: "v1",
      verb: "knowledge.thing",
      schemaHash: "s".repeat(64),
      verbHash: "v".repeat(64),
      replyTo: "_INBOX.agent",
      payload: { a: 1 },
    });
    expect(deadlineUnixMs as number).toBeGreaterThanOrEqual(before + 2_500);
  });

  it("omits an empty verb hash", async () => {
    const { seen, fetchImpl } = fake(
      () => new Response(JSON.stringify({ version: 1, id: "req-1", ok: true, payload: null })),
    );
    await callHostRpc({ ...base, verbHash: "", fetchImpl });
    expect("verbHash" in seen[0].body).toBe(false);
  });

  it("throws the service's error code from an error envelope", async () => {
    const { fetchImpl } = fake(
      () =>
        new Response(
          JSON.stringify({
            version: 1,
            id: "req-1",
            ok: false,
            error: { code: "FAILED_PRECONDITION", message: "stale verb hash", retryable: false },
          }),
        ),
    );
    await expect(callHostRpc({ ...base, fetchImpl })).rejects.toThrow(
      "svc.db.v1.knowledge.thing failed [FAILED_PRECONDITION]: stale verb hash",
    );
  });

  it("throws on a non-200 status, a non-JSON body and a network error", async () => {
    await expect(
      callHostRpc({ ...base, errorPrefix: "p", fetchImpl: fake(() => new Response("no", { status: 403 })).fetchImpl }),
    ).rejects.toThrow("p: host returned 403 for knowledge.thing");
    await expect(
      callHostRpc({ ...base, errorPrefix: "p", fetchImpl: fake(() => new Response("not json")).fetchImpl }),
    ).rejects.toThrow(/p: host returned 200 with non-JSON body/);
    await expect(
      callHostRpc({
        ...base,
        errorPrefix: "p",
        fetchImpl: fake(() => {
          throw new Error("ECONNREFUSED");
        }).fetchImpl,
      }),
    ).rejects.toThrow("p: host network error for knowledge.thing: ECONNREFUSED");
  });
});
