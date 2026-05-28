/**
 * Curated TypeScript type declarations for the `svc.graph-memory.v1`
 * IDL request / response shapes referenced by {@link IGraphMemoryAdapter}
 * and `tool-handlers.ts` (AGI-228 Phase 1 follow-on).
 *
 * Inlined (NOT re-exported from `../../generated/graph-memory/types.js`)
 * so this file is fully self-contained. Vendored byte-identical by
 * sia-web-agent under `src/vendor/svc-rpc/graph-memory/`. The agent
 * ships its own `SiadGraphMemoryAdapter` implementation that builds
 * wire envelopes against these types — it does NOT vendor the
 * generated `client.ts` (which would drag `createSvcClient` + the
 * whole svc-rpc framework along).
 *
 * **Drift protection.** The canonical `GraphMemoryAdapter` class
 * declares `implements IGraphMemoryAdapter`. Its method bodies thread
 * the Zod-inferred types from `../../generated/graph-memory/types.ts`
 * straight through. If the IDL changes the wire shape and the
 * codegen-emitted types diverge from these hand-maintained types, the
 * `implements` declaration fails to typecheck — that's the structural
 * lockstep guard between the IDL and the vendored handler surface.
 *
 * Pure type module — no runtime imports, no Zod schemas.
 */

// ---------------------------------------------------------------------------
// Shared entity shapes — mirror `NodeSchema`, `EdgeSchema`,
// `ConversationResponseSchema` from `graph-memory.idl.ts`.
// ---------------------------------------------------------------------------

export interface Node {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface ConversationResponse {
  id: string;
  agent_id: string;
  user_input: string;
  agent_output: string;
  context?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// entities.* — product-surface verbs.
// ---------------------------------------------------------------------------

export interface EntitiesStoreRequest {
  agent_id: string;
  user_input: string;
  agent_output: string;
  context?: string;
  metadata?: Record<string, unknown>;
}
export type EntitiesStoreResponse = ConversationResponse;

export interface EntitiesRetrieveRequest {
  nodeId: string;
}
export type EntitiesRetrieveResponse = Node | null;

export interface EntitiesListRequest {
  agentId?: string;
  limit?: number;
}
export type EntitiesListResponse = ConversationResponse[];

export interface EntitiesSearchRequest {
  query: string;
  threshold?: number;
  limit?: number;
}
export interface EntitiesSearchResponse {
  results: Node[];
  level_used: string;
  levels_tried: string[];
  query: string;
  threshold: number;
  total_results: number;
  timestamp: string;
}

export interface EntitiesUpdateStatusRequest {
  nodeId: string;
  status: string;
}
export interface EntitiesUpdateStatusResponse {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  version: number;
  changed_fields: string[];
}

export interface EntitiesUpdateRequest {
  nodeId: string;
  properties: Record<string, unknown>;
  modes?: Record<string, string>;
}
export type EntitiesUpdateResponse = EntitiesUpdateStatusResponse;

export interface EntitiesPromoteRequest {
  source_entity_ids: string[];
  target_level: string;
  title?: string;
  content?: string;
  method?: string;
  dry_run?: boolean;
}
export interface EntitiesPromoteResponse {
  success: boolean;
  dry_run: boolean;
  promoted_entity: unknown;
  source_entities: unknown[];
  errors?: string[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// graph.* — product-surface verbs.
// ---------------------------------------------------------------------------

export interface GraphTraverseRequest {
  nodeId: string;
  direction?: string;
  edgeTypes?: string[];
  maxDepth?: number;
}
export interface GraphTraverseResponse {
  results: unknown[];
  count: number;
}

export interface GraphEdgesRequest {
  fromNodeId: string;
  toNodeId: string;
  type: string;
  properties?: Record<string, unknown>;
}
export type GraphEdgesResponse = Edge;

/**
 * `graph.stats` takes no request fields (IDL: `z.object({})`).
 * Modeled as `Record<string, never>` rather than an empty interface so
 * lint rules don't flag the empty shape, while still rejecting any
 * payload key.
 */
export type GraphStatsRequest = Record<string, never>;
export interface GraphStatsResponse {
  total_nodes: number;
  total_edges: number;
  node_types: Record<string, number>;
  edge_types: Record<string, number>;
  timestamp: string;
}

export interface GraphQueryRequest {
  query: string;
}
export interface GraphQueryResponse {
  nodes?: Node[];
  edges?: Edge[];
  count?: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// admin.http — tunnel-style escape hatch.
// ---------------------------------------------------------------------------

export interface AdminHttpRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface AdminHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}
