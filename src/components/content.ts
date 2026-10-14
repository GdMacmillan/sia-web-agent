/**
 * Content components — skills and prompts as component versions.
 *
 * Each skill directory and each prompt file is its own component:
 * `skill-<dir>` and `prompt-<role>`. The files shipped with the source tree
 * (`skills/<dir>/`, `prompts/<role>.md`) are the seed, read in place at the
 * synthetic version `1.0.0`; a host version lives where every other
 * component version does, `<root>/<name>/.versions/<v>/`, holding its
 * `component.json` and the content (`SKILL.md` plus the skill's supporting
 * files, or `prompt.md`). See `docs/COMPONENTS.md` §Skills and prompts.
 *
 * Everything here reads the filesystem only and never throws.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { getAgentPackageRoot } from "../utils/path-utils.js";
import { logger } from "../utils/logger.js";
import {
  MANIFEST_FILE,
  describeComponentVersion,
  resolveCurrentVersion,
} from "./discovery.js";
import {
  COMPONENT_NAME_PATTERN,
  CONTENT_ENTRY_FILES,
  CONTENT_KINDS,
  CONTENT_NAME_PREFIXES,
  PROMPT_ROLES,
  isPromptRole,
  type ComponentManifest,
  type ContentKind,
} from "./manifest.js";
import { checkContent } from "./content-contract.js";
import { currentComponentRoots } from "./roots.js";

/** The version every in-place seed skill and prompt is read at. */
export const SEED_CONTENT_VERSION = "1.0.0";
/** The `sdk` range a content manifest carries (unused for content; the schema requires one). */
export const CONTENT_SDK_RANGE = "^1.0.0";
/** Who the synthetic seed manifest names as its producer. */
export const SEED_PRODUCED_BY = "source tree";

/** `skill-<base>` / `prompt-<base>`. */
export function contentComponentName(kind: ContentKind, base: string): string {
  return `${CONTENT_NAME_PREFIXES[kind]}${base}`;
}

/**
 * The kind and base of a content component name, or null when `name` is
 * not one: `skill-<dir>` with a valid directory name, or `prompt-<role>`
 * for a role the agent loads.
 */
export function parseContentComponentName(
  name: unknown,
): { kind: ContentKind; base: string } | null {
  if (typeof name !== "string" || !COMPONENT_NAME_PATTERN.test(name)) {
    return null;
  }
  for (const kind of CONTENT_KINDS) {
    const prefix = CONTENT_NAME_PREFIXES[kind];
    if (!name.startsWith(prefix)) {
      continue;
    }
    const base = name.slice(prefix.length);
    if (kind === "prompt") {
      return isPromptRole(base) ? { kind, base } : null;
    }
    return COMPONENT_NAME_PATTERN.test(base) ? { kind, base } : null;
  }
  return null;
}

/** The directory holding `skills/` and `prompts/` (the source tree). */
export function contentSeedRoot(): string {
  return getAgentPackageRoot();
}

