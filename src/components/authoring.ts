/**
 * Authoring helpers — the pure, filesystem-level half of writing a new
 * component version, or the first version of a new component. See
 * `docs/COMPONENTS.md` §Authoring a version and §Authoring a new component.
 *
 * A new version is always written under the host-managed root, never the
 * seed root shipped with the source tree, and never touches `current`:
 * promoting a version is the host's deliberate, separate act.
 *
 * Every function here returns a result object and never throws.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import semver from "semver";
import { isSafePath } from "../utils/skills-loader.js";
import {
  CURRENT_LINK,
  MANIFEST_FILE,
  VERSIONS_DIR,
  describeComponentVersion,
  discoverComponents,
  type DiscoveredComponent,
} from "./discovery.js";
import { COMPONENT_NAME_PATTERN, type ComponentManifest } from "./manifest.js";
import {
  NEW_COMPONENT_VERSION,
  TOOL_NAME_PATTERN,
  defaultToolName,
  newComponentManifest,
  stubContractSource,
  stubEntrySource,
} from "./scaffold.js";

/** How far a version number moves for a new component version. */
export const VERSION_BUMPS = ["patch", "minor", "major"] as const;
export type VersionBump = (typeof VERSION_BUMPS)[number];

/** Directories never copied along with a version (scratch state). */
const SKIPPED_DIR_NAMES = new Set([".code-workspace", "node_modules"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The next version after `version` for the given bump, or null when invalid. */
export function bumpVersion(version: string, bump: VersionBump): string | null {
  if (!VERSION_BUMPS.includes(bump)) {
    return null;
  }
  return semver.inc(version, bump);
}

/** Whether `value` is a version bump name. */
export function isVersionBump(value: unknown): value is VersionBump {
  return (
    typeof value === "string" && (VERSION_BUMPS as readonly string[]).includes(value)
  );
}

/**
 * The version directories present under `<componentDir>/.versions/`,
 * valid versions first in ascending order, then anything else by name.
 */
export function listComponentVersions(componentDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(path.join(componentDir, VERSIONS_DIR)).filter((name) => {
      try {
        return statSync(path.join(componentDir, VERSIONS_DIR, name)).isDirectory();
      } catch (_error) {
        return false;
      }
    });
  } catch (_error) {
    return [];
  }
  const valid = names.filter((name) => semver.valid(name) !== null);
  const other = names.filter((name) => semver.valid(name) === null).sort();
  return [...semver.sort(valid), ...other];
}

export interface DescribeComponentInput {
  name: string;
  /** Roots in precedence order (highest first). */
  roots: readonly string[];
}

export interface ComponentDescription {
  name: string;
  /** The root whose copy of the component wins. */
  root: string;
  /** Lower-precedence roots that also carry the component. */
  shadowedRoots: string[];
  componentDir: string;
  currentVersion: string;
  /** Every version directory present under the winning root. */
  versions: string[];
  manifest: ComponentManifest;
  versionDir: string;
  entryPath: string;
  contractPath: string;
}

export type DescribeComponentResult =
  | { ok: true; description: ComponentDescription }
  | { ok: false; reason: string };

function findComponent(
  name: string,
  roots: readonly string[],
): { ok: true; component: DiscoveredComponent; shadowedRoots: string[] } | { ok: false; reason: string } {
  if (typeof name !== "string" || !COMPONENT_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `invalid component name "${String(name)}"` };
  }
  if (roots.length === 0) {
    return { ok: false, reason: "no component roots are present" };
  }
  const discovery = discoverComponents(roots);
  const component = discovery.found.find((c) => c.manifest.name === name);
  if (component === undefined) {
    const skipped = discovery.skipped.find((c) => c.name === name);
    if (skipped !== undefined) {
      // A component with versions staged but nothing live yet — a new
      // component before its first activation, or one whose first version
      // the host took back — is not a mystery: say what is there and how a
      // version there runs.
      const versions = listComponentVersions(path.join(skipped.root, name));
      return {
        ok: false,
        reason:
          `component "${name}" under ${skipped.root} is unusable: ${skipped.reason}; ` +
          `versions present: ${versions.join(", ") || "none"}. ` +
          "A version there runs via run_component_contract with an explicit version; " +
          "it becomes current only when the host activates it.",
      };
    }
    return { ok: false, reason: `unknown component "${name}"` };
  }
  const shadowedRoots = discovery.shadowed
    .filter((s) => s.name === name)
    .map((s) => s.root);
  return { ok: true, component, shadowedRoots };
}

/**
 * Describe the component `name` as the loader sees it: which root wins,
 * which roots are shadowed, the current version, the versions present and
 * the paths. Never throws.
 */
