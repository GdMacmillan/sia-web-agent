/**
 * Authoring skill and prompt versions: the next version is copied from
 * what is served (the in-place seed, or the activated version), records
 * the seed it started from, and never activates itself; a new skill is
 * created whole; and the built-in contract judges each.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  planComponentVersion,
  planNewComponent,
  readVersionOrSeed,
} from "../../../src/components/authoring.js";
import {
  SEED_BASELINE_FILE,
  contentDigest,
  readSeedBaseline,
  seedContentSource,
  versionContentSource,
} from "../../../src/components/content.js";
import { checkContent } from "../../../src/components/content-contract.js";
import { runComponentContract } from "../../../src/components/contract.js";
import { makeRoot, removeRoot } from "./fixtures.js";
import {
  skillMd,
  writeContentVersion,
  writeSeedPrompt,
  writeSeedSkill,
} from "./content-fixtures.js";

describe("content authoring", () => {
  let seedRoot: string;
  let root: string;

  beforeEach(() => {
    seedRoot = makeRoot("author-seed-");
    root = makeRoot("author-root-");
    writeSeedSkill(seedRoot, "probe", { "notes/extra.md": "Extra notes.\n" });
    writeSeedPrompt(seedRoot, "answer", "Answer the question asked.\n");
  });
  afterEach(() => {
    removeRoot(seedRoot);
    removeRoot(root);
  });

  const plan = (name: string) =>
    planComponentVersion({
      name,
      roots: [root],
      authoringRoot: root,
      need: "make it clearer",
      producedBy: "agent-1",
      contentSeedRoot: seedRoot,
    });

  it("copies the in-place seed into the first version, leaving the seed alone", () => {
    const seedBefore = readFileSync(
      path.join(seedRoot, "skills", "probe", "SKILL.md"),
      "utf-8",
    );
    const result = plan("skill-probe");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { plan: p } = result;
    expect(p).toMatchObject({
      name: "skill-probe",
      kind: "skill",
      previousVersion: "1.0.0",
      nextVersion: "1.0.1",
      parentOrigin: "seed",
      entryPath: path.join(p.versionDir, "SKILL.md"),
    });
    expect(readFileSync(p.entryPath, "utf-8")).toBe(seedBefore);
    expect(
      readFileSync(path.join(p.versionDir, "notes", "extra.md"), "utf-8"),
    ).toBe("Extra notes.\n");
    const manifest = JSON.parse(readFileSync(p.manifestPath, "utf-8"));
    expect(manifest).toMatchObject({
      name: "skill-probe",
      version: "1.0.1",
      kind: "skill",
      entry: "SKILL.md",
      lineage: {
        parent: "skill-probe@1.0.0",
        need: "make it clearer",
        producedBy: "agent-1",
      },
    });
    expect(existsSync(path.join(root, "skill-probe", "current"))).toBe(false);
    expect(
      readFileSync(path.join(seedRoot, "skills", "probe", "SKILL.md"), "utf-8"),
    ).toBe(seedBefore);
  });

  it("records the digest of the seed the lineage started from", () => {
    const result = plan("skill-probe");
    if (!result.ok) throw new Error(result.reason);
    const seed = seedContentSource("skill", "probe", seedRoot)!;
    expect(readSeedBaseline(result.plan.versionDir)).toBe(contentDigest(seed));
  });

  it("builds on the activated version and carries its baseline forward", () => {
    const parentDir = writeContentVersion(root, "skill", "probe", "1.0.1", {
      files: { "SKILL.md": skillMd("probe", "Accepted.\n") },
      current: true,
    });
    const baseline = "b".repeat(64);
    writeFileSync(path.join(parentDir, SEED_BASELINE_FILE), `${baseline}\n`);
    const result = plan("skill-probe");
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).toMatchObject({
      previousVersion: "1.0.1",
      nextVersion: "1.0.2",
      parentOrigin: "version",
    });
    expect(readFileSync(result.plan.entryPath, "utf-8")).toContain("Accepted.");
    expect(readSeedBaseline(result.plan.versionDir)).toBe(baseline);
  });

  it("writes a prompt version as prompt.md alone", () => {
    const result = plan("prompt-answer");
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.kind).toBe("prompt");
    const files = readdirSync(result.plan.versionDir).sort();
    expect(files).toEqual([SEED_BASELINE_FILE, "component.json", "prompt.md"]);
    expect(readFileSync(result.plan.entryPath, "utf-8")).toBe(
      "Answer the question asked.\n",
    );
  });

  it("refuses a skill with no seed and no version", () => {
    const result = plan("skill-absent");
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('create_component with kind "skill"'),
    });
  });

  describe("readVersionOrSeed", () => {
    it("reads the in-place seed at 1.0.0", () => {
      const read = readVersionOrSeed({
        name: "skill-probe",
        version: "1.0.0",
        roots: [root],
        contentSeedRoot: seedRoot,
      });
      expect(read).toMatchObject({
        ok: true,
        manifest: { name: "skill-probe", version: "1.0.0", kind: "skill" },
        content: { origin: "seed" },
      });
    });

    it("reads a host version with its content", () => {
      writeContentVersion(root, "skill", "probe", "1.0.1", {
        files: { "SKILL.md": skillMd("probe") },
      });
      expect(
        readVersionOrSeed({
          name: "skill-probe",
          version: "1.0.1",
          roots: [root],
          contentSeedRoot: seedRoot,
        }),
      ).toMatchObject({ ok: true, content: { origin: "version" } });
    });

    it("is not found for another seedless version", () => {
      expect(
        readVersionOrSeed({
          name: "skill-probe",
          version: "2.0.0",
          roots: [root],
          contentSeedRoot: seedRoot,
        }).ok,
      ).toBe(false);
    });
  });

  describe("creating a skill", () => {
    const create = (name: string, kind?: "tools" | "skill") =>
      planNewComponent({
        name,
        roots: [root],
        authoringRoot: root,
        intent: "Plan a trip, step by step.",
        need: "the owner asked for trip planning",
        producedBy: "agent-1",
        contentSeedRoot: seedRoot,
        ...(kind !== undefined ? { kind } : {}),
      });

    it("lays out a first version whose stub passes the content contract", () => {
      const result = create("skill-trip-planning", "skill");
      if (!result.ok) throw new Error(result.reason);
      expect(result.plan).toMatchObject({ kind: "skill", version: "0.1.0" });
      const source = versionContentSource(
        "skill",
        "trip-planning",
        "0.1.0",
        result.plan.versionDir,
      );
      expect(checkContent(source)).toEqual([]);
      expect(
        existsSync(path.join(root, "skill-trip-planning", "current")),
      ).toBe(false);
    });

    it("refuses a skill that ships with the source tree", () => {
      expect(create("skill-probe", "skill")).toMatchObject({
        ok: false,
        reason: expect.stringContaining("ships with the source tree"),
      });
    });

    it("never creates a prompt, and keeps skill- names for skills", () => {
      expect(create("prompt-answer", "skill").ok).toBe(false);
      expect(create("skill-trip-planning")).toMatchObject({
        ok: false,
        reason: expect.stringContaining('kind "skill"'),
      });
    });
  });

  describe("the built-in contract", () => {
    const run = (name: string, version?: string) =>
      runComponentContract(name, {
        contentRoots: [root],
        contentSeedRoot: seedRoot,
        ...(version !== undefined ? { version } : {}),
      });

    it("judges the seed when nothing is activated", async () => {
      const result = await run("skill-probe");
      expect(result).toMatchObject({ ok: true, version: "1.0.0" });
      expect(result.loaded).toMatchObject({
        entry: { file: "SKILL.md (+1 file)" },
        contract: { file: "(built-in content contract)" },
      });
    });

    it("judges a staged version named explicitly, never importing it", async () => {
      writeContentVersion(root, "skill", "probe", "1.0.1", {
        files: { "SKILL.md": skillMd("wrong-name") },
      });
      const result = await run("skill-probe", "1.0.1");
      expect(result).toMatchObject({
        ok: false,
        version: "1.0.1",
        error: expect.stringContaining('frontmatter name "wrong-name"'),
      });
    });

    it("reports an unknown version", async () => {
      expect((await run("skill-probe", "3.0.0")).ok).toBe(false);
    });
  });
});
