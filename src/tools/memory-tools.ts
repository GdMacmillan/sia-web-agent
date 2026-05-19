/**
 * Memory Tools for Agent Entity Management
 *
 * Provides access to the Graph-Memory system for storing and retrieving
 * any type of entity (ideas, notes, learnings, tasks, patterns, decisions).
 * These tools match the MCP server tools exactly for consistency.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  rerankEntities,
  rerankEntitiesWithScores,
  type RetrievedEntity,
  type WeightPreset,
} from "../utils/knowledge-reranking.js";
import { processQueryWithHyDE } from "../utils/hyde.js";
import { processQueryWithDecomposition } from "../utils/query-decomposition.js";
import { logger } from "../utils/logger.js";
import { getDefaultClient } from "../clients/graph-memory-client.js";
import { getConfig } from "../config/index.js";

// Get shared Graph Memory client instance
const graphMemoryClient = getDefaultClient();

// Helper to make API calls to Graph Memory (delegates to client)

async function callGraphMemoryAPI(
  method: string,
  endpoint: string,

  data?: any,
): Promise<any> {
  return graphMemoryClient.request(method, endpoint, data);
}

/**
 * Parse user_input field (format: "[entity_type] title") to recover metadata.
 * Mirrors the Go pattern in consolidation/discovery.go:172-183.
 */
function parseUserInput(userInput: string | undefined): {
  entity_type?: string;
  title?: string;
} {
  if (!userInput) return {};
  if (userInput.startsWith("[")) {
    const idx = userInput.indexOf("] ");
    if (idx > 0) {
      return {
        entity_type: userInput.substring(1, idx) || undefined,
        title: userInput.substring(idx + 2).trim() || undefined,
      };
    }
  }
  return { title: userInput };
}

