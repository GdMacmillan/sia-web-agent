/**
 * Protocol definition for pluggable memory backends.
 *
 * This module defines the BackendProtocol that all backend implementations
 * must follow. Backends can store files in different locations (state, filesystem,
 * database, etc.) and provide a uniform interface for file operations.
 *
 * ## Protocol v2 (in-place)
 *
 * Ported from upstream deepagents' v2 protocol, but WITHOUT the upstream
 * v1/v2 split or `adaptBackendProtocol` shim — all fork backends are local
 * with a single consumer (`src/middleware/fs.ts`), so the interface is
 * rewritten in place rather than versioned. See
 * [`docs/UPDATE_WORKFLOW.md`](../../docs/UPDATE_WORKFLOW.md). If a v1 compat
 * shim is ever needed, upstream's lives at
 * `libs/deepagents/src/backends/utils.ts` (`adaptBackendProtocol`).
 *
 * Key shape changes from the previous fork protocol:
 * - `lsInfo()` → `ls()` returning {@link LsResult} (was `FileInfo[]`)
 * - `read()` returns {@link ReadResult} (was a plain `string`)
 * - `grepRaw()` → `grep()` returning {@link GrepResult} (was `GrepMatch[] | string`)
 * - `globInfo()` → `glob()` returning {@link GlobResult} (was `FileInfo[]`)
 * - `readRaw()` returns {@link ReadRawResult} (was `FileData`)
 * - new optional `delete()` returning {@link DeleteResult}
 */

import type { BaseStore } from "@langchain/langgraph-checkpoint";

export type MaybePromise<T> = T | Promise<T>;

/**
 * Structured file listing info.
 *
 * Minimal contract used across backends. Only "path" is required.
 * Other fields are best-effort and may be absent depending on backend.
 */
export interface FileInfo {
  /** File path */
  path: string;
  /** Whether this is a directory */
  is_dir?: boolean;
  /** File size in bytes (approximate) */
  size?: number;
  /** ISO 8601 timestamp of last modification */
  modified_at?: string;
}

/**
 * Structured grep match entry.
 */
export interface GrepMatch {
  /** File path where match was found */
  path: string;
  /** Line number (1-indexed) */
  line: number;
  /** The matching line text */
  text: string;
}

/**
 * Legacy file data format (v1).
 *
 * Content is stored as an array of lines (split on "\n"). This format only
 * supports text files and is the shape persisted in LangGraph state/store.
 */
export interface FileDataV1 {
  /** File content as an array of lines */
  content: string[];
  /** ISO format timestamp of creation */
  created_at: string;
  /** ISO format timestamp of last modification */
  modified_at: string;
}

/**
 * Current file data format (v2).
 *
 * Content is stored as a string for text files, or as a Uint8Array for binary
 * files (images, PDFs, audio, etc.). The MIME type is stored alongside so
 * callers can render/inspect the content appropriately.
 */
export interface FileDataV2 {
  /** File content: string for text, Uint8Array for binary */
  content: string | Uint8Array;
  /** MIME type of the file (e.g. "image/png", "text/plain") */
  mimeType: string;
  /** ISO format timestamp of creation */
  created_at: string;
  /** ISO format timestamp of last modification */
  modified_at: string;
}

/**
 * Union of v1 and v2 file data formats.
 *
 * State- and store-backed backends persist and return the v1 shape (the
 * LangGraph state schema stores `content: string[]`); filesystem-style
 * backends may return v2 for binary content. Use {@link isFileDataV1} to
 * discriminate at runtime.
 */
export type FileData = FileDataV1 | FileDataV2;

/**
 * Runtime discriminator between the v1 (array-of-lines) and v2 file formats.
 */
export function isFileDataV1(data: FileData): data is FileDataV1 {
  return Array.isArray((data as FileDataV1).content);
}

/**
 * Structured result from backend `read` operations.
 *
 * Replaces the previous plain-string return, giving callers a programmatic way
 * to distinguish errors from content and to carry a MIME type for binary reads.
 */
export interface ReadResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** File content: string for text, Uint8Array for binary. Undefined on failure. */
  content?: string | Uint8Array;
  /** MIME type of the file, when available */
  mimeType?: string;
}

