/**
 * `SiadGraphMemoryAdapter` wire-envelope tests.
 *
 * This adapter hand-builds its RPC envelope rather than going through
 * `createSvcClient`, which is what keeps the svc-rpc framework runtime
 * out of the agent process. The cost of that is that every wire field
 * has to be set here by hand, and nothing else in the type system will
 * notice if one goes missing.
 *
 * These tests pin the fields the envelope must carry, so dropping one
 * fails here rather than at run time. The substantive assertions are on
 * the hash fields; the rest is scaffolding.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { SiadGraphMemoryAdapter } from "../../../src/tools/siad-graph-memory-adapter.js";
import {
  GRAPH_MEMORY_SCHEMA_HASH,
  GRAPH_MEMORY_VERB_SCHEMA_HASHES,
} from "../../../src/vendor/svc-rpc/graph-memory/schema-hash.js";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Build an adapter whose `fetch` records the outgoing envelope and
 * returns a well-formed success response.
 */
function makeAdapter(): {
  adapter: SiadGraphMemoryAdapter;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = jest.fn(
    async (url: unknown, init: unknown): Promise<Response> => {
      const opts = init as { body: string };
      captured.push({
        url: String(url),
        body: JSON.parse(opts.body) as Record<string, unknown>,
      });
      return {
        status: 200,
        json: async () => ({
          version: 1,
          id: "req-1",
          ok: true,
          payload: { entity: null },
        }),
      } as unknown as Response;
    },
  );

  const adapter = new SiadGraphMemoryAdapter({
    workspaceId: "ws-test",
    siadToken: "test-token",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    randomId: () => "req-1",
  });
  return { adapter, captured };
}

describe("SiadGraphMemoryAdapter — wire envelope", () => {
  it("sends verbHash for the verb being called", async () => {
    // If this fails, the envelope has stopped carrying the per-verb
    // hash and the two sides can no longer agree per verb.
    const { adapter, captured } = makeAdapter();
    await adapter.retrieveEntity({ id: "e-1" } as never);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.verb).toBe("entities.retrieve");
    expect(captured[0]!.body.verbHash).toBe(
      GRAPH_MEMORY_VERB_SCHEMA_HASHES["entities.retrieve"],
    );
    // Non-empty and a real hash, not a placeholder.
    expect(captured[0]!.body.verbHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends a DIFFERENT verbHash per verb", async () => {
    // Guards against binding one constant for the whole service, which
    // would type-check and pass a single-verb test while being wrong for
    // every other verb.
    const { adapter, captured } = makeAdapter();
    await adapter.retrieveEntity({ id: "e-1" } as never);
    await adapter.storeEntity({ name: "x" } as never);

    const [first, second] = captured;
    expect(first!.body.verbHash).not.toBe(second!.body.verbHash);
    expect(second!.body.verbHash).toBe(
      GRAPH_MEMORY_VERB_SCHEMA_HASHES["entities.store"],
    );
  });

  it("still sends the whole-service schemaHash alongside it", async () => {
    // Both scopes ride the envelope: the service-wide hash identifies
    // the IDL as a whole, the per-verb hash identifies just this verb.
    const { adapter, captured } = makeAdapter();
    await adapter.retrieveEntity({ id: "e-1" } as never);
    expect(captured[0]!.body.schemaHash).toBe(GRAPH_MEMORY_SCHEMA_HASH);
  });

  it("covers every verb in the vendored map", async () => {
    // A verb absent from the map would send no verbHash at all.
    for (const [verb, hash] of Object.entries(
      GRAPH_MEMORY_VERB_SCHEMA_HASHES,
    )) {
      expect(typeof verb).toBe("string");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(GRAPH_MEMORY_VERB_SCHEMA_HASHES).length).toBeGreaterThan(
      0,
    );
  });
});
