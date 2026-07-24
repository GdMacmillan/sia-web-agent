/**
 * Composite Backend Tests
 *
 * Tests that the CompositeBackend properly:
 * - Routes operations to different backends based on path prefix
 * - Handles prefix stripping and re-adding transparently
 * - Manages default and routed backends correctly
 * - Supports hybrid storage strategies (StateBackend + StoreBackend)
 * - Preserves data integrity across backends
 *
 * Aligned with deepagentsjs pattern at:
 * /projects/deepagentsjs/tests/unit/backends/composite.test.ts
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { CompositeBackend } from "../../../src/backends/composite.js";
import { StateBackend } from "../../../src/backends/state.js";
import { StoreBackend } from "../../../src/backends/store.js";
// eslint-disable-next-line import/no-extraneous-dependencies
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

// Mock getCurrentTaskInput from @langchain/langgraph
jest.mock("@langchain/langgraph", () => {
  const actual = jest.requireActual("@langchain/langgraph") as any;
  return {
    ...actual,
    getCurrentTaskInput: jest.fn(),
  };
});

import { getCurrentTaskInput } from "@langchain/langgraph";

/**
 * Helper to create a mock config with state and store
 */
function makeConfig() {
  const state = {
    messages: [],
    files: {},
  };
  const store = new InMemoryStore();

  // Mock getCurrentTaskInput to return our state
  (getCurrentTaskInput as jest.Mock).mockReturnValue(state);

  const stateAndStore = {
    state,
    store,
  };

  const config = {
    store,
    configurable: {},
  };

  return { state, store, stateAndStore, config };
}

