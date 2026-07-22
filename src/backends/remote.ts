/**
 * RemoteBackend: Proxy file operations to a remote siad daemon over HTTP.
 *
 * Implements BackendProtocol for file access on remote machines via siad.
 */

import { mkdir, writeFile } from "fs/promises";
import path from "path";

import type {
  BackendProtocol,
  EditResult,
  FileData,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "./protocol.js";
import { fileDataToString, getMimeType } from "./utils.js";
import { LRUCache, type CacheStats } from "../utils/lru-cache.js";

const REMOTE_TIMEOUT_MS = 30_000;

export interface RemoteBackendConfig {
  /** Base URL of the remote siad daemon, e.g. "http://198.51.100.111:7700" */
  baseUrl: string;
  /** Node ID for error messages */
  nodeId: string;
  /** Local project root — when set, remote writes sync to leader filesystem */
  leaderSync?: {
    projectRoot: string;
  };
  /** Cache configuration. Set to false to disable caching entirely. */
  cache?:
    | {
        ttlMs?: number; // default 30_000 (30s)
        maxReadEntries?: number; // default 200
        maxSearchEntries?: number; // default 50
      }
    | false;
}

export class RemoteBackend implements BackendProtocol {
  private baseUrl: string;
  private nodeId: string;
  private leaderProjectRoot: string | null;

  private readCache: LRUCache<string, ReadResult> | null;
  private readRawCache: LRUCache<string, FileData> | null;
  private grepCache: LRUCache<string, GrepResult> | null;
  private globCache: LRUCache<string, GlobResult> | null;
  private lsCache: LRUCache<string, LsResult> | null;

  constructor(config: RemoteBackendConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.nodeId = config.nodeId;
    this.leaderProjectRoot = config.leaderSync?.projectRoot ?? null;

    if (config.cache === false) {
      this.readCache = null;
      this.readRawCache = null;
      this.grepCache = null;
      this.globCache = null;
      this.lsCache = null;
    } else {
      const ttlMs = config.cache?.ttlMs ?? 30_000;
      const maxRead = config.cache?.maxReadEntries ?? 200;
      const maxSearch = config.cache?.maxSearchEntries ?? 50;
      this.readCache = new LRUCache({ maxSize: maxRead, ttlMs });
      this.readRawCache = new LRUCache({ maxSize: maxRead, ttlMs });
      this.grepCache = new LRUCache({ maxSize: maxSearch, ttlMs });
      this.globCache = new LRUCache({ maxSize: maxSearch, ttlMs });
      this.lsCache = new LRUCache({ maxSize: maxSearch, ttlMs });
    }
  }

  private invalidateCachesForPath(filePath: string): void {
    if (this.readCache) {
      for (const key of this.readCache.keys()) {
        if (key.startsWith(filePath + ":")) {
          this.readCache.delete(key);
        }
      }
    }
    this.readRawCache?.delete(filePath);
    this.grepCache?.clear();
    this.globCache?.clear();
    this.lsCache?.clear();
  }

  getCacheStats(): Record<string, CacheStats | null> {
    return {
      read: this.readCache?.getStats() ?? null,
      readRaw: this.readRawCache?.getStats() ?? null,
      grep: this.grepCache?.getStats() ?? null,
      glob: this.globCache?.getStats() ?? null,
      ls: this.lsCache?.getStats() ?? null,
    };
  }

  private async fetchJSON<T>(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = new URL(endpoint, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `Remote ${this.nodeId} ${endpoint} failed: ${resp.status} ${body}`,
      );
    }

    return resp.json() as Promise<T>;
  }

  private async postJSON<T>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(endpoint, this.baseUrl);

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Remote ${this.nodeId} ${endpoint} failed: ${resp.status} ${text}`,
      );
    }

    return resp.json() as Promise<T>;
  }

  private async syncToLeader(filePath: string, content: string): Promise<void> {
    if (!this.leaderProjectRoot) return;
    try {
      const rel = filePath.replace(/^\//, "");
      const resolved = path.resolve(this.leaderProjectRoot, rel);
      // Defense in depth: ensure resolved path is under project root
      if (!resolved.startsWith(this.leaderProjectRoot)) return;
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[leader-sync] Failed to sync ${filePath} from ${this.nodeId}: ${err}`,
      );
    }
  }

  async ls(path: string): Promise<LsResult> {
    const cacheKey = `ls:${path}`;
    const cached = this.lsCache?.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const data = await this.fetchJSON<{
        entries: Array<{
          path: string;
          is_dir: boolean;
          size: number;
          modified_at: string;
        }>;
      }>("/files/ls", { path });

      const result: LsResult = {
        files: data.entries.map((entry) => ({
          path: entry.path,
          is_dir: entry.is_dir,
          size: entry.size,
          modified_at: entry.modified_at,
        })),
      };
      this.lsCache?.set(cacheKey, result);
      return result;
    } catch (error) {
      // Recoverable {error} rather than a thrown, run-ending exception.
      const msg = error instanceof Error ? error.message : String(error);
      return {
        error: `Failed to list remote directory on ${this.nodeId}: ${msg}`,
      };
    }
  }

  async read(
    filePath: string,
    offset: number = 0,
    limit: number = 2000,
  ): Promise<ReadResult> {
    const cacheKey = `${filePath}:${offset}:${limit}`;
    const cached = this.readCache?.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const data = await this.fetchJSON<{
        content: string;
        path: string;
      }>("/files/read", {
        path: filePath,
        offset: String(offset),
        limit: String(limit),
      });

      const result: ReadResult = {
        content: data.content,
        mimeType: getMimeType(filePath),
      };
      this.readCache?.set(cacheKey, result);
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: `Error reading remote file on ${this.nodeId}: ${msg}` };
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const cached = this.readRawCache?.get(filePath);
    if (cached !== undefined) return { data: cached };

    try {
      const data = await this.fetchJSON<{
        content: string;
        path: string;
        modified_at?: string;
      }>("/files/read", {
        path: filePath,
        offset: "0",
        limit: "100000", // Read as much as possible
      });

      // Parse the line-numbered content back into raw lines
      const lines = data.content.split("\n").map((line) => {
        // Strip the line number prefix (e.g. "     1\t")
        const tabIndex = line.indexOf("\t");
        return tabIndex >= 0 ? line.substring(tabIndex + 1) : line;
      });

      const modifiedAt = data.modified_at ?? new Date().toISOString();
      const fileData: FileData = {
        content: lines,
        created_at: modifiedAt,
        modified_at: modifiedAt,
      };
      this.readRawCache?.set(filePath, fileData);
      return { data: fileData };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: `Error reading remote file on ${this.nodeId}: ${msg}` };
    }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    this.invalidateCachesForPath(filePath);
    try {
      await this.postJSON<{ path: string; modified_at: string }>(
        "/files/write",
        { path: filePath, content },
      );
      await this.syncToLeader(filePath, content);
      return { path: filePath, filesUpdate: null };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, filesUpdate: null };
    }
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    this.invalidateCachesForPath(filePath);
    try {
      // Get current mtime for conflict detection
      const stat = await this.fetchJSON<{
        exists: boolean;
        modified_at?: string;
      }>("/files/stat", { path: filePath });

      const result = await this.postJSON<{
        path: string;
        modified_at: string;
        occurrences: number;
      }>("/files/edit", {
        path: filePath,
        old_string: oldString,
        new_string: newString,
        replace_all: replaceAll ?? false,
        if_not_modified_since: stat.modified_at,
      });

      // Sync edited content to leader
      if (this.leaderProjectRoot) {
        try {
          const raw = await this.readRaw(filePath);
          if (raw.data) {
            await this.syncToLeader(
              filePath,
              fileDataToString(raw.data) + "\n",
            );
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[leader-sync] Failed to sync edit of ${filePath}: ${err}`,
          );
        }
      }

      return {
        path: filePath,
        filesUpdate: null,
        occurrences: result.occurrences,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, filesUpdate: null };
    }
  }

  async grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
  ): Promise<GrepResult> {
    const cacheKey = `grep:${pattern}:${path ?? ""}:${glob ?? ""}`;
    const cached = this.grepCache?.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const body: Record<string, unknown> = { pattern };
      if (path) body.path = path;
      if (glob) body.glob = glob;

      const data = await this.postJSON<{
        matches: Array<{ path: string; line: number; text: string }>;
        truncated: boolean;
      }>("/files/grep", body);

      const result: GrepResult = {
        matches: data.matches.map((m) => ({
          path: m.path,
          line: m.line,
          text: m.text,
        })),
      };
      this.grepCache?.set(cacheKey, result);
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        error: `Error searching remote files on ${this.nodeId}: ${msg}`,
      };
    }
  }

  async glob(pattern: string, path?: string): Promise<GlobResult> {
    const cacheKey = `glob:${pattern}:${path ?? ""}`;
    const cached = this.globCache?.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const params: Record<string, string> = { pattern };
      if (path) params.path = path;

      const data = await this.fetchJSON<{
        files: Array<{
          path: string;
          is_dir: boolean;
          size: number;
          modified_at: string;
        }>;
        truncated: boolean;
      }>("/files/glob", params);

      const result: GlobResult = {
        files: data.files.map((f) => ({
          path: f.path,
          is_dir: f.is_dir,
          size: f.size,
          modified_at: f.modified_at,
        })),
      };
      this.globCache?.set(cacheKey, result);
      return result;
    } catch (error) {
      // Recoverable {error} rather than a thrown exception.
      const msg = error instanceof Error ? error.message : String(error);
      return { error: `Failed to glob remote files on ${this.nodeId}: ${msg}` };
    }
  }
}