/**
 * Store any type of entity in the graph memory database
 */
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
  func: async ({
    entity_type,
    title,
    content,
    context,
    tags,
    priority,
    status,
    abstraction_level,
    metadata,
    related_entity_ids,
    relationship_types,
  }) => {
    // Search for semantically similar entities to suggest relationships
    let suggestedEntities: Array<{
      id: string;
      title: string;
      entity_type: string;
    }> = [];
    let suggestionWarning = "";

    try {
      // Construct search query from title + content
      const searchQuery = `${title} ${content}`.substring(0, 500);

      // Build DSL query with entity_type filter
      const sanitizedQuery = searchQuery.replace(/"/g, '\\"');
      const semanticQuery = `MATCH CONVERSATIONS SEMANTIC "${sanitizedQuery}" THRESHOLD 0.5 LIMIT 5`;

      // Execute search via DSL
      const searchResponse = await callGraphMemoryAPI("POST", "/graph/query", {
        query: semanticQuery,
      });

      if (searchResponse.success) {
        const nodes =
          searchResponse.data.data?.nodes || searchResponse.data.nodes || [];

        // Filter and format suggestions (only same entity_type)
        if (nodes.length > 0) {
          const filtered = nodes
            .map((node: any) => {
              const nodeMetadata =
                node.properties?.metadata || node.properties || {};
              const parsed = parseUserInput(node.properties?.user_input);
              return {
                id: node.id,
                title:
                  nodeMetadata.title ||
                  parsed.title ||
                  node.properties?.title ||
                  "Untitled",
                entity_type:
                  nodeMetadata.entity_type || parsed.entity_type || "unknown",
              };
            })
            .filter((e: any) => e.entity_type === entity_type)
            .slice(0, 5); // Top 5

          suggestedEntities = filtered;
        }

        if (suggestedEntities.length === 0) {
          suggestionWarning =
            "No similar entities found for relationship suggestions. Consider linking related entities manually.";
        }
      } else {
        // Search failed
        suggestionWarning =
          "Could not search for related entities due to error.";
      }
    } catch (_searchError) {
      suggestionWarning = "Could not search for related entities due to error.";
    }

    const entityData: any = {
      agent_id: getConfig().runtime.agentId,
      user_input: `[${entity_type}] ${title}`,
      agent_output: content,
      context: context || "general",
      metadata: {
        entity_type,
        title,
        content,
        context,
        tags: tags || [],
        priority: priority || "medium",
        status: status || "active",
        abstraction_level: abstraction_level || "raw",
        created_at: new Date().toISOString(),
        ...(metadata || {}),
        // NOTE: relationship metadata is NO LONGER stored - we use edges instead
      },
    };

    const response = await callGraphMemoryAPI(
      "POST",
      "/conversations",
      entityData,
    );

    if (!response.success) {
      throw new Error(`Failed to store entity: ${response.error}`);
    }

    const entityId = response.data.id;

    // Create edges for related entities (if any)
    const relatedIds = related_entity_ids || [];
    const relationshipTypesArray = relationship_types || [];
    const edgeErrors: Array<{
      target_id: string;
      relationship_type: string;
      error: string;
    }> = [];

    if (relatedIds.length > 0) {
      for (let i = 0; i < relatedIds.length; i++) {
        const targetId = relatedIds[i];
        const edgeType = relationshipTypesArray[i] || "RELATED_TO";

        try {
          const edgeResponse = await callGraphMemoryAPI(
            "POST",
            "/graph/edges",
            {
              from_node_id: entityId,
              to_node_id: targetId,
              type: edgeType,
              properties: {
                created_at: new Date().toISOString(),
              },
            },
          );
          if (!edgeResponse.success) {
            const errMsg = edgeResponse.error || "Unknown edge creation error";
            logger.error(
              `Failed to create edge from ${entityId} to ${targetId}: ${errMsg}`,
            );
            edgeErrors.push({
              target_id: targetId,
              relationship_type: edgeType,
              error: errMsg,
            });
          }
        } catch (edgeError) {
          // Log edge creation failure but don't fail the entire operation
          const errMsg =
            edgeError instanceof Error ? edgeError.message : String(edgeError);
          logger.error(
            `Failed to create edge from ${entityId} to ${targetId}: ${errMsg}`,
          );
          edgeErrors.push({
            target_id: targetId,
            relationship_type: edgeType,
            error: errMsg,
          });
        }
      }
    }

    const storedEntity: any = {
      id: entityId,
      entity_type,
      title,
      status: "created",
      message: `Entity "${title}" (type: ${entity_type}) has been stored in graph memory`,
      details: {
        priority: priority || "medium",
        tags: tags || [],
        context: context || "general",
        created_at: new Date().toISOString(),
      },
    };

    // Surface edge creation failures if any
    if (edgeErrors.length > 0) {
      storedEntity.edge_errors = edgeErrors;
      storedEntity.edge_warning = `${edgeErrors.length} of ${relatedIds.length} relationship(s) could not be stored. Check edge_errors for details.`;
    }

    // Add relationship suggestions if found
    if (suggestedEntities.length > 0) {
      storedEntity.suggested_related_entities = suggestedEntities;
      storedEntity.suggestion_note =
        "These entities were found based on semantic similarity. To link them, use the 'related_entity_ids' parameter when storing.";
    } else if (suggestionWarning) {
      storedEntity.suggestion_warning = suggestionWarning;
    }

    return JSON.stringify(storedEntity, null, 2);
  },
});

/**
 * Retrieve a specific entity from graph memory by its ID
 */
export const retrieveEntityTool = new DynamicStructuredTool({
  name: "retrieve_entity",
  description:
    "Retrieve a specific entity from graph memory by its ID. Returns the full entity details including all metadata.",
  schema: z.object({
    entity_id: z.string().describe("The unique ID of the entity to retrieve"),
  }),
  func: async ({ entity_id }) => {
    const response = await callGraphMemoryAPI(
      "GET",
      `/graph/nodes/${entity_id}`,
      undefined,
    );

    if (!response.success) {
      throw new Error(`Entity not found: ${response.error}`);
    }

    const node = response.data;
    // Try nested metadata first, fall back to flat properties
    const metadata = node.properties?.metadata || node.properties || {};
    const parsed = parseUserInput(node.properties?.user_input);

    const entity = {
      id: node.id,
      entity_type: metadata.entity_type || parsed.entity_type || "unknown",
      title:
        metadata.title || parsed.title || node.properties?.title || "Untitled",
      content: node.properties?.agent_output || metadata.content || "",
      context: metadata.context,
      tags: metadata.tags || [],
      priority: metadata.priority || "medium",
      status: metadata.status || "active",
      agent_id: node.properties?.agent_id || "unknown",
      metadata: metadata.metadata || {},
      created_at: metadata.created_at,
      updated_at: metadata.updated_at,
    };

    return JSON.stringify(
      {
        entity,
        message: `Retrieved ${entity.entity_type}: "${entity.title}"`,
      },
      null,
      2,
    );
  },
});