export function describeComponent(
  input: DescribeComponentInput,
): DescribeComponentResult {
  const found = findComponent(input.name, input.roots);
  if (!found.ok) {
    return found;
  }
  const { component, shadowedRoots } = found;
  return {
    ok: true,
    description: {
      name: component.manifest.name,
      root: component.root,
      shadowedRoots,
      componentDir: component.componentDir,
      currentVersion: component.manifest.version,
      versions: listComponentVersions(component.componentDir),
      manifest: component.manifest,
      versionDir: component.versionDir,
      entryPath: component.entryPath,
      contractPath: component.contractPath,
    },
  };
}

export interface ReadComponentVersionInput {
  name: string;
  version: string;
  /** Roots in precedence order; the first that carries `<name>/` is used. */
  roots: readonly string[];
}

export type ReadComponentVersionResult =
  | { ok: true; component: DiscoveredComponent }
  | { ok: false; reason: string };

/**
 * Resolve `<root>/<name>/.versions/<version>/` under the first root that
 * carries `<name>/`, whether or not `current` points at it. Never throws.
 */
export function readComponentVersion(
  input: ReadComponentVersionInput,
): ReadComponentVersionResult {
  const { name, version, roots } = input;
  if (typeof name !== "string" || !COMPONENT_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `invalid component name "${String(name)}"` };
  }
  if (typeof version !== "string" || semver.valid(version) === null) {
    return { ok: false, reason: `invalid version "${String(version)}"` };
  }
  for (const rawRoot of roots) {
    const root = path.resolve(rawRoot);
    const componentDir = path.join(root, name);
    if (!existsSync(componentDir)) {
      continue;
    }
    if (!isSafePath(componentDir, root)) {
      return {
        ok: false,
        reason: "component directory resolves outside the component root",
      };
    }
    const target = path.join(componentDir, VERSIONS_DIR, version);
    if (!existsSync(target)) {
      return {
        ok: false,
        reason: `version "${version}" of "${name}" not found`,
      };
    }
    if (!isSafePath(target, root)) {
      return {
        ok: false,
        reason: `version "${version}" resolves outside the component root`,
      };
    }
    let versionDir: string;
    try {
      versionDir = realpathSync(target);
      if (!statSync(versionDir).isDirectory()) {
        return { ok: false, reason: `version "${version}" is not a directory` };
      }
    } catch (error: unknown) {
      return { ok: false, reason: errorMessage(error) };
    }
    return describeComponentVersion(root, name, versionDir, version);
  }
  return { ok: false, reason: `unknown component "${name}"` };
}

export interface PlanComponentVersionInput {
  name: string;
  /** Roots in precedence order, as the loader sees them. */
  roots: readonly string[];
  /** The host-managed root new versions are written under. Undefined = none configured. */
  authoringRoot: string | undefined;
  /** The seed root shipped with the source tree; authoring there is refused. */
  seedRoot?: string | undefined;
  bump?: VersionBump;
  /** The need that prompted the version, in the author's words. */
  need: string;
  /** Who produces it (an agent id, a person, a tool). */
  producedBy: string;
}

export interface PlannedComponentVersion {
  name: string;
  /** The root the version was written under (the authoring root, resolved). */
  root: string;
  previousVersion: string;
  nextVersion: string;
  versionDir: string;
  manifestPath: string;
  entryPath: string;
  contractPath: string;
  /** Whether the component was copied into the authoring root by this call. */
  copied: boolean;
}

export type PlanComponentVersionResult =
  | { ok: true; plan: PlannedComponentVersion }
  | { ok: false; reason: string };

/** Copy a directory tree, leaving scratch directories behind. */
function copyTree(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    errorOnExist: false,
    force: false,
    filter: (source) => !SKIPPED_DIR_NAMES.has(path.basename(source)),
  });
}

function sameRealpath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch (_error) {
    return false;
  }
}

/**
 * Resolve and create the root new versions are written under. Refuses an
 * unconfigured root and the seed root shipped with the source tree (also
 * when reached through a link). `what` names the thing that has nowhere
 * to go in the first refusal ("a new version", "a new component").
 */
function resolveAuthoringRoot(
  authoringRoot: string | undefined,
  seedRoot: string | undefined,
  what: string,
): { ok: true; root: string } | { ok: false; reason: string } {
  if (authoringRoot === undefined || authoringRoot === "") {
    return {
      ok: false,
      reason: `no host-managed component root is configured (SIA_COMPONENTS_DIR); ${what} has nowhere to go`,
    };
  }
  const root = path.resolve(authoringRoot);
  try {
    mkdirSync(root, { recursive: true });
    if (!statSync(root).isDirectory()) {
      return { ok: false, reason: `authoring root is not a directory: ${root}` };
    }
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `cannot create authoring root ${root}: ${errorMessage(error)}`,
    };
  }
  if (seedRoot !== undefined && sameRealpath(root, seedRoot)) {
    return {
      ok: false,
      reason:
        "the authoring root is the seed root shipped with the source tree; new versions must go under the host-managed root",
    };
  }
  return { ok: true, root };
}

