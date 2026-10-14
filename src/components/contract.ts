/**
 * Contract runner — proves a component version works, in-process, through
 * the real tool or middleware it builds. See `docs/COMPONENTS.md` §6.
 *
 * A skill or prompt version has no contract of its own: it is held to the
 * built-in content contract (`content-contract.ts`) instead, with the same
 * result shape, and its in-place seed (`1.0.0`) can be checked too.
 *
 * Fail-closed: every outcome that is not a clean pass is `ok: false` with
 * the error text. The runner never throws.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { getConfig } from "../config/index.js";
import { getProjectRoot } from "../utils/path-utils.js";
import { isSafePath } from "../utils/skills-loader.js";
import {
  SimpleToolRegistry,
  normalizeToolResult,
} from "../code-execution/ipc-bridge.js";
import { currentComponentRoots } from "./roots.js";
import { readComponentVersion } from "./authoring.js";
import {
  describeComponentVersion,
  discoverComponents,
  resolveCurrentVersion,
  type DiscoveredComponent,
} from "./discovery.js";
import {
  SEED_CONTENT_VERSION,
  contentDigest,
  contentSeedRoot,
  parseContentComponentName,
  resolveContent,
  seedContentSource,
  versionContentSource,
  type ContentSource,
} from "./content.js";
import {
  CONTENT_CONTRACT_LABEL,
  CONTENT_CONTRACT_REVISION,
  checkContent,
} from "./content-contract.js";
import {
  defaultImportModule,
  isMiddlewareLike,
  isToolLike,
  type ImportModule,
} from "./loader.js";
import {
  COMPONENT_NAME_PATTERN,
  PROMPT_ROLES,
  isContentKind,
  type ComponentKind,
  type ContentKind,
} from "./manifest.js";
import { getActiveComponents, getActiveToolPool } from "./registry.js";
import {
  SDK_VERSION,
  buildComponentDeps,
  buildInternals,
  type ComponentConfig,
  type ComponentContract,
  type ComponentEntry,
  type ContractDeps,
  type ContractInvoke,
} from "./sdk.js";

/** Default contract timeout. */
export const DEFAULT_CONTRACT_TIMEOUT_MS = 30_000;

/** A file the runner read, identified by its content. */
export interface LoadedFile {
  /** Path relative to the version directory. */
  file: string;
  /** First 12 hex digits of the sha256 of the bytes on disk. */
  sha256: string;
}

export interface ContractResult {
  ok: boolean;
  durationMs: number;
  /** The targeted version, once its manifest parsed; null before that. */
  version: string | null;
  sdkVersion: string;
  /**
   * The entry and contract as they were on disk just before this run
   * imported them; absent when the run stopped before that point.
   */
  loaded?: { entry: LoadedFile; contract: LoadedFile };
  error?: string;
}

export interface RunContractOptions {
  /**
   * Target `<root>/<name>/.versions/<version>/` directly instead of the
   * `current` pointer, so a candidate can be checked before it is activated.
   */
  version?: string;
  timeoutMs?: number;
  importModule?: ImportModule;
  /** Overrides the per-agent config handed to the component. */
  config?: ComponentConfig;
  /**
   * Skill and prompt components only: the roots to search (default: the
   * roots as they are now) and where the in-place seeds live (default: the
   * source tree).
   */
  contentRoots?: readonly string[];
  contentSeedRoot?: string;
}

type ResolveTargetResult =
  | { ok: true; component: DiscoveredComponent }
  | { ok: false; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeFile(filePath: string, versionDir: string): LoadedFile {
  let sha256: string;
  try {
    sha256 = createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 12);
  } catch (_error) {
    sha256 = "unreadable";
  }
  return { file: path.relative(versionDir, filePath), sha256 };
}

/** Resolve `name` (and optionally `version`) to a described component. */
function resolveTarget(
  name: string,
  roots: readonly string[],
  version: string | undefined,
): ResolveTargetResult {
  if (version === undefined) {
    const discovery = discoverComponents(roots);
    const found = discovery.found.find((c) => c.manifest.name === name);
    if (found !== undefined) {
      return { ok: true, component: found };
    }
    const skipped = discovery.skipped.find((c) => c.name === name);
    if (skipped !== undefined) {
      return { ok: false, reason: skipped.reason };
    }
    return { ok: false, reason: `unknown component "${name}"` };
  }

  return readComponentVersion({ name, version, roots });
}

/** The tools a component value itself contributes, by kind. */
function ownTools(kind: ComponentKind, value: unknown): StructuredToolInterface[] {
  if (kind === "tools" && Array.isArray(value)) {
    return value.filter(isToolLike);
  }
  if (kind === "middleware" && isMiddlewareLike(value)) {
    const tools = (value as { tools?: unknown }).tools;
    return Array.isArray(tools) ? tools.filter(isToolLike) : [];
  }
  return [];
}