/**
 * Search for entities using natural language queries
 */
export const searchEntitiesTool = new DynamicStructuredTool({
  name: "search_entities",
  description:
    "Search for entities using natural language queries. Uses semantic similarity to find relevant entities across all types. Supports filtering by entity type, tags, priority, status, and weighted re-ranking.",
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
    level: z
      .string()
      .optional()
      .describe(
        "Optional: Filter by abstraction level (e.g., 'raw', 'synthesized', 'abstract'). Can specify multiple levels comma-separated: 'synthesized,abstract'",
      ),
    cascade: z
      .boolean()
      .optional()
      .describe(
        "Optional: Use cascade retrieval - start at abstract level and fall back to synthesized then raw until results are found (default: false)",
      ),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 10)"),
    use_hyde: z
      .boolean()
      .optional()
      .describe(
        "Optional: Explicitly enable/disable HyDE (Hypothetical Document Embedding). If not specified, auto-detects based on query characteristics (question-form, abstract concepts).",
      ),
    decompose: z
      .boolean()
      .optional()
      .describe(
        "Optional: Enable query decomposition for complex multi-part queries. If not specified, auto-detects based on query complexity (conjunctions, multiple question words, length).",
      ),
    rerank: z
      .boolean()
      .optional()
      .describe(
        "Optional: Enable weighted re-ranking of results (default: true). Re-ranking uses semantic similarity, recency, access count, success rate, and priority to sort results.",
      ),
    rerank_preset: z
      .enum(["balanced", "semantic_heavy", "recency_heavy", "proven_only"])
      .optional()
      .describe(
        "Optional: Weight preset for re-ranking (default: balanced). Presets: balanced (default mix), semantic_heavy (prioritize semantic match), recency_heavy (prioritize recent knowledge), proven_only (prioritize success rate).",
      ),
    include_scores: z
      .boolean()
      .optional()
      .describe(
        "Optional: Include detailed score breakdown in response (default: false). Shows individual component scores for debugging/transparency.",
      ),
  }),
  func: async ({
    query,
    entity_type,
    tags,
    priority,
    status,
    level,
    cascade,
    limit,
    use_hyde,
    decompose,
    rerank,
    rerank_preset,
    include_scores,
  }) => {
    const searchLimit = limit || 10;

    // Define search function for decomposition to use
    const performSearch = async (
      searchQuery: string,
      searchOptions: any = {},
    ): Promise<RetrievedEntity[]> => {
      let nodes: any[];

      if (searchOptions.cascade || cascade) {
        // Use cascade retrieval endpoint
        const cascadeResponse = await callGraphMemoryAPI(
          "POST",
          "/search/cascade",
          {
            query: searchQuery,
            threshold: 0.3,
            limit: searchOptions.limit || searchLimit,
          },
        );

        if (!cascadeResponse.success) {
          throw new Error(`Failed to cascade search: ${cascadeResponse.error}`);
        }

        nodes = cascadeResponse.data.results || [];
      } else {
        // Use semantic search with optional LEVEL filter
        let semanticQuery = `MATCH CONVERSATIONS SEMANTIC "${searchQuery}" THRESHOLD 0.3`;

        if (searchOptions.level || level) {
          semanticQuery += ` LEVEL "${searchOptions.level || level}"`;
        }

        semanticQuery += ` LIMIT ${searchOptions.limit || searchLimit}`;

        const response = await callGraphMemoryAPI("POST", "/graph/query", {
          query: semanticQuery,
        });

        if (!response.success) {
          throw new Error(`Failed to search entities: ${response.error}`);
        }

        nodes = response.data.data?.nodes || response.data.nodes || [];
      }

      // Map to entity format
      return nodes.map((node: any) => {
        const metadata = node.properties?.metadata || node.properties || {};
        const parsed = parseUserInput(node.properties?.user_input);
        return {
          id: node.id,
          entity_type: metadata.entity_type || parsed.entity_type || "unknown",
          title:
            metadata.title ||
            parsed.title ||
            node.properties?.title ||
            "Untitled",
          content: node.properties?.agent_output || metadata.content || "",
          context: metadata.context,
          tags: metadata.tags || [],
          priority: metadata.priority || "medium",
          status: metadata.status || "active",
          agent_id: node.properties?.agent_id || "unknown",
          created_at: metadata.created_at,
          metadata: metadata,
        };
      });
    };

    // Try decomposition first for complex queries
    const decompositionResult = await processQueryWithDecomposition(
      query,
      async (subQuery: string, opts: any) => {
        // This is the search function passed to decomposition
        // It performs a single search with HyDE applied
        const hydeResult = await processQueryWithHyDE(subQuery, {
          useHyde: opts?.use_hyde,
        });

        // Execute search
        return await performSearch(hydeResult.searchQuery, opts);
      },
      {
        decompose,
        searchOptions: {
          entity_type,
          tags,
          priority,
          status,
          level,
          cascade,
          limit: searchLimit,
          use_hyde,
        },
        applyHydeToSubQueries: true,
      },
    );

    let entities: RetrievedEntity[];
    let hydeInfo: any;

    if (
      decompositionResult.applied &&
      decompositionResult.entities.length > 0
    ) {
      // Use decomposition results
      entities = decompositionResult.entities;
      hydeInfo = {
        applied: false,
        reason: "HyDE applied to sub-queries during decomposition",
      };
    } else {
      // Fallback to standard search
      const hydeResult = await processQueryWithHyDE(query, {
        useHyde: use_hyde,
      });

      entities = await performSearch(hydeResult.searchQuery, {
        entity_type,
        tags,
        priority,
        status,
        level,
        cascade,
        limit: searchLimit,
      });

      hydeInfo = {
        applied: hydeResult.applied,
        reason: hydeResult.reason,
        cached: hydeResult.cached,
      };
    }

    // Apply client-side filters
    if (entity_type) {
      entities = entities.filter((e: any) => e.entity_type === entity_type);
    }
    if (tags && tags.length > 0) {
      entities = entities.filter((e: any) =>
        tags.some((tag) => e.tags?.includes(tag)),
      );
    }
    if (priority) {
      entities = entities.filter((e: any) => e.priority === priority);
    }
    if (status) {
      entities = entities.filter((e: any) => e.status === status);
    }

    // Apply weighted re-ranking if enabled (default: true)
    const rerankEnabled = rerank !== false;
    const rerankPreset = (rerank_preset as WeightPreset) || "balanced";
    const includeScores = include_scores || false;

    const rerankingInfo: any = {
      applied: false,
      preset: rerankPreset,
      include_scores: includeScores,
    };

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

    if (rerankEnabled && entities.length > 0) {
      if (includeScores) {
        // Use rerankEntitiesWithScores to get score breakdown
        const scoredEntities = rerankEntitiesWithScores(
          entities as RetrievedEntity[],
          rerankPreset,
        );
        entities = scoredEntities.map((s) => s.entity);
        scoreDetails = scoredEntities.map((s) => ({
          score: s.score,
          components: s.components,
        }));
      } else {
        // Use regular rerankEntities
        entities = rerankEntities(entities as RetrievedEntity[], rerankPreset);
      }
      rerankingInfo.applied = true;
    }

    const result: any = {
      query,
      filters_applied: {
        entity_type,
        tags,
        priority,
        status,
        level,
        cascade,
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
      entities: entities.map((e: any, i: number) => ({
        id: e.id,
        entity_type: e.entity_type,
        title: e.title,
        context: e.context,
        tags: e.tags,
        priority: e.priority,
        status: e.status,
        agent_id: e.agent_id,
        created_at: e.created_at,
        // Include boost info if from decomposition
        ...(e.matchCount
          ? {
              match_count: e.matchCount,
              matched_sub_queries: e.matchedSubQueries,
              boost_score: e.boostScore,
            }
          : {}),
        // Include rerank scores if requested
        ...(includeScores && scoreDetails[i]
          ? {
              rerank_score: scoreDetails[i].score,
              rerank_components: scoreDetails[i].components,
            }
          : {}),
      })),
      message: decompositionResult.applied
        ? `Found ${entities.length} entities via query decomposition (${decompositionResult.successfulSubQueries} of ${decompositionResult.subQueries?.length} sub-queries succeeded)`
        : `Found ${entities.length} matching entities`,
    };

    return JSON.stringify(result, null, 2);
  },
});

