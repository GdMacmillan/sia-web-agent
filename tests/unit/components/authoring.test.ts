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
  readComponentVersion,
} from "../../../src/components/authoring.js";
import {
  PASSING_CONTRACT,
  SERVICE_ENTRY,
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

  it("refuses when the next version already exists", () => {
    expect(plan().ok).toBe(true);
    const again = plan();
    expect(again).toMatchObject({ ok: false });
    if (again.ok) return;
    expect(again.reason).toMatch(/already exists/);
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

  it("refuses an unknown or invalid name", () => {
    expect(describeComponent({ name: "nope", roots: [seed] })).toMatchObject({
      ok: false,
      reason: 'unknown component "nope"',
    });
    expect(describeComponent({ name: "../x", roots: [seed] })).toMatchObject({ ok: false });
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