/**
 * Build `invoke` for a contract: the component's own tools take precedence
 * over the assembled agent's pool (so a candidate version is what gets
 * exercised), and every call runs in a scratch thread unless the contract
 * names one.
 */
function buildInvoke(
  name: string,
  kind: ComponentKind,
  value: unknown,
): ContractInvoke {
  // Later entries win in the registry, so the component's own tools go last.
  const registry = new SimpleToolRegistry([
    ...getActiveToolPool(),
    ...ownTools(kind, value),
  ]);
  const defaultThreadId = `contract-${name}-${randomUUID()}`;

  return async (toolName, args, opts) => {
    const tool = registry.getTool(toolName);
    if (tool === undefined) {
      const available = registry.listTools().join(", ") || "(none)";
      throw new Error(`unknown tool "${toolName}"; available: ${available}`);
    }
    const result: unknown = await tool.invoke(args as never, {
      configurable: { thread_id: opts?.threadId ?? defaultThreadId },
    });
    return normalizeToolResult(result);
  };
}

/**
 * Race `promise` against a timer. The timer is unref'd so it never keeps
 * the process alive, and a late rejection after the timer wins is absorbed
 * rather than surfacing as an unhandled rejection.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type ResolveContentTargetResult =
  { ok: true; source: ContentSource } | { ok: false; reason: string };

/**
 * Resolve a skill or prompt component to the version to check: `version`
 * under the first root carrying it (or the in-place seed at `1.0.0`), or,
 * without one, the version a root's `current` names, else the seed.
 */
function resolveContentTarget(
  kind: ContentKind,
  base: string,
  name: string,
  roots: readonly string[],
  seedRoot: string,
  version: string | undefined,
): ResolveContentTargetResult {
  const seed = seedContentSource(kind, base, seedRoot);
  const fromDescribed = (
    component: DiscoveredComponent,
  ): ResolveContentTargetResult =>
    component.manifest.kind === kind
      ? {
          ok: true,
          source: versionContentSource(
            kind,
            base,
            component.manifest.version,
            component.versionDir,
          ),
        }
      : {
          ok: false,
          reason: `"${name}" has kind "${component.manifest.kind}", not "${kind}"`,
        };

  if (version !== undefined) {
    const read = readComponentVersion({ name, version, roots });
    if (read.ok) {
      return fromDescribed(read.component);
    }
    if (version === SEED_CONTENT_VERSION && seed !== null) {
      return { ok: true, source: seed };
    }
    return { ok: false, reason: read.reason };
  }

  for (const rawRoot of roots) {
    const root = path.resolve(rawRoot);
    if (!existsSync(path.join(root, name))) {
      continue;
    }
    const pointer = resolveCurrentVersion(root, name);
    if (!pointer.ok) {
      if (pointer.reason.startsWith("no ")) {
        continue;
      }
      return { ok: false, reason: pointer.reason };
    }
    const described = describeComponentVersion(
      root,
      name,
      pointer.versionDir,
      pointer.versionDirName,
    );
    return described.ok
      ? fromDescribed(described.component)
      : { ok: false, reason: described.reason };
  }
  return seed !== null
    ? { ok: true, source: seed }
    : { ok: false, reason: `unknown component "${name}"` };
}

/** One identity for every file of a content version, so any change shows. */
function describeContent(source: ContentSource): LoadedFile {
  const entry = path.basename(source.file);
  const others = source.files.length - 1;
  return {
    file:
      others > 0
        ? `${entry} (+${others} file${others === 1 ? "" : "s"})`
        : entry,
    sha256: contentDigest(source).slice(0, 12),
  };
}

/** The built-in contract, identified like a file so run history can compare it. */
function describeContentContract(): LoadedFile {
  return {
    file: CONTENT_CONTRACT_LABEL,
    sha256: createHash("sha256")
      .update(`content-contract:${CONTENT_CONTRACT_REVISION}`)
      .digest("hex")
      .slice(0, 12),
  };
}

/**
 * The other prompts as they would be served beside `source`, for the
 * no-duplicate-sentences check.
 */
function otherPrompts(
  source: ContentSource,
  roots: readonly string[],
  seedRoot: string,
): { label: string; text: string }[] {
  const texts: { label: string; text: string }[] = [];
  for (const role of PROMPT_ROLES) {
    if (role === source.base) {
      continue;
    }
    const other = resolveContent("prompt", role, { roots, seedRoot });
    if (other === null) {
      continue;
    }
    try {
      texts.push({
        label: `${other.name}@${other.version}`,
        text: readFileSync(other.file, "utf-8"),
      });
    } catch (_error) {
      // An unreadable neighbour cannot be compared against.
    }
  }
  return texts;
}