/**
 * List all entities in graph memory with optional filtering
 */
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
  func: async ({
    entity_type,
    tags,
    priority,
    status,
    context,
    limit,
    offset,
  }) => {
    // Use DSL query to list recent conversations
    const listLimit = limit || 100;
    const listOffset = offset && offset > 0 ? offset : 0;
    // Fetch enough rows to satisfy offset+limit after client-side filtering
    const fetchLimit = listLimit + listOffset;
    const query = `MATCH CONVERSATIONS RECENT LIMIT ${fetchLimit}`;

    const response = await callGraphMemoryAPI("POST", "/graph/query", {
      query,
    });

    if (!response.success) {
      throw new Error(`Failed to list entities: ${response.error}`);
    }

    const nodes = response.data.data?.nodes || response.data.nodes || [];

    // Map to entity format
    let entities = nodes.map((node: any) => {
      // Try nested metadata first, fall back to flat properties
      const metadata = node.properties?.metadata || node.properties || {};
      const parsed = parseUserInput(node.properties?.user_input);
      return {
        id: node.id,
        entity_type: metadata.entity_type || parsed.entity_type || "unknown",
        title:
          metadata.title ||
          parsed.title ||
          node.properties?.title ||
          "Untitled",
        context: metadata.context,
        tags: metadata.tags || [],
        priority: metadata.priority || "medium",
        status: metadata.status || "active",
        agent_id: node.properties?.agent_id || "unknown",
        created_at: metadata.created_at,
      };
    });

    // Apply client-side filters
    if (entity_type) {
      entities = entities.filter((e: any) => e.entity_type === entity_type);
    }
    if (tags && tags.length > 0) {
      entities = entities.filter((e: any) =>
        tags.some((tag) => e.tags?.includes(tag)),
      );
    }
    if (priority) {
      entities = entities.filter((e: any) => e.priority === priority);
    }
    if (status) {
      entities = entities.filter((e: any) => e.status === status);
    }
    if (context) {
      entities = entities.filter((e: any) => e.context === context);
    }

    // Apply offset then limit
    if (listOffset > 0) {
      entities = entities.slice(listOffset);
    }
    entities = entities.slice(0, listLimit);

    // Group by entity type for better overview
    const entityTypes = new Map<string, number>();
    entities.forEach((e: any) => {
      const count = entityTypes.get(e.entity_type) || 0;
      entityTypes.set(e.entity_type, count + 1);
    });

    return JSON.stringify(
      {
        filters_applied: {
          entity_type,
          tags,
          priority,
          status,
          context,
          limit: listLimit,
          offset: listOffset,
        },
        total_count: entities.length,
        entity_types: Object.fromEntries(entityTypes),
        entities: entities.map((e: any) => ({
          id: e.id,
          entity_type: e.entity_type,
          title: e.title,
          context: e.context,
          tags: e.tags,
          priority: e.priority,
          status: e.status,
          agent_id: e.agent_id,
          created_at: e.created_at,
        })),
        message: `Listed ${entities.length} entities`,
      },
      null,
      2,
    );
  },
});

