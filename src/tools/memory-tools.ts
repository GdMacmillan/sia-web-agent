/**
 * Memory tools for agent entity management.
 *
 * Each tool is a thin `DynamicStructuredTool` shell around a handler
 * from `src/vendor/svc-rpc/graph-memory/tool-handlers.ts`. Calls go
 * through a workspace-bound {@link SiadGraphMemoryAdapter} that
 * delegates each verb to the host process; the LLM never sees
 * `workspace_id`.
 *
 * Agent-only enrichments (HyDE / query decomposition / reranking) live
 * here as wrappers around the `searchEntities` handler — they don't
 * replace it.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  listEntities,
  nextStepForSearch,
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
import {
  getMemoryAdapter as getAdapter,
  _resetMemoryAdapterForTests,
  _setMemoryAdapterForTests,
} from "./memory-adapter.js";
import {
  rerankEntities,
  rerankEntitiesWithScores,
  type RetrievedEntity,
  type WeightPreset,
} from "../utils/knowledge-reranking.js";
import { processQueryWithHyDE } from "../utils/hyde.js";
import { processQueryWithDecomposition } from "../utils/query-decomposition.js";
import { getConfig } from "../config/index.js";

// Re-exported for back-compat: existing memory-tools tests import these
// seams from this module. The implementation now lives in `memory-adapter`.
export { _resetMemoryAdapterForTests, _setMemoryAdapterForTests };

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
/* store_entity                                                              */
/* ------------------------------------------------------------------------- */

