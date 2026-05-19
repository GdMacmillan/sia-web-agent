# Environment

Every env var the agent reads. Sourced from `src/config/loader.ts`
(the singleton config loader — most config flows through this) and
direct grep across `src/middleware/` for vars middleware reads on its
own.

For the *host-contract* perspective on the env-stamping side of this —
which vars siad (or any equivalent host) is expected to set — see
[`HOST_CONTRACT.md`](./HOST_CONTRACT.md).

---

## LLM provider

The agent is provider-agnostic. `LLM_PROVIDER` picks the family; the
rest of the keys are namespaced by a provider-specific prefix derived
from the provider name (e.g. `openrouter` → `OPENROUTER_`, `openai` →
`OPENAI_`).

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `openrouter` | One of `openrouter`, `openai`, `vllm`, `ollama`, `lmstudio`, `custom`. Unknown values fail at boot. |
| `{PREFIX}_API_KEY` | `""` | Provider API key. Empty is allowed (some providers like `vllm` / `ollama` are keyless). |
| `{PREFIX}_BASE_URL` | provider preset | Override the provider's base URL. Presets: openrouter → `https://openrouter.ai/api/v1`, openai → `https://api.openai.com/v1`, vllm → `http://localhost:8000/v1`, ollama → `http://localhost:11434/v1`, lmstudio → `http://localhost:1234/v1`, custom → empty. |
| `{PREFIX}_MODEL` | provider preset | Default model for any role/tier that doesn't have an override. Presets: openrouter → `openai/gpt-4o-mini`, openai → `gpt-4o-mini`, others → empty. |

### Model tiers (recommended)

Tier vars let you point the agent at different models per
capability-class. Resolution looks at the tier first, then falls back
to `{PREFIX}_MODEL`.

| Variable | Used by |
|---|---|
| `{PREFIX}_SMALL_FAST_MODEL` | Memory operations, summarization (cheap compression). |
| `{PREFIX}_MIDTIER_MODEL` | Orchestrator (main agent), researcher, answer. |
| `{PREFIX}_HEAVY_THINKING_MODEL` | Planner. |

### Per-role overrides (highest precedence)

For finer control, role-specific overrides win over tier and provider
defaults.

| Variable | Used by |
|---|---|
| `{PREFIX}_ORCHESTRATOR_MODEL` / `_API_KEY` | Main agent. |
| `{PREFIX}_PLANNER_MODEL` / `_API_KEY` | Plan sub-agent. |
| `{PREFIX}_RESEARCHER_MODEL` / `_API_KEY` | Research sub-agent. |
| `{PREFIX}_ANSWER_MODEL` / `_API_KEY` | Answer sub-agent. |
| `{PREFIX}_MEMORY_MODEL` / `_API_KEY` | Summarization model. |
| `{PREFIX}_TOOL_USE_MODEL` / `_API_KEY` | Reserved for future tool-execution role. |

## Identity

| Variable | Default | Purpose |
|---|---|---|
| `SIA_AGENT_ID` | `self-improving-agent` | Echoed in usage-event payloads; the host scopes the per-spawn bearer token to it. |
| `SIA_AGENT_NAME` | `Self-Improving Agent` | Display name. Currently informational only. |
| `SIA_WORKSPACE_ID` | unset | Tenant scope. Echoed in usage-event payloads; the host validates the echo. Only read by `usage-events` middleware — without `SIAD_EVENTS_URL` set, ignored. |

## Host callback (usage events)

These power the loopback POST to the host's `/v1/agent/events/usage`
endpoint. When either is unset, the `usage-events` middleware no-ops
silently — the agent runs normally without telemetry. Full contract:
[`HOST_CONTRACT.md`](./HOST_CONTRACT.md).

| Variable | Purpose |
|---|---|
| `SIAD_EVENTS_URL` | Full URL of the host's usage-events endpoint. Convention: `http://127.0.0.1:{port}/v1/agent/events/usage`. |
| `SIAD_LOCAL_TOKEN` | Bearer token the agent presents on every POST. Host mints fresh per spawn. |

## Services

### Graph memory

