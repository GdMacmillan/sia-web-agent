/**
 * Path Utilities - Consistent Project Root Resolution
 *
 * Provides utilities to resolve the project root path reliably across different
 * execution contexts (tests, source code, CLI, server). Uses a hybrid strategy
 * to find the project root with multiple fallbacks.
 *
 * Strategy Priority:
 * 1. Monorepo detection: package.json with workspaces field (Yarn)
 * 2. Git repository root: .git directory
 * 3. Project markers: langgraph.json or CLAUDE.md
 * 4. Directory name: self-improving-agent directory
 * 5. Fall back to process.cwd()
 *
 * Result is cached for performance.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Cached project root to avoid repeated lookups
 */
let cachedProjectRoot: string | null = null;

/**
 * Check if a package.json file has a workspaces field (indicating Yarn monorepo root)
 *
 * @param jsonPath - Path to package.json
 * @returns true if file has workspaces field, false otherwise
 */
function hasWorkspacesField(jsonPath: string): boolean {
  try {
    const content = fs.readFileSync(jsonPath, "utf-8");
    const pkg = JSON.parse(content);
    return Boolean(pkg.workspaces);
  } catch {
    return false;
  }
}

/**
 * Find the project root by looking for a package.json with workspaces field.
 * This indicates a Yarn monorepo root and is the most reliable marker.
 *
 * @param startDir - Directory to start searching from
 * @returns Absolute path to project root, or null if not found
 */
