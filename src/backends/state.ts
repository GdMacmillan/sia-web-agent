/**
 * StateBackend: Store files in LangGraph agent state (ephemeral).
 */

import type {
  BackendProtocol,
  DeleteResult,
  EditResult,
  FileData,
  FileInfo,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  StateAndStore,
  WriteResult,
} from "./protocol.js";
import {
  createFileData,
  fileDataToString,
  formatReadResponse,
  getMimeType,
  globSearchFiles,
  grepMatchesFromFiles,
  performStringReplacement,
  truncateFileInfos,
  truncateGrepMatches,
  updateFileData,
} from "./utils.js";

/**
 * Backend that stores files in agent state (ephemeral).
 *
 * Uses LangGraph's state management and checkpointing. Files persist within
 * a conversation thread but not across threads. State is automatically
 * checkpointed after each agent step.
 *
 * Special handling: Since LangGraph state must be updated via Command objects
 * (not direct mutation), operations return filesUpdate in WriteResult/EditResult
 * for the middleware to apply via Command.
 */
export class StateBackend implements BackendProtocol {
  private stateAndStore: StateAndStore;

  constructor(stateAndStore: StateAndStore) {
    this.stateAndStore = stateAndStore;
  }

  /**
   * Get files from current state.
   */
  private getFiles(): Record<string, FileData> {
    return (
      ((this.stateAndStore.state as any).files as Record<string, FileData>) ||
      {}
    );
  }

  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param path - Absolute path to directory
   * @returns List of FileInfo objects for files and directories directly in the directory.
   *          Directories have a trailing / in their path and is_dir=true.
   */
  ls(path: string): LsResult {
    const files = this.getFiles();
    const infos: FileInfo[] = [];
    const subdirs = new Set<string>();

    // Normalize path to have trailing slash for proper prefix matching
    const normalizedPath = path.endsWith("/") ? path : path + "/";

    for (const [k, fd] of Object.entries(files)) {
      // Check if file is in the specified directory or a subdirectory
      if (!k.startsWith(normalizedPath)) {
        continue;
      }

      // Get the relative path after the directory
      const relative = k.substring(normalizedPath.length);

      // If relative path contains '/', it's in a subdirectory
      if (relative.includes("/")) {
        // Extract the immediate subdirectory name
        const subdirName = relative.split("/")[0];
        subdirs.add(normalizedPath + subdirName + "/");
        continue;
      }

      // This is a file directly in the current directory
      const size = fileDataToString(fd).length;
      infos.push({
        path: k,
        is_dir: false,
        size: size,
        modified_at: fd.modified_at,
      });
    }

    // Add directories to the results
    for (const subdir of Array.from(subdirs).sort()) {
      infos.push({
        path: subdir,
        is_dir: true,
        size: 0,
        modified_at: "",
      });
    }

    infos.sort((a, b) => a.path.localeCompare(b.path));
    return { files: truncateFileInfos(infos) };
  }

  /**
   * Read file content with line numbers.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns ReadResult with content on success or error on failure
   */
  read(
    filePath: string,
    offset: number = 0,
    limit: number = 2000,
  ): ReadResult {
    const files = this.getFiles();
    const fileData = files[filePath];

    if (!fileData) {
      return { error: `File '${filePath}' not found` };
    }

    return {
      content: formatReadResponse(fileData, offset, limit),
      mimeType: getMimeType(filePath),
    };
  }

  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns ReadRawResult with data on success or error on failure
   */
  readRaw(filePath: string): ReadRawResult {
    const files = this.getFiles();
    const fileData = files[filePath];

    if (!fileData) return { error: `File '${filePath}' not found` };
    return { data: fileData };
  }

  /**
   * Create a new file with content.
   * Returns WriteResult with filesUpdate to update LangGraph state.
   */
  write(filePath: string, content: string): WriteResult {
    const files = this.getFiles();

    if (filePath in files) {
      return {
        error: `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.`,
      };
    }

    const newFileData = createFileData(content);
    return {
      path: filePath,
      filesUpdate: { [filePath]: newFileData },
    };
  }

  /**
   * Edit a file by replacing string occurrences.
   * Returns EditResult with filesUpdate and occurrences.
   */
  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): EditResult {
    const files = this.getFiles();
    const fileData = files[filePath];

    if (!fileData) {
      return { error: `Error: File '${filePath}' not found` };
    }

    const content = fileDataToString(fileData);
    const result = performStringReplacement(
      content,
      oldString,
      newString,
      replaceAll,
    );

    if (typeof result === "string") {
      return { error: result };
    }

    const [newContent, occurrences] = result;
    const newFileData = updateFileData(fileData, newContent);
    return {
      path: filePath,
      filesUpdate: { [filePath]: newFileData },
      occurrences: occurrences,
    };
  }

  /**
   * Structured search results or error string for invalid input.
   */
  grep(
    pattern: string,
    path: string | null = "/",
    glob: string | null = null,
  ): GrepResult {
    const files = this.getFiles();
    const result = grepMatchesFromFiles(files, pattern, path ?? "/", glob);
    if (typeof result === "string") {
      return { error: result };
    }
    return { matches: truncateGrepMatches(result) };
  }

  /**
   * Structured glob matching returning FileInfo objects.
   */
  glob(pattern: string, path: string = "/"): GlobResult {
    const files = this.getFiles();
    const result = globSearchFiles(files, pattern, path);

    if (result === "No files found") {
      return { files: [] };
    }

    const paths = result.split("\n");
    const infos: FileInfo[] = [];
    for (const p of paths) {
      const fd = files[p];
      const size = fd ? fileDataToString(fd).length : 0;
      infos.push({
        path: p,
        is_dir: false,
        size: size,
        modified_at: fd?.modified_at || "",
      });
    }
    return { files: truncateFileInfos(infos) };
  }

  /**
   * Validate that a file exists and is eligible for deletion.
   *
   * NOTE: LangGraph state is immutable except via `Command`, and `DeleteResult`
   * carries no `filesUpdate`, so this does not itself remove the key from
   * state. No `delete` tool is currently wired into the filesystem middleware;
   * this satisfies the protocol surface and validates existence. A future
   * delete tool would apply the state removal via a `Command` in its handler.
   */
  delete(filePath: string): DeleteResult {
    const files = this.getFiles();
    if (!(filePath in files)) {
      return { error: `File '${filePath}' not found` };
    }
    return { path: filePath };
  }
}