/** Where the in-place seed of a content component lives. */
export function seedContentPath(
  kind: ContentKind,
  base: string,
  seedRoot: string = contentSeedRoot(),
): string {
  return kind === "skill"
    ? path.join(seedRoot, "skills", base)
    : path.join(seedRoot, "prompts", `${base}.md`);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch (_error) {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch (_error) {
    return false;
  }
}

/** Whether `base` has an in-place seed of `kind`. */
export function hasSeedContent(
  kind: ContentKind,
  base: string,
  seedRoot: string = contentSeedRoot(),
): boolean {
  if (kind === "prompt") {
    return isPromptRole(base) && isFile(seedContentPath(kind, base, seedRoot));
  }
  if (!COMPONENT_NAME_PATTERN.test(base)) {
    return false;
  }
  const dir = seedContentPath(kind, base, seedRoot);
  return isDirectory(dir) && isFile(path.join(dir, CONTENT_ENTRY_FILES.skill));
}

/**
 * The bases with an in-place seed, sorted: every skill directory carrying a
 * `SKILL.md` whose name is a valid component name, or every prompt role
 * whose file exists.
 */
export function listSeedContent(
  kind: ContentKind,
  seedRoot: string = contentSeedRoot(),
): string[] {
  if (kind === "prompt") {
    return PROMPT_ROLES.filter((role) =>
      hasSeedContent("prompt", role, seedRoot),
    );
  }
  let entries: string[];
  try {
    entries = readdirSync(path.join(seedRoot, "skills")).sort();
  } catch (_error) {
    return [];
  }
  return entries.filter(
    (entry) =>
      !entry.startsWith(".") && hasSeedContent("skill", entry, seedRoot),
  );
}

/** One file of a content version. */
export interface ContentFile {
  /** Path relative to the version (a prompt seed's file reads as `prompt.md`). */
  rel: string;
  /** Absolute path on disk. */
  abs: string;
  /** Whether the entry is a symbolic link (refused by the contract, never followed). */
  symlink: boolean;
}

/**
 * Every file under `dir`, relative paths sorted, links reported rather
 * than followed. Hidden entries are never part of a content version, and
 * the manifest is excluded at the top level.
 */
export function walkContentDir(dir: string): ContentFile[] {
  const files: ContentFile[] = [];
  const walk = (current: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) {
        continue;
      }
      if (prefix === "" && entry === MANIFEST_FILE) {
        continue;
      }
      const abs = path.join(current, entry);
      const rel = prefix === "" ? entry : `${prefix}/${entry}`;
      let stat;
      try {
        stat = lstatSync(abs);
      } catch (_error) {
        continue;
      }
      if (stat.isSymbolicLink()) {
        files.push({ rel, abs, symlink: true });
      } else if (stat.isDirectory()) {
        walk(abs, rel);
      } else if (stat.isFile()) {
        files.push({ rel, abs, symlink: false });
      }
    }
  };
  walk(dir, "");
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** A content version as served: where it came from and what it consists of. */
export interface ContentSource {
  kind: ContentKind;
  base: string;
  /** The component name (`skill-<base>` / `prompt-<base>`). */
  name: string;
  version: string;
  /** `version`: a host version under a component root; `seed`: the file shipped with the source tree. */
  origin: "version" | "seed";
  /**
   * The directory a skill's supporting files resolve against: the version
   * directory, or the seed skill directory. For a prompt seed, the
   * `prompts/` directory.
   */
  dir: string;
  /** The file that is served: `SKILL.md`, `prompt.md` or `prompts/<role>.md`. */
  file: string;
  /** Every file the version consists of. */
  files: ContentFile[];
}

/** The in-place seed of a content component, or null when it has none. */
export function seedContentSource(
  kind: ContentKind,
  base: string,
  seedRoot: string = contentSeedRoot(),
): ContentSource | null {
  if (!hasSeedContent(kind, base, seedRoot)) {
    return null;
  }
  const name = contentComponentName(kind, base);
  if (kind === "prompt") {
    const file = seedContentPath(kind, base, seedRoot);
    return {
      kind,
      base,
      name,
      version: SEED_CONTENT_VERSION,
      origin: "seed",
      dir: path.dirname(file),
      file,
      files: [{ rel: CONTENT_ENTRY_FILES.prompt, abs: file, symlink: false }],
    };
  }
  const dir = seedContentPath(kind, base, seedRoot);
  return {
    kind,
    base,
    name,
    version: SEED_CONTENT_VERSION,
    origin: "seed",
    dir,
    file: path.join(dir, CONTENT_ENTRY_FILES.skill),
    files: walkContentDir(dir),
  };
}

/** A host version of a content component, read from its version directory. */
export function versionContentSource(
  kind: ContentKind,
  base: string,
  version: string,
  versionDir: string,
): ContentSource {
  return {
    kind,
    base,
    name: contentComponentName(kind, base),
    version,
    origin: "version",
    dir: versionDir,
    file: path.join(versionDir, CONTENT_ENTRY_FILES[kind]),
    files: walkContentDir(versionDir),
  };
}

/**
 * One digest over every file of a content version (relative path and
 * bytes, in order), hex. Two sources with the same files hash the same
 * wherever they live.
 */