describe("CompositeBackend", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should route operations between StateBackend and StoreBackend", async () => {
    const { state, stateAndStore } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(stateAndStore), {
      "/memories/": new StoreBackend(stateAndStore),
    });

    const stateRes = await composite.write("/file.txt", "alpha");
    expect(stateRes.filesUpdate).toBeDefined();
    expect(stateRes.path).toBe("/file.txt");
    if (stateRes.filesUpdate) {
      Object.assign(state.files, stateRes.filesUpdate);
    }

    const storeRes = await composite.write("/memories/readme.md", "beta");
    expect(storeRes.error).toBeUndefined();
    expect(storeRes.filesUpdate).toBeNull();

    const infos = (await composite.ls("/")).files ?? [];
    const paths = infos.map((i) => i.path);
    expect(paths).toContain("/file.txt");
    expect(paths).toContain("/memories/");

    const matches1 = (await composite.grep("alpha", "/")).matches;
    expect(Array.isArray(matches1)).toBe(true);
    if (matches1) {
      expect(matches1.some((m) => m.path === "/file.txt")).toBe(true);
    }

    const matches2 = (await composite.grep("beta", "/")).matches;
    expect(Array.isArray(matches2)).toBe(true);
    if (matches2) {
      expect(matches2.some((m) => m.path === "/memories/readme.md")).toBe(true);
    }

    const glob = (await composite.glob("**/*.md", "/")).files ?? [];
    expect(glob.some((i) => i.path === "/memories/readme.md")).toBe(true);
  });

  it("should handle multiple routes", async () => {
    const { state, stateAndStore } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(stateAndStore), {
      "/memories/": new StoreBackend(stateAndStore),
      "/archive/": new StoreBackend(stateAndStore),
      "/cache/": new StoreBackend(stateAndStore),
    });

    const resState = await composite.write("/temp.txt", "ephemeral data");
    expect(resState.filesUpdate).toBeDefined();
    expect(resState.path).toBe("/temp.txt");
    if (resState.filesUpdate) {
      Object.assign(state.files, resState.filesUpdate);
    }

    const resMem = await composite.write(
      "/memories/important.md",
      "long-term memory",
    );
    expect(resMem.filesUpdate).toBeNull();
    expect(resMem.path).toBe("/important.md");

    const resArch = await composite.write("/archive/old.log", "archived log");
    expect(resArch.filesUpdate).toBeNull();
    expect(resArch.path).toBe("/old.log");

    const resCache = await composite.write(
      "/cache/session.json",
      "cached session",
    );
    expect(resCache.filesUpdate).toBeNull();
    expect(resCache.path).toBe("/session.json");

    const infos = (await composite.ls("/")).files ?? [];
    const paths = infos.map((i) => i.path);
    expect(paths).toContain("/temp.txt");
    expect(paths).toContain("/memories/");
    expect(paths).toContain("/archive/");
    expect(paths).toContain("/cache/");

    const memInfos = (await composite.ls("/memories/")).files ?? [];
    const memPaths = memInfos.map((i) => i.path);
    expect(memPaths).toContain("/memories/important.md");
    expect(memPaths).not.toContain("/temp.txt");
    expect(memPaths).not.toContain("/archive/old.log");

    const allMatches = (await composite.grep(".", "/")).matches;
    expect(Array.isArray(allMatches)).toBe(true);
    if (allMatches) {
      const pathsWithContent = allMatches.map((m) => m.path);
      expect(pathsWithContent).toContain("/temp.txt");
      expect(pathsWithContent).toContain("/memories/important.md");
      expect(pathsWithContent).toContain("/archive/old.log");
      expect(pathsWithContent).toContain("/cache/session.json");
    }

    const globResults = (await composite.glob("**/*.md", "/")).files ?? [];
    expect(globResults.some((i) => i.path === "/memories/important.md")).toBe(
      true,
    );

    const editRes = await composite.edit(
      "/memories/important.md",
      "long-term",
      "persistent",
      false,
    );
    expect(editRes.error).toBeUndefined();
    expect(editRes.occurrences).toBe(1);

    const { content: updatedContent } = await composite.read(
      "/memories/important.md",
    );
    expect(updatedContent).toContain("persistent memory");
  });

  it("should handle nested directories correctly", async () => {
    const { state, stateAndStore } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(stateAndStore), {
      "/memories/": new StoreBackend(stateAndStore),
      "/archive/": new StoreBackend(stateAndStore),
    });

    const stateFiles: Record<string, string> = {
      "/temp.txt": "temp",
      "/work/file1.txt": "work file 1",
      "/work/projects/proj1.txt": "project 1",
    };

    for (const [path, content] of Object.entries(stateFiles)) {
      const res = await composite.write(path, content);
      if (res.filesUpdate) {
        Object.assign(state.files, res.filesUpdate);
      }
    }

    const memoryFiles: Record<string, string> = {
      "/memories/important.txt": "important",
      "/memories/diary/entry1.txt": "diary entry",
    };

    for (const [path, content] of Object.entries(memoryFiles)) {
      await composite.write(path, content);
    }

    const archiveFiles: Record<string, string> = {
      "/archive/old.txt": "old",
      "/archive/2023/log.txt": "2023 log",
    };

    for (const [path, content] of Object.entries(archiveFiles)) {
      await composite.write(path, content);
    }

    const rootListing = (await composite.ls("/")).files ?? [];
    const rootPaths = rootListing.map((fi) => fi.path);
    expect(rootPaths).toContain("/temp.txt");
    expect(rootPaths).toContain("/work/");
    expect(rootPaths).toContain("/memories/");
    expect(rootPaths).toContain("/archive/");
    expect(rootPaths).not.toContain("/work/file1.txt");
    expect(rootPaths).not.toContain("/memories/important.txt");

    const workListing = (await composite.ls("/work/")).files ?? [];
    const workPaths = workListing.map((fi) => fi.path);
    expect(workPaths).toContain("/work/file1.txt");
    expect(workPaths).toContain("/work/projects/");
    expect(workPaths).not.toContain("/work/projects/proj1.txt");

    const memListing = (await composite.ls("/memories/")).files ?? [];
    const memPaths = memListing.map((fi) => fi.path);
    expect(memPaths).toContain("/memories/important.txt");
    expect(memPaths).toContain("/memories/diary/");
    expect(memPaths).not.toContain("/memories/diary/entry1.txt");

    const archListing = (await composite.ls("/archive/")).files ?? [];
    const archPaths = archListing.map((fi) => fi.path);
    expect(archPaths).toContain("/archive/old.txt");
    expect(archPaths).toContain("/archive/2023/");
    expect(archPaths).not.toContain("/archive/2023/log.txt");
  });

  it("should handle trailing slashes in ls", async () => {
    const { state, stateAndStore } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(stateAndStore), {
      "/store/": new StoreBackend(stateAndStore),
    });

    const res = await composite.write("/file.txt", "content");
    if (res.filesUpdate) {
      Object.assign(state.files, res.filesUpdate);
    }

    await composite.write("/store/item.txt", "store content");

    const listing = (await composite.ls("/")).files ?? [];
    const paths = listing.map((fi) => fi.path);
    expect(paths).toEqual(paths.slice().sort());

    const emptyListing1 = (await composite.ls("/store/nonexistent/")).files ?? [];
    expect(emptyListing1).toEqual([]);

    const emptyListing2 = (await composite.ls("/nonexistent/")).files ?? [];
    expect(emptyListing2).toEqual([]);

    const listing1 = (await composite.ls("/store/")).files ?? [];
    const listing2 = (await composite.ls("/store")).files ?? [];
    expect(listing1.map((fi) => fi.path)).toEqual(
      listing2.map((fi) => fi.path),
    );
  });

  it("should work with StoreBackend as default and another StoreBackend route", async () => {
    const { stateAndStore } = makeConfig();

    const defaultStore = new StoreBackend(stateAndStore);
    const memoriesStore = new StoreBackend(stateAndStore);

    const composite = new CompositeBackend(defaultStore, {
      "/memories/": memoriesStore,
    });

    const res1 = await composite.write("/notes.txt", "default store content");
    expect(res1.error).toBeUndefined();
    expect(res1.path).toBe("/notes.txt");

    const res2 = await composite.write(
      "/memories/important.txt",
      "routed store content",
    );
    expect(res2.error).toBeUndefined();
    expect(res2.path).toBe("/important.txt");

    const { content: content1 } = await composite.read("/notes.txt");
    expect(content1).toContain("default store content");

    const { content: content2 } = await composite.read(
      "/memories/important.txt",
    );
    expect(content2).toContain("routed store content");

    const infos = (await composite.ls("/")).files ?? [];
    const paths = infos.map((i) => i.path);
    expect(paths).toContain("/notes.txt");
    expect(paths).toContain("/memories/");

    const matches1 = (await composite.grep("default", "/")).matches;
    expect(Array.isArray(matches1)).toBe(true);
    if (matches1) {
      expect(matches1.some((m) => m.path === "/notes.txt")).toBe(true);
    }

    const matches2 = (await composite.grep("routed", "/")).matches;
    expect(Array.isArray(matches2)).toBe(true);
    if (matches2) {
      expect(matches2.some((m) => m.path === "/memories/important.txt")).toBe(
        true,
      );
    }
  });
});
