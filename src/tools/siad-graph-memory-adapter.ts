/**
 * SiadGraphMemoryAdapter — agent-side `IGraphMemoryAdapter` implementation
 * that tunnels every `svc.graph-memory.v1` verb through siad's loopback
 * `POST /rpc/call` endpoint (AGI-228 Phase 2).
 *
 * The chain at runtime:
 *
 *     memory tool (LLM)
 *       └─ vendored tool-handlers.ts function (IGraphMemoryAdapter)
 *            └─ SiadGraphMemoryAdapter (this file)
 *                 └─ POST /rpc/call → siad
 *                      └─ siad publishes on w.{wsId}.svc.graph-memory.v1.<verb>
 *                           └─ graph-memory responder
 *
 * Why this exists. The canonical `GraphMemoryAdapter` in the monorepo
 * wraps `createSvcClient` (breaker / retry / hooks / catalog / NATS
 * transport). Pulling that runtime into sia-web-agent would drag the
 * whole svc-rpc framework along — ~6.8 kloc the agent doesn't need.
 * Instead, this adapter mirrors the host-side `NatsRpcStorageBackend`
 * → `SiadRpcTransport` → `SiadHttpClient` chain from the monorepo
 * (`packages/sia/src/storage/`) inline, against just the interface the
 * vendored handlers depend on. The agent process therefore never imports
 * `nats`, never opens a NATS connection, and never holds a workspace
 * authority — siad is the authoritative tenant proxy on every call.
 *
 * Resilience. None on the agent side. siad's NATS client owns breaker
 * / retry / budget on the data plane; the upstream svc-rpc client
 * runtime (which we don't ship) is what would normally hydrate
 * `RpcError`. Here we throw plain `Error` on failure — the LLM-facing
 * tool-handlers don't differentiate retryability anyway.
 *
 * Envelope wire shape. Mirrors `RpcRequestEnvelope` from
 * `packages/svc-rpc/src/envelope.ts` — see that file for the canonical
 * Zod schema. `replyTo` is a placeholder ("_INBOX.agent") because siad
 * rewrites it to a fresh local inbox per request (the agent has no NATS
 * subscription after AGI-210). `deadlineUnixMs` is hard-coded to 30s
 * out, matching the default tool call timeout on the agent side.
 */
import type { IGraphMemoryAdapter } from "../vendor/svc-rpc/graph-memory/adapter-interface.js";
import { GRAPH_MEMORY_SCHEMA_HASH } from "../vendor/svc-rpc/graph-memory/schema-hash.js";
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
import { logger } from "../utils/logger.js";

const SERVICE = "graph-memory";
const SERVICE_VERSION = "v1";
const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_BASE_URL = "http://127.0.0.1:7700";

/** Wire envelope subset siad accepts (mirrors `RpcRequestEnvelope`). */
interface RpcRequestEnvelope<TPayload> {
  version: 1;
  id: string;
  workspaceId: string;
  service: string;
  serviceVersion: string;
  verb: string;
  schemaHash: string;
  replyTo: string;
  deadlineUnixMs: number;
  payload: TPayload;
}

/** Wire envelope siad returns on `200 OK` (success branch). */
interface RpcResponseEnvelopeOk<TPayload> {
  version: 1;
  id: string;
  ok: true;
  payload: TPayload;
}

/** Wire envelope siad returns on `200 OK` (error branch). */
interface RpcResponseEnvelopeErr {
  version: 1;
  id: string;
  ok: false;
  error: { code: string; message: string; retryable: boolean };
}

type RpcResponseEnvelope<T> = RpcResponseEnvelopeOk<T> | RpcResponseEnvelopeErr;

export interface SiadGraphMemoryAdapterOptions {
  /** Workspace this adapter is bound to. Required. */
  workspaceId: string;
  /**
   * Base URL of the loopback siad daemon. Defaults to
   * `process.env.SIA_DAEMON_URL` or `http://127.0.0.1:7700`.
   */
  siadUrl?: string;
  /**
   * Bearer token for the loopback bridge. Defaults to
   * `process.env.SIA_DAEMON_TOKEN`.
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
          "set from SIA_WORKSPACE_ID by siad's install_node_daemon).",
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
        "[SiadGraphMemoryAdapter] SIA_DAEMON_TOKEN is empty — siad will reject every /rpc/call with 401. " +
          "This usually means the agent was spawned outside of `apply_agent`.",
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
        "SiadGraphMemoryAdapter: SIA_DAEMON_TOKEN is empty — cannot authenticate /rpc/call",
      );
    }

    const envelope: RpcRequestEnvelope<TReq> = {
      version: 1,
      id: this.randomId(),
      workspaceId: this.workspaceId,
      service: SERVICE,
      serviceVersion: SERVICE_VERSION,
      verb,
      schemaHash: GRAPH_MEMORY_SCHEMA_HASH,
      replyTo: "_INBOX.agent",
      deadlineUnixMs: Date.now() + this.deadlineMs,
      payload,
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.siadUrl}/rpc/call`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.siadToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(envelope),
      });
    } catch (err) {
      throw new Error(
        `SiadGraphMemoryAdapter: /rpc/call network error for ${verb}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }

    if (res.status !== 200) {
      try {
        await res.text();
      } catch {
        // ignore
      }
      throw new Error(
        `SiadGraphMemoryAdapter: /rpc/call returned ${res.status} for ${verb}`,
      );
    }

    let body: RpcResponseEnvelope<TResp>;
    try {
      body = (await res.json()) as RpcResponseEnvelope<TResp>;
    } catch (err) {
      throw new Error(
        `SiadGraphMemoryAdapter: /rpc/call returned 200 with non-JSON body for ${verb}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }

    if (body.ok) return body.payload;
    throw new Error(
      `svc.graph-memory.v1.${verb} failed [${body.error.code}]: ${body.error.message}`,
    );
  }
}
