/**
 * `SiadGraphMemoryAdapter` wire-envelope tests (AGI-357).
 *
 * This adapter hand-builds its RPC envelope rather than going through
 * `createSvcClient`, which is what keeps the svc-rpc framework runtime
 * out of the agent process. The cost of that is that every new wire
 * field has to be added here by hand, and nothing else will notice if it
 * isn't.
 *
 * AGI-357 made that failure loud instead of silent: the graph-memory
 * responder now requires a per-verb `verbHash` on every request and
 * rejects a client that omits it — there is no whole-service fallback.
 * So if this envelope stops carrying `verbHash`, every graph-memory call
 * the agent makes fails with FAILED_PRECONDITION.
 *
 * These tests exist to fail loudly if that happens. The whole point is
 * the assertion on `verbHash`; the rest is scaffolding.
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
  it("TRIPWIRE: sends verbHash for the verb being called", async () => {
    // If this fails, the agent's graph-memory calls are now rejected by
    // the responder. Do not "fix" it by relaxing the responder.
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
    // Guards against someone binding one constant for the whole service
    // — which would type-check, pass a single-verb test, and break every
    // other verb.
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
    // Kept on the wire so an OLD responder (one that predates per-verb
    // hashing) can still validate us. That is what makes it safe to ship
    // this agent build before the responders are upgraded.
    const { adapter, captured } = makeAdapter();
    await adapter.retrieveEntity({ id: "e-1" } as never);
    expect(captured[0]!.body.schemaHash).toBe(GRAPH_MEMORY_SCHEMA_HASH);
  });

  it("covers every verb in the vendored map", async () => {
    // A verb absent from the map would send no verbHash and be rejected.
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
