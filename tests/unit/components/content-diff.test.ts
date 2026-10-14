/**
 * The diff a skill or prompt version is announced with: a unified diff
 * against its parent, and the cap that keeps it bounded on the wire.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  DIFF_MAX_BYTES,
  capDiff,
  diffContentSources,
  unifiedDiff,
} from "../../../src/components/content-diff.js";
import { versionContentSource } from "../../../src/components/content.js";
import { makeRoot, removeRoot } from "./fixtures.js";
import { writeContentVersion } from "./content-fixtures.js";

const labels = { old: "a/x", new: "b/x" };

describe("unifiedDiff", () => {
  it("is empty for identical texts", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", labels)).toEqual({
      text: "",
      added: 0,
      removed: 0,
    });
  });

  it("renders one hunk with context and counts", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n") + "\n";
    const after = ["1", "2", "3", "four", "5", "6", "7", "8"].join("\n") + "\n";
    const diff = unifiedDiff(before, after, labels);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.text).toBe(
      [
        "--- a/x",
        "+++ b/x",
        "@@ -1,7 +1,7 @@",
        " 1",
        " 2",
        " 3",
        "-4",
        "+four",
        " 5",
        " 6",
        " 7",
        "",
      ].join("\n"),
    );
  });

  it("splits distant changes into separate hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[2] = "early";
    changed[27] = "late";
    const diff = unifiedDiff(
      lines.join("\n") + "\n",
      changed.join("\n") + "\n",
      labels,
    );
    expect(diff.text.match(/^@@ /gm)).toHaveLength(2);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
  });
});

describe("diffContentSources", () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot("content-diff-");
  });
  afterEach(() => removeRoot(root));

  const version = (v: string, files: Record<string, string>) =>
    versionContentSource(
      "skill",
      "probe",
      v,
      writeContentVersion(root, "skill", "probe", v, { files }),
    );

  it("diffs file by file, adds and removes included, manifest never", () => {
    const parent = version("1.0.0", { "SKILL.md": "a\n", "old.md": "gone\n" });
    const child = version("1.0.1", { "SKILL.md": "b\n", "new.md": "here\n" });
    const diff = diffContentSources(parent, child);
    expect(diff.files).toBe(3);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
    expect(diff.text).toContain("--- a/SKILL.md (skill-probe@1.0.0)");
    expect(diff.text).toContain("+++ b/SKILL.md (skill-probe@1.0.1)");
    expect(diff.text).toContain("--- /dev/null\n+++ b/new.md");
    expect(diff.text).toContain(
      "--- a/old.md (skill-probe@1.0.0)\n+++ /dev/null",
    );
    expect(diff.text).not.toContain("component.json");
  });

  it("reads every line as added against no parent", () => {
    const child = version("0.1.0", { "SKILL.md": "one\ntwo\n" });
    expect(diffContentSources(null, child)).toMatchObject({
      added: 2,
      removed: 0,
      files: 1,
    });
  });

  it("is empty when nothing changed", () => {
    const parent = version("1.0.0", { "SKILL.md": "same\n" });
    const child = version("1.0.1", { "SKILL.md": "same\n" });
    expect(diffContentSources(parent, child)).toEqual({
      text: "",
      added: 0,
      removed: 0,
      files: 0,
    });
  });
});

describe("capDiff", () => {
  it("leaves a diff that fits unchanged", () => {
    expect(capDiff("+a\n-b\n")).toEqual({ text: "+a\n-b\n", truncated: false });
  });

  it("cuts at a line boundary, within the cap, saying how much was left out", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `+line number ${i}`);
    const text = lines.join("\n") + "\n";
    const capped = capDiff(text);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text, "utf-8")).toBeLessThanOrEqual(
      DIFF_MAX_BYTES,
    );
    const out = capped.text.split("\n");
    expect(out[out.length - 1]).toBe("");
    const marker = out[out.length - 2];
    const kept = out.length - 2;
    expect(marker).toBe(`… diff truncated: ${5000 - kept} more lines`);
    expect(out.slice(0, kept)).toEqual(lines.slice(0, kept));
  });

  it("counts bytes, not characters", () => {
    const capped = capDiff(`+${"é".repeat(100)}\n+${"é".repeat(100)}\n`, 300);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text, "utf-8")).toBeLessThanOrEqual(300);
  });
});
