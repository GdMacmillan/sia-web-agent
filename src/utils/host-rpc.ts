/**
 * Service calls through the host's loopback `POST /rpc/call` endpoint.
 *
 * The agent holds no connection to any backing service and no credential
 * for one. It hands the host a call envelope authenticated with its own
 * host token; the host decides whether the call is allowed, forwards it,
 * and returns the service's answer. See `docs/HOST_CONTRACT.md` §3.
 *
 * This helper throws a plain `Error` on any non-success — network failure,
 * a non-200 status, a non-JSON body, or an error envelope — and leaves
 * retry policy to the host. Callers that must never throw wrap it.
 */

/** Wire envelope the host accepts on the service-call endpoint. */
export interface RpcRequestEnvelope<TPayload> {
  version: 1;
  id: string;
  workspaceId: string;
  service: string;
  serviceVersion: string;
  verb: string;
  schemaHash: string;
  /**
   * Schema hash scoped to the single verb being called.
   *
   * The service-wide `schemaHash` identifies the whole service definition,
   * so it changes whenever any verb does. `verbHash` identifies just the
   * verb in this request, which lets the two sides agree per verb rather
   * than all-or-nothing.
   */
  verbHash?: string;
  replyTo: string;
  deadlineUnixMs: number;
  payload: TPayload;
}

/** Wire envelope the host returns on `200 OK` (success branch). */
interface RpcResponseEnvelopeOk<TPayload> {
  version: 1;
  id: string;
  ok: true;
  payload: TPayload;
}

/** Wire envelope the host returns on `200 OK` (error branch). */
interface RpcResponseEnvelopeErr {
  version: 1;
  id: string;
  ok: false;
  error: { code: string; message: string; retryable: boolean };
}

type RpcResponseEnvelope<T> = RpcResponseEnvelopeOk<T> | RpcResponseEnvelopeErr;

export interface HostRpcCall<TPayload> {
  /** Base URL of the host, no trailing slash. */
  url: string;
  /** The agent's own host token. */
  token: string;
  workspaceId: string;
  service: string;
  serviceVersion: string;
  verb: string;
  schemaHash: string;
  /** Omitted from the envelope when empty. */
  verbHash?: string;
  payload: TPayload;
  deadlineMs: number;
  /** Prefix for thrown messages, e.g. the calling adapter's name. */
  errorPrefix?: string;
  /** Test seam. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam. Defaults to `crypto.randomUUID()`. */
  randomId?: () => string;
}

function defaultRandomId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** One service call through the host. Resolves with the response payload. */
export async function callHostRpc<TReq, TResp>(
  call: HostRpcCall<TReq>,
): Promise<TResp> {
  const prefix = call.errorPrefix ?? "host rpc";
  const fetchImpl = call.fetchImpl ?? fetch;
  const { verb } = call;

  const envelope: RpcRequestEnvelope<TReq> = {
    version: 1,
    id: (call.randomId ?? defaultRandomId)(),
    workspaceId: call.workspaceId,
    service: call.service,
    serviceVersion: call.serviceVersion,
    verb,
    schemaHash: call.schemaHash,
    // An empty string carries no more information than omitting the key
    // and only widens the envelope.
    ...(call.verbHash ? { verbHash: call.verbHash } : {}),
    replyTo: "_INBOX.agent",
    deadlineUnixMs: Date.now() + call.deadlineMs,
    payload: call.payload,
  };

  let res: Response;
  try {
    res = await fetchImpl(`${call.url}/rpc/call`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${call.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
    });
  } catch (err) {
    throw new Error(
      `${prefix}: host network error for ${verb}: ${
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
    throw new Error(`${prefix}: host returned ${res.status} for ${verb}`);
  }

  let body: RpcResponseEnvelope<TResp>;
  try {
    body = (await res.json()) as RpcResponseEnvelope<TResp>;
  } catch (err) {
    throw new Error(
      `${prefix}: host returned 200 with non-JSON body for ${verb}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  if (body.ok) return body.payload;
  throw new Error(
    `svc.${call.service}.${call.serviceVersion}.${verb} failed [${body.error.code}]: ${body.error.message}`,
  );
}