If unset, defaults to `http://localhost:8080`. Tool calls fail at call
time when the backend is unreachable; no boot-time validation.

| Variable | Default | Purpose |
|---|---|---|
| `GRAPH_MEMORY_API` | unset | Full URL override (takes precedence over host + port). |
| `GRAPH_MEMORY_HOST` | `localhost` | Backend host. |
| `GRAPH_MEMORY_PORT` | `8080` | Backend port. |

### Web search

| Variable | Default | Purpose |
|---|---|---|
| `TAVILY_API_KEY` | `""` | Tavily API key for the `web_search` tool. Empty disables web search. |

## Middleware tuning

### Summarization

| Variable | Default | Purpose |
|---|---|---|
| `SUMMARIZATION_TRIGGER_TOKENS` | `170000` | Trigger compression when conversation tokens cross this threshold. |
| `SUMMARIZATION_KEEP_MESSAGES` | `20` | After compression, keep this many of the most-recent messages verbatim. |

### Cost tracking

| Variable | Default | Purpose |
|---|---|---|
| `COST_TRACKING_CACHE_TTL_MS` | unset | TTL for cached cost lookups; defaults to the cost-tracking module's internal default when unset. |

### Knowledge formation

Knowledge formation auto-extracts learnings from completed tasks and
stores them in graph memory.

| Variable | Default | Purpose |
|---|---|---|
| `KNOWLEDGE_FORMATION_ENABLED` | `true` | Set to `false` to disable extraction entirely. |
| `KNOWLEDGE_FORMATION_SENSITIVITY` | `balanced` | One of `conservative` / `balanced` / `aggressive`. Picks a preset for confidence + dedup + max-per-task knobs below. |
| `KNOWLEDGE_FORMATION_MIN_CONFIDENCE` | preset | Override the minimum confidence to store a learning. |
| `KNOWLEDGE_FORMATION_MAX_LEARNINGS` | preset | Override the max learnings stored per task. |
| `KNOWLEDGE_FORMATION_DEDUP_THRESHOLD` | preset | Override the similarity threshold for dedup against existing entities. |
| `KNOWLEDGE_FORMATION_EXCLUDE_AGENTS` | `""` | Comma-separated agent types to exclude from extraction. |
| `KNOWLEDGE_FORMATION_DEBUG` | `false` | Verbose logging. |

### Outcome tracking

Outcome tracking ranks memory results by historical success rate.

| Variable | Default | Purpose |
|---|---|---|
| `OUTCOME_TRACKING_ENABLED` | `true` | Set to `false` to disable outcome tracking. |
| `OUTCOME_TRACKING_CRITIC_ENABLED` | `true` | Set to `false` to disable the LLM-based outcome critic (used by knowledge formation). |
| `OUTCOME_TRACKING_SIMILARITY_WEIGHT` | module default | Reranking weight on semantic similarity. |
| `OUTCOME_TRACKING_SUCCESS_WEIGHT` | module default | Reranking weight on historical success rate. |
| `OUTCOME_TRACKING_RECENCY_WEIGHT` | module default | Reranking weight on recency. |
| `OUTCOME_TRACKING_MAX_HISTORY` | module default | Max past applications to consider when scoring. |
| `OUTCOME_TRACKING_MIN_APPLICATIONS` | module default | Minimum past applications before success-rate weighting kicks in. |

## Runtime

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | One of `trace` / `debug` / `info` / `warn` / `error`. |
| `NODE_ENV` | `development` | Standard Node environment marker. |
| `SIA_PROJECT_ROOT` | unset | Override the project root. When unset, resolved automatically via `getProjectRoot()` (walks up from module location looking for marker files). |
| `SIA_CLI_SOCKET_PATH` | unset | Reserved for CLI socket integration. |

## Notes on hidden config flow

`src/config/loader.ts` declares it's the only place that reads
`process.env`. That's almost true — the host-contract middleware
(`src/middleware/usage-events.ts`) reads `SIA_WORKSPACE_ID`,
`SIA_AGENT_ID`, `SIAD_EVENTS_URL`, and `SIAD_LOCAL_TOKEN` directly so
that the callback is fully self-contained. Other middleware go through
`getConfig()`.
