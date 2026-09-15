/**
 * The active component set: manifests are live (re-read each turn), the
 * loaded code is not.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discoverComponents } from "../../../src/components/discovery.js";
import {
  _resetComponentsForTests,
  COMPONENTS_MIDDLEWARE_NAME,
  createComponentsMiddleware,
  getActiveComponents,
  getActiveToolPool,
  refreshActiveManifests,
  setActiveComponents,
  setActiveToolPool,
} from "../../../src/components/registry.js";
import {
  SERVICE_ENTRY,
  baseManifest,
  makeRoot,
  removeRoot,
  writeComponent,
} from "./fixtures.js";

describe("component registry", () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    _resetComponentsForTests();
    removeRoot(root);
  });

  function activate(): void {
    const { found } = discoverComponents([root]);
    setActiveComponents({ components: found, roots: [root], services: { x: 1 } });
  }

  it("starts empty and resets", () => {
    expect(getActiveComponents()).toEqual({ components: [], roots: [], services: {} });
    setActiveToolPool([{ name: "t", invoke: async () => "" } as any]);
    expect(getActiveToolPool().map((t) => t.name)).toEqual(["t"]);
    _resetComponentsForTests();
    expect(getActiveToolPool()).toEqual([]);
  });

  it("records loaded components with their loaded version and paths", () => {
    const f = writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    activate();
    const [active] = getActiveComponents().components;
    expect(active.manifest.name).toBe("hello");
    expect(active.loadedVersion).toBe("0.1.0");
    expect(active.versionDir).toBe(f.versionDir);
    expect(active.entryPath).toBe(f.entryPath);
    expect(getActiveComponents().roots).toEqual([root]);
    expect(getActiveComponents().services).toEqual({ x: 1 });
  });

  it("refreshes manifest fields from disk without touching the loaded code", () => {
    const f = writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    activate();

    writeFileSync(
      f.manifestPath,
      JSON.stringify(
        baseManifest("hello", "0.1.0", { intent: "Rewritten.", depth: 2 }),
      ),
    );
    refreshActiveManifests();

    const [active] = getActiveComponents().components;
    expect(active.manifest.intent).toBe("Rewritten.");
    expect(active.manifest.depth).toBe(2);
    expect(active.loadedVersion).toBe("0.1.0");
    expect(active.versionDir).toBe(f.versionDir);
  });

  it("describes a flipped pointer immediately while the loaded version stays", () => {
    const first = writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    writeComponent(root, "hello", "0.2.0", {
      entry: SERVICE_ENTRY,
      current: false,
      manifest: { intent: "The next version." },
    });
    activate();

    unlinkSync(path.join(first.componentDir, "current"));
    symlinkSync(
      path.join(".versions", "0.2.0"),
      path.join(first.componentDir, "current"),
      "dir",
    );
    refreshActiveManifests();

    const [active] = getActiveComponents().components;
    expect(active.manifest.version).toBe("0.2.0");
    expect(active.manifest.intent).toBe("The next version.");
    expect(active.loadedVersion).toBe("0.1.0");
    expect(active.versionDir).toBe(first.versionDir);
  });

  it("keeps the last good manifest when the refreshed one is invalid", () => {
    const f = writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    activate();
    writeFileSync(f.manifestPath, "{ broken");
    refreshActiveManifests();
    expect(getActiveComponents().components[0].manifest.intent).toBe(
      "A test component.",
    );
  });

  it("refreshes through the componentsMiddleware beforeAgent hook", async () => {
    const f = writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    activate();
    writeFileSync(
      f.manifestPath,
      JSON.stringify(baseManifest("hello", "0.1.0", { intent: "Via hook." })),
    );

    const middleware = createComponentsMiddleware() as {
      name: string;
      beforeAgent?: (state: unknown, runtime: unknown) => unknown;
    };
    expect(middleware.name).toBe(COMPONENTS_MIDDLEWARE_NAME);
    const result = await middleware.beforeAgent?.({}, {});
    expect(result).toBeUndefined();
    expect(getActiveComponents().components[0].manifest.intent).toBe("Via hook.");
  });

  it("is a no-op with no active components", () => {
    expect(() => refreshActiveManifests()).not.toThrow();
  });
});
