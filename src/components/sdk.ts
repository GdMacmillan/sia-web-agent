/**
 * The component SDK — the only surface component code sees.
 *
 * Component code lives outside the source tree and cannot import anything,
 * so everything it needs arrives on `ComponentDeps`. Everything here except
 * `internals` is stable across a major of `SDK_VERSION`: additions bump the
 * minor, removals or signature changes bump the major. See
 * `docs/COMPONENTS.md` §5.
 */

import { createMiddleware, tool } from "langchain";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { z } from "zod/v4";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createAgentLogger } from "../utils/logger.js";
import {
  ToolEnabledExecutor,
  validateCode,
  formatCodePreview,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "../code-execution/index.js";
import type { ComponentManifest } from "./manifest.js";
import { MIDDLEWARE_ONLY_TOOL_NAMES } from "./names.js";
import { getActiveToolPool } from "./registry.js";

/**
 * The SDK version a manifest's `sdk` range is checked against.
 *
 * 1.1.0: `internals.codeExecution.getExposableTools`.
 */
export const SDK_VERSION = "1.1.0";

/** Per-agent configuration handed to every component. */
export interface ComponentConfig {
  readonly agentId: string;
  readonly agentName: string;
  readonly projectRoot: string;
}

/** The logger type handed to components. */
export type ComponentLogger = ReturnType<typeof createAgentLogger>;

/**
 * Bundled internals exposed for specific components. Unstable: a minor SDK
 * bump may change this namespace.
 */
export interface ComponentInternals {
  codeExecution: {
    ToolEnabledExecutor: typeof ToolEnabledExecutor;
    validateCode: typeof validateCode;
    formatCodePreview: typeof formatCodePreview;
    DEFAULT_TIMEOUT_MS: number;
    MAX_TIMEOUT_MS: number;
    /**
     * The tools a code-execution session may call through its generated
     * tool API: the assembled agent's pool minus the middleware-only tools
     * (`MIDDLEWARE_ONLY_TOOL_NAMES`). Available after assembly; empty
     * before. Since SDK 1.1.0.
     */
    getExposableTools: () => StructuredToolInterface[];
  };
}

/** The active pool minus the middleware-only tools. */
export function getExposableTools(): StructuredToolInterface[] {
  return getActiveToolPool().filter(
    (tool) => !MIDDLEWARE_ONLY_TOOL_NAMES.has(tool.name),
  );
}

export interface ComponentDeps {
  /** `SDK_VERSION`. */
  sdkVersion: string;
  /** `zod/v4`. */
  z: typeof z;
  /** langchain `tool()`. */
  tool: typeof tool;
  createMiddleware: typeof createMiddleware;
  dispatchCustomEvent: typeof dispatchCustomEvent;
  logger: ComponentLogger;
  config: Readonly<ComponentConfig>;
  /** This component's parsed manifest. */
  manifest: ComponentManifest;
  /** The resolved version directory. */
  componentDir: string;
  /**
   * Values published by `kind: service` components loaded before this one.
   * A frozen snapshot: no component can alter another's view.
   */
  services: Readonly<Record<string, unknown>>;
  internals: ComponentInternals;
}

/** The default export of `entry.ts`. The return type follows `kind`. */
export type ComponentEntry = (deps: ComponentDeps) => unknown;

export interface InvokeOptions {
  /** Thread the call runs in; defaults to a per-run scratch thread. */
  threadId?: string;
}

/** Invoke a tool by name through the assembled agent's tool pool. */
export type ContractInvoke = (
  toolName: string,
  args: unknown,
  opts?: InvokeOptions,
) => Promise<string>;

export interface ContractDeps extends ComponentDeps {
  /** The value `entry.ts` returned for this version. */
  component: unknown;
  invoke: ContractInvoke;
}

/** The default export of `contract.ts`. Any throw fails; any return passes. */
export type ComponentContract = (deps: ContractDeps) => Promise<void> | void;

/** Assemble the `internals` namespace from the bundled modules. */
export function buildInternals(): ComponentInternals {
  return {
    codeExecution: {
      ToolEnabledExecutor,
      validateCode,
      formatCodePreview,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      getExposableTools,
    },
  };
}

export interface BuildComponentDepsInput {
  manifest: ComponentManifest;
  componentDir: string;
  config: ComponentConfig;
  services: Record<string, unknown>;
  internals: ComponentInternals;
}

/** Build the dependency bundle for one component. */
export function buildComponentDeps(
  input: BuildComponentDepsInput,
): ComponentDeps {
  return {
    sdkVersion: SDK_VERSION,
    z,
    tool,
    createMiddleware,
    dispatchCustomEvent,
    logger: createAgentLogger(`component:${input.manifest.name}`),
    config: Object.freeze({ ...input.config }),
    manifest: input.manifest,
    componentDir: input.componentDir,
    services: Object.freeze({ ...input.services }),
    internals: input.internals,
  };
}