/**
 * Structured result from backend `readRaw` operations.
 */
export interface ReadRawResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** Raw file data, undefined on failure */
  data?: FileData;
}

/**
 * Structured result from backend `ls` operations.
 */
export interface LsResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** List of FileInfo objects, undefined on failure */
  files?: FileInfo[];
}

/**
 * Structured result from backend `glob` operations.
 */
export interface GlobResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** List of FileInfo objects matching the pattern, undefined on failure */
  files?: FileInfo[];
}

/**
 * Structured result from backend `grep`/search operations.
 */
export interface GrepResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** Structured grep match entries, undefined on failure */
  matches?: GrepMatch[];
}

/**
 * Result from backend write operations.
 *
 * Checkpoint backends populate filesUpdate with {file_path: file_data} for LangGraph state.
 * External backends set filesUpdate to null (already persisted to disk/S3/database/etc).
 */
export interface WriteResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** File path of written file, undefined on failure */
  path?: string;
  /**
   * State update dict for checkpoint backends, null for external storage.
   * Checkpoint backends populate this with {file_path: file_data} for LangGraph state.
   * External backends set null (already persisted to disk/S3/database/etc).
   */
  filesUpdate?: Record<string, FileData> | null;
  /** Metadata for the write operation, attached to the ToolMessage */
  metadata?: Record<string, unknown>;
}

/**
 * Result from backend edit operations.
 *
 * Checkpoint backends populate filesUpdate with {file_path: file_data} for LangGraph state.
 * External backends set filesUpdate to null (already persisted to disk/S3/database/etc).
 */
export interface EditResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** File path of edited file, undefined on failure */
  path?: string;
  /**
   * State update dict for checkpoint backends, null for external storage.
   * Checkpoint backends populate this with {file_path: file_data} for LangGraph state.
   * External backends set null (already persisted to disk/S3/database/etc).
   */
  filesUpdate?: Record<string, FileData> | null;
  /** Number of replacements made, undefined on failure */
  occurrences?: number;
  /** Metadata for the edit operation, attached to the ToolMessage */
  metadata?: Record<string, unknown>;
}

/**
 * Result from backend delete operations.
 */
export interface DeleteResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** File path of deleted file, undefined on failure */
  path?: string;
}

/**
 * Result of code execution in a sandbox backend.
 * Simplified schema optimized for LLM consumption.
 */
export interface ExecuteResponse {
  /** Combined stdout and stderr output of the executed command */
  output: string;
  /** The process exit code. 0 indicates success, non-zero indicates failure */
  exitCode: number | null;
  /** Whether the output was truncated due to backend limitations */
  truncated: boolean;
}

/**
 * Standardized error codes for file upload/download operations.
 */
export type FileOperationError =
  | "file_not_found"
  | "permission_denied"
  | "is_directory"
  | "invalid_path";

/**
 * Result of a single file download operation (sandbox backends).
 */
export interface FileDownloadResponse {
  /** The file path that was requested */
  path: string;
  /** File contents as Uint8Array on success, null on failure */
  content: Uint8Array | null;
  /** Standardized error code on failure, null on success */
  error: FileOperationError | null;
}

/**
 * Result of a single file upload operation (sandbox backends).
 */
export interface FileUploadResponse {
  /** The file path that was requested */
  path: string;
  /** Standardized error code on failure, null on success */
  error: FileOperationError | null;
}

/**
 * Protocol for pluggable memory backends (single, unified — protocol v2).
 *
 * Backends can store files in different locations (state, filesystem, database,
 * etc.) and provide a uniform interface for file operations. Every read-style
 * method returns a structured Result carrying either data or an `error` string,
 * so failures are recoverable tool errors rather than thrown exceptions.
 *
 * Methods can return either direct values or Promises, allowing both
 * synchronous and asynchronous implementations.
 */
export interface BackendProtocol {
  /**
   * Structured listing with file metadata.
   *
   * Lists files and directories in the specified directory (non-recursive).
   * Directories have a trailing / in their path and is_dir=true.
   *
   * @param path - Absolute path to directory
   * @returns LsResult with `files` on success or `error` on failure
   */
  ls(path: string): MaybePromise<LsResult>;

