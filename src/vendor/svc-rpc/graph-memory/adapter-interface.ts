/**
 * IGraphMemoryAdapter — pure interface extracted from
 * {@link GraphMemoryAdapter} (AGI-228 Phase 1 follow-on).
 *
 * The concrete `GraphMemoryAdapter` class wraps `createSvcClient` from
 * `@self-improving-agent/svc-rpc`, which pulls in the breaker / retry /
 * catalog / NATS-transport machinery. The MCP surface in this monorepo
 * is fine with that. The agent surface in `sia-web-agent` is not — it
 * routes every svc-rpc call through siad over the loopback HTTP
 * tunnel (AGI-290 / AGI-294) and therefore must ship its own thin
 * `IGraphMemoryAdapter` implementation that builds an envelope and
 * hands it to `SiadHttpClient.callRpc`.
 *
 * Decoupling `tool-handlers.ts` from the concrete class via this
 * interface is what lets both surfaces share the same handler code
 * without dragging the framework along. The handler signatures take
 * `IGraphMemoryAdapter`; both the MCP-side `GraphMemoryAdapter` and
 * the agent-side `SiadGraphMemoryAdapter` satisfy it.
 *
 * Pure type module — no runtime imports.
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
   * LLM-supplied wsId. See AGI-204 + feedback_workspace_id_transparent.md.
   */
  readonly workspaceId: string;

  // ── Entities (AGI-225 verb roster — `entities.*`) ─────────────────────

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

  // ── Graph (AGI-225 verb roster — `graph.*`) ───────────────────────────

  traverseGraph(req: GraphTraverseRequest): Promise<GraphTraverseResponse>;
  graphEdges(req: GraphEdgesRequest): Promise<GraphEdgesResponse>;
  graphStats(req: GraphStatsRequest): Promise<GraphStatsResponse>;
  graphQuery(req: GraphQueryRequest): Promise<GraphQueryResponse>;

  // ── Admin escape hatch ───────────────────────────────────────────────

  adminHttp(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}
