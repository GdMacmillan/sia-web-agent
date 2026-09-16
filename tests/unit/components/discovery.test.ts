/**
 * Component discovery: layout, precedence and containment.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { discoverComponents } from "../../../src/components/discovery.js";
import {
  makeRoot,
  removeRoot,
  writeComponent,
  baseManifest,
  SERVICE_ENTRY,
} from "./fixtures.js";

describe("discoverComponents", () => {
  let root: string;
  let other: string;

  beforeEach(() => {
    root = makeRoot();
    other = makeRoot("components-other-");
  });

  afterEach(() => {
    removeRoot(root);
    removeRoot(other);
  });

  it("lists the current version of each component", () => {
    writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    const { found, skipped } = discoverComponents([root]);
    expect(skipped).toEqual([]);
    expect(found).toHaveLength(1);
    const [c] = found;
    expect(c.manifest.name).toBe("hello");
    expect(c.manifest.version).toBe("0.1.0");
    expect(c.versionDir).toBe(
      realpathSync(path.join(root, "hello", ".versions", "0.1.0")),
    );
    expect(c.entryPath).toBe(path.join(c.versionDir, "entry.ts"));
    expect(c.contractPath).toBe(path.join(c.versionDir, "contract.ts"));
  });

  it("returns nothing for a missing root", () => {
    const result = discoverComponents([path.join(root, "does-not-exist")]);
    expect(result.found).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("skips a component with no current pointer", () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      current: false,
    });
    const { found, skipped } = discoverComponents([root]);
    expect(found).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/no "current" pointer/);
  });

  it("skips a dangling current pointer", () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      currentTarget: path.join(".versions", "9.9.9"),
    });
    const { found, skipped } = discoverComponents([root]);
    expect(found).toEqual([]);
    expect(skipped[0].reason).toMatch(/dangling/);
  });

  it("skips a symlinked current that escapes the root", () => {
    // A real version directory elsewhere, pointed at from inside the root.
    const outside = path.join(other, "hello", ".versions", "0.1.0");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      path.join(outside, "component.json"),
      JSON.stringify(baseManifest("hello", "0.1.0")),
    );
    writeFileSync(path.join(outside, "entry.ts"), SERVICE_ENTRY);

    mkdirSync(path.join(root, "hello"), { recursive: true });
    symlinkSync(outside, path.join(root, "hello", "current"), "dir");

    const { found, skipped } = discoverComponents([root]);
    expect(found).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/outside the component root/);
  });

  it("skips a current that points outside .versions", () => {
    writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY, current: false });
    const stray = path.join(root, "hello", "stray");
    mkdirSync(stray);
    writeFileSync(
      path.join(stray, "component.json"),
      JSON.stringify(baseManifest("hello", "stray")),
    );
    symlinkSync("stray", path.join(root, "hello", "current"), "dir");
    const { found, skipped } = discoverComponents([root]);
    expect(found).toEqual([]);
    expect(skipped[0].reason).toMatch(/inside ".versions"/);
  });

  describe("current as a one-line file", () => {
    it("accepts a regular file naming the version directory", () => {
      writeComponent(root, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        currentFile: true,
      });
      const { found, skipped } = discoverComponents([root]);
      expect(skipped).toEqual([]);
      expect(found).toHaveLength(1);
      expect(found[0].manifest.version).toBe("0.1.0");
      expect(found[0].versionDir).toBe(
        realpathSync(path.join(root, "hello", ".versions", "0.1.0")),
      );
    });

    it("tolerates surrounding whitespace in the file", () => {
      writeComponent(root, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        currentFile: true,
        currentText: "  0.1.0 \r\n",
      });
      const { found, skipped } = discoverComponents([root]);
      expect(skipped).toEqual([]);
      expect(found).toHaveLength(1);
    });

    it("skips a file whose content is not a version name", () => {
      writeComponent(root, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        currentFile: true,
        currentText: "0.1.0 or maybe 0.2.0\n",
      });
      const { found, skipped } = discoverComponents([root]);
      expect(found).toEqual([]);
      expect(skipped[0].reason).toMatch(/"current" file must name a version/);
    });

    it("skips an empty file", () => {
      writeComponent(root, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        currentFile: true,
        currentText: "\n",
      });
      const { found, skipped } = discoverComponents([root]);
      expect(found).toEqual([]);
      expect(skipped[0].reason).toMatch(/"current" file must name a version/);
    });

    it("skips a file that attempts path traversal", () => {
      for (const text of ["../../other", "..", ".", "a/b"]) {
        const dir = makeRoot("components-trav-");
        writeComponent(dir, "hello", "0.1.0", {
          entry: SERVICE_ENTRY,
          currentFile: true,
          currentText: `${text}\n`,
        });
        const { found, skipped } = discoverComponents([dir]);
        expect(found).toEqual([]);
        expect(skipped).toHaveLength(1);
        expect(skipped[0].reason).toMatch(/"current" file must name a version/);
        removeRoot(dir);
      }
    });

    it("skips a file naming a version that does not exist", () => {
      writeComponent(root, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        currentFile: true,
        currentText: "9.9.9\n",
      });
      const { found, skipped } = discoverComponents([root]);
      expect(found).toEqual([]);
      expect(skipped[0].reason).toMatch(/dangling/);
    });
  });

  it("skips a manifest that is not valid JSON, with the reason", () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      manifestText: "{ not json",
    });
    const { found, skipped } = discoverComponents([root]);
    expect(found).toEqual([]);
    expect(skipped[0].reason).toMatch(/not valid JSON/);
  });

  it("skips a manifest over 10 MB", () => {
    const padding = "x".repeat(10 * 1024 * 1024 + 1);
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      manifestText: JSON.stringify(
        baseManifest("hello", "0.1.0", { intent: padding }),
      ),
    });
    const { found, skipped } = discoverComponents([root]);
    expect(found).toEqual([]);
    expect(skipped[0].reason).toMatch(/too large/);
  });

  it("skips a component whose entry file is missing", () => {
    writeComponent(root, "hello", "0.1.0");
    const { found, skipped } = discoverComponents([root]);
    expect(found).toEqual([]);
    expect(skipped[0].reason).toMatch(/entry not found/);
  });

  it("skips a manifest whose name does not match its directory", () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      manifest: { name: "other" },
    });
    const { skipped } = discoverComponents([root]);
    expect(skipped[0].reason).toMatch(/does not match directory name/);
  });

  it("ignores hidden directories and plain files", () => {
    mkdirSync(path.join(root, ".hidden"));
    writeFileSync(path.join(root, "README.md"), "hi");
    writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    const { found, skipped } = discoverComponents([root]);
    expect(found.map((c) => c.manifest.name)).toEqual(["hello"]);
    expect(skipped).toEqual([]);
  });

  it("skips a directory whose name is not a valid component name", () => {
    mkdirSync(path.join(root, "Not_Valid"));
    const { found, skipped } = discoverComponents([root]);
    expect(found).toEqual([]);
    expect(skipped[0].name).toBe("Not_Valid");
  });

  it("lets the first root shadow the same name in a later root", () => {
    writeComponent(root, "hello", "0.2.0", { entry: SERVICE_ENTRY });
    writeComponent(other, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    writeComponent(other, "seed-only", "0.1.0", { entry: SERVICE_ENTRY });
    const { found, shadowed, skipped } = discoverComponents([root, other]);
    expect(skipped).toEqual([]);
    expect(found.map((c) => `${c.manifest.name}@${c.manifest.version}`)).toEqual(
      ["hello@0.2.0", "seed-only@0.1.0"],
    );
    expect(shadowed).toEqual([
      { name: "hello", root: path.resolve(other), shadowedBy: path.resolve(root) },
    ]);
  });

  it("carries the manifest profile when present", () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      manifest: { profile: { excludedTools: ["bash"] } },
    });
    const { found } = discoverComponents([root]);
    expect(found[0].profile?.excludedTools.has("bash")).toBe(true);
  });
});