  /**
   * Read file content.
   *
   * For text files, content is paginated by line offset/limit and returned as
   * a formatted string with line numbers. For binary files, the raw Uint8Array
   * content and a MIME type are returned.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed), default 0
   * @param limit - Maximum number of lines to read, default 2000
   * @returns ReadResult with `content` on success or `error` on failure
   */
  read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): MaybePromise<ReadResult>;

  /**
   * Search file contents for a regex pattern.
   *
   * @param pattern - Regex pattern to search for
   * @param path - Base path to search from (default: null)
   * @param glob - Optional glob pattern to filter files (e.g., "*.py")
   * @returns GrepResult with `matches` on success or `error` on failure
   */
  grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
  ): MaybePromise<GrepResult>;

  /**
   * Structured glob matching returning FileInfo objects.
   *
   * @param pattern - Glob pattern (e.g., `*.py`, `**\/*.ts`)
   * @param path - Base path to search from (default: "/")
   * @returns GlobResult with `files` on success or `error` on failure
   */
  glob(pattern: string, path?: string): MaybePromise<GlobResult>;

  /**
   * Create a new file.
   *
   * @param filePath - Absolute file path
   * @param content - File content as string
   * @returns WriteResult with error populated on failure
   */
  write(filePath: string, content: string): MaybePromise<WriteResult>;

  /**
   * Edit a file by replacing string occurrences.
   *
   * @param filePath - Absolute file path
   * @param oldString - String to find and replace
   * @param newString - Replacement string
   * @param replaceAll - If true, replace all occurrences (default: false)
   * @returns EditResult with error, path, filesUpdate, and occurrences
   */
  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): MaybePromise<EditResult>;

  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns ReadRawResult with `data` on success or `error` on failure
   */
  readRaw(filePath: string): MaybePromise<ReadRawResult>;

  /**
   * Delete a single file. Optional — backends that don't support deletion can
   * omit this.
   *
   * @param filePath - Absolute path to the file to delete
   * @returns DeleteResult with path on success or error on failure
   */
  delete?(filePath: string): MaybePromise<DeleteResult>;
}

/**
 * Protocol for sandboxed backends with an isolated runtime.
 *
 * Adds command execution and an id to {@link BackendProtocol}. Ported from
 * upstream `SandboxBackendProtocolV2`; see `BaseSandbox` in
 * `src/backends/sandbox.ts` for the abstract base.
 */
export interface SandboxBackendProtocolV2 extends BackendProtocol {
  /**
   * Execute a command in the sandbox.
   *
   * @param command - Full shell command string to execute
   * @returns ExecuteResponse with combined output, exit code, and truncation flag
   */
  execute(command: string): MaybePromise<ExecuteResponse>;

  /** Unique identifier for the sandbox backend instance */
  readonly id: string;
}

/**
 * Type guard: does `backend` implement the sandbox protocol (execute + id)?
 */
export function isSandboxBackend(
  backend: unknown,
): backend is SandboxBackendProtocolV2 {
  return (
    backend != null &&
    typeof backend === "object" &&
    typeof (backend as SandboxBackendProtocolV2).execute === "function" &&
    typeof (backend as SandboxBackendProtocolV2).id === "string" &&
    (backend as SandboxBackendProtocolV2).id !== ""
  );
}

/**
 * State and store container for backend initialization.
 *
 * This provides a clean interface for what backends need to access:
 * - state: Current agent state (with files, messages, etc.)
 * - store: Optional persistent store for cross-conversation data
 *
 * Different contexts build this differently:
 * - Tools: Extract state via getCurrentTaskInput(config)
 * - Middleware: Use request.state directly
 */
export interface StateAndStore {
  /** Current agent state with files, messages, etc. */
  state: unknown;
  /** Optional BaseStore for persistent cross-conversation storage */
  store?: BaseStore;
  /** Optional assistant ID for per-assistant isolation in store */
  assistantId?: string;
}

/**
 * Factory function type for creating backend instances.
 *
 * Backends receive StateAndStore which contains the current state
 * and optional store, extracted from the execution context.
 */
export type BackendFactory = (stateAndStore: StateAndStore) => BackendProtocol;
