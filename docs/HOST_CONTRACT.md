# Host Contract

The agent is designed to be portable. It depends on the host (the process
that spawns it) for two things only:

1. A set of **environment variables** stamped at spawn time.
2. One **loopback HTTP endpoint** the agent can POST usage events to.

Anything beyond that — DB connections, message buses, deployment topology —
is the host's concern, not the agent's. A host that honors this contract
can run the agent without any of the rest of the sia-web stack.

This document is the source of truth for that contract. The reference
implementation is **siad** (Go daemon, lives in the `sia-web` monorepo);
any other host that wants to manage SIA agents must produce the same
env-var shape and accept the same HTTP requests.

---

## 1. Environment variables (host → agent at spawn)

All variables are read from `process.env` at agent boot via the central
config loader (`src/config/`). The host stamps them on the spawned child
process; there is no out-of-band fetch.

### 1.1 LLM provider (required)

| Variable | Purpose | Required |
|---|---|---|
| `LLM_PROVIDER` | One of `openrouter`, `openai`, `vllm`, `ollama`, `lmstudio`, `custom`. Defaults to `openrouter` when unset. | No |
| `{PREFIX}_API_KEY` | API key for the chosen provider (e.g. `OPENROUTER_API_KEY`). | Yes (except for keyless local providers like `ollama`) |
| `{PREFIX}_BASE_URL` | Override the provider's default base URL. | No |
| `{PREFIX}_MODEL` | Default model when no role-specific model is set. | No |
| `{PREFIX}_SMALL_FAST_MODEL` | Model tier for routing + memory. | Recommended |
| `{PREFIX}_MIDTIER_MODEL` | Model tier for orchestrator / researcher / answer. | Recommended |
| `{PREFIX}_HEAVY_THINKING_MODEL` | Model tier for the planner. | Recommended |
| `{PREFIX}_{ROLE}_MODEL` | Per-role override (highest precedence). | No |

`{PREFIX}` matches the provider name uppercased: `OPENROUTER_`, `OPENAI_`,
`VLLM_`, etc.

### 1.2 Identity

The agent currently reads two identity vars from env:

| Variable | Purpose | Required |
|---|---|---|
| `SIA_WORKSPACE_ID` | Tenant scope. Echoed in usage-event payloads; the host validates the echo as defense-in-depth. | Required iff `SIAD_EVENTS_URL` is set |
| `SIA_AGENT_ID` | Stable agent identifier. Echoed in usage-event payloads; the host scopes the per-spawn bearer token to it. Defaults to `"self-improving-agent"` when unset. | Required iff `SIAD_EVENTS_URL` is set |

The reference `siad` implementation also stamps additional identity
vars (`SIA_NODE_ID`, `SIA_OWNER_USER_ID`) for its own bookkeeping and
for forward compatibility with planned agent features. The agent does
not currently read either — they're stamped-but-unconsumed today. Hosts
should stamp them if their downstream pipeline expects them; the agent
won't object.

For standalone OSS use, both can be left unset — the usage-events
callback no-ops and the agent boots with the default `SIA_AGENT_ID`.

### 1.3 Usage-events callback (optional)

| Variable | Purpose | Required |
|---|---|---|
| `SIAD_EVENTS_URL` | Full URL of the host's usage-events endpoint. Convention: `http://127.0.0.1:{port}/v1/agent/events/usage`. When unset, the agent's usage-events middleware no-ops. | No |
| `SIAD_LOCAL_TOKEN` | Bearer token the agent presents on every POST. The host mints a fresh token per spawn and validates it on the way back in. | Required iff `SIAD_EVENTS_URL` is set |

The agent's middleware skips the POST entirely if either variable is
unset — there is no "send anyway and see what happens" fallback. When a
host wants telemetry, it MUST stamp both. Best-effort: cost tracking
never blocks the agent regardless.

### 1.4 Stamping rules (for host implementers)

Order of precedence (last write wins):

1. `os.Environ()` of the host process (inherits its own env).
2. `SIA_AGENT_ID` (set by the host from its own state).
3. Per-agent runtime config the host fetched ahead of spawn (LLM keys, model selections, etc.).
4. `SIAD_LOCAL_TOKEN`, `SIAD_EVENTS_URL` (minted/built per spawn).
5. Operator overrides (always last; operator wins).

The reference implementation mints `SIAD_LOCAL_TOKEN` from 32 bytes of
`crypto/rand`, hex-encoded (256-bit entropy), and stores it in an in-memory
registry keyed by `SIA_AGENT_ID` for the lifetime of the child process.
Tokens are dropped when the child exits.

---

## 2. Loopback HTTP endpoint (agent → host at invoke)

