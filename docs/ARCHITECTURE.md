# Architecture

The agent is a LangGraph-based deep agent: a single LLM orchestrator that
composes behavior through stacked middleware and delegates structured
sub-tasks to specialized sub-agents. The runtime is built on
`deepagentsjs` patterns plus a thin set of locally-developed middleware
for self-modification, telemetry, and operational concerns.

This doc covers what the agent is and how it's wired. The runtime
contract between the agent and any host that spawns it lives in
[`HOST_CONTRACT.md`](./HOST_CONTRACT.md).

---

## File layout

```
src/
├── graph.ts                 # LangGraph entry — exports `graph`
├── agent.ts                 # createDeepAgent — middleware composition
├── deep-agent-setup.ts      # createDeepAgentWithDefaults — standard wiring
├── sub-agents.ts            # plan / research / answer sub-agent specs
├── system-prompts.ts        # loads prompts from /prompts
├── backend-config.ts        # default filesystem backend factory
├── backends/                # filesystem backend implementations
├── clients/                 # HTTP clients (graph-memory)
├── code-execution/          # TS/JS execution sandbox
├── config/                  # env-driven config loader + model factories
├── middleware/              # all middleware (see below)
├── schemas/                 # zod schemas
├── subagents/               # sub-agent runtime infra
├── tools/                   # tool definitions
├── types/                   # shared types
├── utils/                   # shared utilities
└── web-search/              # web search backend (Tavily)
prompts/                     # manager / plan / research / answer system prompts
skills/                      # extended capabilities (loaded on demand)
```

## Entry point

`src/graph.ts` builds the agent and exports `graph`, which
`langgraph.json` points at:

```ts
// src/graph.ts
const agent = await createDeepAgentWithDefaults({ projectRoot });
export const graph: any = agent.graph;
```

`createDeepAgentWithDefaults` (in `src/deep-agent-setup.ts`) is the
standard factory. It:

1. Resolves project root via `getProjectRoot()`.
2. Creates the orchestrator LLM via `createStandardModel()` →
   `resolveModelEndpoint(config.llm, "orchestrator")`.
3. Assembles the standard tool set via `createStandardTools(projectRoot)`.
4. Loads the three default sub-agents lazily (`plan`, `research`, `answer`).
5. Creates a `MemorySaver` checkpointer (in-process; replace with a
   durable saver for production).
6. Calls `createDeepAgent` with everything above.

`createDeepAgent` (in `src/agent.ts`) is the low-level factory. Most
callers use the higher-level `createDeepAgentWithDefaults`; the
low-level form is exposed for tests and custom wiring.

## Middleware composition

The agent runs as a LangGraph `ReactAgent` with a middleware pipeline
applied around each model call. The composition in `src/agent.ts` is
the source of truth; the order matters.

### Main-agent middleware (in execution order)