/**
 * Update the status of an entity to track its lifecycle
 */
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
  func: async ({ entity_id, status, notes }) => {
    // First, retrieve the existing entity to get current state
    const getResponse = await callGraphMemoryAPI(
      "GET",
      `/graph/nodes/${entity_id}`,
      undefined,
    );

    if (!getResponse.success) {
      throw new Error(`Entity not found: ${getResponse.error}`);
    }

    const node = getResponse.data;
    const metadata = node.properties?.metadata || {};

    // Update the entity with new status
    const updateData: any = {
      properties: {
        metadata: {
          ...metadata,
          status,
          updated_at: new Date().toISOString(),
          ...(notes ? { status_notes: notes } : {}),
        },
      },
    };

    const response = await callGraphMemoryAPI(
      "PATCH",
      `/graph/nodes/${entity_id}`,
      updateData,
    );

    if (!response.success) {
      throw new Error(`Failed to update entity status: ${response.error}`);
    }

    const updatedMetadata = response.data.properties?.metadata || {};

    return JSON.stringify(
      {
        entity: {
          id: entity_id,
          entity_type: updatedMetadata.entity_type || metadata.entity_type,
          title: updatedMetadata.title || metadata.title,
          status: updatedMetadata.status,
        },
        new_status: status,
        notes,
        updated_at: updatedMetadata.updated_at,
        message: `Entity status updated to "${status}"`,
      },
      null,
      2,
    );
  },
});

