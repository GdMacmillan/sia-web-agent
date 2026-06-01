/**
 * Shared accessor for the workspace-bound graph-memory adapter.
 *
 * The adapter's `workspaceId` is bound at construction from runtime
 * context (`getConfig().runtime.workspaceId`, sourced from
 * `SIA_WORKSPACE_ID`) and stamped on every request — the LLM never
 * supplies it. Graph memory has no unscoped path, so a missing
 * workspace id is a fail-fast, not a silent fall-through.
 *
 * Kept separate from `memory-tools.ts` so non-tool consumers (e.g. the
 * knowledge-formation middleware) can reach the same cached, bound
 * adapter without importing the search-enrichment helpers that live
 * alongside the tools.
 */
import type { IGraphMemoryAdapter } from "../vendor/svc-rpc/graph-memory/adapter-interface.js";
import { SiadGraphMemoryAdapter } from "./siad-graph-memory-adapter.js";
import { getConfig } from "../config/index.js";

let cachedAdapter: IGraphMemoryAdapter | null = null;

/**
 * Return the process-wide graph-memory adapter, constructing it on
 * first use from runtime config. Throws when no workspace id is
 * available — graph memory cannot be reached unscoped.
 */
export function getMemoryAdapter(): IGraphMemoryAdapter {
  if (cachedAdapter) return cachedAdapter;

  const workspaceId = getConfig().runtime.workspaceId;
  if (!workspaceId) {
    if (process.env.SIA_LEGACY_UNSCOPED === "1") {
      throw new Error(
        "memory-adapter: SIA_WORKSPACE_ID is unset AND SIA_LEGACY_UNSCOPED=1 — " +
          "graph-memory has no unscoped path; remove SIA_LEGACY_UNSCOPED or " +
          "set SIA_WORKSPACE_ID.",
      );
    }
    throw new Error(
      "memory-adapter: SIA_WORKSPACE_ID is required. The host process must " +
        "stamp it on the agent at spawn time.",
    );
  }

  cachedAdapter = new SiadGraphMemoryAdapter({ workspaceId });
  return cachedAdapter;
}

/** Test seam. Reset the cached adapter so the next call re-reads config. */
export function _resetMemoryAdapterForTests(): void {
  cachedAdapter = null;
}

/** Test seam. Inject a stub adapter (e.g. mock IGraphMemoryAdapter). */
export function _setMemoryAdapterForTests(
  adapter: IGraphMemoryAdapter | null,
): void {
  cachedAdapter = adapter;
}