export const storeEntityTool = new DynamicStructuredTool({
  name: "store_entity",
  description:
    'Store an entity (learning, decision, pattern, note, task, ...) in graph memory, optionally linked to existing entities. Load the "memory-management" skill for entity and relationship conventions.',
  schema: z.object({
    entity_type: z
      .string()
      .describe("e.g. 'learning', 'decision', 'pattern', 'note'"),
    title: z.string().describe("Short title"),
    content: z.string().describe("Full content"),
    context: z
      .string()
      .optional()
      .describe("Area it applies to, e.g. 'authentication'"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    priority: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Default 'medium'"),
    status: z.string().optional().describe("Default 'active'"),
    abstraction_level: z
      .enum(["raw", "synthesized", "abstract"])
      .optional()
      .describe(
        "Default 'raw' (one observation); 'synthesized' or 'abstract' for consolidated insights",
      ),
    metadata: z
      .record(z.string(), z.any())
      .optional()
      .describe("Custom key-value metadata"),
    related_entity_ids: z
      .array(z.string())
      .optional()
      .describe("Existing entity IDs to link to"),
    relationship_types: z
      .array(z.string())
      .optional()
      .describe(
        "Relationship type per related_entity_ids entry, e.g. 'DEPENDS_ON'",
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
    "Retrieve one entity from graph memory by ID, with all its fields and metadata.",
  schema: z.object({
    entity_id: z.string().describe("Entity ID"),
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
    "Search graph memory with a natural-language query (semantic and keyword match across all entity types), with optional filters and re-ranking. Searches stored knowledge, not code.",
  schema: z.object({
    query: z.string().describe("Natural-language query"),
    entity_type: z.string().optional().describe("Filter by entity type"),
    tags: z.array(z.string()).optional().describe("Filter by tags (any match)"),
    priority: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Filter by priority"),
    status: z.string().optional().describe("Filter by status"),
    limit: z.number().optional().describe("Max results (default 10)"),
    use_hyde: z
      .boolean()
      .optional()
      .describe(
        "Force hypothetical-document expansion on or off (auto when unset)",
      ),
    decompose: z
      .boolean()
      .optional()
      .describe("Split a multi-part query (auto when unset)"),
    rerank: z
      .boolean()
      .optional()
      .describe("Weighted re-ranking (default true)"),
    rerank_preset: z
      .enum(["balanced", "semantic_heavy", "recency_heavy", "proven_only"])
      .optional()
      .describe("Re-ranking preset (default 'balanced')"),
    include_scores: z
      .boolean()
      .optional()
      .describe("Include score breakdown (default false)"),
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
        // This tool re-shapes the handler result around the query
        // enrichment envelope, so the handler's hint is re-attached here.
        next_step: nextStepForSearch(entities.length),
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
    "List entities in graph memory, optionally filtered, for an overview of stored knowledge. Use search_entities to find something specific.",
  schema: z.object({
    entity_type: z.string().optional().describe("Filter by entity type"),
    tags: z.array(z.string()).optional().describe("Filter by tags (any match)"),
    priority: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Filter by priority"),
    status: z.string().optional().describe("Filter by status"),
    context: z.string().optional().describe("Filter by context"),
    limit: z.number().optional().describe("Max results (default 100)"),
    offset: z.number().optional().describe("Results to skip (default 0)"),
  }),
  func: async (input) => {
    const result = await listEntities(getAdapter(), input as ListEntitiesInput);
    return JSON.stringify(result, null, 2);
  },
});

/* ------------------------------------------------------------------------- */
/* update_entity_status                                                      */
/* ------------------------------------------------------------------------- */

export const updateEntityStatusTool = new DynamicStructuredTool({
  name: "update_entity_status",
  description:
    "Set an entity's status (e.g. completed, archived, blocked), with optional notes.",
  schema: z.object({
    entity_id: z.string().describe("The ID of the entity to update"),
    status: z.string().describe("New status"),
    notes: z
      .string()
      .optional()
      .describe("Why it changed: outcome, blockers, next steps"),
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
    "Update fields of an existing entity, merge keys into its metadata, or link it to other entities. Keeps the last 3 versions. For a status-only change use update_entity_status.",
  schema: z.object({
    entity_id: z.string().describe("The ID of the entity to update"),
    title: z.string().optional().describe("New title"),
    content: z.string().optional().describe("New or additional content"),
    content_mode: z
      .enum(["replace", "append"])
      .optional()
      .describe("Default 'replace'; 'append' adds to the existing content"),
    tags: z.array(z.string()).optional().describe("Tags to set or merge"),
    tags_mode: z
      .enum(["replace", "merge"])
      .optional()
      .describe("Default 'replace'; 'merge' unions with existing tags"),
    priority: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("New priority"),
    context: z.string().optional().describe("New context"),
    status: z.string().optional().describe("New status"),
    metadata: z
      .record(z.string(), z.any())
      .optional()
      .describe("Metadata keys to set; other keys are kept"),
    related_entity_ids: z
      .array(z.string())
      .optional()
      .describe("Entity IDs to link to (edges point from this entity)"),
    relationship_types: z
      .array(z.string())
      .optional()
      .describe("Type per related_entity_ids entry (default 'RELATED_TO')"),
    notes: z
      .string()
      .optional()
      .describe("Why it changed (kept in version history)"),
  }),
  func: async (input) => {
    const result = await updateEntity(getAdapter(), input as UpdateEntityInput);
    return JSON.stringify(result, null, 2);
  },
});

/* ------------------------------------------------------------------------- */
/* promote_entities                                                          */
/* ------------------------------------------------------------------------- */

export const promoteEntitiesTool = new DynamicStructuredTool({
  name: "promote_entities",
  description:
    "Consolidate 3+ raw entities into one synthesized entity, or 3+ synthesized entities into an abstract one. Content is generated unless you supply it; the result stays linked to its sources.",
  schema: z.object({
    source_entity_ids: z
      .array(z.string())
      .min(3)
      .describe("At least 3 source entity IDs"),
    target_level: z
      .enum(["synthesized", "abstract"])
      .describe("'synthesized' (from raw) or 'abstract' (from synthesized)"),
    title: z.string().optional().describe("Title (generated if omitted)"),
    content: z.string().optional().describe("Content (generated if omitted)"),
    dry_run: z
      .boolean()
      .optional()
      .describe("Preview without writing (default false)"),
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
    "Find entities connected to a starting entity through relationship edges, up to 5 hops. Pass the start as node_id or entity_id.",
  schema: z.object({
    node_id: z.string().optional().describe("Start entity ID"),
    entity_id: z
      .string()
      .optional()
      .describe("Alias for node_id — use either one"),
    direction: z
      .enum(["out", "in", "both"])
      .optional()
      .describe("Edge direction (default 'out')"),
    edge_types: z
      .array(z.string())
      .optional()
      .describe("Only follow these relationship types"),
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
      .describe("Hops to follow (default 1)"),
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