The agent's usage-events middleware (`src/middleware/usage-events.ts`)
fires after every LLM completion and POSTs raw token counts to the host.
The host enriches with its own context (userId, nodeId, version stamp),
republishes onto whatever message bus it uses, and computes cost
host-side.

### 2.1 Request

```http
POST {SIAD_EVENTS_URL}
Authorization: Bearer {SIAD_LOCAL_TOKEN}
Content-Type: application/json

{
  "agentId":     "<from SIA_AGENT_ID>",
  "workspaceId": "<from SIA_WORKSPACE_ID>",
  "timestamp":   "<ISO-8601 UTC>",
  "provider":    "openrouter" | "openai" | "...",
  "model":       "<resolved model name>",
  "inputTokens":  <int>,
  "outputTokens": <int>,
  "threadId":    "<thread_id from runtime.configurable, optional>",
  "runId":       "<UUID generated per LLM call, optional>",
  "cachedTokens": <int, optional>,
  "providerMetadata": { "generationId": "...", "model": "..." }
}
```

### 2.2 Required fields

`agentId`, `workspaceId`, `provider`, `model`, `timestamp`, `inputTokens`,
`outputTokens`. The host MUST reject requests missing any of these with
`400 Bad Request`.

### 2.3 Optional fields

- `threadId` — only included when the agent run was scoped to a thread.
- `runId` — UUIDv4 generated per LLM call. Lets the host dedupe.
- `cachedTokens` — included only when the provider reported cache reads.
  Omitting the field is distinct from sending `0`.
- `providerMetadata` — provider-specific extras (OpenRouter generation
  ID, resolved model, etc.). The host may persist or discard.

### 2.4 Responses

| Status | Meaning | Agent action |
|---|---|---|
| `202 Accepted` | Host enqueued the event for async processing. | Continue. |
| `400 Bad Request` | Body invalid, required field missing, or `workspaceId` echo did not match the spawn's workspace. | Log + drop. |
| `401 Unauthorized` | Missing/wrong bearer, or `agentId` is not in the host's per-spawn registry. | Log + drop. |
| `503 Service Unavailable` | Host accepted the request but its downstream (message bus, DB) failed. | Log + drop. |

### 2.5 Failure handling

Usage events are **best-effort, never load-bearing**. The agent:

- Never blocks the LLM completion on the POST. The middleware fires after
  `handler(request)` returns and wraps its work in `try/catch`.
- Times out the POST after 2 seconds.
- Catches every error (network, 4xx, 5xx, timeout) and logs at debug.
- Drops the event. No retry, no queue.

If you are implementing a host and want at-least-once delivery, do it on
the host side after `202` — the agent will not redeliver.

---

## 3. Security model

- **Loopback only.** The host binds the events endpoint to `127.0.0.1`.
  Other machines cannot reach it.
- **Per-spawn bearer.** `SIAD_LOCAL_TOKEN` rotates on every agent spawn.
  A compromised agent process cannot impersonate a different agent on
  the same host.
- **Workspace echo.** The agent sends its `workspaceId` in the body; the
  host validates it matches the workspace the agent was spawned for.
- **Constant-time compare.** Reference implementation uses
  `subtle.ConstantTimeCompare` on the bearer to prevent timing oracles.

The agent does not sign payloads, does not establish a TLS session
(loopback), and does not persist credentials. All trust derives from the
host having stamped the right token at spawn time.

---

## 4. What the agent does NOT depend on

Explicitly out of scope of this contract:

- **No DB connection.** The agent never reads or writes to any database.
  Configuration (LLM keys, model selections) reaches the agent via env;
  if the host stores those in a DB, the host fetches and stamps them.
- **No message bus client.** The agent does not connect to NATS, Kafka,
  or any other broker. Telemetry leaves the agent only via the loopback
  POST.
- **No service discovery.** The agent does not look up the host by DNS,
  IP, or registry. The host gives it a URL or it stays silent.
- **No file-system handshake.** No shared sockets, no PID files, no
  `~/.siad/`-style state.

A host that satisfies §1 + §2 above is sufficient. Anything more is
implementation detail.

---

## 5. Reference implementation pointers

For implementers studying siad (in the `sia-web` monorepo):

- Env stamping: `packages/siad/internal/process/manager.go` — `Start()`,
  `mintLoopbackToken()`.
- HTTP handler: `packages/siad/internal/chatbridge/publisher.go` —
  `handleAgentUsageEvent`, `agentUsageEventRequest`.
- Route registration: `packages/siad/internal/chatbridge/bridge.go`.

For the agent side (this repo):

- Middleware: `src/middleware/usage-events.ts` —
  `createUsageEventsMiddleware`.
- Wired into the model pipeline at: `src/agent.ts`.
