/**
 * Memory Tools for Agent Entity Management (AGI-228).
 *
 * Every tool delegates to the vendored `tool-handlers` module from
 * `packages/svc-rpc/src/services/graph-memory/` (this repo:
 * `src/vendor/svc-rpc/graph-memory/`). The MCP server in the monorepo
 * vendors the same handlers — both surfaces are structurally identical
 * by construction (parity test on the monorepo side enforces this).
 *
 * Each `DynamicStructuredTool.func` is a thin shell around the
 * corresponding handler:
 *
 *     handler(adapter, input) → JSON string
 *
 * `adapter` is a workspace-bound {@link SiadGraphMemoryAdapter} that
 * tunnels every verb through siad's `/rpc/call` endpoint. The LLM
 * never sees `workspace_id` as a tool parameter.
 *
 * Agent-only enrichments (HyDE / query-decomposition / reranking) stay
 * here as wrappers around the vendored `searchEntities` handler — they
 * don't replace it.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  listEntities,
  promoteEntities,
  retrieveEntity,
  searchEntities,
  storeEntity,
  traverseGraph,
  updateEntity,
  updateEntityStatus,
  type ListEntitiesInput,
  type PromoteEntitiesInput,
  type SearchEntitiesInput,
  type SearchEntitiesResult,
  type StoreEntityHandlerInput,
  type TraverseGraphInput,
  type UpdateEntityInput,
  type UpdateEntityStatusInput,
} from "../vendor/svc-rpc/graph-memory/tool-handlers.js";
import type { StoredEntityShape } from "../vendor/svc-rpc/graph-memory/entity-shape.js";
import type { IGraphMemoryAdapter } from "../vendor/svc-rpc/graph-memory/adapter-interface.js";
import { SiadGraphMemoryAdapter } from "./siad-graph-memory-adapter.js";
import {
  rerankEntities,
  rerankEntitiesWithScores,
  type RetrievedEntity,
  type WeightPreset,
} from "../utils/knowledge-reranking.js";
import { processQueryWithHyDE } from "../utils/hyde.js";
import { processQueryWithDecomposition } from "../utils/query-decomposition.js";
import { getConfig } from "../config/index.js";

/**
 * Search-result entity as carried inside `searchEntitiesTool`. Decomposition
 * yields {@link MergedEntity}-style records with `matchCount` / `boostScore`;
 * the standard path yields plain {@link RetrievedEntity}-style records. The
 * adapter also threads `agent_id` through from the wire, even though
 * {@link RetrievedEntity} doesn't declare it — agent rendering surfaces it.
 */
type SearchResultEntity = RetrievedEntity & {
  agent_id?: string;
  matchCount?: number;
  matchedSubQueries?: string[];
  boostScore?: number;
};

/* ------------------------------------------------------------------------- */
/* Adapter lifecycle                                                         */
/* ------------------------------------------------------------------------- */

let cachedAdapter: IGraphMemoryAdapter | null = null;