/**
 * Full entity update with versioning and update modes
 * Supports replace (default), append (for content), and merge (for tags) modes
 */
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
  func: async ({
    entity_id,
    title,
    content,
    content_mode,
    tags,
    tags_mode,
    priority,
    context,
    status,
    notes,
  }) => {
    // Build metadata updates, filtering out undefined values
    const metadataUpdates: Record<string, unknown> = {};
    const modes: Record<string, string> = {};

    if (title !== undefined) {
      metadataUpdates.title = title;
    }
    if (content !== undefined) {
      metadataUpdates.content = content;
      if (content_mode) {
        modes.content = content_mode;
      }
    }
    if (tags !== undefined) {
      metadataUpdates.tags = tags;
      if (tags_mode) {
        modes.tags = tags_mode;
      }
    }
    if (priority !== undefined) {
      metadataUpdates.priority = priority;
    }
    if (context !== undefined) {
      metadataUpdates.context = context;
    }
    if (status !== undefined) {
      metadataUpdates.status = status;
    }
    if (notes) {
      metadataUpdates.update_notes = notes;
    }

    // PATCH request with modes
    const response = await callGraphMemoryAPI(
      "PATCH",
      `/graph/nodes/${entity_id}`,
      {
        properties: {
          metadata: metadataUpdates,
        },
        modes,
      },
    );

    if (!response.success) {
      throw new Error(`Failed to update entity: ${response.error}`);
    }

    const updatedMetadata = response.data.properties?.metadata || {};

    return JSON.stringify(
      {
        entity: {
          id: entity_id,
          entity_type: updatedMetadata.entity_type,
          title: updatedMetadata.title,
          status: updatedMetadata.status,
          version: response.version || updatedMetadata.current_version,
        },
        changed_fields: response.changed_fields,
        updated_at: updatedMetadata.updated_at,
        message: `Entity updated to version ${response.version || updatedMetadata.current_version}`,
      },
      null,
      2,
    );
  },
});

