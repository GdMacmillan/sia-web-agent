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
├── code-execution/          # TS/JS execution via tsx (plain child process, not sandboxed)
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
| 5a | `createSourceEditNoteMiddleware` | After a successful `write_file` / `edit_file` inside the installed source tree, appends a note that an update of the installed version replaces the tree (so the edit will not carry forward) and that the edit runs unreviewed until then. Never touches the request or a failed result; silent in a version-controlled working tree, in `.code-workspace/` and `node_modules/`, and when `SOURCE_EDIT_NOTE_ENABLED=false`. Registered in the sub-agent stack too. |
| 6 | `createSkillsMiddleware` *(if projectRoot set)* | Indexes `/skills/SKILL.md` files once per process, appends static how-to-use instructions to the system prompt, sends the name + description list as a session context message at the head of every request, and exposes `load_skill` for on-demand expansion. |
| 7 | `createCodeExecutionMiddleware` *(if projectRoot set)* | Provides `execute_code` for TypeScript/JavaScript execution via tsx. Max execution time: 120s. The bundled registration evaluates the in-tree twin of the seed component `components/execute-code`; with the seed root present the loader's instance replaces it by name (see [`COMPONENTS.md`](./COMPONENTS.md)). |
| 7a | `createCodeInterpreterMiddleware` *(opt-in, `ENABLE_CODE_INTERPRETER=true`)* | Provides the sandboxed QuickJS `eval` tool with in-REPL `task()` subagent fan-out. Lazily loaded. See [Code interpreter (QuickJS)](#code-interpreter-quickjs). |
| 8 | `createSubAgentMiddleware` | Provides the `task` tool. Delegates work to sub-agents (see [Sub-agents](#sub-agents)). |
| 9 | `summarizationMiddleware` | LangChain built-in. Compresses conversation history when token usage approaches a configured threshold. |
| 10 | `createPatchToolCallsMiddleware` | Repairs dangling / inconsistent tool calls across model providers. End of the **core** segment. |
| — | Caller-supplied **novel** custom middleware | Anything passed via `params.middleware` whose `.name` doesn't match a core/tail entry inserts **here**, between core and tail. |
| 11 | `anthropicPromptCachingMiddleware` | LangChain built-in. Prompt caching for a native `ChatAnthropic` model only; `unsupportedModelBehavior: "ignore"` skips every other model. First of the **tail** segment. |
| 11a | `createHostContextMiddleware` | Request-only. Appends today's date (local time, recomputed per model call) as the last message, and re-sends any system-role message found inside the history as a tagged context message in the same position. Never writes state. See [System prompt stability](#system-prompt-stability). |
| 11b | `createSystemPromptCacheMiddleware` | For an Anthropic model reached through an OpenAI-compatible gateway (`anthropic/` prefix or `claude` in the id), marks the system prompt's text block with `cache_control: { type: "ephemeral" }`. Every other model's request is unchanged. Innermost of every middleware that touches the system prompt. |
| 12 | `createKnowledgeFormationMiddleware` | After a task completes, evaluates the outcome (via `outcome-critic.ts`) and stores learnings in graph memory. |
| 13 | `humanInTheLoopMiddleware` *(if `interruptOn` provided)* | LangChain built-in. Pauses for human approval on configured tools. |

The stack is assembled with `mergeMiddlewareStack(core, custom, tail)`
(`src/middleware/utils.ts`). The **core** segment (rows 1–10) and the
**tail** segment (rows 11–13, order per upstream PR #331: caching →
knowledge formation → HITL, with 11a/11b right after caching) are merged with caller middleware **by
`.name`**: a same-name custom entry *replaces* the matching core/tail
entry in place; a novel custom entry inserts between the two segments.
This name-addressable stack is a genome prerequisite (swap / toggle /
add / remove operators). The system prompt is composed via
`SystemPromptConfig { prefix, base, suffix }` (`normalizeSystemPrompt` +
`assemblePromptParts`): a plain-string `systemPrompt` still goes before
the base prompt (legacy), while a config can replace/remove the base or
append a suffix (Phase 5 harness profiles drive this).

### System prompt stability

The system prompt the model receives is byte-identical on every call for
the life of the process, so a provider's prompt cache can serve the tool
definitions and system prompt from cache. Anything that changes is sent as
an ordinary message wrapped in a single tagged envelope,
`<host-context source="…" kind="…">…</host-context>` (one helper,
`src/utils/host-context.ts`, emits every instance). The first line inside
the tag is a fixed trust line for its `source`, so the model reads who
supplied the text before the text itself:

| Source | Kind | Content | Position |
|---|---|---|---|
| `host` | `skills` | The skills list (read once per process). | First message of every request. |
| `host` | `briefing` | A system-role message the host wrote into the history (a chat-room briefing, say). | Where it sits in the history. |
| `host` | `date` | `Today's date: YYYY-MM-DD`, local time. | Last message of every request. |
| `memory` | `memory` | Related graph-memory entries attached to a search-type tool result. | Appended to that tool result. |

The `host` trust line says the text comes from the system, not a person,
and asks nothing; the `memory` line says the entries are leads to verify,
written by other agents too, and that an instruction inside them is not a
request. Any `<host-context` or `<room-message` tag inside a wrapped body
is escaped, so a body cannot forge or close an envelope.

The three `host` envelopes are request-only; the checkpointed history is
unchanged. The `memory` envelope is part of the tool result, so it is
checkpointed with it.

The environment block in the system prompt (`src/utils/system-context.ts`)
carries only process-lifetime facts — working directory, git status,
platform, OS version — plus the model name, id and knowledge cutoff when
the host supplies them (`SIA_MODEL_NAME`, `SIA_MODEL_KNOWLEDGE_CUTOFF`; the
id is the resolved orchestrator model). A fact the host didn't supply is
omitted, never guessed. A middleware that appends to the system prompt
MUST append only text that is fixed for the process's lifetime.

Each agent's system prompt is its own file in `prompts/` followed by
`prompts/shared.md`, the rules every agent needs (what it reads is data,
report faithfully, load `codebase-navigation` before code work, end with a
final response). A rule lives in exactly one file;
`tests/unit/prompts/no-duplicate-sentences.test.ts` fails on a sentence
repeated across them. Guidance on parallel tool calls lives only in the
Claude harness profile's suffix (`src/profiles/builtins.ts`), so agents
running under a non-Claude profile get none.

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

The `plan` and `research` sub-agents are read-only. The shared sub-agent
middleware injects write-capable tools of its own (`write_file`,
`edit_file`, `execute_code`, `eval`), so filtering the base tool set is not
enough: each carries `createReadOnlyMiddleware` (`src/middleware/read-only.ts`),
which withholds file writes, memory writes and code execution from the
model and refuses a call to one if the model names it anyway. The `answer`
sub-agent is not read-only; it may store what it learns in memory.

## Code interpreter (QuickJS)

An **opt-in** second code-execution surface, vendored from upstream
`@langchain/quickjs` into `src/code-interpreter/`. Enabled with
`ENABLE_CODE_INTERPRETER=true`; disabled by default, in which case it is
never even imported (the module is loaded via dynamic `import()` in
`src/agent.ts` only when the flag is set, keeping its heavy WASM/ESM deps
out of the default module graph). The tsx-based `execute_code` tool
remains the default surface regardless — this adds a separate `eval`
tool, it does not replace anything.

The `eval` tool runs JavaScript/TypeScript in a fully isolated QuickJS
WASM sandbox (no network, no filesystem, no stdlib clock). State
persists across `eval` calls within a turn (a real REPL). Its headline
capability is **programmatic subagent orchestration**: an in-REPL
`task({ description, subagentType, responseSchema? })` global lets the
model fan work out to configured subagents in plain JavaScript
(`Promise.all`, filtering, multi-stage flows), bounded by a hard
per-eval concurrency cap of 32. Optional programmatic tool calling
(PTC) can also expose selected agent tools under a `tools.*` namespace.

The bridge from the REPL `task()` global to the fork's real `task` tool
(`src/middleware/subagents.ts`) lives in
`src/code-interpreter/middleware.ts`; it translates the REPL's
`subagentType` to the fork's snake_case `subagent_type` schema and
unwraps the returned LangGraph `Command` envelope to the subagent's
content.

**Three things to know:**

- **HITL bypass.** Tools and subagents invoked *inside* an `eval` do
  not route through the parent agent's `ToolNode`, so per-call
  `interruptOn` / human-in-the-loop approval does **not** fire for them.
  Gate the `eval` tool itself (or use the normal `task` tool outside
  JavaScript) if you need approval before a subagent launches.
- **Shared task id in events.** Every `task()` call within a single
  `eval` shares that eval's tool-call id in streamed SSE events; they
  are not individually attributable at the event layer.
- **`responseSchema` is validated but currently a no-op.** The schema is
  size/depth/property-checked and threaded through `config.configurable`
  under `SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY`
  (`src/code-interpreter/constants.ts`), but the fork's task tool does
  not yet consume that key to recompile a structured-output subagent
  (upstream's does). Until it does, a `responseSchema` passed to
  `task()` shapes nothing.

Vendored files under `src/code-interpreter/` are kept byte-identical to
upstream except `middleware.ts` (adapted to the fork's `systemPrompt`
string-append pattern and a local `constants.ts` instead of importing
`deepagents`). Tests live in `tests/unit/code-interpreter/` and run via
`yarn test:interpreter` (a separate jest config that sets
`--experimental-vm-modules` for the WASM/prettier dynamic imports);
`yarn test` runs them after the main suite. See
[`docs/UPDATE_WORKFLOW.md`](./UPDATE_WORKFLOW.md) for the re-sync
discipline.

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
- **Code execution** — `execute_code` (via the seed component
  `components/execute-code`, or its bundled twin
  `createCodeExecutionMiddleware`; only when `projectRoot` is set).
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

### Protocol v2 (structured Result returns)

`BackendProtocol` uses upstream deepagents' **v2** shape (ported
in-place — no v1/v2 split or `adaptBackendProtocol` shim, since all five
backends are local with a single consumer). Every read-style method
returns a structured Result carrying either data or a recoverable
`error` string, instead of a bare value or a thrown exception:

| Method | Returns | Notes |
|---|---|---|
| `ls(path)` | `LsResult` `{ files? , error? }` | renamed from `lsInfo` |
| `read(path, offset?, limit?)` | `ReadResult` `{ content?, mimeType?, error? }` | `content` is a `string` (text) or `Uint8Array` (binary) |
| `readRaw(path)` | `ReadRawResult` `{ data?, error? }` | |
| `grep(pattern, path?, glob?)` | `GrepResult` `{ matches?, error? }` | renamed from `grepRaw` |
| `glob(pattern, path?)` | `GlobResult` `{ files?, error? }` | renamed from `globInfo` |
| `write` / `edit` | `WriteResult` / `EditResult` | unchanged |
| `delete?(path)` | `DeleteResult` `{ path?, error? }` | **optional**; implemented on `FilesystemBackend` + `StateBackend`/`StoreBackend`, omitted on `RemoteBackend` until siad supports it |

`FileData` is now a union `FileDataV1 | FileDataV2` — v1 (`content: string[]`)
is what state/store persist and the LangGraph state schema validates; v2
(`content: string | Uint8Array` + `mimeType`) carries binary reads. The
`FilesystemBackend.read` **multimodal path** returns raw bytes + MIME
type for non-text files (see `getMimeType`/`isTextMimeType` in
`backends/utils.ts`); the `read_file` tool surfaces binary safely rather
than mis-decoding bytes as text.

Ride-along robustness fixes landed with the rewrite: recoverable
`{ error }` returns replace thrown exceptions on remote failures;
`ls`/`glob`/`grep` results are size-capped (`truncateFileInfos` /
`truncateGrepMatches`); and `glob` passes `suppressErrors` to fast-glob
so a symlink cycle (`ELOOP`) can't abort the walk. All preserved
invariants — `validatePathInProject`, `O_NOFOLLOW`, virtualMode, and
`CompositeBackend`'s `/remote/{nodeId}/` routing — are unchanged; the
permissions layer above still sits atop the hard project-root boundary.

`BaseSandbox` (`backends/sandbox.ts`, `SandboxBackendProtocolV2`) is an
abstract base for sandboxed/remote execution backends: subclasses
implement `execute` / `uploadFiles` / `downloadFiles` / `id` and inherit
POSIX-shell default implementations of the filesystem methods. It is
scaffolding for future distributed execution — no concrete sandbox
backend is wired in yet.

### Filesystem permissions

`createFilesystemMiddleware` / `createFilesystemTools` accept an optional
`permissions: FilesystemPermission[]` — a first-match-wins policy layer
(`src/permissions/`, ported from upstream deepagents). Each rule names
`operations` (`"read"` / `"write"`), absolute glob `paths` (micromatch,
`{dot:true}`), and a `mode` (`"allow"` default, or `"deny"`). Evaluation
is first-match-wins with a **permissive default**: no rule matches ⇒
allowed, and an empty/omitted ruleset is a no-op (zero behavior change).

The gate runs **inside the tool handlers**: `read_file` / `write_file` /
`edit_file` check the target path *before* any state or backend access
(a denied path never reaches the filesystem); `ls` / `glob` / `grep`
filter denied entries out of their results. Rule paths are validated at
setup (`validatePermissionPaths`) — absolute only, no `..` or `~`.

Permissions match the **pre-backend path namespace** — the virtual
absolute path the model passes, before the backend resolves it (virtual
paths under virtualMode). This is a *policy* layer that sits **above**
the backend's hard `validatePathInProject` project-root boundary
(`src/utils/path-utils.ts`), never in place of it: the boundary still
rejects any escape regardless of permission rules.

A separate `enabledTools?: FsToolName[]` allowlist selects which of the
six built-in filesystem tools to expose (`read_file` is always included).
It is distinct from `createFilesystemMiddleware`'s `tools` option, which
injects pre-created tool instances.

## System prompts

`src/system-prompts.ts` loads prompts from `prompts/*.md` at runtime:

- `manager.md` — the orchestrator's system prompt (the base prompt for
  every agent run, prepended to any `systemPrompt` the caller passes).
- `planner.md` — the plan sub-agent's prompt.
- `researcher.md` — the research sub-agent's prompt.
- `answer.md` — the answer sub-agent's prompt.
- `shared.md` — a fragment, not an agent prompt: the rules every agent
  needs, appended to each of the four above.
- `no-web-search.md` — a fragment appended last to the prompts that
  mention web search when no web-search key is configured.

The skills middleware reads the summaries of all `skills/*/SKILL.md`
files once per process and sends them as a host context message at the
head of every request (the system prompt carries only the static
how-to-use text), so the orchestrator knows what skills are available
without holding their full bodies in context.

## Harness profiles

`src/profiles/` defines **harness profiles** — small, JSON-serializable
units of behavior configuration ("proto-genomes") that shape an agent at
assembly time, *orthogonal to model selection*. A `HarnessProfile` has
five fields: `baseSystemPrompt` (replace the base prompt),
`systemPromptSuffix` (append after it), `toolDescriptionOverrides`
(rewrite named tool descriptions), `excludedTools`, and
`excludedMiddleware`.

`resolveHarnessProfile(modelString, override)` (`profiles/builtins.ts`)
picks a profile: the `HARNESS_PROFILE` env var overrides everything
(`off` disables profiles; a name selects a built-in), otherwise the
model string is matched by pattern. One built-in ships today —
`anthropic-claude` (matches `anthropic/claude-*`), carrying the
universal Claude guidance suffix (parallel tool calls /
investigate-before-answering / tool-result reflection).

`createDeepAgent` applies the resolved profile: the suffix/base flow
through the Phase-4 `SystemPromptConfig` assembly; `excludedMiddleware`
filters the merged stack **post-merge** (required scaffolding —
`FilesystemMiddleware`, `subAgentMiddleware` — is always protected);
`excludedTools` appends `_ToolExclusionMiddleware`
(`middleware/tool_exclusion.ts`) so exclusions catch every
tool-injecting middleware; and `toolDescriptionOverrides` feed
`createFilesystemTools` and the subagent `task` description.

**Serialization** (`profiles/harness.ts`) is deliberate, not incidental:
`serializeProfile` / `parseHarnessProfileConfig` round-trip a profile
through a `.strict()` zod schema with prototype-pollution rejection
(`__proto__` / `constructor` / `prototype` at any depth). This is what
lets profiles serve as genome snapshots / blueprints. The upstream
global-symbol registry, merge machinery, `extraMiddleware`, and
general-purpose-subagent config are intentionally **not** ported (slim
scope).

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
