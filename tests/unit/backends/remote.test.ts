/**
 * RemoteBackend Tests
 *
 * Tests the HTTP-based remote file access backend that proxies
 * file operations to a remote siad daemon.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import * as fsPromises from "fs/promises";
import { RemoteBackend } from "../../../src/backends/remote.js";

// Mock fs/promises
jest.mock("fs/promises", () => ({
  mkdir: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  writeFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));
const mockMkdir = fsPromises.mkdir as jest.MockedFunction<
  typeof fsPromises.mkdir
>;
const mockWriteFile = fsPromises.writeFile as jest.MockedFunction<
  typeof fsPromises.writeFile
>;

// Mock fetch globally
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as any).fetch = mockFetch;

describe("RemoteBackend", () => {
  let backend: RemoteBackend;

  beforeEach(() => {
    mockFetch.mockReset();
    mockMkdir.mockReset().mockResolvedValue(undefined);
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    backend = new RemoteBackend({
      baseUrl: "http://198.51.100.111:7700",
      nodeId: "sia-desktop-01",
    });
  });

  describe("read", () => {
    it("returns file content from remote siad", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "packages/agent/src/graph.ts",
          content: "     1\timport { foo } from 'bar';",
          lines_read: 1,
          offset: 0,
          limit: 2000,
          total_lines: 1,
        }),
      } as any);

      const result = await backend.read("/packages/agent/src/graph.ts");
      expect(result).toContain("import { foo }");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(calledUrl.pathname).toBe("/files/read");
      expect(calledUrl.searchParams.get("path")).toBe(
        "/packages/agent/src/graph.ts",
      );
    });

    it("returns error message on failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => '{"error":"not_found"}',
      } as any);

      const result = await backend.read("/nonexistent.txt");
      expect(result).toContain("Error reading remote file");
      expect(result).toContain("sia-desktop-01");
    });

    it("passes offset and limit parameters", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: "     5\tsome line",
          lines_read: 1,
        }),
      } as any);

      await backend.read("/file.ts", 4, 10);

      const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(calledUrl.searchParams.get("offset")).toBe("4");
      expect(calledUrl.searchParams.get("limit")).toBe("10");
    });
  });

  describe("lsInfo", () => {
    it("returns directory entries from remote siad", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "/",
          entries: [
            {
              name: "packages",
              path: "/packages/",
              is_dir: true,
              size: 0,
              modified_at: "2024-01-01T00:00:00Z",
            },
            {
              name: "README.md",
              path: "/README.md",
              is_dir: false,
              size: 1234,
              modified_at: "2024-01-01T00:00:00Z",
            },
          ],
        }),
      } as any);

      const result = await backend.lsInfo("/");
      expect(result).toHaveLength(2);
      expect(result[0].path).toBe("/packages/");
      expect(result[0].is_dir).toBe(true);
      expect(result[1].path).toBe("/README.md");
      expect(result[1].size).toBe(1234);
    });
  });

  describe("readRaw", () => {
    it("parses line-numbered content into FileData", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: "     1\tfirst line\n     2\tsecond line",
          path: "/file.txt",
        }),
      } as any);

      const result = await backend.readRaw("/file.txt");
      expect(result.content).toEqual(["first line", "second line"]);
      expect(result.created_at).toBeTruthy();
      expect(result.modified_at).toBeTruthy();
    });
  });

  describe("write", () => {
    it("creates a file via POST /files/write", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "/file.txt",
          modified_at: "2026-03-11T00:00:00Z",
        }),
      } as any);

      const result = await backend.write("/file.txt", "content");
      expect(result.path).toBe("/file.txt");
      expect(result.error).toBeUndefined();
      expect(result.filesUpdate).toBeNull();

      const [url, options] = mockFetch.mock.calls[0] as [string, any];
      expect(new URL(url).pathname).toBe("/files/write");
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body)).toEqual({
        path: "/file.txt",
        content: "content",
      });
    });

    it("returns error on failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () =>
          '{"error":"file_exists","message":"File already exists"}',
      } as any);

      const result = await backend.write("/file.txt", "content");
      expect(result.error).toContain("409");
      expect(result.filesUpdate).toBeNull();
    });
  });

  describe("edit", () => {
    it("edits a file via stat + POST /files/edit", async () => {
      // First call: stat
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          exists: true,
          modified_at: "2026-03-11T00:00:00Z",
        }),
      } as any);
      // Second call: edit
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "/file.txt",
          modified_at: "2026-03-11T00:00:01Z",
          occurrences: 1,
        }),
      } as any);

      const result = await backend.edit("/file.txt", "old", "new");
      expect(result.path).toBe("/file.txt");
      expect(result.occurrences).toBe(1);
      expect(result.error).toBeUndefined();

      // Verify stat call
      const statUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(statUrl.pathname).toBe("/files/stat");

      // Verify edit call
      const [editUrl, editOptions] = mockFetch.mock.calls[1] as [string, any];
      expect(new URL(editUrl).pathname).toBe("/files/edit");
      const editBody = JSON.parse(editOptions.body);
      expect(editBody.old_string).toBe("old");
      expect(editBody.new_string).toBe("new");
      expect(editBody.if_not_modified_since).toBe("2026-03-11T00:00:00Z");
    });

    it("returns error on failure", async () => {
      // stat succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          exists: true,
          modified_at: "2026-03-11T00:00:00Z",
        }),
      } as any);
      // edit fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () =>
          '{"error":"string_not_found","message":"old_string not found"}',
      } as any);

      const result = await backend.edit("/file.txt", "missing", "new");
      expect(result.error).toContain("422");
      expect(result.filesUpdate).toBeNull();
    });
  });

  describe("grepRaw", () => {
    it("returns matches from remote siad", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          matches: [{ path: "src/foo.ts", line: 42, text: "matching line" }],
          truncated: false,
        }),
      } as any);

      const result = await backend.grepRaw("pattern", "src", "*.ts");
      expect(result).toEqual([
        { path: "src/foo.ts", line: 42, text: "matching line" },
      ]);

      const [url, options] = mockFetch.mock.calls[0] as [string, any];
      expect(new URL(url).pathname).toBe("/files/grep");
      expect(options.method).toBe("POST");
      const body = JSON.parse(options.body);
      expect(body.pattern).toBe("pattern");
      expect(body.path).toBe("src");
      expect(body.glob).toBe("*.ts");
    });

    it("returns error string on failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_pattern"}',
      } as any);

      const result = await backend.grepRaw("[invalid");
      expect(typeof result).toBe("string");
      expect(result).toContain("Error searching remote files");
    });
  });

  describe("globInfo", () => {
    it("returns file info from remote siad", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          files: [
            {
              path: "src/foo.ts",
              is_dir: false,
              size: 1234,
              modified_at: "2026-03-12T00:00:00Z",
            },
          ],
          truncated: false,
        }),
      } as any);

      const result = await backend.globInfo("**/*.ts", "src");
      expect(result).toEqual([
        {
          path: "src/foo.ts",
          is_dir: false,
          size: 1234,
          modified_at: "2026-03-12T00:00:00Z",
        },
      ]);

      const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(calledUrl.pathname).toBe("/files/glob");
      expect(calledUrl.searchParams.get("pattern")).toBe("**/*.ts");
      expect(calledUrl.searchParams.get("path")).toBe("src");
    });

    it("throws on failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error":"missing_pattern"}',
      } as any);

      await expect(backend.globInfo("**/*.ts")).rejects.toThrow(
        "Failed to glob remote files",
      );
    });
  });

  describe("leader sync", () => {
    let syncBackend: RemoteBackend;

    beforeEach(() => {
      syncBackend = new RemoteBackend({
        baseUrl: "http://198.51.100.111:7700",
        nodeId: "sia-desktop-01",
        leaderSync: { projectRoot: "/home/leader/project" },
      });
    });

    it("write() syncs content to local filesystem", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "/src/foo.ts",
          modified_at: "2026-03-12T00:00:00Z",
        }),
      } as any);

      const result = await syncBackend.write("/src/foo.ts", "new content");
      expect(result.error).toBeUndefined();
      expect(mockMkdir).toHaveBeenCalledWith("/home/leader/project/src", {
        recursive: true,
      });
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/home/leader/project/src/foo.ts",
        "new content",
        "utf-8",
      );
    });

    it("edit() reads back and syncs", async () => {
      // stat
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          exists: true,
          modified_at: "2026-03-12T00:00:00Z",
        }),
      } as any);
      // edit
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "/src/foo.ts",
          modified_at: "2026-03-12T00:00:01Z",
          occurrences: 1,
        }),
      } as any);
      // readRaw (read back for sync)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: "     1\tline one\n     2\tline two",
          path: "/src/foo.ts",
        }),
      } as any);

      const result = await syncBackend.edit("/src/foo.ts", "old", "new");
      expect(result.error).toBeUndefined();
      expect(result.occurrences).toBe(1);
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/home/leader/project/src/foo.ts",
        "line one\nline two\n",
        "utf-8",
      );
    });

    it("sync failure does not fail the write", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "/src/foo.ts",
          modified_at: "2026-03-12T00:00:00Z",
        }),
      } as any);

      mockWriteFile.mockRejectedValueOnce(new Error("disk full"));

      const result = await syncBackend.write("/src/foo.ts", "content");
      expect(result.error).toBeUndefined();
      expect(result.path).toBe("/src/foo.ts");
    });

    it("no sync when leaderSync not configured", async () => {
      // Use the default backend (no leaderSync)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "/src/foo.ts",
          modified_at: "2026-03-12T00:00:00Z",
        }),
      } as any);

      await backend.write("/src/foo.ts", "content");
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("path traversal prevented", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "/../../../etc/passwd",
          modified_at: "2026-03-12T00:00:00Z",
        }),
      } as any);

      const result = await syncBackend.write(
        "/../../../etc/passwd",
        "malicious",
      );
      expect(result.error).toBeUndefined();
      // Should not have written outside project root
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe("caching", () => {
    let cachedBackend: RemoteBackend;

    const mockReadResponse = (content = "     1\tline one") =>
      ({
        ok: true,
        json: async () => ({ content, path: "/file.ts" }),
      }) as any;

    const mockGrepResponse = () =>
      ({
        ok: true,
        json: async () => ({
          matches: [{ path: "src/foo.ts", line: 1, text: "match" }],
          truncated: false,
        }),
      }) as any;

    const mockGlobResponse = () =>
      ({
        ok: true,
        json: async () => ({
          files: [
            {
              path: "src/foo.ts",
              is_dir: false,
              size: 100,
              modified_at: "2026-03-12T00:00:00Z",
            },
          ],
          truncated: false,
        }),
      }) as any;

    const mockLsResponse = () =>
      ({
        ok: true,
        json: async () => ({
          entries: [
            {
              path: "/src/",
              is_dir: true,
              size: 0,
              modified_at: "2026-03-12T00:00:00Z",
            },
          ],
        }),
      }) as any;

    beforeEach(() => {
      cachedBackend = new RemoteBackend({
        baseUrl: "http://198.51.100.111:7700",
        nodeId: "sia-desktop-01",
        cache: { ttlMs: 30_000 },
      });
    });

    it("read() returns cached result on second call", async () => {
      mockFetch.mockResolvedValueOnce(mockReadResponse());

      const r1 = await cachedBackend.read("/file.ts");
      const r2 = await cachedBackend.read("/file.ts");

      expect(r1).toBe(r2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("read() cache miss with different offset/limit", async () => {
      mockFetch
        .mockResolvedValueOnce(mockReadResponse("     1\tline one"))
        .mockResolvedValueOnce(mockReadResponse("     5\tline five"));

      await cachedBackend.read("/file.ts", 0, 2000);
      await cachedBackend.read("/file.ts", 4, 10);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("readRaw() returns cached result on second call", async () => {
      mockFetch.mockResolvedValueOnce(
        mockReadResponse("     1\tline one\n     2\tline two"),
      );

      const r1 = await cachedBackend.readRaw("/file.ts");
      const r2 = await cachedBackend.readRaw("/file.ts");

      expect(r1).toBe(r2);
      expect(r1.content).toEqual(["line one", "line two"]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("grepRaw() returns cached result on second call", async () => {
      mockFetch.mockResolvedValueOnce(mockGrepResponse());

      const r1 = await cachedBackend.grepRaw("pattern", "src", "*.ts");
      const r2 = await cachedBackend.grepRaw("pattern", "src", "*.ts");

      expect(r1).toEqual(r2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("globInfo() returns cached result on second call", async () => {
      mockFetch.mockResolvedValueOnce(mockGlobResponse());

      const r1 = await cachedBackend.globInfo("**/*.ts", "src");
      const r2 = await cachedBackend.globInfo("**/*.ts", "src");

      expect(r1).toEqual(r2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("lsInfo() returns cached result on second call", async () => {
      mockFetch.mockResolvedValueOnce(mockLsResponse());

      const r1 = await cachedBackend.lsInfo("/src");
      const r2 = await cachedBackend.lsInfo("/src");

      expect(r1).toEqual(r2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("write() invalidates read and search caches", async () => {
      // Populate read cache
      mockFetch.mockResolvedValueOnce(mockReadResponse());
      await cachedBackend.read("/file.ts");
      // Populate grep cache
      mockFetch.mockResolvedValueOnce(mockGrepResponse());
      await cachedBackend.grepRaw("pattern");

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Write invalidates caches
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "/file.ts",
          modified_at: "2026-03-12T00:00:00Z",
        }),
      } as any);
      await cachedBackend.write("/file.ts", "new content");

      // Re-read should fetch again
      mockFetch.mockResolvedValueOnce(mockReadResponse("     1\tnew content"));
      await cachedBackend.read("/file.ts");

      // Re-grep should fetch again
      mockFetch.mockResolvedValueOnce(mockGrepResponse());
      await cachedBackend.grepRaw("pattern");

      // 2 initial + 1 write + 2 re-fetches = 5
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it("edit() invalidates caches", async () => {
      // Populate read cache
      mockFetch.mockResolvedValueOnce(mockReadResponse());
      await cachedBackend.read("/file.ts");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Edit invalidates caches
      // stat
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          exists: true,
          modified_at: "2026-03-12T00:00:00Z",
        }),
      } as any);
      // edit
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "/file.ts",
          modified_at: "2026-03-12T00:00:01Z",
          occurrences: 1,
        }),
      } as any);
      await cachedBackend.edit("/file.ts", "old", "new");

      // Re-read should fetch again
      mockFetch.mockResolvedValueOnce(mockReadResponse("     1\tnew content"));
      await cachedBackend.read("/file.ts");

      // 1 initial read + 2 edit (stat+edit) + 1 re-read = 4
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("errors are NOT cached for read()", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "server error",
      } as any);

      const r1 = await cachedBackend.read("/file.ts");
      expect(r1).toContain("Error reading remote file");

      // Second call should fetch again, not return cached error
      mockFetch.mockResolvedValueOnce(mockReadResponse());
      const r2 = await cachedBackend.read("/file.ts");
      expect(r2).not.toContain("Error");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("errors are NOT cached for grepRaw()", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "bad pattern",
      } as any);

      const r1 = await cachedBackend.grepRaw("[invalid");
      expect(typeof r1).toBe("string");

      mockFetch.mockResolvedValueOnce(mockGrepResponse());
      const r2 = await cachedBackend.grepRaw("[invalid");
      expect(Array.isArray(r2)).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("cache: false disables all caching", async () => {
      const noCacheBackend = new RemoteBackend({
        baseUrl: "http://198.51.100.111:7700",
        nodeId: "sia-desktop-01",
        cache: false,
      });

      mockFetch
        .mockResolvedValueOnce(mockReadResponse())
        .mockResolvedValueOnce(mockReadResponse());

      await noCacheBackend.read("/file.ts");
      await noCacheBackend.read("/file.ts");

      expect(mockFetch).toHaveBeenCalledTimes(2);

      const stats = noCacheBackend.getCacheStats();
      expect(stats.read).toBeNull();
      expect(stats.readRaw).toBeNull();
      expect(stats.grep).toBeNull();
      expect(stats.glob).toBeNull();
      expect(stats.ls).toBeNull();
    });

    it("TTL expiration causes cache miss", async () => {
      jest.useFakeTimers();

      const shortTtlBackend = new RemoteBackend({
        baseUrl: "http://198.51.100.111:7700",
        nodeId: "sia-desktop-01",
        cache: { ttlMs: 5_000 },
      });

      mockFetch.mockResolvedValueOnce(mockReadResponse());
      await shortTtlBackend.read("/file.ts");

      // Advance time past TTL
      jest.advanceTimersByTime(6_000);

      mockFetch.mockResolvedValueOnce(mockReadResponse("     1\tupdated"));
      await shortTtlBackend.read("/file.ts");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    it("getCacheStats() returns correct counts", async () => {
      mockFetch.mockResolvedValueOnce(mockReadResponse());
      await cachedBackend.read("/file.ts");

      // Second call is cache hit
      await cachedBackend.read("/file.ts");

      const stats = cachedBackend.getCacheStats();
      expect(stats.read).toMatchObject({
        size: 1,
        hits: 1,
        misses: 1,
        maxSize: 200,
      });
    });

    it("default config enables caching", async () => {
      // Default backend (no cache config) should have caching enabled
      mockFetch.mockResolvedValueOnce(mockReadResponse());

      await backend.read("/file.ts");
      await backend.read("/file.ts");

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