function findMonorepoRoot(startDir: string): string | null {
  let current = startDir;

  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, "package.json");
    try {
      if (
        fs.existsSync(packageJsonPath) &&
        hasWorkspacesField(packageJsonPath)
      ) {
        return current;
      }
    } catch {
      // Continue searching if we can't access the file
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Find the project root by looking for a .git directory.
 * This indicates a Git repository root.
 *
 * @param startDir - Directory to start searching from
 * @returns Absolute path to project root, or null if not found
 */
function findGitRoot(startDir: string): string | null {
  let current = startDir;

  while (current !== path.dirname(current)) {
    const gitPath = path.join(current, ".git");
    try {
      if (fs.existsSync(gitPath)) {
        return current;
      }
    } catch {
      // Continue searching if we can't access the directory
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Find the project root by looking for project-specific marker files.
 * These include langgraph.json and CLAUDE.md which only exist at the project root.
 *
 * @param startDir - Directory to start searching from
 * @returns Absolute path to project root, or null if not found
 */
export function findProjectRootByMarker(startDir: string): string | null {
  const MARKER_FILES = ["langgraph.json", "CLAUDE.md"];
  let current = startDir;

  while (current !== path.dirname(current)) {
    // Check for marker files in priority order
    for (const marker of MARKER_FILES) {
      const markerPath = path.join(current, marker);
      try {
        if (fs.existsSync(markerPath)) {
          return current;
        }
      } catch {
        // Continue searching if we can't access the file
      }
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Find the project root by looking for a directory named "self-improving-agent"
 * walking up from the given start directory.
 *
 * @param startDir - Directory to start searching from
 * @returns Absolute path to project root, or null if not found
 */
export function findProjectRootByName(startDir: string): string | null {
  let current = startDir;

  while (current !== path.dirname(current)) {
    if (path.basename(current) === "self-improving-agent") {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Find the project root by walking up from the directory containing this module.
 * This strategy works well when the module is in src/utils/ or similar.
 *
 * Uses import.meta.url to get the current file path, then walks up from there.
 *
 * @returns Absolute path to project root, or null if not found
 */
export function findProjectRootFromModule(): string | null {
  try {
    // Use Function to access import.meta.url in a way that avoids parse-time errors
    const getImportMetaUrl = new Function(
      "return (typeof import !== 'undefined') ? import.meta.url : null",
    );
    const currentFileUrl = getImportMetaUrl();

    if (!currentFileUrl) {
      return null;
    }

    const currentFilePath = currentFileUrl.startsWith("file://")
      ? currentFileUrl.slice("file://".length)
      : currentFileUrl;

    const moduleDir = path.dirname(currentFilePath);

    // Try strategies in order from module directory
    let result = findMonorepoRoot(moduleDir);
    if (result) return result;

    result = findGitRoot(moduleDir);
    if (result) return result;

    result = findProjectRootByMarker(moduleDir);
    if (result) return result;

    result = findProjectRootByName(moduleDir);
    if (result) return result;

    return null;
  } catch {
    // If import.meta.url is not available, return null
    return null;
  }
}

/**
 * Get the project root using multiple strategies in priority order.
 *
 * Strategies (in order):
 * 0. SIA_PROJECT_ROOT environment variable (set by CLI in self-improve mode)
 * 1. Try to find from module location (import.meta.url)
 * 2. Try to find monorepo root (package.json with workspaces)
 * 3. Try to find git root (.git directory)
 * 4. Try to find by marker files (langgraph.json, CLAUDE.md)
 * 5. Try to find by directory name (self-improving-agent)
 * 6. Fall back to process.cwd()
 *
 * Result is cached to avoid repeated filesystem lookups.
 *
 * @returns Absolute path to the project root
 */
export function getProjectRoot(): string {
  // Return cached value if available
  if (cachedProjectRoot !== null) {
    return cachedProjectRoot;
  }

  // Strategy 0: SIA_PROJECT_ROOT env var (set by CLI in self-improve mode)
  const fromEnv = process.env.SIA_PROJECT_ROOT;
  if (fromEnv && fs.existsSync(fromEnv)) {
    cachedProjectRoot = fromEnv;
    return cachedProjectRoot;
  }

  // Strategy 1: From module location (most reliable)
  const fromModule = findProjectRootFromModule();
  if (fromModule) {
    cachedProjectRoot = fromModule;
    return cachedProjectRoot;
  }

  // Strategy 2: By monorepo marker (package.json with workspaces)
  const cwd = process.cwd();
  const fromMonorepo = findMonorepoRoot(cwd);
  if (fromMonorepo) {
    cachedProjectRoot = fromMonorepo;
    return cachedProjectRoot;
  }

  // Strategy 3: By git root (.git directory)
  const fromGit = findGitRoot(cwd);
  if (fromGit) {
    cachedProjectRoot = fromGit;
    return cachedProjectRoot;
  }

  // Strategy 4: By marker files
  const fromMarker = findProjectRootByMarker(cwd);
  if (fromMarker) {
    cachedProjectRoot = fromMarker;
    return cachedProjectRoot;
  }

  // Strategy 5: By directory name
  const fromName = findProjectRootByName(cwd);
  if (fromName) {
    cachedProjectRoot = fromName;
    return cachedProjectRoot;
  }

  // Strategy 6: Fall back to cwd
  cachedProjectRoot = cwd;
  return cachedProjectRoot;
}

/**
 * Resolve a path relative to the project root.
 * Handles both absolute and relative paths.
 *
 * @param filePath - Path to resolve (absolute or relative to project root)
 * @returns Absolute path to the file
 *
 * @example
 * resolveProjectPath("src/index.ts") // => "/path/to/self-improving-agent/src/index.ts"
 * resolveProjectPath("/absolute/path") // => "/absolute/path"
 */
export function resolveProjectPath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(getProjectRoot(), filePath);
}

/**
 * Get the directory that contains the agent's prompts/ and skills/ folders.
 * In the standalone @sia-web/agent layout this is the project root itself.
 *
 * @returns Absolute path to the agent's resource root
 */
export function getAgentPackageRoot(): string {
  return getProjectRoot();
}

/**
 * Get the relative path from project root to a file
 *
 * @param filePath - Absolute path to file
 * @returns Relative path from project root
 *
 * @example
 * getRelativeProjectPath("/path/to/self-improving-agent/src/index.ts")
 * // => "src/index.ts"
 */
export function getRelativeProjectPath(filePath: string): string {
  const projectRoot = getProjectRoot();
  return path.relative(projectRoot, filePath);
}

/**
 * Clear the cached project root. Useful for testing.
 */
export function clearProjectRootCache(): void {
  cachedProjectRoot = null;
}

/**
 * Get diagnostic information about path resolution.
 * Useful for debugging path issues.
 *
 * @returns Object containing path resolution diagnostics
 */
export function getPathDiagnostics(): {
  projectRoot: string;
  agentPackageRoot: string;
  cwd: string;
  moduleDir?: string;
  detectionStrategy?: string;
} {
  const projectRoot = getProjectRoot();

  let moduleDir: string | undefined;
  let detectionStrategy: string | undefined;

  try {
    const getImportMetaUrl = new Function(
      "return (typeof import !== 'undefined') ? import.meta.url : null",
    );
    const url = getImportMetaUrl();
    if (url) {
      moduleDir = path.dirname(
        url.startsWith("file://") ? url.slice("file://".length) : url,
      );
    }
  } catch {
    // import.meta.url not available
  }

  // Determine which strategy was used
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(packageJsonPath) && hasWorkspacesField(packageJsonPath)) {
    detectionStrategy = "monorepo (package.json with workspaces)";
  } else if (fs.existsSync(path.join(projectRoot, ".git"))) {
    detectionStrategy = "git repository (.git directory)";
  } else if (
    fs.existsSync(path.join(projectRoot, "langgraph.json")) ||
    fs.existsSync(path.join(projectRoot, "CLAUDE.md"))
  ) {
    detectionStrategy = "project marker (langgraph.json or CLAUDE.md)";
  } else if (path.basename(projectRoot) === "self-improving-agent") {
    detectionStrategy = "directory name (self-improving-agent)";
  } else {
    detectionStrategy = "fallback (process.cwd)";
  }

  return {
    projectRoot,
    agentPackageRoot: getAgentPackageRoot(),
    cwd: process.cwd(),
    moduleDir,
    detectionStrategy,
  };
}

/**
 * Validate that a path is within the project boundary.
 * Throws a detailed security error if the path is outside the project.
 *
 * This function ensures that file operations are restricted to the project directory,
 * preventing access to sensitive system files or directories outside the project.
 *
 * @param targetPath - The path to validate (absolute or relative)
 * @throws Error with detailed message if path is outside project boundary
 *
 * @example
 * validatePathInProject('/Users/user/project/src/file.ts'); // OK
 * validatePathInProject('/etc/passwd'); // Throws SecurityError
 * validatePathInProject('src/file.ts'); // OK (resolved relative to current directory)
 */
export function validatePathInProject(targetPath: string): void {
  // Handle null, undefined, or empty paths
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error(
      `Security Error: Invalid path provided.\n` +
        `Received: ${typeof targetPath === "string" ? `"${targetPath}"` : String(targetPath)}\n` +
        `All file paths must be non-empty strings.`,
    );
  }

  const projectRoot = getProjectRoot();

  // Resolve the path to an absolute path
  const resolved = path.resolve(targetPath);

  // Check if resolved path is within project root
  // Using path.relative to determine if target is inside or outside project
  const relative = path.relative(projectRoot, resolved);

  // If relative path starts with '..' or is absolute, it's outside the project
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Security Error: Path access denied.\n` +
        `Attempted to access: ${targetPath}\n` +
        `Resolved to: ${resolved}\n` +
        `Project boundary: ${projectRoot}\n` +
        `All file operations must be within the project directory.`,
    );
  }

  // Path is within project boundary
}

/**
 * Check if a path is within the project boundary without throwing an error.
 * Returns a boolean indicating whether the path is safe to access.
 *
 * @param targetPath - The path to check
 * @returns true if path is within project, false otherwise
 *
 * @example
 * if (isPathInProject(userPath)) {
 *   // Safe to proceed
 * }
 */
export function isPathInProject(targetPath: string): boolean {
  try {
    validatePathInProject(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a path and validate it's within the project boundary.
 * Convenience function that combines path resolution and validation.
 *
 * For relative paths, resolves from the project root.
 * For absolute paths, validates they're within the project.
 *
 * @param inputPath - Path to resolve and validate (relative or absolute)
 * @returns Absolute path within project
 * @throws Error if path is outside project boundary
 *
 * @example
 * const configPath = resolveAndValidate('config/settings.json');
 * // Returns: /Users/user/project/config/settings.json
 */
export function resolveAndValidate(inputPath: string): string {
  const projectRoot = getProjectRoot();

  // Resolve path (absolute paths stay absolute, relative resolve from project root)
  const resolved = path.isAbsolute(inputPath)
    ? inputPath
    : path.join(projectRoot, inputPath);

  // Validate the resolved path is within project
  validatePathInProject(resolved);

  return resolved;
}
