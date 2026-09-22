/**
 * The pure half of component lineage: entity titles and bodies, the host
 * result mapping, and the reconcile decision table.
 */
import { describe, it, expect } from "@jest/globals";
import {
  LINEAGE_ENTITY_TYPE,
  OUTCOMES,
  SUPERSEDES,
  buildLineageEntity,
  buildParentEntity,
  decideReconcile,
  lineageTitle,
  outcomeFromHostResult,
  parseLineageRef,
  settlePayload,
  type HostComponentView,
} from "../../../src/components/lineage.js";
import type { ComponentManifest } from "../../../src/components/manifest.js";

const manifest = (overrides: Partial<ComponentManifest> = {}): ComponentManifest =>
  ({
    name: "execute-code",
    version: "0.2.1",
    kind: "middleware",
    intent: "run code",
    sdk: "^1.0.0",
    entry: "entry.ts",
    contract: "contract.ts",
    depth: 0,
    lineage: { producedBy: "seed" },
    ...overrides,
  }) as ComponentManifest;

describe("lineageTitle / parseLineageRef", () => {
  it("is name@version and round-trips", () => {
    expect(lineageTitle("execute-code", "0.2.3")).toBe("execute-code@0.2.3");
    expect(parseLineageRef("execute-code@0.2.3")).toEqual({ name: "execute-code", version: "0.2.3" });
    expect(parseLineageRef("0.2.3")).toBeNull();
    expect(parseLineageRef("")).toBeNull();
  });
});

describe("buildLineageEntity", () => {
  const entity = buildLineageEntity({
    name: "execute-code",
    version: "0.2.3",
    depth: 0,
    need: "return (no output) for a silent success",
    parent: "execute-code@0.2.1",
    producedBy: "agent-1",
    threadId: "thread-9",
    outcome: "candidate",
  });

  it("uses the exact title, the lineage type and a raw abstraction level", () => {
    expect(entity.entity_type).toBe(LINEAGE_ENTITY_TYPE);
    expect(entity.title).toBe("execute-code@0.2.3");
    expect(entity.abstraction_level).toBe("raw");
    expect(entity.status).toBe("active");
    expect(entity.context).toBe("component_version execute-code");
  });

  it("puts both spellings of the component, the version and the outcome in the tags", () => {
    expect(entity.tags).toEqual(
      expect.arrayContaining([
        "component_version",
        "component:execute-code",
        "execute-code",
        "execute_code",
        "version:0.2.3",
        "outcome:candidate",
        "produced-by:agent-1",
      ]),
    );
  });

  it("writes prose a stranger can use and keeps the structured copy in metadata", () => {
    expect(entity.content).toContain("execute-code");
    expect(entity.content).toContain("execute_code");
    expect(entity.content).toContain("0.2.3");
    expect(entity.content).toContain("execute-code@0.2.1");
    expect(entity.content).toContain("return (no output) for a silent success");
    expect(entity.content).toContain("thread-9");
    expect(entity.content).toContain("agent-1");
    expect(entity.content).toContain("candidate");
    expect(entity.metadata).toEqual({
      component: "execute-code",
      version: "0.2.3",
      need: "return (no output) for a silent success",
      thread_id: "thread-9",
      depth: 0,
      provenance: { produced_by: "agent-1", parent: "execute-code@0.2.1" },
      outcome: "candidate",
    });
  });

  it("carries nothing node-private", () => {
    const text = JSON.stringify(entity);
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain(".siad");
    expect(text).not.toContain("token");
  });

  it("omits the parent and thread when absent", () => {
    const root = buildLineageEntity({
      name: "execute-code",
      version: "0.1.0",
      depth: 0,
      producedBy: "seed",
      outcome: "converged",
    });
    expect(root.metadata?.provenance).toEqual({ produced_by: "seed" });
    expect(root.metadata).not.toHaveProperty("thread_id");
    expect(root.content).not.toContain("undefined");
    expect(root.status).toBe("completed");
  });
});

describe("buildParentEntity", () => {
  it("records a current version as converged, produced by its manifest's author", () => {
    const parent = buildParentEntity(manifest({ version: "0.1.0" }));
    expect(parent.title).toBe("execute-code@0.1.0");
    expect(parent.metadata?.outcome).toBe("converged");
    expect(parent.metadata?.provenance).toEqual({ produced_by: "seed" });
    expect(parent.tags).toContain("outcome:converged");
    expect(parent.tags).toContain("produced-by:seed");
    expect(parent.status).toBe("completed");
  });

  it("keeps the manifest's own parent and need", () => {
    const parent = buildParentEntity(
      manifest({
        version: "0.2.1",
        lineage: { producedBy: "agent-1", parent: "execute-code@0.1.0", need: "trim" },
      }),
    );
    expect(parent.metadata?.provenance).toEqual({
      produced_by: "agent-1",
      parent: "execute-code@0.1.0",
    });
    expect(parent.metadata?.need).toBe("trim");
  });
});

