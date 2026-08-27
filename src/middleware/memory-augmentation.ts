/**
 * Memory-augmentation middleware.
 *
 * Long-term memory is only useful if it gets read. Relying on the model
 * to call `search_entities` before every task turns out not to work in
 * practice, so this middleware makes the read path deterministic: every
 * search-type tool call (`grep`, `glob`, `search`, and `bash` runs of
 * `rg` / `grep` / `find`) also looks up related graph-memory entries and
 * appends the top hits to the tool's own result under
 * `[Graph memory context]`.
 *
 * Design constraints, all load-bearing:
 *
 *   - **The tool result is sacred.** The lookup runs concurrently with
 *     the tool and is awaited separately, so a memory failure — throw,
 *     timeout, malformed response — can never alter or reject what the
 *     tool returned. Worst case is an unchanged result.
 *   - **Standalone-safe.** The agent must run on a bare LangGraph server
 *     with no host daemon and no workspace, where graph memory simply is
 *     not there. The adapter is resolved lazily on the first eligible
 *     call; if that fails, or the very first lookup fails, the
 *     middleware latches off for the life of the process and passes
 *     every later call straight through. Transient failures after a
 *     first success are tolerated (logged, skipped, not latched).
 *   - **Budgeted.** The shared `augmentSearch` enforces `budgetMs`; a
 *     slow lookup yields no context rather than a slow tool.
 *   - **It closes the outcome loop.** Every entity surfaced is recorded
 *     via `trackPatternRetrieval`, so knowledge-formation's outcome
 *     tracking can attribute a task's success or failure back to the
 *     memories that informed it.
 */
import { createMiddleware, ToolMessage } from "langchain";
import { getConfig } from "../config/index.js";
import { getMemoryAdapter } from "../tools/memory-adapter.js";
import {
  getOrCreateTaskId,
  trackPatternRetrieval,
} from "../utils/application-tracking.js";
import { logger } from "../utils/logger.js";
import type { IGraphMemoryAdapter } from "../vendor/svc-rpc/graph-memory/adapter-interface.js";
import {
  augmentSearch,
  createSearchAugmentationCache,
  isSearchAugmentationTool,
  type AugmentSearchResult,
} from "../vendor/svc-rpc/graph-memory/search-augmentation.js";

/** Header line that introduces the appended block in a tool result. */
export const MEMORY_CONTEXT_HEADER = "[Graph memory context]";

export interface MemoryAugmentationMiddlewareOptions {
  /** Override the configured `features.memoryAugmentation.enabled`. */
  enabled?: boolean;
  /** Override the configured `features.memoryAugmentation.budgetMs`. */
  budgetMs?: number;
  /** Adapter factory; defaults to the process-wide workspace-bound adapter. */
  getAdapter?: () => IGraphMemoryAdapter;
}

function readFeatureConfig(): { enabled: boolean; budgetMs: number } {
  try {
    const cfg = getConfig().features.memoryAugmentation;
    return { enabled: cfg.enabled, budgetMs: cfg.budgetMs };
  } catch {
    // Config that cannot load is a deployment where this feature has no
    // business running; the tools themselves are unaffected.
    return { enabled: false, budgetMs: 500 };
  }
}

export function createMemoryAugmentationMiddleware(
  options: MemoryAugmentationMiddlewareOptions = {},
) {
  const feature = readFeatureConfig();
  const enabled = options.enabled ?? feature.enabled;
  const budgetMs = options.budgetMs ?? feature.budgetMs;
  const getAdapter = options.getAdapter ?? getMemoryAdapter;
  const cache = createSearchAugmentationCache();

  let latchedOff = !enabled;
  let adapter: IGraphMemoryAdapter | null = null;
  let everSucceeded = false;

  const latch = (reason: string, err?: unknown): void => {
    latchedOff = true;
    logger.debug(
      { reason, err: err instanceof Error ? err.message : err },
      "[MemoryAugmentation] disabled for this process",
    );
  };

  const resolveAdapter = (): IGraphMemoryAdapter | null => {
    if (adapter) return adapter;
    try {
      adapter = getAdapter();
      return adapter;
    } catch (err) {
      latch("graph memory unavailable", err);
      return null;
    }
  };

  const lookup = async (
    toolName: string,
    toolInput: unknown,
  ): Promise<AugmentSearchResult | null> => {
    const a = resolveAdapter();
    if (!a) return null;
    try {
      return await augmentSearch(a, { toolName, toolInput, budgetMs, cache });
    } catch (err) {
      // `augmentSearch` never rejects by contract; this is belt and braces.
      logger.debug({ err }, "[MemoryAugmentation] lookup threw");
      return null;
    }
  };

  return createMiddleware({
    name: "memoryAugmentationMiddleware",
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall?.name;
      if (latchedOff || !toolName || !isSearchAugmentationTool(toolName)) {
        return handler(request);
      }

      // Kick off the lookup first so it overlaps with the tool's own run.
      const pending = lookup(toolName, request.toolCall.args);
      const result = await handler(request);

      const augmentation = await pending;
      if (!augmentation) return result;

      if (augmentation.error && !everSucceeded) {
        // First contact with graph memory failed: treat as "not here".
        latch("first lookup failed", augmentation.error);
        return result;
      }
      if (augmentation.error) {
        logger.debug(
          { toolName, err: augmentation.error },
          "[MemoryAugmentation] lookup failed; skipping",
        );
        return result;
      }
      if (augmentation.query !== null) everSucceeded = true;
      if (!augmentation.context) return result;

      if (result instanceof ToolMessage && typeof result.content === "string") {
        result.content = `${result.content}\n\n${MEMORY_CONTEXT_HEADER}\n${augmentation.context}`;
        try {
          trackPatternRetrieval(
            augmentation.entities.map((e) => e.id),
            getOrCreateTaskId({ configurable: request.runtime?.configurable }),
          );
        } catch (err) {
          logger.debug({ err }, "[MemoryAugmentation] tracking failed");
        }
        logger.debug(
          {
            toolName,
            query: augmentation.query,
            count: augmentation.count,
            cached: augmentation.cached,
            elapsedMs: augmentation.elapsedMs,
          },
          "[MemoryAugmentation] attached context",
        );
      }
      return result;
    },
  });
}
