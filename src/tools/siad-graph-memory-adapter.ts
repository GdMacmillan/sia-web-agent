/**
 * Implements {@link IGraphMemoryAdapter} by calling the local host
 * process configured via `SIA_DAEMON_URL` + `SIA_DAEMON_TOKEN`. The
 * host is whatever process spawned the agent; it accepts the call and
 * dispatches to its graph-memory backend.
 *
 * The agent process holds no NATS connection and no workspace
 * authority. The workspace id is bound at construction from runtime
 * config and threaded into every call — the LLM never supplies it.
 *
 * Failure handling is intentionally thin: this adapter surfaces a
 * plain `Error` on any non-success, leaving retry / breaker policy
 * to the host implementation.
 */
import type { IGraphMemoryAdapter } from "../vendor/svc-rpc/graph-memory/adapter-interface.js";
import {
  GRAPH_MEMORY_SCHEMA_HASH,
  GRAPH_MEMORY_VERB_SCHEMA_HASHES,
} from "../vendor/svc-rpc/graph-memory/schema-hash.js";
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
} from "../vendor/svc-rpc/graph-memory/ir-types.js";
import { callHostRpc } from "../utils/host-rpc.js";
import { logger } from "../utils/logger.js";

const SERVICE = "graph-memory";
const SERVICE_VERSION = "v1";
const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_BASE_URL = "http://127.0.0.1:7700";

export interface SiadGraphMemoryAdapterOptions {
  /** Workspace this adapter is bound to. Required. */
  workspaceId: string;
  /**
   * Base URL of the host process. Defaults to
   * `process.env.SIA_DAEMON_URL` or `http://127.0.0.1:7700`.
   */
  siadUrl?: string;
  /**
   * Bearer token. Defaults to `process.env.SIA_DAEMON_TOKEN`.
   */
  siadToken?: string;
  /** Per-call deadline in ms. Defaults to 30000. */
  deadlineMs?: number;
  /** Test seam. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam. Defaults to `crypto.randomUUID()`. */
  randomId?: () => string;
}

export class SiadGraphMemoryAdapter implements IGraphMemoryAdapter {
  readonly workspaceId: string;
  private readonly siadUrl: string;
  private readonly siadToken: string;
  private readonly deadlineMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly randomId: () => string;

  constructor(opts: SiadGraphMemoryAdapterOptions) {
    if (!opts.workspaceId) {
      throw new Error(
        "SiadGraphMemoryAdapter requires a non-empty workspaceId. " +
          "It MUST come from runtime context (getConfig().runtime.workspaceId, " +
          "sourced from SIA_WORKSPACE_ID).",
      );
    }
    this.workspaceId = opts.workspaceId;
    this.siadUrl = (
      opts.siadUrl ??
      process.env.SIA_DAEMON_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, "");
    this.siadToken = opts.siadToken ?? process.env.SIA_DAEMON_TOKEN ?? "";
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.randomId =
      opts.randomId ??
      (() => {
        if (typeof crypto !== "undefined" && crypto.randomUUID) {
          return crypto.randomUUID();
        }
        return `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      });

    if (!this.siadToken) {
      logger.warn(
        "[SiadGraphMemoryAdapter] SIA_DAEMON_TOKEN is empty — graph-memory calls will be rejected by the host.",
      );
    }
  }

  // ── Entities ──────────────────────────────────────────────────────────

  storeEntity(req: EntitiesStoreRequest): Promise<EntitiesStoreResponse> {
    return this.call<EntitiesStoreRequest, EntitiesStoreResponse>(
      "entities.store",
      req,
    );
  }

  retrieveEntity(
    req: EntitiesRetrieveRequest,
  ): Promise<EntitiesRetrieveResponse> {
    return this.call<EntitiesRetrieveRequest, EntitiesRetrieveResponse>(
      "entities.retrieve",
      req,
    );
  }

  listEntities(req: EntitiesListRequest): Promise<EntitiesListResponse> {
    return this.call<EntitiesListRequest, EntitiesListResponse>(
      "entities.list",
      req,
    );
  }

  searchEntities(req: EntitiesSearchRequest): Promise<EntitiesSearchResponse> {
    return this.call<EntitiesSearchRequest, EntitiesSearchResponse>(
      "entities.search",
      req,
    );
  }

  updateEntityStatus(
    req: EntitiesUpdateStatusRequest,
  ): Promise<EntitiesUpdateStatusResponse> {
    return this.call<
      EntitiesUpdateStatusRequest,
      EntitiesUpdateStatusResponse
    >("entities.update_status", req);
  }

  updateEntity(req: EntitiesUpdateRequest): Promise<EntitiesUpdateResponse> {
    return this.call<EntitiesUpdateRequest, EntitiesUpdateResponse>(
      "entities.update",
      req,
    );
  }

  promoteEntities(
    req: EntitiesPromoteRequest,
  ): Promise<EntitiesPromoteResponse> {
    return this.call<EntitiesPromoteRequest, EntitiesPromoteResponse>(
      "entities.promote",
      req,
    );
  }

  // ── Graph ─────────────────────────────────────────────────────────────

  traverseGraph(req: GraphTraverseRequest): Promise<GraphTraverseResponse> {
    return this.call<GraphTraverseRequest, GraphTraverseResponse>(
      "graph.traverse",
      req,
    );
  }

  graphEdges(req: GraphEdgesRequest): Promise<GraphEdgesResponse> {
    return this.call<GraphEdgesRequest, GraphEdgesResponse>("graph.edges", req);
  }

  graphStats(req: GraphStatsRequest): Promise<GraphStatsResponse> {
    return this.call<GraphStatsRequest, GraphStatsResponse>("graph.stats", req);
  }

  graphQuery(req: GraphQueryRequest): Promise<GraphQueryResponse> {
    return this.call<GraphQueryRequest, GraphQueryResponse>("graph.query", req);
  }

  // ── Admin escape hatch ───────────────────────────────────────────────

  adminHttp(req: AdminHttpRequest): Promise<AdminHttpResponse> {
    return this.call<AdminHttpRequest, AdminHttpResponse>("admin.http", req);
  }

  // ── Wire ──────────────────────────────────────────────────────────────

  private async call<TReq, TResp>(verb: string, payload: TReq): Promise<TResp> {
    if (!this.siadToken) {
      throw new Error(
        "SiadGraphMemoryAdapter: SIA_DAEMON_TOKEN is empty — cannot authenticate to the host",
      );
    }
    return callHostRpc<TReq, TResp>({
      url: this.siadUrl,
      token: this.siadToken,
      workspaceId: this.workspaceId,
      service: SERVICE,
      serviceVersion: SERVICE_VERSION,
      verb,
      schemaHash: GRAPH_MEMORY_SCHEMA_HASH,
      verbHash: GRAPH_MEMORY_VERB_SCHEMA_HASHES[verb],
      payload,
      deadlineMs: this.deadlineMs,
      errorPrefix: "SiadGraphMemoryAdapter",
      fetchImpl: this.fetchImpl,
      randomId: this.randomId,
    });
  }
}
