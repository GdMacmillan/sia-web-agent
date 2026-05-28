/**
 * Per-tool handlers for the graph-memory tool surface. Each handler
 * is a pure function of `(adapter, input) → result`: no I/O outside
 * the adapter, no logging, no rendering. Callers wrap each handler
 * in their own surface-specific shell.
 *
 * Behaviors that live in the handlers (rather than the shells):
 *
 *   - `storeEntity` pre-searches for similar entities, creates edges,
 *     surfaces `edge_errors` + suggestions.
 *   - `searchEntities` / `listEntities` decode wire responses and
 *     apply uniform in-process filters.
 *   - `updateEntity` / `updateEntityStatus` thread `version` +
 *     `changed_fields` through the response.
 *   - `promoteEntities` formats source-entity + dry-run reporting.
 *
 * Enrichments like HyDE, query decomposition, and reranking belong
 * in the caller — they wrap the handler call, they don't replace it.
 */
import type { IGraphMemoryAdapter } from "./adapter-interface.js";
import {
  buildUpdatePayload,
  decodeNode,
  decodeRetrieveResponse,
  decodeStoreResponse,
  decodeUpdateResponse,
  encodeStoreRequest,
  type EntityStoreInput,
  type EntityUpdateFields,
  type EntityUpdateModes,
  type Priority,
  type StoredEntityShape,
} from "./entity-shape.js";

/* ------------------------------------------------------------------------- */
/* Shared types                                                              */
/* ------------------------------------------------------------------------- */

export interface EdgeError {
  target_id: string;
  relationship_type: string;
  error: string;
}

export interface SuggestedEntity {
  id: string;
  title: string;
  entity_type: string;
}

export interface StoreEntityResult {
  id: string;
  entity_type: string;
  title: string;
  status: "created";
  message: string;
  details: {
    priority: Priority;
    tags: string[];
    context: string | undefined;
    created_at: string;
  };
  edge_errors?: EdgeError[];
  edge_warning?: string;
  suggested_related_entities?: SuggestedEntity[];
  suggestion_note?: string;
  suggestion_warning?: string;
}

export interface ListEntitiesFilters {
  entity_type?: string;
  tags?: string[];
  priority?: Priority;
  status?: string;
  context?: string;
}

/* ------------------------------------------------------------------------- */
/* store_entity                                                              */
/* ------------------------------------------------------------------------- */

export interface StoreEntityHandlerInput extends EntityStoreInput {
  /** `agent_id` carried on the wire envelope; defaults to "memory_agent". */
  agent_id?: string;
}

/**
 * Pre-search for similar entities of the same entity_type so the LLM
 * can wire the new entity into the existing graph. Failures are
 * non-fatal — the caller still proceeds with the store.
 */
async function suggestRelatedEntities(
  adapter: IGraphMemoryAdapter,
  input: EntityStoreInput,
): Promise<{ suggestions: SuggestedEntity[]; warning?: string }> {
  try {
    const resp = await adapter.searchEntities({
      query: input.title,
      threshold: 0.5,
      limit: 5,
    });

    const sameType = resp.results
      .map((node) => decodeNode(node))
      .filter(
        (e): e is StoredEntityShape =>
          !!e && e.entity_type === input.entity_type,
      )
      .slice(0, 5)
      .map((e) => ({ id: e.id, title: e.title, entity_type: e.entity_type }));

    if (sameType.length === 0) {
      return {
        suggestions: [],
        warning:
          "No similar entities found for relationship suggestions. Consider linking related entities manually using 'related_entity_ids' parameter.",
      };
    }

    return { suggestions: sameType };
  } catch {
    return {
      suggestions: [],
      warning: "Could not search for related entities due to error.",
    };
  }
}