describe("outcomeFromHostResult", () => {
  it("maps the host's three result words and nothing else", () => {
    expect(outcomeFromHostResult("activated")).toBe("converged");
    expect(outcomeFromHostResult("reverted")).toBe("reverted");
    expect(outcomeFromHostResult("failed")).toBe("failed");
    expect(outcomeFromHostResult("rejected")).toBeNull();
    expect(outcomeFromHostResult("")).toBeNull();
    expect(outcomeFromHostResult(undefined)).toBeNull();
  });

  it("exposes the five outcomes and the edge name", () => {
    expect(OUTCOMES).toEqual(["candidate", "converged", "reverted", "failed", "rejected"]);
    expect(SUPERSEDES).toBe("SUPERSEDES");
  });
});

describe("decideReconcile", () => {
  const pending = { name: "execute-code", version: "0.2.3" };
  const view = (c: Partial<HostComponentView>): HostComponentView[] => [
    { name: "execute-code", versions: [], ...c },
  ];

  it("settles on a matching lastOutcome, in either phase", () => {
    const host = view({
      active: "0.2.3",
      lastOutcome: { version: "0.2.3", result: "activated", at: "2026-09-22T00:00:00Z" },
    });
    expect(decideReconcile(pending, host, "boot", false)).toEqual({
      action: "settle",
      outcome: "converged",
      at: "2026-09-22T00:00:00Z",
    });
    expect(decideReconcile(pending, host, "turn", false)).toMatchObject({ action: "settle" });
  });

  it("carries the host's error as the reason on a revert or failure", () => {
    const host = view({
      active: "0.2.1",
      lastOutcome: { version: "0.2.3", result: "reverted", error: "contract: 422" },
    });
    expect(decideReconcile(pending, host, "turn", false)).toEqual({
      action: "settle",
      outcome: "reverted",
      reason: "contract: 422",
    });
    const failed = view({ lastOutcome: { version: "0.2.3", result: "failed", error: "revert: x" } });
    expect(decideReconcile(pending, failed, "turn", false)).toMatchObject({
      action: "settle",
      outcome: "failed",
      reason: "revert: x",
    });
  });

  it("waits while the version is the candidate or the active one without a verdict", () => {
    expect(
      decideReconcile(pending, view({ active: "0.2.1", candidate: { version: "0.2.3" } }), "turn", false),
    ).toEqual({ action: "wait" });
    expect(decideReconcile(pending, view({ active: "0.2.3" }), "turn", false)).toEqual({
      action: "wait",
    });
    // A verdict for another version says nothing about this one.
    expect(
      decideReconcile(
        pending,
        view({ active: "0.2.3", lastOutcome: { version: "0.2.2", result: "reverted" } }),
        "boot",
        false,
      ),
    ).toEqual({ action: "wait" });
  });

  it("at boot, a version that is gone waits until the cap and is then rejected", () => {
    const gone = view({ active: "0.2.1" });
    expect(decideReconcile(pending, gone, "boot", false)).toEqual({ action: "wait" });
    expect(decideReconcile(pending, gone, "boot", true)).toEqual({
      action: "settle",
      outcome: "rejected",
    });
  });

  it("on a turn, a version that is gone is rejected at once", () => {
    expect(decideReconcile(pending, view({ active: "0.2.1" }), "turn", false)).toEqual({
      action: "settle",
      outcome: "rejected",
    });
  });

  it("a component the host does not list counts as gone", () => {
    expect(decideReconcile(pending, [], "turn", false)).toEqual({
      action: "settle",
      outcome: "rejected",
    });
  });

  it("an older host that reports no components decides nothing", () => {
    expect(decideReconcile(pending, null, "turn", false)).toEqual({ action: "unknown" });
    expect(decideReconcile(pending, null, "boot", true)).toEqual({ action: "unknown" });
  });

  it("an unknown result word waits rather than guessing", () => {
    expect(
      decideReconcile(pending, view({ lastOutcome: { version: "0.2.3", result: "weird" } }), "turn", false),
    ).toEqual({ action: "wait" });
  });
});

describe("settlePayload", () => {
  it("flips the outcome tag, completes the entity and appends the verdict", () => {
    const payload = settlePayload(
      ["component_version", "outcome:candidate", "version:0.2.3"],
      { outcome: "reverted", reason: "contract: 422", at: "2026-09-22T00:00:00Z" },
    );
    expect(payload.tags).toEqual(["component_version", "version:0.2.3", "outcome:reverted"]);
    expect(payload.status).toBe("completed");
    expect(payload.metadata).toEqual({
      outcome: "reverted",
      reason: "contract: 422",
      settled_at: "2026-09-22T00:00:00Z",
    });
    expect(payload.contentLine).toContain("reverted");
    expect(payload.contentLine).toContain("contract: 422");
  });

  it("stamps settled_at from the clock when the verdict carries no time", () => {
    const payload = settlePayload([], { outcome: "converged" }, () => "2026-09-22T01:02:03.000Z");
    expect(payload.metadata.settled_at).toBe("2026-09-22T01:02:03.000Z");
    expect(payload.metadata).not.toHaveProperty("reason");
  });
});
