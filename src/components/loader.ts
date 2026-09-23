/**
 * Component loader — turns discovered components into middleware, tools and
 * services by importing each entry module and calling its default export
 * with an injected dependency bundle.
 *
 * Every failure is a per-component skip with a warning. The loader never
 * throws: nothing a component does at load time can prevent the agent from
 * starting. See `docs/COMPONENTS.md` §4.
 */

import { pathToFileURL } from "node:url";
import semver from "semver";
import type { AgentMiddleware } from "langchain";
import type { StructuredTool } from "@langchain/core/tools";
import {
  REQUIRED_MIDDLEWARE_NAMES,
  type HarnessProfile,
} from "../profiles/harness.js";
import { logger } from "../utils/logger.js";
import {
  discoverComponents,
  type DiscoveredComponent,
  type ShadowedComponent,
  type SkippedComponent,
} from "./discovery.js";
import type { ComponentKind } from "./manifest.js";
import {
  SDK_VERSION,
  buildComponentDeps,
  type ComponentConfig,
  type ComponentEntry,
  type ComponentInternals,
} from "./sdk.js";
import { tagReplaces } from "./replaces-tag.js";

/** Load a module from an absolute path. */
export type ImportModule = (absolutePath: string) => Promise<unknown>;

let importSeq = 0;

/**
 * Production importer: a cache-busted `file://` import, so a restart always
 * sees the current pointer even when the module loader caches by URL. The
 * counter keeps two imports within one millisecond distinct.
 */
export const defaultImportModule: ImportModule = (absolutePath) =>
  import(`${pathToFileURL(absolutePath).href}?t=${Date.now()}-${++importSeq}`);

export interface LoadedMiddleware {
  middleware: AgentMiddleware;
  /** The bundled middleware this one stands in for, when set. */
  replaces: string | undefined;
  component: DiscoveredComponent;
}

export interface LoadedComponent {
  component: DiscoveredComponent;
  kind: ComponentKind;
  /** What the entry returned. */
  value: unknown;
}

export interface LoadComponentsOptions {
  /** Component roots, highest precedence first. */
  roots: readonly string[];
  config: ComponentConfig;
  internals: ComponentInternals;
  /** Every middleware name the default stack can carry (the `replaces` targets). */
  knownMiddlewareNames: ReadonlySet<string>;
  importModule?: ImportModule;
}

export interface LoadComponentsResult {
  middleware: LoadedMiddleware[];
  tools: StructuredTool[];
  services: Record<string, unknown>;
  /** Manifest profiles of the components that loaded, in load order. */
  profiles: HarnessProfile[];
  /** The components that loaded, in load order. */
  components: DiscoveredComponent[];
  loaded: LoadedComponent[];
  skipped: SkippedComponent[];
  shadowed: ShadowedComponent[];
}

/** Duck-type check for a middleware value returned by an entry. */
export function isMiddlewareLike(
  value: unknown,
): value is AgentMiddleware & { name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    (value as { name: string }).name.length > 0
  );
}

/** Duck-type check for a tool value: a named object with `invoke`. */
export function isToolLike(value: unknown): value is StructuredTool {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { invoke?: unknown }).invoke === "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Load every component under `roots`. Services load first so
 * `deps.services` is populated for later entries; otherwise discovery
 * order is preserved. Never throws.
 */
export async function loadComponents(
  options: LoadComponentsOptions,
): Promise<LoadComponentsResult> {
  const importModule = options.importModule ?? defaultImportModule;
  const discovery = discoverComponents(options.roots);

  const result: LoadComponentsResult = {
    middleware: [],
    tools: [],
    services: {},
    profiles: [],
    components: [],
    loaded: [],
    skipped: [...discovery.skipped],
    shadowed: discovery.shadowed,
  };

  for (const entry of discovery.skipped) {
    logger.warn(
      { component: entry.name, root: entry.root, reason: entry.reason },
      "component skipped",
    );
  }
  for (const entry of discovery.shadowed) {
    logger.debug(
      { component: entry.name, root: entry.root, shadowedBy: entry.shadowedBy },
      "component shadowed by an earlier root",
    );
  }

  const ordered = [
    ...discovery.found.filter((c) => c.manifest.kind === "service"),
    ...discovery.found.filter((c) => c.manifest.kind !== "service"),
  ];

  const skip = (component: DiscoveredComponent, reason: string): void => {
    result.skipped.push({
      name: component.manifest.name,
      root: component.root,
      reason,
    });
    logger.warn(
      {
        component: component.manifest.name,
        version: component.manifest.version,
        root: component.root,
        reason,
      },
      "component skipped",
    );
  };

  for (const component of ordered) {
    const { manifest } = component;
    try {
      if (!semver.satisfies(SDK_VERSION, manifest.sdk)) {
        skip(
          component,
          `sdk range "${manifest.sdk}" does not include SDK ${SDK_VERSION}`,
        );
        continue;
      }

      if (manifest.replaces !== undefined) {
        if (REQUIRED_MIDDLEWARE_NAMES.has(manifest.replaces)) {
          skip(
            component,
            `replaces "${manifest.replaces}" names required scaffolding`,
          );
          continue;
        }
        if (!options.knownMiddlewareNames.has(manifest.replaces)) {
          skip(
            component,
            `replaces "${manifest.replaces}" is not a middleware in the default stack`,
          );
          continue;
        }
      }

      const module = (await importModule(component.entryPath)) as {
        default?: unknown;
      };
      const entryFn = module?.default;
      if (typeof entryFn !== "function") {
        skip(component, "entry has no default export function");
        continue;
      }

      const deps = buildComponentDeps({
        manifest,
        componentDir: component.versionDir,
        config: options.config,
        services: result.services,
        internals: options.internals,
      });
      const value: unknown = await (entryFn as ComponentEntry)(deps);

      switch (manifest.kind) {
        case "middleware": {
          if (!isMiddlewareLike(value)) {
            skip(component, "entry did not return a middleware (an object with a string name)");
            continue;
          }
          if (manifest.replaces !== undefined) {
            if (value.name !== manifest.replaces) {
              skip(
                component,
                `middleware name "${value.name}" does not match replaces "${manifest.replaces}"`,
              );
              continue;
            }
            tagReplaces(value, manifest.replaces);
          } else if (options.knownMiddlewareNames.has(value.name)) {
            skip(
              component,
              `middleware name "${value.name}" matches a default middleware; set "replaces" to stand in for it`,
            );
            continue;
          }
          result.middleware.push({
            middleware: value,
            replaces: manifest.replaces,
            component,
          });
          break;
        }
        case "tools": {
          if (!Array.isArray(value) || !value.every(isToolLike)) {
            skip(component, "entry did not return an array of tools");
            continue;
          }
          result.tools.push(...(value as StructuredTool[]));
          break;
        }
        case "service": {
          result.services[manifest.name] = value;
          break;
        }
      }

      if (component.profile !== undefined) {
        result.profiles.push(component.profile);
      }
      result.components.push(component);
      result.loaded.push({ component, kind: manifest.kind, value });
      logger.info(
        {
          component: manifest.name,
          version: manifest.version,
          kind: manifest.kind,
          root: component.root,
        },
        "component loaded",
      );
    } catch (error: unknown) {
      skip(component, `entry failed: ${errorMessage(error)}`);
    }
  }

  return result;
}
