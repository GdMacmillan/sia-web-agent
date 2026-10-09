/**
 * Assembly wiring — resolves the component roots, loads the components and
 * shapes their output for `createDeepAgent`: middleware for the
 * `customMiddleware` merge, tools appended after the built-ins, and profile
 * overlays folded into the harness profile.
 *
 * With no component roots present this is a no-op and the agent assembles
 * exactly as it did before components existed.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentMiddleware } from "langchain";
import type { StructuredTool } from "@langchain/core/tools";
import type { HarnessProfile } from "../profiles/harness.js";
import { allowPathRoot } from "../utils/path-utils.js";
import { logger } from "../utils/logger.js";
import {
  loadComponents,
  type ImportModule,
  type LoadComponentsResult,
} from "./loader.js";
import type { ComponentConfig, ComponentInternals } from "./sdk.js";
import { MIDDLEWARE_ONLY_TOOL_NAMES, MIDDLEWARE_TOOL_NAMES } from "./names.js";
import { getLineageReconciler } from "./lineage-reconcile.js";
import { createComponentsMiddleware, setActiveComponents } from "./registry.js";

export { MIDDLEWARE_ONLY_TOOL_NAMES, MIDDLEWARE_TOOL_NAMES };

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

export interface PrepareComponentAssemblyOptions {
  projectRoot: string;
  componentsDir?: string | undefined;
  /** The built-in tools; component tools are appended after them. */
  tools: StructuredTool[];
  knownMiddlewareNames: ReadonlySet<string>;
  config: ComponentConfig;
  internals: ComponentInternals;
  importModule?: ImportModule;
  /**
   * Runs before each agent turn once components are loaded (default: the
   * lineage reconciler's turn check). Injectable for tests.
   */
  beforeTurn?: () => Promise<void> | void;
}

export interface ComponentAssembly {
  /** Component middleware plus `componentsMiddleware`; empty when nothing loaded. */
  middleware: AgentMiddleware[];
  /** Built-in tools first, then component tools, deduplicated by name. */
  tools: StructuredTool[];
  /** Manifest profiles of the loaded components, in load order. */
  profileOverlays: HarnessProfile[];
  /** The loader result, or null when no root exists. */
  loaded: LoadComponentsResult | null;
  roots: string[];
}

/**
 * Resolve roots, allow file operations under them, load the components and
 * shape the output for assembly. Never throws.
 */
export async function prepareComponentAssembly(
  options: PrepareComponentAssemblyOptions,
): Promise<ComponentAssembly> {
  const roots = resolveComponentRoots({
    projectRoot: options.projectRoot,
    componentsDir: options.componentsDir,
  });
  const noop: ComponentAssembly = {
    middleware: [],
    tools: options.tools,
    profileOverlays: [],
    loaded: null,
    roots,
  };
  if (roots.length === 0) {
    return noop;
  }

  // The filesystem tools are bounded to the project root; components live
  // outside it, so admit both spellings of each root (as given and fully
  // resolved) — the tools may see either.
  for (const root of roots) {
    allowPathRoot(root);
    try {
      allowPathRoot(realpathSync(root));
    } catch (_error) {
      // Already validated to exist above; nothing else to admit.
    }
  }

  let loaded: LoadComponentsResult;
  try {
    loaded = await loadComponents({
      roots,
      config: options.config,
      internals: options.internals,
      knownMiddlewareNames: options.knownMiddlewareNames,
      importModule: options.importModule,
    });
  } catch (error: unknown) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "component loading failed; continuing without components",
    );
    return noop;
  }

  const taken = new Set<string>([
    ...options.tools.map((t) => t.name),
    ...MIDDLEWARE_TOOL_NAMES,
  ]);
  const componentTools: StructuredTool[] = [];
  for (const tool of loaded.tools) {
    if (taken.has(tool.name)) {
      logger.warn(
        { tool: tool.name },
        "component tool skipped: name collides with an existing tool",
      );
      continue;
    }
    taken.add(tool.name);
    componentTools.push(tool);
  }

  setActiveComponents({
    components: loaded.components,
    roots,
    services: loaded.services,
  });

  const middleware =
    loaded.components.length > 0
      ? [
          ...loaded.middleware.map((entry) => entry.middleware),
          createComponentsMiddleware({
            beforeTurn: options.beforeTurn ?? (() => getLineageReconciler().onTurn()),
          }),
        ]
      : [];

  return {
    middleware,
    tools: [...options.tools, ...componentTools],
    profileOverlays: loaded.profiles,
    loaded,
    roots,
  };
}
