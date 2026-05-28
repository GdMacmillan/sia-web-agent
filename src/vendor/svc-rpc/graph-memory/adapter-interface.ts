/**
 * Verb-level contract for the graph-memory service. A pure interface
 * with no transport assumptions, so any caller that satisfies the
 * methods — direct in-process, RPC-tunnelled through a host, mocked
 * in tests — composes with the shared `tool-handlers` module.
 *
 * Pure type module: no runtime imports.
 */
import type {
  AdminHttpRequest,
  AdminHttpResponse,
  EntitiesListRequest,
  EntitiesListResponse,
  EntitiesPromoteRequest,
  EntitiesPromoteResponse,
  EntitiesRetrieveRequest,
  EntitiesRetrieveResponse,
  EntitiesSearchRequest,
  EntitiesSearchResponse,
  EntitiesStoreRequest,
  EntitiesStoreResponse,
  EntitiesUpdateRequest,
  EntitiesUpdateResponse,
  EntitiesUpdateStatusRequest,
  EntitiesUpdateStatusResponse,
  GraphEdgesRequest,
  GraphEdgesResponse,
  GraphQueryRequest,
  GraphQueryResponse,
  GraphStatsRequest,
  GraphStatsResponse,
  GraphTraverseRequest,
  GraphTraverseResponse,
} from "./ir-types.js";

/**
 * The full `svc.graph-memory.v1` verb surface, plus the `admin.http`
 * escape hatch and the bound `workspaceId`. Mirrors
 * {@link GRAPH_MEMORY_ADAPTER_VERBS} method-for-method.
 */
export interface IGraphMemoryAdapter {
  /**
   * Bound at construction from runtime context. Readonly so callers
   * (and tests) can assert the adapter was not constructed with an
   * LLM-supplied workspace id.
   */
  readonly workspaceId: string;

  // ── Entities ──────────────────────────────────────────────────────────

  storeEntity(req: EntitiesStoreRequest): Promise<EntitiesStoreResponse>;
  retrieveEntity(
    req: EntitiesRetrieveRequest,
  ): Promise<EntitiesRetrieveResponse>;
  listEntities(req: EntitiesListRequest): Promise<EntitiesListResponse>;
  searchEntities(req: EntitiesSearchRequest): Promise<EntitiesSearchResponse>;
  updateEntityStatus(
    req: EntitiesUpdateStatusRequest,
  ): Promise<EntitiesUpdateStatusResponse>;
  updateEntity(req: EntitiesUpdateRequest): Promise<EntitiesUpdateResponse>;
  promoteEntities(
    req: EntitiesPromoteRequest,
  ): Promise<EntitiesPromoteResponse>;

  // ── Graph ─────────────────────────────────────────────────────────────

  traverseGraph(req: GraphTraverseRequest): Promise<GraphTraverseResponse>;
  graphEdges(req: GraphEdgesRequest): Promise<GraphEdgesResponse>;
  graphStats(req: GraphStatsRequest): Promise<GraphStatsResponse>;
  graphQuery(req: GraphQueryRequest): Promise<GraphQueryResponse>;

  // ── Admin escape hatch ───────────────────────────────────────────────

  adminHttp(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}
