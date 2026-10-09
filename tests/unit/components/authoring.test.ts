/**
 * Authoring helpers: version bumps, laying out the next version under a
 * host-managed root (copying the whole component there first), the
 * refusals that keep the seed root and `current` untouched, and the
 * read-side helpers the tools build on.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  bumpVersion,
  describeComponent,
  listComponentVersions,
  planComponentVersion,
  planNewComponent,
  readComponentVersion,
} from "../../../src/components/authoring.js";
import { parseComponentManifest } from "../../../src/components/manifest.js";
import {
  PASSING_CONTRACT,
  SERVICE_ENTRY,
  TOOLS_ENTRY,
  makeRoot,
  removeRoot,
  writeComponent,
} from "./fixtures.js";

describe("bumpVersion", () => {
  it("bumps patch, minor and major", () => {
    expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(bumpVersion("0.1.0", "minor")).toBe("0.2.0");
    expect(bumpVersion("0.1.0", "major")).toBe("1.0.0");
  });

  it("returns null for an invalid version or bump", () => {
    expect(bumpVersion("not-a-version", "patch")).toBeNull();
    expect(bumpVersion("0.1.0", "huge" as never)).toBeNull();
  });
});

describe("planComponentVersion", () => {
  let seed: string;
  let host: string;

  const plan = (overrides: Record<string, unknown> = {}) =>
    planComponentVersion({
      name: "hello",
      roots: [host, seed].filter(existsSync),
      authoringRoot: host,
      seedRoot: seed,
      need: "print louder",
      producedBy: "agent-1",
      ...overrides,
    });

  beforeEach(() => {
    seed = makeRoot("seed-");
    host = path.join(makeRoot("host-"), "components");
    writeComponent(seed, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      currentFile: true,
      manifest: { depth: 0, lineage: { producedBy: "seed" } },
    });
  });

  afterEach(() => {
    removeRoot(seed);
    removeRoot(path.dirname(host));
  });

  it("copies the whole component into the host root and adds the next version", () => {
    expect(existsSync(host)).toBe(false);
    const result = plan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { plan: planned } = result;
    expect(planned).toMatchObject({
      name: "hello",
      root: host,
      previousVersion: "0.1.0",
      nextVersion: "0.1.1",
      copied: true,
    });
    expect(planned.versionDir).toBe(path.join(host, "hello", ".versions", "0.1.1"));
    expect(planned.entryPath).toBe(path.join(planned.versionDir, "entry.ts"));
    expect(planned.contractPath).toBe(path.join(planned.versionDir, "contract.ts"));

    // The previous version and its pointer travelled with the copy.
    expect(existsSync(path.join(host, "hello", ".versions", "0.1.0", "entry.ts"))).toBe(true);
    expect(readFileSync(path.join(host, "hello", "current"), "utf-8").trim()).toBe("0.1.0");

    // The candidate is a copy of the previous version with a rewritten manifest.
    expect(readFileSync(planned.entryPath, "utf-8")).toBe(SERVICE_ENTRY);
    expect(readFileSync(planned.contractPath, "utf-8")).toBe(PASSING_CONTRACT);
    const manifest = JSON.parse(readFileSync(planned.manifestPath, "utf-8"));
    expect(manifest).toMatchObject({
      name: "hello",
      version: "0.1.1",
      kind: "service",
      depth: 0,
      lineage: { parent: "hello@0.1.0", need: "print louder", producedBy: "agent-1" },
    });
    expect(manifest.intent).toBe("A test component.");

    // The seed root is untouched.
    expect(existsSync(path.join(seed, "hello", ".versions", "0.1.1"))).toBe(false);
    expect(readFileSync(path.join(seed, "hello", "current"), "utf-8").trim()).toBe("0.1.0");
  });

  it("reuses an existing host copy on a second plan and never rewrites current", () => {
    const first = plan();
    expect(first.ok).toBe(true);
    const second = plan({ bump: "minor" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.plan).toMatchObject({
      previousVersion: "0.1.0",
      nextVersion: "0.2.0",
      copied: false,
    });
    expect(readFileSync(path.join(host, "hello", "current"), "utf-8").trim()).toBe("0.1.0");
    expect(listComponentVersions(path.join(host, "hello"))).toEqual([
      "0.1.0",
      "0.1.1",
      "0.2.0",
    ]);
  });

  it("derives the next version from the host copy's current when it wins", () => {
    // A host copy whose current already names a later version.
    writeComponent(host, "hello", "0.3.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      currentFile: true,
    });
    const result = plan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ previousVersion: "0.3.0", nextVersion: "0.3.1" });
  });

  it("copies a link-form current as a link", () => {
    const linked = makeRoot("linked-");
    try {
      writeComponent(linked, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        contract: PASSING_CONTRACT,
      });
      const result = plan({ roots: [linked] });
      expect(result.ok).toBe(true);
      expect(lstatSync(path.join(host, "hello", "current")).isSymbolicLink()).toBe(true);
    } finally {
      removeRoot(linked);
    }
  });

  it("skips scratch directories when copying", () => {
    const scratch = path.join(seed, "hello", ".versions", "0.1.0", ".code-workspace", "t1");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(path.join(scratch, "junk.txt"), "x");
    const result = plan();
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(host, "hello", ".versions", "0.1.0", ".code-workspace"))).toBe(false);
    expect(existsSync(path.join(host, "hello", ".versions", "0.1.1", ".code-workspace"))).toBe(false);
  });

  it("refuses when no authoring root is configured", () => {
    const result = plan({ authoringRoot: undefined });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toMatch(/SIA_COMPONENTS_DIR/);
    expect(existsSync(host)).toBe(false);
  });

  it("refuses to author under the seed root", () => {
    const result = plan({ authoringRoot: seed });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toMatch(/seed root/);
    expect(existsSync(path.join(seed, "hello", ".versions", "0.1.1"))).toBe(false);
  });

  it("refuses when the seed root is reached through a link", () => {
    const link = path.join(path.dirname(host), "seed-link");
    symlinkSync(seed, link, "dir");
    const result = plan({ authoringRoot: link });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toMatch(/seed root/);
  });

  it("refuses an unknown component", () => {
    const result = plan({ name: "nope" });
    expect(result).toMatchObject({ ok: false, reason: 'unknown component "nope"' });
  });

  it("numbers past candidates already waiting under the host copy", () => {
    // current stays 0.1.0 while 0.1.1 waits for activation: the next patch
    // is 0.1.2, and the parent is still the version the code came from.
    expect(plan()).toMatchObject({ ok: true, plan: { nextVersion: "0.1.1" } });
    const again = plan();
    expect(again).toMatchObject({
      ok: true,
      plan: { previousVersion: "0.1.0", nextVersion: "0.1.2", copied: false },
    });
    if (!again.ok) return;
    const manifest = JSON.parse(readFileSync(again.plan.manifestPath, "utf-8"));
    expect(manifest.lineage.parent).toBe("hello@0.1.0");
    expect(readFileSync(path.join(host, "hello", "current"), "utf-8").trim()).toBe("0.1.0");
    expect(listComponentVersions(path.join(host, "hello"))).toEqual(["0.1.0", "0.1.1", "0.1.2"]);
  });

  it("does not number below the current version when older candidates are present", () => {
    // A host copy carrying an old leftover (0.0.9) and a current of 0.1.0.
    writeComponent(host, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      currentFile: true,
    });
    writeComponent(host, "hello", "0.0.9", { entry: SERVICE_ENTRY, current: false });
    expect(plan()).toMatchObject({ ok: true, plan: { previousVersion: "0.1.0", nextVersion: "0.1.1" } });
  });

  it("refuses invalid and traversing names before touching the filesystem", () => {
    for (const name of ["../etc", "Hello", "a/b", "", "."]) {
      const result = plan({ name });
      expect(result).toMatchObject({ ok: false });
      if (result.ok) return;
      expect(result.reason).toMatch(/invalid component name/);
    }
    expect(existsSync(host)).toBe(false);
  });

  it("refuses an invalid bump and an empty need", () => {
    expect(plan({ bump: "enormous" })).toMatchObject({ ok: false });
    expect(plan({ need: "   " })).toMatchObject({ ok: false });
  });

  it("refuses when current is dangling", () => {
    rmSync(path.join(seed, "hello", ".versions", "0.1.0"), { recursive: true });
    const result = plan();
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toMatch(/dangling/);
  });
});

describe("describeComponent", () => {
  let seed: string;
  let host: string;

  beforeEach(() => {
    seed = makeRoot("seed-");
    host = makeRoot("host-");
  });

  afterEach(() => {
    removeRoot(seed);
    removeRoot(host);
  });

  it("reports the winning root, the shadowed roots, the versions and the paths", () => {
    writeComponent(seed, "hello", "0.1.0", { entry: SERVICE_ENTRY, currentFile: true });
    writeComponent(host, "hello", "0.1.0", { entry: SERVICE_ENTRY, currentFile: true });
    writeComponent(host, "hello", "0.1.1", { entry: SERVICE_ENTRY, current: false });

    const result = describeComponent({ name: "hello", roots: [host, seed] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.description).toMatchObject({
      name: "hello",
      root: host,
      shadowedRoots: [seed],
      componentDir: path.join(host, "hello"),
      currentVersion: "0.1.0",
      versions: ["0.1.0", "0.1.1"],
      entryPath: path.join(host, "hello", ".versions", "0.1.0", "entry.ts"),
      contractPath: path.join(host, "hello", ".versions", "0.1.0", "contract.ts"),
    });
    expect(result.description.manifest.intent).toBe("A test component.");
  });

  it("reports an unusable component with the loader's reason", () => {
    writeComponent(seed, "hello", "0.1.0", { entry: SERVICE_ENTRY, current: false });
    const result = describeComponent({ name: "hello", roots: [seed] });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toMatch(/no "current" pointer/);
  });

  it("lists the staged versions of a component that has no current yet, and how one runs", () => {
    writeComponent(host, "waiting", "0.1.0", { entry: TOOLS_ENTRY, current: false });
    writeComponent(host, "waiting", "0.1.1", { entry: TOOLS_ENTRY, current: false });
    const result = describeComponent({ name: "waiting", roots: [host, seed] });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toMatch(/no "current" pointer/);
    expect(result.reason).toContain("versions present: 0.1.0, 0.1.1");
    expect(result.reason).toContain("run_component_contract");
    expect(result.reason).toMatch(/becomes current only when the host activates it/);
  });

  it("refuses an unknown or invalid name", () => {
    expect(describeComponent({ name: "nope", roots: [seed] })).toMatchObject({
      ok: false,
      reason: 'unknown component "nope"',
    });
    expect(describeComponent({ name: "../x", roots: [seed] })).toMatchObject({ ok: false });
  });
});

describe("planNewComponent", () => {
  let seed: string;
  let host: string;

  const plan = (overrides: Record<string, unknown> = {}) =>
    planNewComponent({
      name: "parse-time-expression",
      roots: [host, seed].filter(existsSync),
      authoringRoot: host,
      seedRoot: seed,
      intent: "Turn phrases like '4 days from now' into ISO 8601 timestamps.",
      need: "what is 4 days from now",
      producedBy: "agent-1",
      ...overrides,
    });

  beforeEach(() => {
    seed = makeRoot("seed-");
    host = makeRoot("host-");
    writeComponent(seed, "hello", "0.1.0", { entry: SERVICE_ENTRY, currentFile: true });
  });

  afterEach(() => {
    removeRoot(seed);
    removeRoot(host);
  });

  it("lays out 0.1.0 under the host root as a runnable stub and never writes current", () => {
    const result = plan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const componentDir = path.join(host, "parse-time-expression");
    const versionDir = path.join(componentDir, ".versions", "0.1.0");
    expect(result.plan).toEqual({
      name: "parse-time-expression",
      root: host,
      version: "0.1.0",
      toolName: "parse_time_expression",
      componentDir,
      versionDir,
      manifestPath: path.join(versionDir, "component.json"),
      entryPath: path.join(versionDir, "entry.ts"),
      contractPath: path.join(versionDir, "contract.ts"),
      previousVersions: [],
    });
    expect(existsSync(path.join(componentDir, "current"))).toBe(false);
    expect(existsSync(path.join(seed, "parse-time-expression"))).toBe(false);

    const raw = JSON.parse(readFileSync(result.plan.manifestPath, "utf-8"));
    const parsed = parseComponentManifest(raw, {
      dirName: "parse-time-expression",
      versionDirName: "0.1.0",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest).toMatchObject({
      name: "parse-time-expression",
      version: "0.1.0",
      kind: "tools",
      depth: 0,
      intent: "Turn phrases like '4 days from now' into ISO 8601 timestamps.",
      lineage: { need: "what is 4 days from now", producedBy: "agent-1" },
    });
    expect(parsed.manifest.lineage.parent).toBeUndefined();
    expect(raw.lineage).not.toHaveProperty("parent");

    expect(readFileSync(result.plan.entryPath, "utf-8")).toContain('name: "parse_time_expression"');
    expect(readFileSync(result.plan.contractPath, "utf-8")).toContain(
      'deps.invoke("parse_time_expression"',
    );
  });

  it("takes an explicit tool name and description, trimmed", () => {
    const result = plan({ toolName: " when_is ", description: " Resolve a phrase to a time. " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.toolName).toBe("when_is");
    const entry = readFileSync(result.plan.entryPath, "utf-8");
    expect(entry).toContain('name: "when_is"');
    expect(entry).toContain('"Resolve a phrase to a time."');
  });

  it("refuses when no authoring root is configured", () => {
    const result = plan({ authoringRoot: undefined });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toMatch(/no host-managed component root is configured/);
    expect(existsSync(path.join(host, "parse-time-expression"))).toBe(false);
  });

  it("refuses to author under the seed root, directly and through a link", () => {
    expect(plan({ authoringRoot: seed })).toMatchObject({ ok: false });
    const link = path.join(makeRoot("link-"), "seed-link");
    symlinkSync(seed, link, "dir");
    try {
      const result = plan({ authoringRoot: link });
      expect(result).toMatchObject({ ok: false });
      if (result.ok) return;
      expect(result.reason).toMatch(/seed root/);
    } finally {
      removeRoot(path.dirname(link));
    }
    expect(existsSync(path.join(seed, "parse-time-expression"))).toBe(false);
  });

  it("refuses a name the seed root ships, whatever its lineage state elsewhere", () => {
    const result = plan({ name: "hello" });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain('component "hello" ships with the source tree');
    expect(result.reason).toContain("it cannot be created again");
    expect(result.reason).toContain("prepare_component_version");
  });

  it("refuses a name any root currently resolves a live version for", () => {
    writeComponent(host, "running", "0.1.0", { entry: TOOLS_ENTRY, currentFile: true });
    const result = plan({ name: "running" });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain(`component "running" already exists under ${host}`);
    expect(result.reason).toContain("versions present: 0.1.0");
    expect(result.reason).toContain("prepare_component_version");
    expect(result.reason).toContain("run_component_contract");
  });

  it("re-creates over a version staged but never made current — one minor above the highest, no parent", () => {
    writeComponent(host, "waiting", "0.1.0", { entry: TOOLS_ENTRY, current: false });
    const result = plan({ name: "waiting" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.plan.version).toBe("0.2.0");
    expect(result.plan.previousVersions).toEqual(["0.1.0"]);
    expect(existsSync(path.join(host, "waiting", ".versions", "0.2.0"))).toBe(true);
    // The host removed it, not the agent — nothing on disk still calls 0.1.0 a parent.
    const raw = JSON.parse(readFileSync(result.plan.manifestPath, "utf-8")) as Record<string, unknown>;
    expect(raw.lineage).not.toHaveProperty("parent");
  });

  it("bumps to the next minor above the highest staged version, not a patch above it", () => {
    writeComponent(host, "waiting", "0.1.3", { entry: TOOLS_ENTRY, current: false });
    const result = plan({ name: "waiting" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.plan.version).toBe("0.2.0");
    expect(result.plan.previousVersions).toEqual(["0.1.3"]);
  });

  it("refuses a tool name that is already taken", () => {
    const result = plan({
      toolName: "read_file",
      reservedToolNames: new Set(["read_file", "execute_code"]),
    });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toMatch(/tool name "read_file" is already taken/);
    expect(existsSync(path.join(host, "parse-time-expression"))).toBe(false);

    const byDefault = plan({
      name: "read-file",
      reservedToolNames: new Set(["read_file"]),
    });
    expect(byDefault).toMatchObject({ ok: false });
  });

  it("refuses invalid names, an invalid tool name, and empty intent or need", () => {
    expect(plan({ name: "../x" })).toMatchObject({ ok: false, reason: 'invalid component name "../x"' });
    expect(plan({ name: "Parse" })).toMatchObject({ ok: false });
    expect(plan({ toolName: "Parse-Time" })).toMatchObject({ ok: false });
    const noIntent = plan({ intent: "  " });
    expect(noIntent).toMatchObject({ ok: false });
    if (!noIntent.ok) expect(noIntent.reason).toMatch(/intent/);
    const noNeed = plan({ need: "" });
    expect(noNeed).toMatchObject({ ok: false });
    if (!noNeed.ok) expect(noNeed.reason).toMatch(/need/);
    expect(plan({ producedBy: "" })).toMatchObject({ ok: false });
    expect(existsSync(path.join(host, "parse-time-expression"))).toBe(false);
  });
});

describe("readComponentVersion", () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    removeRoot(root);
  });

  it("reads a version that current does not point at", () => {
    writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY, currentFile: true });
    writeComponent(root, "hello", "0.1.1", {
      entry: SERVICE_ENTRY,
      current: false,
      manifest: { lineage: { parent: "hello@0.1.0", producedBy: "agent-1" } },
    });
    const result = readComponentVersion({ name: "hello", version: "0.1.1", roots: [root] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.component.manifest).toMatchObject({
      version: "0.1.1",
      lineage: { parent: "hello@0.1.0" },
    });
    expect(result.component.versionDir).toBe(path.join(root, "hello", ".versions", "0.1.1"));
  });

  it("fails for a missing version, an invalid version and an unknown name", () => {
    writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    expect(
      readComponentVersion({ name: "hello", version: "9.9.9", roots: [root] }),
    ).toMatchObject({ ok: false, reason: 'version "9.9.9" of "hello" not found' });
    expect(
      readComponentVersion({ name: "hello", version: "../x", roots: [root] }),
    ).toMatchObject({ ok: false, reason: 'invalid version "../x"' });
    expect(
      readComponentVersion({ name: "nope", version: "0.1.0", roots: [root] }),
    ).toMatchObject({ ok: false, reason: 'unknown component "nope"' });
  });
});
