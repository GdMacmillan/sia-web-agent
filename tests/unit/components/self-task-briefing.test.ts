/**
 * The self-task briefing: which of the agent's own versions it lists and in
 * what order, how each part reads when present, absent or unreadable, and
 * that it always resolves within its budget.
 */
import { describe, it, expect, jest } from "@jest/globals";
import {
  BRIEFING_INTRO,
  BRIEFING_LINEAGE_LIMIT,
  BRIEFING_REFUSAL_RECORD_MAX_CHARS,
  FAILURE_MODES_NONE,
  LINEAGE_NONE,
  LINEAGE_UNREADABLE,
  buildSelfTaskBriefing,
  lineageLine,
} from "../../../src/components/self-task-briefing.js";
import type { IGraphMemoryAdapter } from "../../../src/vendor/svc-rpc/graph-memory/adapter-interface.js";
import type { StoredEntityShape } from "../../../src/vendor/svc-rpc/graph-memory/entity-shape.js";

type Meta = Record<string, unknown>;

function adapterWith(entities: Array<{ title: string; meta: Meta }>): IGraphMemoryAdapter {
  const nodes = entities.map((e, i) => ({
    id: `n${i}`,
    properties: {
      agent_output: `${e.title} prose`,
      metadata: {
        entity_type: "component_version",
        title: e.title,
        tags: ["component_version"],
        status: "completed",
        updated_at: "2026-01-01T00:00:00Z",
        custom_metadata: e.meta,
      },
    },
  }));
  return {
    workspaceId: "ws",
    searchEntities: jest.fn(async () => ({ results: nodes, level_used: "raw", levels_tried: ["raw"] })),
    graphQuery: jest.fn(async () => ({ nodes, edges: [] })),
  } as unknown as IGraphMemoryAdapter;
}

const noHost = {
  readFailureModes: async () => ({ unavailable: "no host token" }),
  readRefusalRecord: async () => ({ unavailable: "no host token" }),
};

