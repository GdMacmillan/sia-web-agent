/**
 * Backend protocol v2 — new-shape tests.
 *
 * Exercises the protocol-v2 additions directly against the Result types
 * (rather than through the v1-compat helpers used by the legacy suites):
 * - structured {files}/{matches}/{content}/{error} results
 * - the multimodal (binary) read path (Uint8Array + mimeType)
 * - delete() on FilesystemBackend and StateBackend
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { FilesystemBackend } from "../../../src/backends/filesystem.js";
import { StateBackend } from "../../../src/backends/state.js";

describe("BackendProtocol v2 result shapes (FilesystemBackend)", () => {
  let testDir: string;
  let backend: FilesystemBackend;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-v2-test-"));
    backend = new FilesystemBackend({ rootDir: testDir, virtualMode: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("read", () => {
    it("returns { content, mimeType } for a text file", async () => {
      await backend.write("/hello.txt", "hi there");
      const result = await backend.read("/hello.txt");
      expect(result.error).toBeUndefined();
      expect(typeof result.content).toBe("string");
      expect(result.content).toContain("hi there");
      expect(result.mimeType).toBe("text/plain");
    });

    it("returns { error } for a missing file", async () => {
      const result = await backend.read("/nope.txt");
      expect(result.error).toBeDefined();
      expect(result.content).toBeUndefined();
    });

    it("returns raw bytes + mimeType for a binary file (multimodal path)", async () => {
      // A minimal PNG header written straight to disk.
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await fs.writeFile(path.join(testDir, "pixel.png"), bytes);

      const result = await backend.read("/pixel.png");
      expect(result.error).toBeUndefined();
      expect(result.mimeType).toBe("image/png");
      expect(result.content).toBeInstanceOf(Uint8Array);
      expect((result.content as Uint8Array).byteLength).toBe(bytes.byteLength);
    });
  });

  describe("ls / glob / grep result shapes", () => {
    it("ls returns { files }", async () => {
      await backend.write("/a.txt", "a");
      const result = await backend.ls("/");
      expect(result.error).toBeUndefined();
      expect(Array.isArray(result.files)).toBe(true);
      expect(result.files!.some((f) => f.path.endsWith("a.txt"))).toBe(true);
    });

    it("glob returns { files }", async () => {
      await backend.write("/x.ts", "export const x = 1");
      const result = await backend.glob("**/*.ts");
      expect(result.error).toBeUndefined();
      expect(result.files!.some((f) => f.path.endsWith("x.ts"))).toBe(true);
    });

    it("grep returns { matches }", async () => {
      await backend.write("/s.txt", "needle here");
      const result = await backend.grep("needle", "/");
      expect(result.error).toBeUndefined();
      expect(result.matches!.length).toBeGreaterThan(0);
      expect(result.matches![0].text).toContain("needle");
    });

    it("grep returns { error } for an invalid regex", async () => {
      const result = await backend.grep("(a+)+", "/");
      expect(result.error).toBeDefined();
      expect(result.matches).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("deletes an existing file and returns { path }", async () => {
      await backend.write("/gone.txt", "bye");
      const result = await backend.delete("/gone.txt");
      expect(result.error).toBeUndefined();
      expect(result.path).toBe("/gone.txt");
      // File is actually gone.
      const read = await backend.read("/gone.txt");
      expect(read.error).toBeDefined();
    });

    it("returns { error } deleting a missing file", async () => {
      const result = await backend.delete("/absent.txt");
      expect(result.error).toBeDefined();
      expect(result.path).toBeUndefined();
    });

    it("refuses to delete a directory", async () => {
      await fs.mkdir(path.join(testDir, "adir"));
      const result = await backend.delete("/adir");
      expect(result.error).toContain("directory");
    });
  });
});

describe("BackendProtocol v2 result shapes (StateBackend)", () => {
  it("read returns { error } for a missing file", async () => {
    const backend = new StateBackend({ state: { files: {} } });
    const result = await backend.read("/missing.txt");
    expect(result.error).toBeDefined();
  });

  it("delete validates existence", async () => {
    const backend = new StateBackend({
      state: {
        files: {
          "/present.txt": {
            content: ["hi"],
            created_at: new Date().toISOString(),
            modified_at: new Date().toISOString(),
          },
        },
      },
    });
    expect((await backend.delete("/present.txt")).path).toBe("/present.txt");
    expect((await backend.delete("/absent.txt")).error).toBeDefined();
  });
});
