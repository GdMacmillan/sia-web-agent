/**
 * Skills and prompts as components: naming, what resolves to be served
 * (an activated version that passes its contract, else the in-place
 * seed), the digest, and the seed baseline a lineage carries.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  SEED_BASELINE_FILE,
  _resetContentWarningsForTests,
  contentDigest,
  listEffectiveSkillBases,
  parseContentComponentName,
  readSeedBaseline,
  resolveContent,
  seedContentSource,
  versionContentSource,
  walkContentDir,
} from "../../../src/components/content.js";
import { makeRoot, removeRoot } from "./fixtures.js";
import {
  skillMd,
  writeContentVersion,
  writeSeedPrompt,
  writeSeedSkill,
} from "./content-fixtures.js";

describe("parseContentComponentName", () => {
  it("reads skill-<dir> and prompt-<role>", () => {
    expect(parseContentComponentName("skill-research")).toEqual({
      kind: "skill",
      base: "research",
    });
    expect(parseContentComponentName("prompt-no-web-search")).toEqual({
      kind: "prompt",
      base: "no-web-search",
    });
  });

  it("is null for code components and unknown prompts", () => {
    expect(parseContentComponentName("execute-code")).toBeNull();
    expect(parseContentComponentName("prompt-pirate")).toBeNull();
    expect(parseContentComponentName("skill-")).toBeNull();
    expect(parseContentComponentName(42)).toBeNull();
  });
});

describe("resolveContent", () => {
  let seedRoot: string;
  let root: string;

  beforeEach(() => {
    _resetContentWarningsForTests();
    seedRoot = makeRoot("content-seed-");
    root = makeRoot("content-root-");
    writeSeedSkill(seedRoot, "probe");
    writeSeedPrompt(seedRoot, "answer", "Answer the question asked.\n");
  });
  afterEach(() => {
    removeRoot(seedRoot);
    removeRoot(root);
  });

  const resolve = (kind: "skill" | "prompt", base: string) =>
    resolveContent(kind, base, { roots: [root], seedRoot });

  it("serves the in-place seed when no version is activated", () => {
    const source = resolve("skill", "probe");
    expect(source).toMatchObject({
      origin: "seed",
      version: "1.0.0",
      name: "skill-probe",
      file: path.join(seedRoot, "skills", "probe", "SKILL.md"),
    });
    expect(resolve("prompt", "answer")).toMatchObject({
      origin: "seed",
      file: path.join(seedRoot, "prompts", "answer.md"),
      files: [expect.objectContaining({ rel: "prompt.md" })],
    });
  });

  it("is null when there is neither a seed nor a version", () => {
    expect(resolve("skill", "absent")).toBeNull();
  });

  it("passes over a staged candidate", () => {
    writeContentVersion(root, "skill", "probe", "1.0.1", {
      files: { "SKILL.md": skillMd("probe", "Candidate.\n") },
    });
    expect(resolve("skill", "probe")?.origin).toBe("seed");
  });

  it("serves the activated version", () => {
    const dir = writeContentVersion(root, "skill", "probe", "1.0.1", {
      files: { "SKILL.md": skillMd("probe", "Accepted.\n") },
      current: true,
    });
    expect(resolve("skill", "probe")).toMatchObject({
      origin: "version",
      version: "1.0.1",
      dir,
      file: path.join(dir, "SKILL.md"),
    });
  });

  it("serves a skill that exists only as an activated version", () => {
    writeContentVersion(root, "skill", "fresh", "0.1.0", {
      files: { "SKILL.md": skillMd("fresh") },
      current: true,
      manifest: { lineage: { producedBy: "test" } },
    });
    expect(resolve("skill", "fresh")?.origin).toBe("version");
    expect(listEffectiveSkillBases({ roots: [root], seedRoot })).toEqual([
      "fresh",
      "probe",
    ]);
  });

  it("falls back to the seed when the activated version fails its contract", () => {
    writeContentVersion(root, "skill", "probe", "1.0.1", {
      files: { "SKILL.md": skillMd("not-probe") },
      current: true,
    });
    expect(resolve("skill", "probe")?.origin).toBe("seed");
  });

  it("falls back to the seed when the activated version has another kind", () => {
    writeContentVersion(root, "prompt", "answer", "1.0.1", {
      files: { "prompt.md": "Answer briefly.\n" },
      current: true,
      manifest: { kind: "service", entry: "entry.ts" },
    });
    expect(resolve("prompt", "answer")?.origin).toBe("seed");
  });

  it("falls back to the seed when the pointer is broken", () => {
    writeContentVersion(root, "skill", "probe", "1.0.1", {
      files: { "SKILL.md": skillMd("probe") },
    });
    writeFileSync(path.join(root, "skill-probe", "current"), "9.9.9\n");
    expect(resolve("skill", "probe")?.origin).toBe("seed");
  });
});

describe("contentDigest and the seed baseline", () => {
  let seedRoot: string;
  let root: string;
  beforeEach(() => {
    seedRoot = makeRoot("content-seed-");
    root = makeRoot("content-root-");
  });
  afterEach(() => {
    removeRoot(seedRoot);
    removeRoot(root);
  });

  it("hashes the same files the same wherever they live", () => {
    writeSeedSkill(seedRoot, "probe", { "notes/a.md": "A\n" });
    const dir = writeContentVersion(root, "skill", "probe", "1.0.1", {
      files: { "SKILL.md": skillMd("probe"), "notes/a.md": "A\n" },
    });
    const seed = seedContentSource("skill", "probe", seedRoot)!;
    const version = versionContentSource("skill", "probe", "1.0.1", dir);
    expect(contentDigest(version)).toBe(contentDigest(seed));
    writeFileSync(path.join(dir, "notes", "a.md"), "B\n");
    expect(contentDigest(version)).not.toBe(contentDigest(seed));
  });

  it("never counts the manifest or hidden files as content", () => {
    const dir = writeContentVersion(root, "skill", "probe", "1.0.1", {
      files: { "SKILL.md": skillMd("probe"), [SEED_BASELINE_FILE]: "x\n" },
    });
    expect(walkContentDir(dir).map((f) => f.rel)).toEqual(["SKILL.md"]);
  });

  it("reads a recorded baseline and ignores anything else", () => {
    const dir = writeContentVersion(root, "skill", "probe", "1.0.1", {
      files: { "SKILL.md": skillMd("probe") },
    });
    expect(readSeedBaseline(dir)).toBeNull();
    writeFileSync(path.join(dir, SEED_BASELINE_FILE), "not a digest\n");
    expect(readSeedBaseline(dir)).toBeNull();
    const digest = "a".repeat(64);
    writeFileSync(path.join(dir, SEED_BASELINE_FILE), `${digest}\n`);
    expect(readSeedBaseline(dir)).toBe(digest);
  });
});