function entity(meta: Meta): StoredEntityShape {
  return {
    id: "x",
    entity_type: "component_version",
    title: "t",
    content: "",
    tags: [],
    priority: "medium",
    status: "completed",
    metadata: meta,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("lineageLine", () => {
  it("names the outcome, its day, the need and the keeper's reason", () => {
    expect(
      lineageLine(
        { name: "execute-code", version: "0.3.8" },
        entity({
          outcome: "converged",
          settled_at: "2026-10-12T09:00:00Z",
          need: "say how long the run took",
          decision_reason: "clean and small",
        }),
      ),
    ).toBe(
      '- execute-code@0.3.8 — converged 2026-10-12. Need: "say how long the run took". Keeper\'s reason: "clean and small".',
    );
  });

  it("marks a rejected version's reason as a constraint", () => {
    expect(
      lineageLine(
        { name: "execute-code", version: "0.3.7" },
        entity({ outcome: "rejected", settled_at: "2026-10-11T00:00:00Z", decision_reason: "no new dependency" }),
      ),
    ).toMatch(/rejected 2026-10-11\. Keeper's reason: "no new dependency"\. Treat it as a constraint\.$/);
  });

  it("carries the agent's own reason for an abandoned version", () => {
    expect(
      lineageLine({ name: "parse-time", version: "0.1.0" }, entity({ outcome: "abandoned", reason: "never announced" })),
    ).toBe("- parse-time@0.1.0 — abandoned (never announced).");
  });

  it("says when a candidate is waiting and when there is no record", () => {
    expect(
      lineageLine({ name: "a", version: "1.0.0" }, entity({ outcome: "candidate", announced_at: "2026-10-14T01:00:00Z" })),
    ).toBe("- a@1.0.0 — candidate, waiting for the keeper since 2026-10-14.");
    expect(lineageLine({ name: "a", version: "1.0.0" }, null)).toBe("- a@1.0.0 — no lineage record.");
  });
});

describe("buildSelfTaskBriefing", () => {
  it("lists the agent's own versions newest first, at most the limit", async () => {
    const refs = Array.from({ length: 10 }, (_, i) => ({ name: "c", version: `0.0.${i}` }));
    const adapter = adapterWith(
      refs.map((r, i) => ({
        title: `c@${r.version}`,
        meta: { outcome: "converged", settled_at: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z` },
      })),
    );
    const briefing = await buildSelfTaskBriefing({
      agentId: "agent-1",
      discover: async () => refs,
      getAdapter: () => adapter,
      readFailureModes: async () => ({ body: null, updatedAt: null }),
      readRefusalRecord: async () => ({ version: 1, markdown: "# Record" }),
    });

    expect(briefing).toBeDefined();
    expect(briefing!.startsWith(BRIEFING_INTRO)).toBe(true);
    const lines = briefing!.split("\n").filter((l) => l.startsWith("- c@"));
    expect(lines).toHaveLength(BRIEFING_LINEAGE_LIMIT);
    expect(lines[0]).toMatch(/^- c@0\.0\.9 — converged 2026-10-10\./);
    expect(lines[BRIEFING_LINEAGE_LIMIT - 1]).toMatch(/^- c@0\.0\.2 /);
    expect(briefing).toContain(`## Known failure modes — written by your keeper\n${FAILURE_MODES_NONE}`);
    expect(briefing).toContain(
      "## Refusal record — the platform's account of every refusal and outcome (version 1)\n# Record",
    );
  });

  it("puts the parts in order: versions, failure modes, refusal record", async () => {
    const briefing = await buildSelfTaskBriefing({
      agentId: "agent-1",
      discover: async () => [],
      readFailureModes: async () => ({ body: "Over-builds.", updatedAt: "2026-10-13T12:00:00Z" }),
      readRefusalRecord: async () => ({ version: 4, markdown: "R", cached: true }),
    });
    expect(briefing).toBe(
      [
        BRIEFING_INTRO,
        `## Your recent component versions (newest first)\n${LINEAGE_NONE}`,
        "## Known failure modes — written by your keeper (updated 2026-10-13)\nOver-builds.",
        "## Refusal record — the platform's account of every refusal and outcome (version 4, the last copy read)\nR",
      ].join("\n\n"),
    );
  });

  it("says the lineage is unreadable when memory is, and still sends the rest", async () => {
    const briefing = await buildSelfTaskBriefing({
      agentId: "agent-1",
      discover: async () => [{ name: "c", version: "1.0.0" }],
      getAdapter: () => {
        throw new Error("no memory");
      },
      readFailureModes: async () => ({ body: "x", updatedAt: null }),
      readRefusalRecord: async () => ({ unavailable: "down" }),
    });
    expect(briefing).toContain(LINEAGE_UNREADABLE);
    expect(briefing).toContain("## Known failure modes");
    expect(briefing).not.toContain("## Refusal record");
  });

  it("caps the refusal record", async () => {
    const briefing = await buildSelfTaskBriefing({
      agentId: "agent-1",
      discover: async () => [],
      readFailureModes: async () => ({ unavailable: "down" }),
      readRefusalRecord: async () => ({ version: 1, markdown: "y".repeat(BRIEFING_REFUSAL_RECORD_MAX_CHARS + 500) }),
    });
    expect(briefing).toContain("y".repeat(BRIEFING_REFUSAL_RECORD_MAX_CHARS));
    expect(briefing).not.toContain("y".repeat(BRIEFING_REFUSAL_RECORD_MAX_CHARS + 1));
    expect(briefing).toMatch(/cut here for length\.\]$/);
  });

  it("is absent when there are no versions and the host has nothing", async () => {
    expect(await buildSelfTaskBriefing({ agentId: "agent-1", discover: async () => [], ...noHost })).toBeUndefined();
    expect(
      await buildSelfTaskBriefing({
        agentId: "agent-1",
        discover: async () => {
          throw new Error("disk");
        },
        ...noHost,
      }),
    ).toBeUndefined();
  });

  it("resolves within its budget when every part hangs", async () => {
    const hang = () => new Promise<never>(() => {});
    const started = Date.now();
    const briefing = await buildSelfTaskBriefing({
      agentId: "agent-1",
      discover: hang,
      readFailureModes: hang,
      readRefusalRecord: hang,
      budgetMs: 100,
    });
    expect(briefing).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("keeps a part that answered when another hangs past the budget", async () => {
    const briefing = await buildSelfTaskBriefing({
      agentId: "agent-1",
      discover: () => new Promise<never>(() => {}),
      readFailureModes: async () => ({ body: "x", updatedAt: null }),
      readRefusalRecord: () => new Promise<never>(() => {}),
      budgetMs: 100,
    });
    expect(briefing).toContain(LINEAGE_UNREADABLE);
    expect(briefing).toContain("## Known failure modes — written by your keeper\nx");
  });
});
