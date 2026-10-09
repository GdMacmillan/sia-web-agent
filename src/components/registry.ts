/**
 * The active component set for this process.
 *
 * Code is loaded once at assembly and is restart-gated; manifests are live.
 * `componentsMiddleware` re-reads every active component's manifest from
 * disk before each agent turn so a flipped pointer is described immediately
 * even though the new code runs only after a restart. See
 * `docs/COMPONENTS.md` §4.
 */

import { createMiddleware, type AgentMiddleware } from "langchain";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { HarnessProfile } from "../profiles/harness.js";
import { logger } from "../utils/logger.js";
import { discoverComponents, type DiscoveredComponent } from "./discovery.js";
import type { ComponentManifest } from "./manifest.js";
import { COMPONENTS_MIDDLEWARE_NAME } from "./names.js";

export { COMPONENTS_MIDDLEWARE_NAME };

export interface ActiveComponent {
  /** Live: refreshed from disk each turn. */
  manifest: ComponentManifest;
  /** Live: refreshed alongside the manifest. */
  profile: HarnessProfile | undefined;
  /** The version whose code this process is running. */
  loadedVersion: string;
  root: string;
  componentDir: string;
  /** The version directory the running code was loaded from. */
  versionDir: string;
  entryPath: string;
  contractPath: string;
}

export interface ActiveComponentsState {
  components: ActiveComponent[];
  roots: string[];
  services: Record<string, unknown>;
}

let active: ActiveComponentsState = { components: [], roots: [], services: {} };
let toolPool: StructuredToolInterface[] = [];

export interface SetActiveComponentsInput {
  components: readonly DiscoveredComponent[];
  roots: readonly string[];
  services?: Record<string, unknown>;
}

/** Record the components that loaded at assembly. */
export function setActiveComponents(input: SetActiveComponentsInput): void {
  active = {
    components: input.components.map((c) => ({
      manifest: c.manifest,
      profile: c.profile,
      loadedVersion: c.manifest.version,
      root: c.root,
      componentDir: c.componentDir,
      versionDir: c.versionDir,
      entryPath: c.entryPath,
      contractPath: c.contractPath,
    })),
    roots: [...input.roots],
    services: { ...(input.services ?? {}) },
  };
}

/** The active set. */
export function getActiveComponents(): Readonly<ActiveComponentsState> {
  return active;
}

/**
 * Record the assembled agent's full tool pool (built-in tools plus every
 * middleware-provided tool) so contracts can invoke tools by name.
 */
export function setActiveToolPool(tools: readonly StructuredToolInterface[]): void {
  toolPool = [...tools];
}

/** The tool pool recorded at assembly. */
export function getActiveToolPool(): readonly StructuredToolInterface[] {
  return toolPool;
}

/**
 * Re-read every active component's manifest from disk and swap the
 * manifest fields only. Paths and the loaded code are untouched. Never
 * throws.
 */
export function refreshActiveManifests(): void {
  if (active.components.length === 0) {
    return;
  }
  try {
    const { found } = discoverComponents(active.roots);
    const byName = new Map(found.map((c) => [c.manifest.name, c]));
    for (const component of active.components) {
      const fresh = byName.get(component.manifest.name);
      if (fresh !== undefined) {
        component.manifest = fresh.manifest;
        component.profile = fresh.profile;
      }
    }
  } catch (error: unknown) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "component manifest refresh failed",
    );
  }
}

export interface ComponentsMiddlewareOptions {
  /**
   * Runs before each agent turn, after the manifests are refreshed (the
   * lineage reconciler's turn check). It must not throw; if it does, the
   * turn still runs.
   */
  beforeTurn?: () => Promise<void> | void;
}

/** Middleware that refreshes active manifests before each agent turn. */
export function createComponentsMiddleware(
  options: ComponentsMiddlewareOptions = {},
): AgentMiddleware {
  return createMiddleware({
    name: COMPONENTS_MIDDLEWARE_NAME,
    beforeAgent: async () => {
      refreshActiveManifests();
      if (options.beforeTurn) {
        try {
          await options.beforeTurn();
        } catch (error: unknown) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            "component turn hook failed",
          );
        }
      }
      return undefined;
    },
  });
}

/** Test hook: forget the active set and the tool pool. */
export function _resetComponentsForTests(): void {
  active = { components: [], roots: [], services: {} };
  toolPool = [];
}
