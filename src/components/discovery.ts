/**
 * Component discovery — pure filesystem, no code loading.
 *
 * Lists `<root>/<name>/current/component.json` for each root in order, applies
 * the containment rule to every path it touches, and parses the manifest.
 * The first root that carries a name wins; later roots are shadowed. See
 * `docs/COMPONENTS.md` §2.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { isSafePath } from "../utils/skills-loader.js";
import type { HarnessProfile } from "../profiles/harness.js";
import {
  COMPONENT_NAME_PATTERN,
  parseComponentManifest,
  type ComponentManifest,
} from "./manifest.js";

/** Manifests larger than this are skipped. */
export const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
/** The pointer inside `<root>/<name>/` that selects the active version. */
export const CURRENT_LINK = "current";
/** The directory inside `<root>/<name>/` that holds every version. */
export const VERSIONS_DIR = ".versions";
/** The manifest file name inside a version directory. */
export const MANIFEST_FILE = "component.json";

export interface DiscoveredComponent {
  manifest: ComponentManifest;
  /** The manifest's `profile`, constructed, when present. */
  profile: HarnessProfile | undefined;
  /** The root the component was found under (resolved). */
  root: string;
  /** `<root>/<name>`. */
  componentDir: string;
  /** The version directory, fully resolved (links followed). */
  versionDir: string;
  /** Absolute path of the entry module. */
  entryPath: string;
  /** Absolute path of the contract module (may not exist). */
  contractPath: string;
}

export interface SkippedComponent {
  name: string;
  root: string;
  reason: string;
}

export interface ShadowedComponent {
  name: string;
  root: string;
  /** The earlier root whose same-named component took precedence. */
  shadowedBy: string;
}

export interface DiscoveryResult {
  found: DiscoveredComponent[];
  skipped: SkippedComponent[];
  shadowed: ShadowedComponent[];
}

export type DescribeVersionResult =
  | { ok: true; component: DiscoveredComponent }
  | { ok: false; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read and validate the manifest inside an already-resolved version
 * directory and compute the entry/contract paths. Shared by discovery
 * (which resolves `current`) and the contract runner (which may target a
 * specific `.versions/<version>` directly).
 *
 * @param root - The component root, resolved.
 * @param name - The component directory name.
 * @param versionDir - The version directory, already realpath'd.
 * @param versionDirName - The `.versions/<version>` directory name.
 */
export function describeComponentVersion(
  root: string,
  name: string,
  versionDir: string,
  versionDirName: string,
): DescribeVersionResult {
  const componentDir = path.join(root, name);
  const manifestPath = path.join(versionDir, MANIFEST_FILE);

  if (!isSafePath(manifestPath, root)) {
    return {
      ok: false,
      reason: `manifest not found or outside the component root: ${manifestPath}`,
    };
  }

  let size: number;
  try {
    size = statSync(manifestPath).size;
  } catch (error: unknown) {
    return { ok: false, reason: `manifest unreadable: ${errorMessage(error)}` };
  }
  if (size > MAX_MANIFEST_BYTES) {
    return {
      ok: false,
      reason: `manifest too large (${size} bytes, limit ${MAX_MANIFEST_BYTES})`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `manifest is not valid JSON: ${errorMessage(error)}`,
    };
  }

  const parsed = parseComponentManifest(raw, {
    dirName: name,
    versionDirName,
  });
  if (!parsed.ok) {
    return parsed;
  }

  const entryPath = path.resolve(versionDir, parsed.manifest.entry);
  if (!isSafePath(entryPath, versionDir)) {
    return {
      ok: false,
      reason: `entry not found or outside the version directory: ${parsed.manifest.entry}`,
    };
  }
  const contractPath = path.resolve(versionDir, parsed.manifest.contract);

  return {
    ok: true,
    component: {
      manifest: parsed.manifest,
      profile: parsed.profile,
      root,
      componentDir,
      versionDir,
      entryPath,
      contractPath,
    },
  };
}

/** Whether a `current` pointer exists at all (a link, even a dangling one). */
function hasPointer(currentPath: string): boolean {
  try {
    lstatSync(currentPath);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Resolve `<root>/<name>/current` to a version directory, enforcing that the
 * pointer exists, stays inside the root, and lands inside `.versions/`.
 */
function resolveCurrentVersion(
  root: string,
  name: string,
): { ok: true; versionDir: string; versionDirName: string } | { ok: false; reason: string } {
  const componentDir = path.join(root, name);
  const currentPath = path.join(componentDir, CURRENT_LINK);

  if (!hasPointer(currentPath)) {
    return { ok: false, reason: `no "${CURRENT_LINK}" pointer` };
  }
  if (!existsSync(currentPath)) {
    return {
      ok: false,
      reason: `"${CURRENT_LINK}" pointer is dangling (target does not exist)`,
    };
  }
  if (!isSafePath(currentPath, root)) {
    return {
      ok: false,
      reason: `"${CURRENT_LINK}" pointer resolves outside the component root`,
    };
  }

  let versionDir: string;
  try {
    versionDir = realpathSync(currentPath);
    if (!statSync(versionDir).isDirectory()) {
      return { ok: false, reason: `"${CURRENT_LINK}" is not a directory` };
    }
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `"${CURRENT_LINK}" pointer unresolvable: ${errorMessage(error)}`,
    };
  }

  let versionsDir: string;
  try {
    versionsDir = realpathSync(path.join(componentDir, VERSIONS_DIR));
  } catch (_error) {
    return { ok: false, reason: `no "${VERSIONS_DIR}" directory` };
  }
  if (path.dirname(versionDir) !== versionsDir) {
    return {
      ok: false,
      reason: `"${CURRENT_LINK}" must point at a directory inside "${VERSIONS_DIR}"`,
    };
  }

  return { ok: true, versionDir, versionDirName: path.basename(versionDir) };
}

/**
 * Discover components under the given roots, in order. A missing root
 * contributes nothing. Never throws.
 */
export function discoverComponents(roots: readonly string[]): DiscoveryResult {
  const found: DiscoveredComponent[] = [];
  const skipped: SkippedComponent[] = [];
  const shadowed: ShadowedComponent[] = [];
  const seen = new Map<string, string>();

  for (const rawRoot of roots) {
    const root = path.resolve(rawRoot);
    let entries: string[];
    try {
      entries = readdirSync(root).sort();
    } catch (_error) {
      continue;
    }

    for (const name of entries) {
      if (name.startsWith(".")) {
        continue;
      }
      const componentDir = path.join(root, name);
      try {
        if (!statSync(componentDir).isDirectory()) {
          continue;
        }
      } catch (_error) {
        continue;
      }

      if (!COMPONENT_NAME_PATTERN.test(name)) {
        skipped.push({
          name,
          root,
          reason: `directory name does not match ${COMPONENT_NAME_PATTERN}`,
        });
        continue;
      }
      const earlier = seen.get(name);
      if (earlier !== undefined) {
        shadowed.push({ name, root, shadowedBy: earlier });
        continue;
      }
      if (!isSafePath(componentDir, root)) {
        skipped.push({
          name,
          root,
          reason: "component directory resolves outside the component root",
        });
        continue;
      }

      const current = resolveCurrentVersion(root, name);
      if (!current.ok) {
        skipped.push({ name, root, reason: current.reason });
        continue;
      }

      const described = describeComponentVersion(
        root,
        name,
        current.versionDir,
        current.versionDirName,
      );
      if (!described.ok) {
        skipped.push({ name, root, reason: described.reason });
        continue;
      }

      found.push(described.component);
      seen.set(name, root);
    }
  }

  return { found, skipped, shadowed };
}