function getAdapter(): IGraphMemoryAdapter {
  if (cachedAdapter) return cachedAdapter;

  const workspaceId = getConfig().runtime.workspaceId;
  if (!workspaceId) {
    if (process.env.SIA_LEGACY_UNSCOPED === "1") {
      throw new Error(
        "memory-tools: SIA_WORKSPACE_ID is unset AND SIA_LEGACY_UNSCOPED=1 — " +
          "there is no legacy unscoped path for svc.graph-memory.v1; remove " +
          "SIA_LEGACY_UNSCOPED or stamp SIA_WORKSPACE_ID via install_node_daemon.",
      );
    }
    throw new Error(
      "memory-tools: SIA_WORKSPACE_ID is required. Set it via " +
        "install_node_daemon (the launchd plist / systemd unit stamps it on " +
        "the agent process). See AGI-202 + feedback_workspace_id_transparent.md.",
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

/* ------------------------------------------------------------------------- */
/* store_entity                                                              */
/* ------------------------------------------------------------------------- */

export const storeEntityTool = new DynamicStructuredTool({
  name: "store_entity",
  description:
    "Store any type of entity in the graph memory database (ideas, notes, learnings, tasks, etc.). Entities can be linked to related entities using custom relationship types.",
  schema: z.object({
    entity_type: z
      .string()
      .describe(
        "Type of entity to store (e.g., 'idea', 'note', 'learning', 'task', 'pattern', 'decision')",
      ),
    title: z.string().describe("Brief title or summary of the entity"),
    content: z
      .string()
      .describe("Main content or detailed description of the entity"),
    context: z
      .string()
      .optional()
      .describe(
        "Context where this entity applies (e.g., 'authentication', 'frontend', 'performance')",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "Optional tags for categorization (e.g., ['optimization', 'backend'])",
      ),
    priority: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Priority level (default: medium)"),
    status: z
      .string()
      .optional()
      .describe(
        "Current status (default: 'active'). Can be any custom status like 'draft', 'completed', 'archived'",
      ),
    abstraction_level: z
      .enum(["raw", "synthesized", "abstract"])
      .optional()
      .describe(
        "Abstraction level of this entity (default: 'raw'). Use 'raw' for individual observations, 'synthesized' for consolidated patterns, 'abstract' for high-level insights.",
      ),
    metadata: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        "Optional custom metadata as key-value pairs for additional properties",
      ),
    related_entity_ids: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of existing entity IDs that this entity is related to",
      ),
    relationship_types: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of relationship types parallel to related_entity_ids (e.g., 'SIMILAR_TO', 'DEPENDS_ON', 'IMPLEMENTS')",
      ),
  }),
  func: async (input) => {
    const agentId = getConfig().runtime.agentId;
    const result = await storeEntity(getAdapter(), {
      ...(input as StoreEntityHandlerInput),
      agent_id: agentId,
    });
    return JSON.stringify(result, null, 2);
  },
});

/* ------------------------------------------------------------------------- */
/* retrieve_entity                                                           */
/* ------------------------------------------------------------------------- */

export const retrieveEntityTool = new DynamicStructuredTool({
  name: "retrieve_entity",
  description:
    "Retrieve a specific entity from graph memory by its ID. Returns the full entity details including all metadata.",
  schema: z.object({
    entity_id: z.string().describe("The unique ID of the entity to retrieve"),
  }),
  func: async ({ entity_id }) => {
    const result = await retrieveEntity(getAdapter(), { entity_id });
    return JSON.stringify(result, null, 2);
  },
});

/* ------------------------------------------------------------------------- */
/* search_entities — HyDE + decomposition + reranking wrap the vendored      */
/* searchEntities() handler.                                                 */
/* ------------------------------------------------------------------------- */