/**
 * Lay out the next version of component `name` under the authoring root:
 * copy the whole component directory there when it is not there yet (so the
 * previous version and its `current` pointer travel with it), then write
 * `.versions/<next>/` from the current version with its manifest rewritten
 * (`version`, `lineage.parent`, `lineage.need`, `lineage.producedBy`).
 *
 * Never rewrites `current`. Never throws.
 */
export function planComponentVersion(
  input: PlanComponentVersionInput,
): PlanComponentVersionResult {
  const { name, roots, seedRoot, need, producedBy } = input;
  const bump = input.bump ?? "patch";

  if (typeof name !== "string" || !COMPONENT_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `invalid component name "${String(name)}"` };
  }
  if (!isVersionBump(bump)) {
    return { ok: false, reason: `invalid version bump "${String(bump)}"` };
  }
  if (typeof need !== "string" || need.trim() === "") {
    return { ok: false, reason: "the need must be stated (non-empty)" };
  }
  if (typeof producedBy !== "string" || producedBy.trim() === "") {
    return { ok: false, reason: "producedBy must be non-empty" };
  }
  const resolvedRoot = resolveAuthoringRoot(input.authoringRoot, seedRoot, "a new version");
  if (!resolvedRoot.ok) {
    return resolvedRoot;
  }
  const authoringRoot = resolvedRoot.root;

  const found = findComponent(name, roots);
  if (!found.ok) {
    return found;
  }
  const { component } = found;
  const previousVersion = component.manifest.version;
  const componentDir = path.join(authoringRoot, name);

  // The next number follows the highest version already present under the
  // authoring copy — candidates still awaiting activation included — and
  // never falls below the current one, so back-to-back candidates number
  // 0.1.1, 0.1.2, … The parent stays the version the code is copied from.
  const highestPresent = existsSync(componentDir)
    ? listComponentVersions(componentDir)
        .filter((v) => semver.valid(v) !== null)
        .reduce<string | null>(
          (acc, v) => (acc === null || semver.gt(v, acc) ? v : acc),
          null,
        )
    : null;
  const base =
    highestPresent !== null && semver.gt(highestPresent, previousVersion)
      ? highestPresent
      : previousVersion;
  const nextVersion = bumpVersion(base, bump);
  if (nextVersion === null) {
    return {
      ok: false,
      reason: `cannot bump version "${base}" (${bump})`,
    };
  }

  const versionDir = path.join(componentDir, VERSIONS_DIR, nextVersion);
  if (existsSync(versionDir)) {
    return {
      ok: false,
      reason: `version ${nextVersion} of "${name}" already exists at ${versionDir}; bump differently or remove it`,
    };
  }

  let copied = false;
  try {
    if (!existsSync(componentDir)) {
      copyTree(component.componentDir, componentDir);
      copied = true;
    } else if (!isSafePath(componentDir, authoringRoot)) {
      return {
        ok: false,
        reason: "component directory resolves outside the authoring root",
      };
    }
    mkdirSync(path.join(componentDir, VERSIONS_DIR), { recursive: true });
    copyTree(component.versionDir, versionDir);

    const manifestPath = path.join(versionDir, MANIFEST_FILE);
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const lineage =
      raw.lineage !== null && typeof raw.lineage === "object"
        ? (raw.lineage as Record<string, unknown>)
        : {};
    const rewritten: Record<string, unknown> = {
      ...raw,
      version: nextVersion,
      lineage: {
        ...lineage,
        parent: `${name}@${previousVersion}`,
        need: need.trim(),
        producedBy: producedBy.trim(),
      },
    };
    writeFileSync(manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`);

    const entry =
      typeof raw.entry === "string" && raw.entry !== "" ? raw.entry : "entry.ts";
    const contract =
      typeof raw.contract === "string" && raw.contract !== ""
        ? raw.contract
        : "contract.ts";

    return {
      ok: true,
      plan: {
        name,
        root: authoringRoot,
        previousVersion,
        nextVersion,
        versionDir,
        manifestPath,
        entryPath: path.resolve(versionDir, entry),
        contractPath: path.resolve(versionDir, contract),
        copied,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `could not write version ${nextVersion} of "${name}": ${errorMessage(error)}`,
    };
  }
}

export interface PlanNewComponentInput {
  /** The new component's name (directory name and registry key). */
  name: string;
  /** Every root that may already carry a component of that name. */
  roots: readonly string[];
  /** The host-managed root the component is written under. */
  authoringRoot: string | undefined;
  /** The seed root shipped with the source tree (refused as an authoring root). */
  seedRoot?: string;
  /** One paragraph, for a person: what the component is for. */
  intent: string;
  /** The need that prompted it, in the words of whoever raised it. */
  need: string;
  producedBy: string;
  /** The tool the entry contributes (default: the name with `-` → `_`). */
  toolName?: string;
  /** The tool's description for the model (default: the intent). */
  description?: string;
  /** Tool names already in use; a collision is refused before anything is written. */
  reservedToolNames?: Iterable<string>;
}

export interface PlannedNewComponent {
  name: string;
  /** The root the component was written under. */
  root: string;
  version: string;
  toolName: string;
  componentDir: string;
  versionDir: string;
  manifestPath: string;
  entryPath: string;
  contractPath: string;
}

export type PlanNewComponentResult =
  | { ok: true; plan: PlannedNewComponent }
  | { ok: false; reason: string };

/**
 * Lay out the first version of a brand-new component under `authoringRoot`:
 * `<root>/<name>/.versions/0.1.0/` with a manifest (`kind: tools`, no
 * parent), an entry contributing one stub tool that echoes its input, and a
 * contract that invokes it — a version whose contract passes as written.
 *
 * Refuses a name any root already carries (that is a new version of an
 * existing component, `planComponentVersion`'s job), a tool name already
 * taken, and the same roots `planComponentVersion` refuses. Every check
 * runs before anything is written. Never writes `current`. Never throws.
 */
export function planNewComponent(input: PlanNewComponentInput): PlanNewComponentResult {
  const { name, roots, seedRoot } = input;
  const intent = typeof input.intent === "string" ? input.intent.trim() : "";
  const need = typeof input.need === "string" ? input.need.trim() : "";
  const producedBy = typeof input.producedBy === "string" ? input.producedBy.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";

  if (typeof name !== "string" || !COMPONENT_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `invalid component name "${String(name)}"` };
  }
  const toolName =
    typeof input.toolName === "string" && input.toolName.trim() !== ""
      ? input.toolName.trim()
      : defaultToolName(name);
  if (!TOOL_NAME_PATTERN.test(toolName)) {
    return {
      ok: false,
      reason: `invalid tool name "${toolName}" (lower-case letters, digits and underscores, starting with a letter)`,
    };
  }
  if (input.reservedToolNames !== undefined && new Set(input.reservedToolNames).has(toolName)) {
    return {
      ok: false,
      reason: `tool name "${toolName}" is already taken by a tool the agent has; choose another tool_name`,
    };
  }
  if (intent === "") {
    return { ok: false, reason: "the intent must be stated (non-empty)" };
  }
  if (need === "") {
    return { ok: false, reason: "the need must be stated (non-empty)" };
  }
  if (producedBy === "") {
    return { ok: false, reason: "producedBy must be non-empty" };
  }

  const resolvedRoot = resolveAuthoringRoot(input.authoringRoot, seedRoot, "a new component");
  if (!resolvedRoot.ok) {
    return resolvedRoot;
  }
  const authoringRoot = resolvedRoot.root;

  // A directory of that name anywhere — with or without a `current` — is
  // an existing component, however far it got. Creating it again would
  // either shadow it or collide with it.
  for (const root of [authoringRoot, ...roots]) {
    const existingDir = path.join(root, name);
    if (!existsSync(existingDir)) {
      continue;
    }
    const versions = listComponentVersions(existingDir);
    return {
      ok: false,
      reason:
        `component "${name}" already exists under ${root}; versions present: ${versions.join(", ") || "none"}. ` +
        "A new version of an existing component is prepare_component_version; " +
        "a version already staged runs via run_component_contract with an explicit version.",
    };
  }

  const componentDir = path.join(authoringRoot, name);
  const versionDir = path.join(componentDir, VERSIONS_DIR, NEW_COMPONENT_VERSION);
  const manifestPath = path.join(versionDir, MANIFEST_FILE);
  const entryPath = path.join(versionDir, "entry.ts");
  const contractPath = path.join(versionDir, "contract.ts");

  try {
    mkdirSync(versionDir, { recursive: true });
    // The name pattern admits no separators; this is the belt to that
    // brace, checked once the directory exists to resolve.
    if (!isSafePath(componentDir, authoringRoot)) {
      return { ok: false, reason: "component directory resolves outside the authoring root" };
    }
    const manifest = newComponentManifest({ name, intent, need, producedBy });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(entryPath, stubEntrySource(toolName, description || intent));
    writeFileSync(contractPath, stubContractSource(toolName));
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `could not write ${name}@${NEW_COMPONENT_VERSION}: ${errorMessage(error)}`,
    };
  }

  return {
    ok: true,
    plan: {
      name,
      root: authoringRoot,
      version: NEW_COMPONENT_VERSION,
      toolName,
      componentDir,
      versionDir,
      manifestPath,
      entryPath,
      contractPath,
    },
  };
}

/** The pointer file/link name, re-exported for callers that report on it. */
export { CURRENT_LINK };
