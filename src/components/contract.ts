/**
 * Contract runner — proves a component version works, in-process, through
 * the real tool or middleware it builds. See `docs/COMPONENTS.md` §6.
 *
 * Fail-closed: every outcome that is not a clean pass is `ok: false` with
 * the error text. The runner never throws.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
import { resolveComponentRoots } from "./assemble.js";
import { readComponentVersion } from "./authoring.js";
import { discoverComponents, type DiscoveredComponent } from "./discovery.js";
import {
  defaultImportModule,
  isMiddlewareLike,
  isToolLike,
  type ImportModule,
} from "./loader.js";
import { COMPONENT_NAME_PATTERN, type ComponentKind } from "./manifest.js";
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

/**
 * The roots to search, in precedence order: the host-managed root as
 * configured now (so one that appeared after assembly is searched, and a
 * version written into it during this process can be checked), then the
 * roots recorded at assembly, then whatever else exists on disk now.
 * Deduplicated by real path.
 */
function contractRoots(): string[] {
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
    const roots = contractRoots();
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
