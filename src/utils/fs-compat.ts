/**
 * Cross-platform filesystem/exec helpers.
 *
 * Small, dependency-light utilities that smooth over platform differences so
 * the rest of the agent can stay platform-agnostic.
 */

import { existsSync } from "fs";
import { rgPath } from "@vscode/ripgrep";

/**
 * Sanitize a single string into a safe path segment (directory or file name).
 *
 * Any character outside `[A-Za-z0-9-_]` is replaced with `_`. This keeps
 * arbitrary identifiers (e.g. a thread id containing `:` from an ISO timestamp,
 * or path-traversal sequences like `..`) from producing invalid or unsafe
 * names when joined into a path.
 *
 * @param segment - The raw segment to sanitize
 * @returns A safe, non-empty segment
 */
export function sanitizePathSegment(segment: string): string {
  const cleaned = (segment ?? "").replace(/[^a-zA-Z0-9-_]/g, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

/**
 * Resolve the ripgrep binary to use.
 *
 * Prefers the bundled `@vscode/ripgrep` binary when it is present on-device
 * (its postinstall fetches the platform-matching binary), otherwise falls back
 * to a `rg` on PATH.
 *
 * @returns The ripgrep command/path to spawn
 */
export function resolveRipgrep(): string {
  try {
    if (rgPath && existsSync(rgPath)) {
      return rgPath;
    }
  } catch {
    // fall through to PATH lookup
  }
  return "rg";
}