export const searchEntitiesTool = new DynamicStructuredTool({
  name: "search_entities",
  description:
    "Search for entities using natural language queries. Uses semantic similarity (entities.search cascade) to find relevant entities across all types. Supports filtering by entity type, tags, priority, status, and weighted re-ranking.",
  schema: z.object({
    query: z
      .string()
      .describe(
        "Natural language search query (e.g., 'authentication patterns', 'performance optimizations')",
      ),
    entity_type: z
      .string()
      .optional()
      .describe(
        "Optional: Filter by entity type (e.g., 'idea', 'note', 'learning')",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "Optional: Filter by tags (matches if entity has any of these tags)",
      ),
    priority: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Optional: Filter by priority level"),
    status: z
      .string()
      .optional()
      .describe("Optional: Filter by status (e.g., 'active', 'completed')"),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 10)"),
    use_hyde: z
      .boolean()
      .optional()
      .describe(
        "Optional: Explicitly enable/disable HyDE (Hypothetical Document Embedding). Auto-detects when unset.",
      ),
    decompose: z
      .boolean()
      .optional()
      .describe(
        "Optional: Enable query decomposition for complex multi-part queries. Auto-detects when unset.",
      ),
    rerank: z
      .boolean()
      .optional()
      .describe(
        "Optional: Enable weighted re-ranking of results (default: true).",
      ),
    rerank_preset: z
      .enum(["balanced", "semantic_heavy", "recency_heavy", "proven_only"])
      .optional()
      .describe("Optional: Weight preset for re-ranking (default: balanced)."),
    include_scores: z
      .boolean()
      .optional()
      .describe(
        "Optional: Include detailed score breakdown in response (default: false).",
      ),
  }),
  func: async ({
    query,
    entity_type,
    tags,
    priority,
    status,
    limit,
    use_hyde,
    decompose,
    rerank,
    rerank_preset,
    include_scores,
  }) => {
    const adapter = getAdapter();
    const searchLimit = limit ?? 10;
    const baseFilters: Omit<SearchEntitiesInput, "query"> = {};
    if (entity_type !== undefined) baseFilters.entity_type = entity_type;
    if (tags !== undefined) baseFilters.tags = tags;
    if (priority !== undefined) baseFilters.priority = priority;
    if (status !== undefined) baseFilters.status = status;
    baseFilters.limit = searchLimit;

    const performSearch = async (q: string): Promise<SearchResultEntity[]> => {
      const result: SearchEntitiesResult = await searchEntities(adapter, {
        query: q,
        ...baseFilters,
      });
      return result.entities.map((e) => storedToRetrieved(e));
    };

    // Decomposition wraps HyDE-wrapped sub-searches.
    const decompositionResult = await processQueryWithDecomposition(
      query,
      async (subQuery: string, opts: { use_hyde?: boolean } = {}) => {
        const hydeResult = await processQueryWithHyDE(subQuery, {
          useHyde: opts.use_hyde,
        });
        return performSearch(hydeResult.searchQuery);
      },
      {
        decompose,
        searchOptions: { ...baseFilters, use_hyde },
        applyHydeToSubQueries: true,
      },
    );

    let entities: SearchResultEntity[];
    let hydeInfo: { applied: boolean; reason?: string; cached?: boolean };

    if (
      decompositionResult.applied &&
      decompositionResult.entities.length > 0
    ) {
      entities = decompositionResult.entities;
      hydeInfo = {
        applied: false,
        reason: "HyDE applied to sub-queries during decomposition",
      };
    } else {
      const hydeResult = await processQueryWithHyDE(query, {
        useHyde: use_hyde,
      });
      entities = await performSearch(hydeResult.searchQuery);
      hydeInfo = {
        applied: hydeResult.applied,
        reason: hydeResult.reason,
        cached: hydeResult.cached,
      };
    }

    const rerankEnabled = rerank !== false;
    const rerankPreset = (rerank_preset as WeightPreset) ?? "balanced";
    const includeScores = include_scores ?? false;

    let scoreDetails: Array<{
      score: number;
      components: {
        semantic: number;
        recency: number;
        accessCount: number;
        successRate: number;
        priorityBoost: number;
      };
    }> = [];

    const rerankingInfo: {
      applied: boolean;
      preset: WeightPreset;
      include_scores: boolean;
    } = {
      applied: false,
      preset: rerankPreset,
      include_scores: includeScores,
    };

    if (rerankEnabled && entities.length > 0) {
      if (includeScores) {
        const scored = rerankEntitiesWithScores(entities, rerankPreset);
        entities = scored.map((s) => s.entity);
        scoreDetails = scored.map((s) => ({
          score: s.score,
          components: s.components,
        }));
      } else {
        entities = rerankEntities(entities, rerankPreset);
      }
      rerankingInfo.applied = true;
    }

    return JSON.stringify(
      {
        query,
        filters_applied: {
          entity_type,
          tags,
          priority,
          status,
          limit: searchLimit,
        },
        hyde: hydeInfo,
        decomposition: {
          applied: decompositionResult.applied,
          reason: decompositionResult.reason,
          sub_queries: decompositionResult.subQueries,
          successful_sub_queries: decompositionResult.successfulSubQueries,
          failed_sub_queries: decompositionResult.failedSubQueries,
          cached: decompositionResult.cached,
          timing: decompositionResult.timing,
        },
        reranking: rerankingInfo,
        count: entities.length,
        entities: entities.map((e, i) => ({
          id: e.id,
          entity_type: e.entity_type,
          title: e.title,
          context: e.context,
          tags: e.tags,
          priority: e.priority,
          status: e.status,
          agent_id: e.agent_id,
          created_at: e.created_at,
          ...(e.matchCount
            ? {
                match_count: e.matchCount,
                matched_sub_queries: e.matchedSubQueries,
                boost_score: e.boostScore,
              }
            : {}),
          ...(includeScores && scoreDetails[i]
            ? {
                rerank_score: scoreDetails[i]!.score,
                rerank_components: scoreDetails[i]!.components,
              }
            : {}),
        })),
        message: decompositionResult.applied
          ? `Found ${entities.length} entities via query decomposition (${decompositionResult.successfulSubQueries} of ${decompositionResult.subQueries?.length} sub-queries succeeded)`
          : `Found ${entities.length} matching entities`,
      },
      null,
      2,
    );
  },
});

