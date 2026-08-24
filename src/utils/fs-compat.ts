/**
 * Cross-platform filesystem/exec helpers.
 *
 * Small, dependency-light utilities that smooth over platform differences so
 * the rest of the agent can stay platform-agnostic.
 */

import { existsSync } from "fs";
import { join } from "path";
import { getProjectRoot } from "./path-utils.js";

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
 * Locate the ripgrep binary shipped by `@vscode/ripgrep`.
 *
 * `@vscode/ripgrep` carries no binary itself. It declares one
 * `@vscode/ripgrep-<platform>-<arch>` optional dependency per platform, each
 * constrained by `os`/`cpu` so a package manager installs exactly the one
 * matching the host and skips the other eleven. The binary always lands at
 * `<pkg>/bin/rg` (`rg.exe` on Windows).
 *
 * We resolve that path ourselves rather than importing `rgPath` from
 * `@vscode/ripgrep`. That module is ESM-only and *throws while it evaluates*
 * when its platform package is absent, so any import of it — static or
 * dynamic — can take down every module in this file's import graph. The
 * platform package holds only the binary and a `package.json` with no
 * `exports` field: there is no JS to parse and nothing that can throw. This
 * mirrors how `resolveTsxCommand` locates tsx's CLI entry, and it is what
 * keeps `resolveRipgrep` synchronous for its callers.
 *
 * @returns The absolute path to the bundled binary, or null if it is absent
 */
function findBundledRipgrep(): string | null {
  // Mirrors @vscode/ripgrep's own resolution: npm_config_arch lets a user
  // install a build for an architecture other than the running one.
  const arch = process.env.npm_config_arch || process.arch;
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;

  // Both roots are trusted host paths, joined with an otherwise fixed layout.
  const roots = [getProjectRoot(), process.cwd()].filter(Boolean);
  for (const root of roots) {
    const candidate = join(
      root,
      "node_modules",
      platformPkg,
      "bin",
      binaryName,
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve the ripgrep binary to use.
 *
 * Prefers the binary bundled by `@vscode/ripgrep` when it is installed,
 * otherwise falls back to an `rg` on PATH.
 *
 * @returns The ripgrep command/path to spawn
 */
export function resolveRipgrep(): string {
  try {
    const bundled = findBundledRipgrep();
    if (bundled) {
      return bundled;
    }
  } catch {
    // fall through to PATH lookup
  }
  return "rg";
}
