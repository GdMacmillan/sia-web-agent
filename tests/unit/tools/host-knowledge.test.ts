/**
 * The two read-only knowledge calls: what they send (an empty request —
 * the host names the caller), how answers are shaped, the deadline, and
 * the refusal record's last-copy fallback.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  _resetHostKnowledgeCacheForTests,
  readFailureModes,
  readRefusalRecord,
} from "../../../src/tools/host-knowledge.js";
import {
  DB_SCHEMA_HASH,
  FAILURE_MODES_VERB,
  FAILURE_MODES_VERB_HASH,
  REFUSAL_RECORD_VERB,
  REFUSAL_RECORD_VERB_HASH,
} from "../../../src/vendor/svc-rpc/db/knowledge-hashes.js";

const env = { SIA_DAEMON_URL: "http://127.0.0.1:7700", SIA_DAEMON_TOKEN: "tok" };

function host(answer: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return answer(body);
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const ok = (payload: unknown) =>
  new Response(JSON.stringify({ version: 1, id: "x", ok: true, payload }));

describe("vendored knowledge hashes", () => {
  it("are full sha-256 hex strings", () => {
    for (const h of [DB_SCHEMA_HASH, REFUSAL_RECORD_VERB_HASH, FAILURE_MODES_VERB_HASH]) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(REFUSAL_RECORD_VERB_HASH).not.toBe(FAILURE_MODES_VERB_HASH);
  });
});

describe("readFailureModes", () => {
  it("sends an empty request naming no agent, with the verb's hash", async () => {
    const { bodies, fetchImpl } = host(() => ok({ body: "Tends to over-build.", updatedAt: "2026-10-13T00:00:00Z" }));
    const out = await readFailureModes({ env, workspaceId: "ws-1", fetchImpl });

    expect(out).toEqual({ body: "Tends to over-build.", updatedAt: "2026-10-13T00:00:00Z" });
    expect(bodies[0]).toMatchObject({
      service: "db",
      serviceVersion: "v1",
      verb: FAILURE_MODES_VERB,
      verbHash: FAILURE_MODES_VERB_HASH,
      workspaceId: "ws-1",
      payload: {},
    });
  });

  it("passes through a catalogue nobody has written", async () => {
    const { fetchImpl } = host(() => ok({ body: null, updatedAt: null }));
    expect(await readFailureModes({ env, workspaceId: "ws-1", fetchImpl })).toEqual({
      body: null,
      updatedAt: null,
    });
  });

  it("is unavailable, never a throw, on an error envelope, a malformed answer or no token", async () => {
    const err = host(
      () =>
        new Response(
          JSON.stringify({ version: 1, id: "x", ok: false, error: { code: "INTERNAL", message: "boom", retryable: true } }),
        ),
    );
    expect(await readFailureModes({ env, workspaceId: "ws-1", fetchImpl: err.fetchImpl })).toEqual({
      unavailable: expect.stringContaining("INTERNAL"),
    });
    const bad = host(() => ok({ body: 3 }));
    expect(await readFailureModes({ env, workspaceId: "ws-1", fetchImpl: bad.fetchImpl })).toEqual({
      unavailable: "malformed answer",
    });
    const none = host(() => ok({ body: null, updatedAt: null }));
    expect(await readFailureModes({ env: {}, workspaceId: "ws-1", fetchImpl: none.fetchImpl })).toEqual({
      unavailable: "no host token",
    });
    expect(none.bodies).toHaveLength(0);
  });

  it("gives up at its deadline when the host never answers", async () => {
    const { fetchImpl } = host(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const out = await readFailureModes({ env, workspaceId: "ws-1", fetchImpl, deadlineMs: 50 });
    expect(out).toEqual({ unavailable: expect.stringMatching(/no answer within 50 ms/) });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("readRefusalRecord", () => {
  beforeEach(() => {
    _resetHostKnowledgeCacheForTests();
  });

  it("sends an empty request with the verb's hash and returns the record", async () => {
    const { bodies, fetchImpl } = host(() => ok({ version: 1, markdown: "# Record" }));
    expect(await readRefusalRecord({ env, workspaceId: "ws-1", fetchImpl })).toEqual({
      version: 1,
      markdown: "# Record",
    });
    expect(bodies[0]).toMatchObject({
      verb: REFUSAL_RECORD_VERB,
      verbHash: REFUSAL_RECORD_VERB_HASH,
      payload: {},
    });
  });

  it("falls back to the last copy read, marked as such, when the host fails", async () => {
    let fail = false;
    const { fetchImpl } = host(() => (fail ? new Response("down", { status: 502 }) : ok({ version: 2, markdown: "v2" })));
    await readRefusalRecord({ env, workspaceId: "ws-1", fetchImpl });
    fail = true;
    expect(await readRefusalRecord({ env, workspaceId: "ws-1", fetchImpl })).toEqual({
      version: 2,
      markdown: "v2",
      cached: true,
    });
  });

  it("replaces the cached copy when the version moves", async () => {
    let version = 1;
    let fail = false;
    const { fetchImpl } = host(() =>
      fail ? new Response("down", { status: 502 }) : ok({ version, markdown: `v${version}` }),
    );
    await readRefusalRecord({ env, workspaceId: "ws-1", fetchImpl });
    version = 3;
    await readRefusalRecord({ env, workspaceId: "ws-1", fetchImpl });
    fail = true;
    expect(await readRefusalRecord({ env, workspaceId: "ws-1", fetchImpl })).toMatchObject({
      version: 3,
      markdown: "v3",
    });
  });

  it("is unavailable when nothing was ever read", async () => {
    const { fetchImpl } = host(() => new Response("down", { status: 502 }));
    expect(await readRefusalRecord({ env, workspaceId: "ws-1", fetchImpl })).toEqual({
      unavailable: expect.stringContaining("502"),
    });
  });
});
