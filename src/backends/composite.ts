/**
 * CompositeBackend: Route operations to different backends based on path prefix.
 */

import type {
  BackendProtocol,
  DeleteResult,
  EditResult,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "./protocol.js";

/**
 * Backend that routes file operations to different backends based on path prefix.
 *
 * This enables hybrid storage strategies like:
 * - `/memories/` → StoreBackend (persistent, cross-thread)
 * - Everything else → StateBackend (ephemeral, per-thread)
 *
 * The CompositeBackend handles path prefix stripping/re-adding transparently.
 */
export class CompositeBackend implements BackendProtocol {
  private default: BackendProtocol;
  private routes: Record<string, BackendProtocol>;
  private sortedRoutes: Array<[string, BackendProtocol]>;

  constructor(
    defaultBackend: BackendProtocol,
    routes: Record<string, BackendProtocol>,
  ) {
    this.default = defaultBackend;
    this.routes = routes;

    // Sort routes by length (longest first) for correct prefix matching
    this.sortedRoutes = Object.entries(routes).sort(
      (a, b) => b[0].length - a[0].length,
    );
  }

  /**
   * Determine which backend handles this key and strip prefix.
   *
   * @param key - Original file path
   * @returns Tuple of [backend, stripped_key] where stripped_key has the route
   *          prefix removed (but keeps leading slash).
   */
  private getBackendAndKey(key: string): [BackendProtocol, string] {
    // Check routes in order of length (longest first)
    for (const [prefix, backend] of this.sortedRoutes) {
      if (key.startsWith(prefix)) {
        // Strip full prefix and ensure a leading slash remains
        // e.g., "/memories/notes.txt" → "/notes.txt"; "/memories/" → "/"
        const suffix = key.substring(prefix.length);
        const strippedKey = suffix ? "/" + suffix : "/";
        return [backend, strippedKey];
      }
    }

    return [this.default, key];
  }

  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param path - Absolute path to directory
   * @returns List of FileInfo objects with route prefixes added, for files and directories
   *          directly in the directory. Directories have a trailing / in their path and is_dir=true.
   */
  async ls(path: string): Promise<LsResult> {
    // Check if path matches a specific route
    for (const [routePrefix, backend] of this.sortedRoutes) {
      if (path.startsWith(routePrefix.replace(/\/$/, ""))) {
        // Query only the matching routed backend
        const suffix = path.substring(routePrefix.length);
        const searchPath = suffix ? "/" + suffix : "/";
        const result = await backend.ls(searchPath);
        if (result.error) return result;

        // Add route prefix back to paths
        const prefixed: FileInfo[] = [];
        for (const fi of result.files ?? []) {
          prefixed.push({
            ...fi,
            path: routePrefix.slice(0, -1) + fi.path,
          });
        }
        return { files: prefixed };
      }
    }

    // Handle namespace prefixes: when path matches a shared prefix of multiple
    // routes (e.g., "/remote/" matches "/remote/node-a/" and "/remote/node-b/"),
    // aggregate matching route prefixes as virtual directories.
    const normalizedPath = path.endsWith("/") ? path : path + "/";
    const matchingRoutes = this.sortedRoutes.filter(([prefix]) =>
      prefix.startsWith(normalizedPath),
    );
    if (matchingRoutes.length > 0 && normalizedPath !== "/") {
      const results: FileInfo[] = [];
      for (const [routePrefix] of matchingRoutes) {
        results.push({
          path: routePrefix,
          is_dir: true,
          size: 0,
          modified_at: "",
        });
      }
      results.sort((a, b) => a.path.localeCompare(b.path));
      return { files: results };
    }

    // At root, aggregate default and all routed backends
    if (path === "/") {
      const results: FileInfo[] = [];
      const defaultResult = await this.default.ls(path);
      if (defaultResult.error) return defaultResult;
      results.push(...(defaultResult.files ?? []));

      // Add the route itself as a directory (e.g., /memories/, /remote/)
      // Deduplicate namespace prefixes (e.g., show /remote/ once, not each sub-route)
      const seenPrefixes = new Set<string>();
      for (const [routePrefix] of this.sortedRoutes) {
        // Extract top-level namespace: /remote/node-a/ → /remote/
        const parts = routePrefix.split("/").filter(Boolean);
        const topLevel = "/" + parts[0] + "/";
        if (!seenPrefixes.has(topLevel)) {
          seenPrefixes.add(topLevel);
          results.push({
            path: topLevel,
            is_dir: true,
            size: 0,
            modified_at: "",
          });
        }
      }

      results.sort((a, b) => a.path.localeCompare(b.path));
      return { files: results };
    }

    // Path doesn't match a route: query only default backend
    return await this.default.ls(path);
  }

  /**
   * Read file content, routing to appropriate backend.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns Formatted file content with line numbers, or error message
   */
  async read(
    filePath: string,
    offset: number = 0,
    limit: number = 2000,
  ): Promise<ReadResult> {
    const [backend, strippedKey] = this.getBackendAndKey(filePath);
    return await backend.read(strippedKey, offset, limit);
  }

  /**
   * Read file content as raw FileData, routing to appropriate backend.
   *
   * @param filePath - Absolute file path
   * @returns ReadRawResult with data on success or error on failure
   */
  async readRaw(filePath: string): Promise<ReadRawResult> {
    const [backend, strippedKey] = this.getBackendAndKey(filePath);
    return await backend.readRaw(strippedKey);
  }

  /**
   * Structured search results, routing to appropriate backend(s).
   */
  async grep(
    pattern: string,
    path: string | null = "/",
    glob: string | null = null,
  ): Promise<GrepResult> {
    const searchBase = path ?? "/";
    // If path targets a specific route, search only that backend
    for (const [routePrefix, backend] of this.sortedRoutes) {
      if (searchBase.startsWith(routePrefix.replace(/\/$/, ""))) {
        const searchPath = searchBase.substring(routePrefix.length - 1);
        const result = await backend.grep(pattern, searchPath || "/", glob);
        if (result.error) return result;

        // Add route prefix back
        return {
          matches: (result.matches ?? []).map((m) => ({
            ...m,
            path: routePrefix.slice(0, -1) + m.path,
          })),
        };
      }
    }

    // Otherwise, search default and all routed backends and merge
    const allMatches: GrepMatch[] = [];
    const defaultResult = await this.default.grep(pattern, searchBase, glob);
    if (defaultResult.error) return defaultResult;
    allMatches.push(...(defaultResult.matches ?? []));

    // Search all routes
    for (const [routePrefix, backend] of Object.entries(this.routes)) {
      const result = await backend.grep(pattern, "/", glob);
      if (result.error) return result;

      // Add route prefix back
      allMatches.push(
        ...(result.matches ?? []).map((m) => ({
          ...m,
          path: routePrefix.slice(0, -1) + m.path,
        })),
      );
    }

    return { matches: allMatches };
  }

  /**
   * Structured glob matching returning FileInfo objects.
   */
  async glob(pattern: string, path: string = "/"): Promise<GlobResult> {
    const results: FileInfo[] = [];

    // Route based on path, not pattern
    for (const [routePrefix, backend] of this.sortedRoutes) {
      if (path.startsWith(routePrefix.replace(/\/$/, ""))) {
        const searchPath = path.substring(routePrefix.length - 1);
        const result = await backend.glob(pattern, searchPath || "/");
        if (result.error) return result;

        // Add route prefix back
        return {
          files: (result.files ?? []).map((fi) => ({
            ...fi,
            path: routePrefix.slice(0, -1) + fi.path,
          })),
        };
      }
    }

    // Path doesn't match any specific route - search default backend AND all routed backends
    const defaultResult = await this.default.glob(pattern, path);
    if (defaultResult.error) return defaultResult;
    results.push(...(defaultResult.files ?? []));

    for (const [routePrefix, backend] of Object.entries(this.routes)) {
      const result = await backend.glob(pattern, "/");
      if (result.error) return result;
      results.push(
        ...(result.files ?? []).map((fi) => ({
          ...fi,
          path: routePrefix.slice(0, -1) + fi.path,
        })),
      );
    }

    // Deterministic ordering
    results.sort((a, b) => a.path.localeCompare(b.path));
    return { files: results };
  }

  /**
   * Create a new file, routing to appropriate backend.
   *
   * @param filePath - Absolute file path
   * @param content - File content as string
   * @returns WriteResult with path or error
   */
  async write(filePath: string, content: string): Promise<WriteResult> {
    const [backend, strippedKey] = this.getBackendAndKey(filePath);
    return await backend.write(strippedKey, content);
  }

  /**
   * Edit a file, routing to appropriate backend.
   *
   * @param filePath - Absolute file path
   * @param oldString - String to find and replace
   * @param newString - Replacement string
   * @param replaceAll - If true, replace all occurrences
   * @returns EditResult with path, occurrences, or error
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): Promise<EditResult> {
    const [backend, strippedKey] = this.getBackendAndKey(filePath);
    return await backend.edit(strippedKey, oldString, newString, replaceAll);
  }

  /**
   * Delete a file, routing to the appropriate backend. Errors if the routed
   * backend does not support deletion.
   *
   * @param filePath - Absolute file path
   * @returns DeleteResult with path or error
   */
  async delete(filePath: string): Promise<DeleteResult> {
    const [backend, strippedKey] = this.getBackendAndKey(filePath);
    if (!backend.delete) {
      return {
        error: `Delete is not supported by the backend routing '${filePath}'`,
      };
    }
    return await backend.delete(strippedKey);
  }
}