| # | Middleware | What it does |
|---|---|---|
| 1 | `autoContinueMiddleware` | Retries transient LLM errors with exponential backoff before anything else sees them. |
| 2 | `capExhaustionMiddleware` | Detects OpenRouter `429 + key_limit` responses and dispatches a `cap_exhausted` event so a host UI can surface it. Re-throws so retry / abort paths still see the original error. |
| 3 | `usageEventsMiddleware` | Posts raw token usage to the host's `SIAD_EVENTS_URL` after every LLM call. No-ops when env unset. See [`HOST_CONTRACT.md`](./HOST_CONTRACT.md). |
| 4 | `todoListMiddleware()` | LangChain built-in. Provides `write_todos` / `update_todo_status` tools for structured task tracking. |
| 5 | `createFilesystemMiddleware` | Provides `ls` / `read_file` / `write_file` / `edit_file` / `glob` / `grep` tools backed by the configured `BackendProtocol`. |
| 6 | `createSkillsMiddleware` *(if projectRoot set)* | Indexes `/skills/SKILL.md` files, injects their summaries into the system prompt, exposes `load_skill` for on-demand expansion. |
| 7 | `createCodeExecutionMiddleware` *(if projectRoot set)* | Provides `execute_code` for TypeScript/JavaScript execution via tsx. Max execution time: 120s. |
| 8 | `createSubAgentMiddleware` | Provides the `task` tool. Delegates work to sub-agents (see [Sub-agents](#sub-agents)). |
| 9 | `summarizationMiddleware` | LangChain built-in. Compresses conversation history when token usage approaches a configured threshold. |
| 10 | `anthropicPromptCachingMiddleware` | LangChain built-in. Enables Anthropic prompt caching. `unsupportedModelBehavior: "ignore"` so non-Anthropic providers don't error. |
| 11 | `createPatchToolCallsMiddleware` | Repairs dangling / inconsistent tool calls across model providers. |
| 12 | `createKnowledgeFormationMiddleware` | After a task completes, evaluates the outcome (via `outcome-critic.ts`) and stores learnings in graph memory. |
| 13 | `humanInTheLoopMiddleware` *(if `interruptOn` provided)* | LangChain built-in. Pauses for human approval on configured tools. |
| 14 | Caller-supplied custom middleware | Anything passed via `params.middleware` runs last. |

`outcome-critic.ts` exists in `src/middleware/` but is not a standalone
middleware — it's a utility imported by `knowledge-formation.ts`.

### Sub-agent middleware

Each sub-agent runs its own pipeline, configured via
`createSubAgentMiddleware`'s `defaultMiddleware`. It mirrors the main
pipeline with two key differences:

- **No `knowledge-formation`** — only the orchestrator extracts
  learnings. Sub-agents do their work and return; their outcomes are
  evaluated by the orchestrator at the boundary.
- **Cheaper summarization model** — the sub-agent's summarization
  middleware uses a small/fast model resolved via
  `resolveModelEndpoint(config.llm, "memory")` rather than the main
  orchestrator model. Summarization is a lightweight compression task
  that doesn't need top-tier reasoning.

## Sub-agents

`src/sub-agents.ts` defines three lazily-loaded specialists. A fourth,
`general-purpose`, is added automatically by `createSubAgentMiddleware`
when `generalPurposeAgent: true` (set by
`createDeepAgentWithDefaults`).

| Sub-agent | Purpose | Tools |
|---|---|---|
| `plan` | Structured implementation plans. Returns JSON with ordered steps, risks, assumptions. | `getPlannerTools` — search + memory (read-only). Read-only filesystem comes through middleware. |
| `research` | Deep, systematic codebase investigation. Returns JSON with findings, recommendations, issues. | `getResearcherTools` — search, web search, read-only filesystem, memory, code execution. |
| `answer` | Deep web research for questions needing current external info. Returns synthesized answer with cited sources. | `getAnswerTools` — web search, search, read-only filesystem, memory. |
| `general-purpose` | Auto-provided fallback for unrouted task delegations. | All tools. |

Tool sets are defined in `src/tools/tool-sets.ts`. Each sub-agent has
its own LLM (`createPlanModel`, `createResearchModel`,
`createAnswerModel` in `src/config/model-config.ts`), letting the
operator route heavier models to planning and cheaper models to
research/answer.

## Tools

The standard tool set (`createStandardTools` in `deep-agent-setup.ts`):

- **Search & exploration** — `search` (ripgrep), `bash`, `web_search`
  (Tavily; requires `TAVILY_API_KEY`).
- **Memory** — `store_entity`, `retrieve_entity`, `search_entities`,
  `list_entities`, `update_entity_status` (5 of the 8 defined in
  `memory-tools.ts`; see [`GRAPH_MEMORY.md`](./GRAPH_MEMORY.md)).
- **Checklists** — `create_checklist`, `get_checklist`, `check_item`,
  `uncheck_item`, `set_dependencies`, `get_ready_items`,
  `delete_checklist`.

Additional tools come from middleware (not from `createStandardTools`):

- **Filesystem** — `ls`, `read_file`, `write_file`, `edit_file`,
  `glob`, `grep` (via `createFilesystemMiddleware`).
- **Todos** — `write_todos`, `update_todo_status` (via `todoListMiddleware`).
- **Skills** — `load_skill` (via `createSkillsMiddleware`, only when
  `projectRoot` is set).
- **Code execution** — `execute_code` (via `createCodeExecutionMiddleware`,
  only when `projectRoot` is set).
- **Sub-agent delegation** — `task` (via `createSubAgentMiddleware`).

## Backends

The filesystem-backed tools delegate to a `BackendProtocol`
implementation. Default: a `FilesystemBackend` rooted at the project
directory with virtual mode enabled (prevents directory traversal).
Callers can override `params.backend` with a custom backend or a
factory `(config: { state, store? }) => BackendProtocol`.

This indirection is what makes the agent portable: tests use a
state-backed backend; production uses the real filesystem backend; a
host that needs custom file semantics (sandboxed write, S3-backed,
etc.) supplies its own.

## System prompts

`src/system-prompts.ts` loads prompts from `prompts/*.md` at runtime:

- `manager.md` — the orchestrator's system prompt (the base prompt for
  every agent run, prepended to any `systemPrompt` the caller passes).
- `plan.md` — the plan sub-agent's prompt.
- `research.md` — the research sub-agent's prompt.
- `answer.md` — the answer sub-agent's prompt.

The skills middleware concatenates summaries of all `skills/*/SKILL.md`
files into the system prompt at boot, so the orchestrator knows what
skills are available without holding their full bodies in context.

## State

The agent uses LangGraph's `MessagesAnnotation` by default — a
messages array with a built-in reducer that deduplicates by message ID.
This is what makes multi-turn streaming work without duplicate
messages when using stream modes like `['values', 'updates']`.

Callers can override with a custom `contextSchema` if they need state
beyond the conversation.

## Checkpointing

`createDeepAgentWithDefaults` wires a `MemorySaver` — in-process,
ephemeral. Replace with a durable checkpointer (Postgres, Redis, etc.)
for any deployment that needs to survive a restart with thread state
intact.

## Configuration

All env-driven configuration runs through `src/config/loader.ts` via
the central `getConfig()` accessor. Provider selection is
`LLM_PROVIDER` (defaults to `openrouter`); per-tier and per-role model
overrides resolve through `resolveModelEndpoint(config.llm, role)`.
Full env reference: [`ENVIRONMENT.md`](./ENVIRONMENT.md).

The agent does not read any DB or message bus. Everything reaches it
through env at spawn time.

## Integration with sia-web

`sia-web` is the reference host implementation: a TypeScript daemon
(`siad`) on user-managed hardware spawns the agent as a child process,
stamps the env vars described in [`HOST_CONTRACT.md`](./HOST_CONTRACT.md),
and listens for usage events on a loopback HTTP endpoint. siad
republishes those events onto NATS for a separate web service to
compute cost host-side.

From the agent's perspective, none of that exists. The agent sees env
vars and one URL. Run it standalone, run it under a different host, or
run it inside sia-web — the runtime is identical.

What the agent depends on from the host:

- LLM provider config (env).
- Optional identity (env): `SIA_WORKSPACE_ID`, `SIA_AGENT_ID`,
  `SIA_NODE_ID`.
- Optional usage-event sink: `SIAD_EVENTS_URL` + `SIAD_LOCAL_TOKEN`.
- Optional graph-memory backend: `GRAPH_MEMORY_HOST` / `_PORT` / `_API`.
- Optional web search: `TAVILY_API_KEY`.

When unset, the corresponding capability no-ops gracefully. The agent
boots, the LLM runs, tools that don't need external resources work,
tools that do return errors at call time.