/**
 * Promote entities to higher abstraction level
 * Minimum 3 source entities required
 */
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
  func: async ({
    source_entity_ids,
    target_level,
    title,
    content,
    dry_run,
  }) => {
    const requestData: any = {
      source_entity_ids,
      target_level,
      dry_run: dry_run || false,
    };

    // Add optional title and content if provided
    if (title) {
      requestData.title = title;
    }
    if (content) {
      requestData.content = content;
    }

    const response = await callGraphMemoryAPI(
      "POST",
      "/admin/promote",
      requestData,
    );

    if (!response.success) {
      throw new Error(`Failed to promote entities: ${response.error}`);
    }

    const promotionResult = response.data;

    if (!promotionResult.success) {
      const errors = promotionResult.errors || [];
      throw new Error(
        `Promotion failed: ${errors.join(", ") || "Unknown error"}`,
      );
    }

    const promotedEntity = promotionResult.promoted_entity;
    const sourceEntities = promotionResult.source_entities || [];

    const result: any = {
      success: true,
      dry_run: promotionResult.dry_run,
      promoted_entity: {
        id: promotedEntity.id,
        entity_type: promotedEntity.entity_type,
        title: promotedEntity.title,
        content: promotedEntity.content,
        abstraction_level: promotedEntity.abstraction_level,
        source_entity_ids: promotedEntity.source_entity_ids,
      },
      source_entities: sourceEntities.map((e: any) => ({
        id: e.id,
        entity_type: e.entity_type,
        title: e.title,
      })),
      timestamp: promotionResult.timestamp,
    };

    if (dry_run) {
      result.message = `[DRY RUN] Would promote ${source_entity_ids.length} entities to '${target_level}' level`;
    } else {
      result.message = `Successfully promoted ${source_entity_ids.length} entities to '${target_level}' level (ID: ${promotedEntity.id})`;
    }

    return JSON.stringify(result, null, 2);
  },
});

/**
 * Traverse the graph to find entities connected via relationship edges
 * Enables multi-hop graph exploration using edge-based relationships
 */
export const traverseGraphTool = new DynamicStructuredTool({
  name: "traverse_graph",
  description:
    "Traverse the graph to find entities connected via relationship edges. Use this to explore multi-hop relationships, discover chains of related entities, and understand how entities are connected in the knowledge graph. Note: use 'node_id' (not 'entity_id') and 'edge_types' (not 'relationship_types') — these differ from store/retrieve tools.",
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
        "Direction to traverse: 'out' (outgoing edges - what this entity relates to), 'in' (incoming edges - what relates to this entity), 'both' (bidirectional). Default: 'out'",
      ),
    edge_types: z
      .array(z.string())
      .optional()
      .describe(
        "Filter by relationship types (e.g., ['EXTENDS', 'IMPLEMENTS', 'DEPENDS_ON']). Also accepts 'relationship_types' as alias. If omitted, all edge types are included.",
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
  func: async ({
    node_id,
    entity_id,
    direction,
    edge_types,
    relationship_types,
    max_depth,
  }) => {
    // Resolve aliases
    const resolvedNodeId = node_id || entity_id;
    if (!resolvedNodeId) {
      throw new Error("node_id (or entity_id) is required");
    }
    const resolvedEdgeTypes = edge_types || relationship_types;

    const response = await callGraphMemoryAPI("POST", "/graph/traverse", {
      node_id: resolvedNodeId,
      direction: direction || "out",
      edge_types: resolvedEdgeTypes,
      max_depth: max_depth || 1,
    });

    if (!response.success) {
      throw new Error(`Failed to traverse graph: ${response.error}`);
    }

    const traversalData = response.data;

    // Format the traversal results for better readability
    const formattedResults = traversalData.results.map((r: any) => {
      const metadata = r.node.properties?.metadata || {};
      const parsed = parseUserInput(r.node.properties?.user_input);
      return {
        id: r.node.id,
        entity_type: metadata.entity_type || parsed.entity_type || r.node.type,
        title:
          metadata.title ||
          parsed.title ||
          r.node.properties?.title ||
          "Untitled",
        depth: r.depth,
        path: r.path,
        edge_types: r.edge_types,
      };
    });

    const result = {
      start_node_id: resolvedNodeId,
      direction: direction || "out",
      max_depth: max_depth || 1,
      edge_types_filter: resolvedEdgeTypes || "all",
      results: formattedResults,
      count: traversalData.count,
      message: `Found ${traversalData.count} connected entities within ${max_depth || 1} hop(s)`,
    };

    return JSON.stringify(result, null, 2);
  },
});