export async function storeEntity(
  adapter: IGraphMemoryAdapter,
  input: StoreEntityHandlerInput,
): Promise<StoreEntityResult> {
  if (!input.entity_type || !input.title || !input.content) {
    throw new Error(
      "Missing required fields: entity_type, title, and content are required",
    );
  }

  const { suggestions, warning: suggestionWarning } =
    await suggestRelatedEntities(adapter, input);

  const wireReq = encodeStoreRequest(input, {
    agentId: input.agent_id ?? "memory_agent",
  });
  const wireResp = await adapter.storeEntity(wireReq);
  const stored = decodeStoreResponse(wireResp, input);

  const related = input.related_entity_ids ?? [];
  const relTypes = input.relationship_types ?? [];
  const edgeErrors: EdgeError[] = [];

  for (let i = 0; i < related.length; i++) {
    const targetId = related[i]!;
    const edgeType = relTypes[i] ?? "RELATED_TO";
    try {
      await adapter.graphEdges({
        fromNodeId: stored.id,
        toNodeId: targetId,
        type: edgeType,
        properties: { created_at: new Date().toISOString() },
      });
    } catch (err) {
      edgeErrors.push({
        target_id: targetId,
        relationship_type: edgeType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result: StoreEntityResult = {
    id: stored.id,
    entity_type: stored.entity_type,
    title: stored.title,
    status: "created",
    message: `Entity "${stored.title}" (type: ${stored.entity_type}) has been stored in graph memory`,
    details: {
      priority: stored.priority,
      tags: stored.tags,
      context: stored.context,
      created_at: stored.created_at,
    },
  };

  if (edgeErrors.length > 0) {
    result.edge_errors = edgeErrors;
    result.edge_warning = `${edgeErrors.length} of ${related.length} relationship(s) could not be stored. Check edge_errors for details.`;
  }

  if (suggestions.length > 0) {
    result.suggested_related_entities = suggestions;
    result.suggestion_note =
      "These entities were found based on semantic similarity. To link them, include their IDs in 'related_entity_ids' parameter when storing.";
  } else if (suggestionWarning) {
    result.suggestion_warning = suggestionWarning;
  }

  return result;
}

/* ------------------------------------------------------------------------- */
/* retrieve_entity                                                           */
/* ------------------------------------------------------------------------- */

export interface RetrieveEntityResult {
  entity: StoredEntityShape;
  message: string;
}

export async function retrieveEntity(
  adapter: IGraphMemoryAdapter,
  input: { entity_id: string },
): Promise<RetrieveEntityResult> {
  if (!input.entity_id) {
    throw new Error("entity_id is required");
  }
  const wireResp = await adapter.retrieveEntity({ nodeId: input.entity_id });
  const entity = decodeRetrieveResponse(wireResp);
  if (!entity) {
    throw new Error(`Entity with ID ${input.entity_id} not found`);
  }
  return {
    entity,
    message: `Retrieved ${entity.entity_type}: "${entity.title}"`,
  };
}

/* ------------------------------------------------------------------------- */
/* search_entities                                                           */
/* ------------------------------------------------------------------------- */

export interface SearchEntitiesInput {
  query: string;
  entity_type?: string;
  tags?: string[];
  priority?: Priority;
  status?: string;
  limit?: number;
  threshold?: number;
}

export interface SearchEntitiesResult {
  query: string;
  filters_applied: ListEntitiesFilters & { limit?: number };
  level_used?: string;
  levels_tried?: string[];
  count: number;
  entities: StoredEntityShape[];
  message: string;
}

export async function searchEntities(
  adapter: IGraphMemoryAdapter,
  input: SearchEntitiesInput,
): Promise<SearchEntitiesResult> {
  if (!input.query) {
    throw new Error("query is required");
  }

  const wireResp = await adapter.searchEntities({
    query: input.query,
    threshold: input.threshold ?? 0.3,
    limit: input.limit ?? 10,
  });

  const decoded = wireResp.results
    .map((node) => decodeNode(node))
    .filter((e): e is StoredEntityShape => !!e);

  const filtered = applyFilters(decoded, {
    entity_type: input.entity_type,
    tags: input.tags,
    priority: input.priority,
    status: input.status,
  });

  return {
    query: input.query,
    filters_applied: {
      entity_type: input.entity_type,
      tags: input.tags,
      priority: input.priority,
      status: input.status,
      limit: input.limit,
    },
    level_used: wireResp.level_used,
    levels_tried: wireResp.levels_tried,
    count: filtered.length,
    entities: filtered,
    message: `Found ${filtered.length} matching entities`,
  };
}

/* ------------------------------------------------------------------------- */
/* list_entities                                                             */
/* ------------------------------------------------------------------------- */

export interface ListEntitiesInput extends ListEntitiesFilters {
  limit?: number;
  offset?: number;
}

export interface ListEntitiesResult {
  filters_applied: ListEntitiesInput;
  total_count: number;
  entity_types: Record<string, number>;
  entities: StoredEntityShape[];
  message: string;
}

export async function listEntities(
  adapter: IGraphMemoryAdapter,
  input: ListEntitiesInput,
): Promise<ListEntitiesResult> {
  const limit = input.limit ?? 100;
  const offset = input.offset && input.offset > 0 ? input.offset : 0;
  const fetchLimit = limit + offset;
  const wireResp = await adapter.graphQuery({
    query: `MATCH CONVERSATIONS RECENT LIMIT ${fetchLimit}`,
  });

  const nodes = wireResp.nodes ?? [];
  let entities = nodes
    .map((node) => decodeNode(node))
    .filter((e): e is StoredEntityShape => !!e);

  entities = applyFilters(entities, {
    entity_type: input.entity_type,
    tags: input.tags,
    priority: input.priority,
    status: input.status,
    context: input.context,
  });

  if (offset > 0) entities = entities.slice(offset);
  entities = entities.slice(0, limit);

  const entityTypes = new Map<string, number>();
  for (const e of entities) {
    entityTypes.set(e.entity_type, (entityTypes.get(e.entity_type) ?? 0) + 1);
  }

  return {
    filters_applied: input,
    total_count: entities.length,
    entity_types: Object.fromEntries(entityTypes),
    entities,
    message: `Listed ${entities.length} entities`,
  };
}

/* ------------------------------------------------------------------------- */
/* update_entity_status                                                      */
/* ------------------------------------------------------------------------- */

export interface UpdateEntityStatusInput {
  entity_id: string;
  status: string;
  notes?: string;
}

export interface UpdateEntityStatusResult {
  entity: {
    id: string;
    entity_type: string;
    title: string;
    status: string;
  };
  new_status: string;
  notes?: string;
  updated_at: string;
  message: string;
}

export async function updateEntityStatus(
  adapter: IGraphMemoryAdapter,
  input: UpdateEntityStatusInput,
): Promise<UpdateEntityStatusResult> {
  if (!input.entity_id || !input.status) {
    throw new Error("entity_id and status are required");
  }

  const wireResp = await adapter.updateEntityStatus({
    nodeId: input.entity_id,
    status: input.status,
  });
  const decoded = decodeUpdateResponse(wireResp);

  return {
    entity: {
      id: decoded.id,
      entity_type: decoded.entity_type,
      title: decoded.title,
      status: decoded.status,
    },
    new_status: input.status,
    notes: input.notes,
    updated_at: decoded.updated_at,
    message: `Entity status updated to "${decoded.status}"`,
  };
}

/* ------------------------------------------------------------------------- */
/* update_entity                                                             */
/* ------------------------------------------------------------------------- */

export interface UpdateEntityInput {
  entity_id: string;
  title?: string;
  content?: string;
  content_mode?: "replace" | "append";
  tags?: string[];
  tags_mode?: "replace" | "merge";
  priority?: Priority;
  context?: string;
  status?: string;
  notes?: string;
}

export interface UpdateEntityResult {
  entity: {
    id: string;
    entity_type: string;
    title: string;
    status: string;
    version: number;
  };
  changed_fields: string[];
  updated_at: string;
  message: string;
}

export async function updateEntity(
  adapter: IGraphMemoryAdapter,
  input: UpdateEntityInput,
): Promise<UpdateEntityResult> {
  if (!input.entity_id) throw new Error("entity_id is required");

  const fields: EntityUpdateFields = {
    title: input.title,
    content: input.content,
    tags: input.tags,
    priority: input.priority,
    context: input.context,
    status: input.status,
  };
  const modes: EntityUpdateModes = {
    content: input.content_mode,
    tags: input.tags_mode,
  };
  const { properties, modes: modeMap } = buildUpdatePayload(
    fields,
    modes,
    input.notes,
  );

  const wireResp = await adapter.updateEntity({
    nodeId: input.entity_id,
    properties: properties.metadata,
    modes: modeMap,
  });
  const decoded = decodeUpdateResponse(wireResp);

  return {
    entity: {
      id: decoded.id,
      entity_type: decoded.entity_type,
      title: decoded.title,
      status: decoded.status,
      version: decoded.version,
    },
    changed_fields: decoded.changed_fields,
    updated_at: decoded.updated_at,
    message: `Entity updated to version ${decoded.version}`,
  };
}

/* ------------------------------------------------------------------------- */
/* promote_entities                                                          */
/* ------------------------------------------------------------------------- */

export interface PromoteEntitiesInput {
  source_entity_ids: string[];
  target_level: "synthesized" | "abstract";
  title?: string;
  content?: string;
  method?: string;
  dry_run?: boolean;
}

export interface PromotedEntitySummary {
  id?: string;
  entity_type?: string;
  title?: string;
  content?: string;
  abstraction_level?: string;
  source_entity_ids?: string[];
}

export interface PromoteEntitiesResult {
  success: true;
  dry_run: boolean;
  promoted_entity: PromotedEntitySummary | null;
  source_entities: Array<{ id?: string; entity_type?: string; title?: string }>;
  timestamp: string;
  message: string;
}

export async function promoteEntities(
  adapter: IGraphMemoryAdapter,
  input: PromoteEntitiesInput,
): Promise<PromoteEntitiesResult> {
  if (
    !Array.isArray(input.source_entity_ids) ||
    input.source_entity_ids.length < 3
  ) {
    throw new Error("promote_entities requires at least 3 source_entity_ids");
  }
  if (
    input.target_level !== "synthesized" &&
    input.target_level !== "abstract"
  ) {
    throw new Error(
      `target_level must be 'synthesized' or 'abstract' (got "${input.target_level}")`,
    );
  }

  const wireResp = await adapter.promoteEntities({
    source_entity_ids: input.source_entity_ids,
    target_level: input.target_level,
    title: input.title,
    content: input.content,
    method: input.method,
    dry_run: input.dry_run ?? false,
  });

  if (!wireResp.success) {
    const errors = wireResp.errors ?? [];
    throw new Error(
      `Promotion failed: ${errors.length > 0 ? errors.join(", ") : "Unknown error"}`,
    );
  }

  const promoted = (wireResp.promoted_entity ??
    null) as PromotedEntitySummary | null;
  const sources = (wireResp.source_entities ?? []) as Array<{
    id?: string;
    entity_type?: string;
    title?: string;
  }>;

  const dryRun = wireResp.dry_run;
  const message = dryRun
    ? `[DRY RUN] Would promote ${input.source_entity_ids.length} entities to '${input.target_level}' level`
    : `Successfully promoted ${input.source_entity_ids.length} entities to '${input.target_level}' level${
        promoted?.id ? ` (ID: ${promoted.id})` : ""
      }`;

  return {
    success: true,
    dry_run: dryRun,
    promoted_entity: promoted,
    source_entities: sources.map((e) => ({
      id: e.id,
      entity_type: e.entity_type,
      title: e.title,
    })),
    timestamp: wireResp.timestamp,
    message,
  };
}

/* ------------------------------------------------------------------------- */
/* traverse_graph                                                            */
/* ------------------------------------------------------------------------- */

export interface TraverseGraphInput {
  /** Either node_id or entity_id is accepted by tool surfaces. */
  node_id?: string;
  entity_id?: string;
  direction?: "out" | "in" | "both";
  /** Either edge_types or relationship_types is accepted. */
  edge_types?: string[];
  relationship_types?: string[];
  max_depth?: number;
}

export interface TraverseGraphResult {
  start_node_id: string;
  direction: "out" | "in" | "both";
  max_depth: number;
  edge_types_filter: string[] | "all";
  results: Array<{
    id: string;
    entity_type: string;
    title: string;
    depth: number;
    path: string[];
    edge_types: string[];
  }>;
  count: number;
  message: string;
}

export async function traverseGraph(
  adapter: IGraphMemoryAdapter,
  input: TraverseGraphInput,
): Promise<TraverseGraphResult> {
  const startId = input.node_id ?? input.entity_id;
  if (!startId) {
    throw new Error("node_id (or entity_id) is required");
  }
  const direction = input.direction ?? "out";
  const edgeTypes = input.edge_types ?? input.relationship_types;
  const maxDepth = input.max_depth ?? 1;

  const wireResp = await adapter.traverseGraph({
    nodeId: startId,
    direction,
    edgeTypes,
    maxDepth,
  });

  const rawResults = (wireResp.results ?? []) as Array<{
    node: { id: string; properties?: Record<string, unknown>; type?: string };
    depth: number;
    path: string[];
    edge_types: string[];
  }>;

  const results = rawResults.map((r) => {
    const decoded = decodeNode(r.node);
    return {
      id: r.node.id,
      entity_type:
        decoded?.entity_type !== "unknown"
          ? (decoded?.entity_type ?? r.node.type ?? "unknown")
          : (r.node.type ?? "unknown"),
      title: decoded?.title ?? "Untitled",
      depth: r.depth,
      path: r.path,
      edge_types: r.edge_types,
    };
  });

  return {
    start_node_id: startId,
    direction,
    max_depth: maxDepth,
    edge_types_filter: edgeTypes ?? "all",
    results,
    count: wireResp.count,
    message: `Found ${wireResp.count} connected entities within ${maxDepth} hop(s)`,
  };
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function applyFilters(
  entities: StoredEntityShape[],
  filters: ListEntitiesFilters,
): StoredEntityShape[] {
  let out = entities;
  if (filters.entity_type)
    out = out.filter((e) => e.entity_type === filters.entity_type);
  if (filters.priority)
    out = out.filter((e) => e.priority === filters.priority);
  if (filters.status) out = out.filter((e) => e.status === filters.status);
  if (filters.context) out = out.filter((e) => e.context === filters.context);
  if (filters.tags && filters.tags.length > 0) {
    const tags = filters.tags;
    out = out.filter((e) => tags.some((t) => e.tags.includes(t)));
  }
  return out;
}
