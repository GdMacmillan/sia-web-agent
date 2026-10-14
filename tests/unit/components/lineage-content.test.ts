/**
 * Lineage for skills and prompts: the entity names its kind and base so a
 * search on either finds it, and the diff a version was announced with is
 * recorded as a bounded excerpt plus the hash of the whole.
 */
import { describe, it, expect } from "@jest/globals";
import { createHash } from "node:crypto";
import {
  LINEAGE_DIFF_MAX_BYTES,
  buildLineageEntity,
  lineageDiffPayload,
} from "../../../src/components/lineage.js";

describe("lineage of a skill or prompt", () => {
  it("tags a skill version with its kind and base name, and no underscore spelling", () => {
    const entity = buildLineageEntity({
      name: "skill-trip-planning",
      version: "1.0.1",
      parent: "skill-trip-planning@1.0.0",
      need: "plan by train",
      producedBy: "agent-1",
      depth: 1,
      outcome: "candidate",
    });
    expect(entity.title).toBe("skill-trip-planning@1.0.1");
    expect(entity.tags).toEqual(
      expect.arrayContaining([
        "kind:skill",
        "skill:trip-planning",
        "trip-planning",
      ]),
    );
    expect(entity.tags).not.toContain("skill_trip_planning");
    expect(entity.content).toContain(
      "skill-trip-planning@1.0.1 is version 1.0.1 of the trip-planning skill (component skill-trip-planning).",
    );
  });

  it("tags a prompt version with its kind and role", () => {
    const entity = buildLineageEntity({
      name: "prompt-manager",
      version: "1.0.1",
      producedBy: "agent-1",
      depth: 1,
      outcome: "candidate",
    });
    expect(entity.tags).toEqual(
      expect.arrayContaining(["kind:prompt", "prompt:manager", "manager"]),
    );
  });

  it("leaves a code component's tags as they were", () => {
    const entity = buildLineageEntity({
      name: "execute-code",
      version: "0.2.1",
      producedBy: "agent-1",
      depth: 1,
      outcome: "candidate",
    });
    expect(entity.tags).toContain("execute_code");
    expect(entity.tags.some((t) => t.startsWith("kind:"))).toBe(false);
  });
});

describe("lineageDiffPayload", () => {
  it("records a small diff whole, with its counts and hash", () => {
    const text = "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1,2 @@\n line\n+new\n";
    const payload = lineageDiffPayload({
      parent: "skill-x@1.0.0",
      text,
      added: 1,
      removed: 0,
    });
    expect(payload.contentLine).toBe(
      `Diff against skill-x@1.0.0 (+1 −0):\n${text}`,
    );
    expect(payload.metadata).toEqual({
      diff_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      diff_added: 1,
      diff_removed: 0,
    });
  });

  it("says no change for an empty diff", () => {
    expect(
      lineageDiffPayload({
        parent: "skill-x@1.0.0",
        text: "",
        added: 0,
        removed: 0,
      }).contentLine,
    ).toBe("Diff against skill-x@1.0.0 (+0 −0): no change.");
  });

  it("keeps only the head of a large diff, cut at a line, but hashes all of it", () => {
    const text = Array.from(
      { length: 500 },
      (_, i) => `+added line number ${i}`,
    ).join("\n");
    const payload = lineageDiffPayload({
      parent: "prompt-manager@1.0.0",
      text,
      added: 500,
      removed: 0,
    });
    const body = payload.contentLine.split("\n").slice(1, -1).join("\n");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
      LINEAGE_DIFF_MAX_BYTES,
    );
    expect(body.endsWith("\n")).toBe(false);
    expect(text.startsWith(body)).toBe(true);
    expect(payload.contentLine).toMatch(/… \(first 4096 bytes of the diff\)$/);
    expect(payload.metadata.diff_sha256).toBe(
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
  });
});