/* ------------------------------------------------------------------------- */
/* list_entities                                                             */
/* ------------------------------------------------------------------------- */

export const listEntitiesTool = new DynamicStructuredTool({
  name: "list_entities",
  description:
    "List all entities in graph memory with optional filtering. Useful for getting an overview of stored knowledge, reviewing entities by type, or filtering by status and priority.",
  schema: z.object({
    entity_type: z
      .string()
      .optional()
      .describe(
        "Optional: Filter by entity type (e.g., 'idea', 'note', 'learning')",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "Optional: Filter by tags (matches if entity has any of these tags)",
      ),
    priority: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Optional: Filter by priority level"),
    status: z
      .string()
      .optional()
      .describe(
        "Optional: Filter by status (e.g., 'active', 'completed', 'archived')",
      ),
    context: z.string().optional().describe("Optional: Filter by context"),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 100)"),
    offset: z
      .number()
      .optional()
      .describe("Number of results to skip for pagination (default: 0)"),
  }),
  func: async (input) => {
    const result = await listEntities(
      getAdapter(),
      input as ListEntitiesInput,
    );
    return JSON.stringify(result, null, 2);
  },
});

/* ------------------------------------------------------------------------- */
/* update_entity_status                                                      */
/* ------------------------------------------------------------------------- */

export const updateEntityStatusTool = new DynamicStructuredTool({
  name: "update_entity_status",
  description:
    "Update the status of an entity to track its lifecycle. Useful for marking entities as completed, archived, in-progress, etc. Optionally add notes about the status change.",
  schema: z.object({
    entity_id: z.string().describe("The ID of the entity to update"),
    status: z
      .string()
      .describe(
        "New status (e.g., 'active', 'completed', 'archived', 'in-progress', 'blocked')",
      ),
    notes: z
      .string()
      .optional()
      .describe(
        "Optional notes about the status change (e.g., outcome, blockers, next steps)",
      ),
  }),
  func: async (input) => {
    const result = await updateEntityStatus(
      getAdapter(),
      input as UpdateEntityStatusInput,
    );
    return JSON.stringify(result, null, 2);
  },
});

/* ------------------------------------------------------------------------- */
/* update_entity                                                             */
/* ------------------------------------------------------------------------- */

export const updateEntityTool = new DynamicStructuredTool({
  name: "update_entity",
  description:
    "Update one or more fields of an existing entity with optional update modes (replace, append, merge). Maintains version history (last 3 versions) for audit and potential rollback. Use this for comprehensive entity updates; use update_entity_status for status-only changes.",
  schema: z.object({
    entity_id: z.string().describe("The ID of the entity to update"),
    title: z.string().optional().describe("New title (replaces existing)"),
    content: z.string().optional().describe("New or additional content"),
    content_mode: z
      .enum(["replace", "append"])
      .optional()
      .describe(
        "How to apply content update: 'replace' (default) overwrites, 'append' concatenates with separator",
      ),
    tags: z.array(z.string()).optional().describe("Tags to set or merge"),
    tags_mode: z
      .enum(["replace", "merge"])
      .optional()
      .describe(
        "How to apply tags update: 'replace' (default) overwrites, 'merge' unions with existing",
      ),
    priority: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("New priority level"),
    context: z.string().optional().describe("New context"),
    status: z.string().optional().describe("New status"),
    notes: z
      .string()
      .optional()
      .describe(
        "Optional notes explaining the update (stored in version history)",
      ),
  }),
  func: async (input) => {
    const result = await updateEntity(
      getAdapter(),
      input as UpdateEntityInput,
    );
    return JSON.stringify(result, null, 2);
  },
});

