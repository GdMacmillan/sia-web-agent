/**
 * Component roots — where components are looked for, in precedence order.
 * Kept apart from assembly so the content resolver (skills and prompts)
 * can ask without pulling in the loader.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import { getProjectRoot } from "../utils/path-utils.js";
import { getActiveComponents } from "./registry.js";

/** The seed root, relative to the project root. */
export const SEED_COMPONENTS_DIRNAME = "components";

export interface ResolveComponentRootsInput {
  projectRoot: string;
  /** The host-managed root (`SIA_COMPONENTS_DIR`), when set. */
  componentsDir?: string | undefined;
}

/**
 * The component roots that exist on disk, highest precedence first:
 * the host-managed root, then the seed root shipped with the source tree.
 */
export function resolveComponentRoots(
  input: ResolveComponentRootsInput,
): string[] {
  const candidates = [
    input.componentsDir,
    path.join(input.projectRoot, SEED_COMPONENTS_DIRNAME),
  ];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const resolved = path.resolve(candidate);
    let real: string;
    try {
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        continue;
      }
      real = realpathSync(resolved);
    } catch (_error) {
      continue;
    }
    if (seen.has(real)) {
      continue;
    }
    seen.add(real);
    roots.push(resolved);
  }
  return roots;
}

/**
 * The roots to search, in precedence order: the host-managed root as
 * configured now (so one that appeared after assembly is searched, and a
 * version written into it during this process can be checked), then the
 * roots recorded at assembly, then whatever else exists on disk now.
 * Deduplicated by real path.
 */
export function currentComponentRoots(): string[] {
  const componentsDir = getConfig().runtime.componentsDir;
  const now = resolveComponentRoots({
    projectRoot: getProjectRoot(),
    componentsDir,
  });
  const host =
    componentsDir === undefined
      ? []
      : now.filter((root) => root === path.resolve(componentsDir));
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const root of [...host, ...getActiveComponents().roots, ...now]) {
    let key: string;
    try {
      key = realpathSync(root);
    } catch (_error) {
      key = path.resolve(root);
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