export function contentDigest(source: ContentSource): string {
  const hash = createHash("sha256");
  for (const file of source.files) {
    hash.update(file.rel).update("\u0000");
    try {
      hash.update(readFileSync(file.abs));
    } catch (_error) {
      hash.update("unreadable");
    }
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/**
 * A hidden file in a content version naming the digest of the in-place
 * seed its lineage started from. Written when a version is prepared from
 * the seed and carried forward to every version prepared after it, so a
 * later change to the source tree's copy can be noticed. Hidden, so it is
 * never part of the content, its contract or its diff.
 */
export const SEED_BASELINE_FILE = ".seed-digest";

/** The seed digest a version's lineage started from, or null when it records none. */
export function readSeedBaseline(versionDir: string): string | null {
  try {
    const value = readFileSync(
      path.join(versionDir, SEED_BASELINE_FILE),
      "utf-8",
    ).trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  } catch (_error) {
    return null;
  }
}

/**
 * The manifest an in-place seed would carry, for the places that describe
 * a version by its manifest (lineage, `describe_component`).
 */
export function seedContentManifest(
  kind: ContentKind,
  base: string,
): ComponentManifest {
  return {
    name: contentComponentName(kind, base),
    version: SEED_CONTENT_VERSION,
    kind,
    intent:
      kind === "skill"
        ? `The ${base} skill as shipped with the source tree.`
        : `The ${base} prompt as shipped with the source tree.`,
    sdk: CONTENT_SDK_RANGE,
    entry: CONTENT_ENTRY_FILES[kind],
    contract: "contract.ts",
    depth: 0,
    lineage: { producedBy: SEED_PRODUCED_BY },
  };
}

const warned = new Set<string>();

function warnOnce(
  key: string,
  fields: Record<string, unknown>,
  message: string,
): void {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  logger.warn(fields, message);
}

/** Forget which fallbacks were already logged (tests). */
export function _resetContentWarningsForTests(): void {
  warned.clear();
}

export interface ResolveContentOptions {
  /** Component roots in precedence order (default: the roots as they are now). */
  roots?: readonly string[];
  /** Where `skills/` and `prompts/` live (default: the source tree). */
  seedRoot?: string;
}

function defaultRoots(): string[] {
  try {
    return currentComponentRoots();
  } catch (_error) {
    return [];
  }
}

/**
 * What to serve for a skill or prompt: the activated host version when one
 * resolves and passes its check, else the in-place seed. The first root
 * that carries the component with a `current` pointer decides; one with
 * only staged versions (a candidate) is passed over. A broken pointer, a
 * manifest of another kind or a failing check is logged once and the seed
 * is served. Null only when there is neither. Never throws.
 */
export function resolveContent(
  kind: ContentKind,
  base: string,
  opts: ResolveContentOptions = {},
): ContentSource | null {
  const seedRoot = opts.seedRoot ?? contentSeedRoot();
  const seed = (): ContentSource | null =>
    seedContentSource(kind, base, seedRoot);
  try {
    const name = contentComponentName(kind, base);
    if (!COMPONENT_NAME_PATTERN.test(name)) {
      return null;
    }
    const roots = opts.roots ?? defaultRoots();
    for (const rawRoot of roots) {
      const root = path.resolve(rawRoot);
      if (!existsSync(path.join(root, name))) {
        continue;
      }
      const pointer = resolveCurrentVersion(root, name);
      if (!pointer.ok) {
        if (pointer.reason.startsWith("no ")) {
          // Staged versions only: nothing activated here.
          continue;
        }
        warnOnce(
          `${root}\u0000${name}\u0000pointer`,
          { component: name, root, reason: pointer.reason },
          "content component pointer unusable; serving the seed",
        );
        return seed();
      }
      const described = describeComponentVersion(
        root,
        name,
        pointer.versionDir,
        pointer.versionDirName,
      );
      if (!described.ok) {
        warnOnce(
          `${root}\u0000${name}\u0000${pointer.versionDirName}`,
          { component: name, root, reason: described.reason },
          "content component version unusable; serving the seed",
        );
        return seed();
      }
      if (described.component.manifest.kind !== kind) {
        warnOnce(
          `${root}\u0000${name}\u0000kind`,
          { component: name, root, kind: described.component.manifest.kind },
          "content component has the wrong kind; serving the seed",
        );
        return seed();
      }
      const source = versionContentSource(
        kind,
        base,
        described.component.manifest.version,
        described.component.versionDir,
      );
      // Re-checked at serve time: an activated version that no longer
      // passes (a hand edit, a stricter check) is never served.
      const problems = checkContent(source);
      if (problems.length > 0) {
        warnOnce(
          `${root}\u0000${name}\u0000${source.version}\u0000check`,
          { component: name, version: source.version, problems },
          "activated content version fails its contract; serving the seed",
        );
        return seed();
      }
      return source;
    }
    return seed();
  } catch (error: unknown) {
    warnOnce(
      `${kind}\u0000${base}\u0000error`,
      {
        kind,
        base,
        error: error instanceof Error ? error.message : String(error),
      },
      "content resolution failed; serving the seed",
    );
    try {
      return seed();
    } catch (_error) {
      return null;
    }
  }
}

/**
 * The skill bases to list, sorted: every seed skill plus every
 * `skill-<base>` component a root resolves a `current` pointer for.
 */
export function listEffectiveSkillBases(
  opts: ResolveContentOptions = {},
): string[] {
  const seedRoot = opts.seedRoot ?? contentSeedRoot();
  const bases = new Set(listSeedContent("skill", seedRoot));
  const prefix = CONTENT_NAME_PREFIXES.skill;
  for (const rawRoot of opts.roots ?? defaultRoots()) {
    const root = path.resolve(rawRoot);
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const parsed = parseContentComponentName(entry);
      if (
        parsed === null ||
        parsed.kind !== "skill" ||
        !entry.startsWith(prefix)
      ) {
        continue;
      }
      if (resolveCurrentVersion(root, entry).ok) {
        bases.add(parsed.base);
      }
    }
  }
  return [...bases].sort();
}