/* ------------------------------------------------------------------------- */
/* promote_entities                                                          */
/* ------------------------------------------------------------------------- */

export const promoteEntitiesTool = new DynamicStructuredTool({
  name: "promote_entities",
  description:
    "Promote 3+ raw entities to synthesized level, or 3+ synthesized entities to abstract level. Uses LLM to generate synthesized content from source entities. Maintains bidirectional links between source and promoted entities.",
  schema: z.object({
    source_entity_ids: z
      .array(z.string())
      .min(3)
      .describe("IDs of entities to promote (minimum 3 required)"),
    target_level: z
      .enum(["synthesized", "abstract"])
      .describe(
        "Target abstraction level: 'synthesized' (from raw entities) or 'abstract' (from synthesized entities)",
      ),
    title: z
      .string()
      .optional()
      .describe(
        "Optional: Manual title for promoted entity (otherwise LLM generates)",
      ),
    content: z
      .string()
      .optional()
      .describe(
        "Optional: Manual content for promoted entity (otherwise LLM generates)",
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "Optional: Preview mode - shows what would be created without making changes (default: false)",
      ),
  }),
  func: async (input) => {
    const result = await promoteEntities(
      getAdapter(),
      input as PromoteEntitiesInput,
    );
    return JSON.stringify(result, null, 2);
  },
});

/* ------------------------------------------------------------------------- */
/* traverse_graph                                                            */
/* ------------------------------------------------------------------------- */

export const traverseGraphTool = new DynamicStructuredTool({
  name: "traverse_graph",
  description:
    "Traverse the graph to find entities connected via relationship edges. Use this to explore multi-hop relationships, discover chains of related entities, and understand how entities are connected in the knowledge graph. Accepts either 'node_id' or 'entity_id', and either 'edge_types' or 'relationship_types'.",
  schema: z.object({
    node_id: z
      .string()
      .optional()
      .describe(
        "The ID of the entity to start traversal from (also accepts 'entity_id' as alias)",
      ),
    entity_id: z
      .string()
      .optional()
      .describe("Alias for node_id — use either one"),
    direction: z
      .enum(["out", "in", "both"])
      .optional()
      .describe(
        "Direction to traverse: 'out' (outgoing edges), 'in' (incoming edges), 'both' (bidirectional). Default: 'out'",
      ),
    edge_types: z
      .array(z.string())
      .optional()
      .describe(
        "Filter by relationship types (e.g., ['EXTENDS', 'IMPLEMENTS', 'DEPENDS_ON']). Also accepts 'relationship_types' as alias.",
      ),
    relationship_types: z
      .array(z.string())
      .optional()
      .describe("Alias for edge_types — use either one"),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe(
        "Maximum depth to traverse (1 = immediate neighbors, 2 = two hops, etc.). Default: 1",
      ),
  }),
  func: async (input) => {
    const result = await traverseGraph(
      getAdapter(),
      input as TraverseGraphInput,
    );
    return JSON.stringify(result, null, 2);
  },
});

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function storedToRetrieved(e: StoredEntityShape): SearchResultEntity {
  // StoredEntityShape lines up with RetrievedEntity for every field the
  // reranker reads (id, entity_type, title, content, context, tags, priority,
  // status, created_at, metadata). The extra `agent_id` flows through.
  return e as unknown as SearchResultEntity;
}