/** Hold a skill or prompt version to the built-in content contract. */
function runContentContract(
  kind: ContentKind,
  base: string,
  name: string,
  opts: RunContractOptions,
  started: number,
): ContractResult {
  const roots = opts.contentRoots ?? currentComponentRoots();
  const seedRoot = opts.contentSeedRoot ?? contentSeedRoot();
  const target = resolveContentTarget(
    kind,
    base,
    name,
    roots,
    seedRoot,
    opts.version,
  );
  if (!target.ok) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      version: null,
      sdkVersion: SDK_VERSION,
      error: target.reason,
    };
  }
  const { source } = target;
  const loaded = {
    entry: describeContent(source),
    contract: describeContentContract(),
  };
  const problems = checkContent(source, {
    ...(kind === "prompt"
      ? { otherPrompts: otherPrompts(source, roots, seedRoot) }
      : {}),
  });
  return {
    ok: problems.length === 0,
    durationMs: Date.now() - started,
    version: source.version,
    sdkVersion: SDK_VERSION,
    loaded,
    ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
  };
}

/**
 * Run the contract of component `name`. Targets the `current` version by
 * default, or `opts.version` under the first root that carries the
 * component. Never throws.
 */
export async function runComponentContract(
  name: string,
  opts: RunContractOptions = {},
): Promise<ContractResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONTRACT_TIMEOUT_MS;
  let version: string | null = null;
  let loaded: ContractResult["loaded"];

  const fail = (error: string): ContractResult => ({
    ok: false,
    durationMs: Date.now() - started,
    version,
    sdkVersion: SDK_VERSION,
    ...(loaded !== undefined ? { loaded } : {}),
    error,
  });

  try {
    if (typeof name !== "string" || !COMPONENT_NAME_PATTERN.test(name)) {
      return fail(`invalid component name "${String(name)}"`);
    }
    const content = parseContentComponentName(name);
    if (content !== null) {
      return runContentContract(
        content.kind,
        content.base,
        name,
        opts,
        started,
      );
    }
    const roots = currentComponentRoots();
    if (roots.length === 0) {
      return fail("no component roots are present");
    }

    const target = resolveTarget(name, roots, opts.version);
    if (!target.ok) {
      return fail(target.reason);
    }
    const { component } = target;
    const { manifest } = component;
    version = manifest.version;
    if (isContentKind(manifest.kind)) {
      // Unreachable through a valid manifest (a content name is caught
      // above); kept so a content version is never imported as code.
      return fail(
        `"${name}" has kind "${manifest.kind}" but is not named as one`,
      );
    }

    if (!semver.satisfies(SDK_VERSION, manifest.sdk)) {
      return fail(
        `sdk range "${manifest.sdk}" does not include SDK ${SDK_VERSION}`,
      );
    }
    if (
      !existsSync(component.contractPath) ||
      !isSafePath(component.contractPath, component.versionDir)
    ) {
      return fail(`no contract file: ${manifest.contract}`);
    }

    loaded = {
      entry: describeFile(component.entryPath, component.versionDir),
      contract: describeFile(component.contractPath, component.versionDir),
    };
    const importModule = opts.importModule ?? defaultImportModule;
    const run = async (): Promise<void> => {
      const entryModule = (await importModule(component.entryPath)) as {
        default?: unknown;
      };
      const entryFn = entryModule?.default;
      if (typeof entryFn !== "function") {
        throw new Error("entry has no default export function");
      }

      const config: ComponentConfig = opts.config ?? {
        agentId: getConfig().runtime.agentId,
        agentName: getConfig().runtime.agentName,
        projectRoot: getProjectRoot(),
      };
      const deps = buildComponentDeps({
        manifest,
        componentDir: component.versionDir,
        config,
        services: { ...getActiveComponents().services },
        internals: buildInternals(),
      });
      const componentValue: unknown = await (entryFn as ComponentEntry)(deps);

      const contractModule = (await importModule(component.contractPath)) as {
        default?: unknown;
      };
      const contractFn = contractModule?.default;
      if (typeof contractFn !== "function") {
        throw new Error("contract has no default export function");
      }

      const contractDeps: ContractDeps = {
        ...deps,
        component: componentValue,
        invoke: buildInvoke(name, manifest.kind, componentValue),
      };
      await (contractFn as ComponentContract)(contractDeps);
    };

    await withTimeout(
      run(),
      timeoutMs,
      `contract timed out after ${timeoutMs} ms`,
    );

    return {
      ok: true,
      durationMs: Date.now() - started,
      version,
      sdkVersion: SDK_VERSION,
      loaded,
    };
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
