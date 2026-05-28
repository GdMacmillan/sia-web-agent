# CLAUDE.md

Codebase documentation for software engineering agents working on this
repo — human contributors using Claude Code, the SIA agent itself when
self-modifying, or any other coding agent. Keep this file accurate; it
is the entry point every agent reads first.

For deeper detail, see the files under `docs/` linked throughout.

## What this repo is

`@sia-web/agent` — the SIA agent runtime, extracted from `sia-web` for
standalone use and open-source contribution. The agent is a
LangGraph-based deep agent: a single LLM orchestrator that composes
behavior through stacked middleware and delegates structured sub-tasks
to specialized sub-agents.

**Scope:** just the agent. No HTTP server, no daemon, no database, no
web frontend. The agent consumes a small host contract (env vars at
spawn + one optional loopback HTTP endpoint for usage events) and can
run anywhere a LangGraph agent can run. The host contract is documented
in [`docs/HOST_CONTRACT.md`](docs/HOST_CONTRACT.md).

**Self-modification is a first-class use case.** The prompts in
`prompts/` and skills in `skills/` are designed to be edited — by
humans and by the agent itself. Changes to those files are behavioral
changes to the agent, not just documentation updates.

## Quick start commands

```bash
yarn install
yarn build              # tsc → dist/
yarn dev                # tsx watch src/index.ts
yarn test               # unit + debugging suites (integration is gated)
yarn test:integration   # RUN_INTEGRATION=true jest tests/integration
yarn lint               # eslint src
yarn typecheck          # tsc --noEmit
```

Standalone run requires only an LLM API key — copy `.env.example` to
`.env` and fill in `OPENROUTER_API_KEY` plus at least one model tier.

## Layout

```
src/                     # agent source
├── graph.ts             # LangGraph entry — exports `graph`
├── agent.ts             # createDeepAgent — middleware composition
├── deep-agent-setup.ts  # createDeepAgentWithDefaults — standard wiring
├── sub-agents.ts        # plan / research / answer sub-agent specs
├── system-prompts.ts    # loads prompts from /prompts
├── backend-config.ts    # default filesystem backend factory
├── backends/            # filesystem backend implementations
├── clients/             # HTTP clients (graph-memory)
├── code-execution/      # TS/JS execution sandbox
├── config/              # env-driven config loader + model factories
├── middleware/          # all middleware
├── schemas/             # zod schemas
├── subagents/           # sub-agent runtime infra
├── tools/               # tool definitions
├── types/               # shared types
├── utils/               # shared utilities
└── web-search/          # Tavily backend
prompts/                 # manager / planner / researcher / answer system prompts
skills/                  # extended capabilities loaded on demand
tests/                   # unit, integration, debugging
docs/                    # reference documentation
```

## Core documentation

| File | Purpose |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Runtime, middleware composition order, sub-agent stack |
| [`docs/HOST_CONTRACT.md`](docs/HOST_CONTRACT.md) | Env-var schema + `POST /v1/agent/events/usage` endpoint a host must honor |
| [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) | Every env var the agent reads, grounded in `src/config/loader.ts` |
| [`docs/GRAPH_MEMORY.md`](docs/GRAPH_MEMORY.md) | Memory tool surface + REST reference |
| [`docs/UPDATE_WORKFLOW.md`](docs/UPDATE_WORKFLOW.md) | Playbook for pulling DeepAgents upstream updates |
| [`docs/AGENT_ARCHITECTURE_SEARCH.md`](docs/AGENT_ARCHITECTURE_SEARCH.md) | Survey of agent design patterns — reference when considering architectural changes |

## Agent runtime

Built on LangChain Deep Agents (`createDeepAgent`) on top of LangGraph.

- Entry: `src/graph.ts` exports `graph`, referenced by `langgraph.json`.
- Standard factory: `createDeepAgentWithDefaults` in
  `src/deep-agent-setup.ts` resolves the project root, builds the
  orchestrator LLM, assembles tools and middleware, and lazy-loads
  sub-agents.
- State: `MessagesAnnotation` — messages with a built-in reducer that
  deduplicates and overwrites by message ID. Prevents duplicates during
  streaming.

## Sub-agents

Three default specialists, plus an auto-added `general-purpose`:

| Sub-agent | Defined in | Role |
|---|---|---|
| `plan` | `src/sub-agents.ts:getPlanSubAgent` | High-level planning, complex task decomposition |
| `research` | `src/sub-agents.ts:getResearchSubAgent` | Codebase exploration, analysis |
| `answer` | `src/sub-agents.ts:getAnswerSubAgent` | Synthesis and final responses |
| `general-purpose` | auto-added | Default fallback for tasks that don't match a specialist |

Sub-agents are lazy-loaded. The `task` tool delegates work to them with
context isolation; multiple `task` calls in one LLM response run as
concurrent Pregel supersteps. Restricted tool sets per role live in
`src/tools/tool-sets.ts`.

## Available tools

Middleware-based architecture in `src/middleware/`. Tools surfaced to
the orchestrator:

- **Filesystem** (`fs.ts`): `ls`, `read_file`, `write_file`, `edit_file`,
  `glob`, `grep`
- **Search** (`custom-tools.ts`): `search` — ripgrep-based codebase
  search
- **Bash** (`tools/bash-tool.ts`): `bash` — shell command execution
- **Web Search** (`tools/web-search-tool.ts`): `web_search` (Tavily)
- **Task Delegation** (`subagents.ts`): `task` — delegate to sub-agents
  with context isolation
- **Skills** (`skills.ts`): `load_skill` — dynamically load a skill by
  name (progressive disclosure)
- **Checklists** (`tools/checklist-tools.ts`): `create_checklist`,
  `check_item`, `get_checklist`, and others
- **Code Execution** (`code-execution.ts`): `execute_code` —
  TypeScript/JavaScript via `tsx`
- **Memory** (`tools/memory-tools.ts`): graph-memory entity storage,
  search, retrieval, traversal, promotion. Eight tools wired in the
  default surface (`store_entity`, `retrieve_entity`, `search_entities`,
  `list_entities`, `update_entity_status`, `update_entity`,
  `promote_entities`, `traverse_graph`); see
  [`docs/GRAPH_MEMORY.md`](docs/GRAPH_MEMORY.md) for the full picture
  and known gaps. Calls dispatch through `SiadGraphMemoryAdapter`
  (`tools/siad-graph-memory-adapter.ts`) to the host process at
  `SIA_DAEMON_URL`; workspace binding comes from
  `getConfig().runtime.workspaceId` (sourced from `SIA_WORKSPACE_ID`),
  the LLM never sees it as a parameter.

## Middleware

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full
composition order and per-middleware purpose. To add a middleware:
implement the `AgentMiddleware` interface and register it in
`src/agent.ts`.

Non-tool middleware worth knowing about:

- `knowledgeFormationMiddleware` — auto-extracts and stores learnings
  after tasks
- `autoContinueMiddleware` — handles continuation when the model stops
  short
- `patchToolCallsMiddleware` — fixes dangling tool calls, ensures
  message history consistency
- `usageEventsMiddleware` — emits raw token usage to the host's
  loopback endpoint (see [`HOST_CONTRACT.md`](docs/HOST_CONTRACT.md))
- `capExhaustionMiddleware` — guards against runaway recursion
- `summarizationMiddleware` — compresses context when near token limit

## Behavioral DNA

The agent's runtime behavior is defined by:

- **Prompts** (`prompts/`) — `manager.md` (orchestrator),
  `planner.md`, `researcher.md`, `answer.md`. Loaded at runtime via
  `src/system-prompts.ts`.
- **Skills** (`skills/`) — extended capabilities loaded on demand by
  the agent via the `load_skill` tool.

Both are first-class self-modification surfaces. When the agent is
asked to improve itself or repurpose for a new role, it modifies these
files. Treat changes to them as **behavioral changes**, with the same
care as code changes.

## Path resolution & sandboxing

All filesystem tool ops (`read_file`, `write_file`, `edit_file`, `ls`,
`grep`, `glob`) flow through `FilesystemBackend.resolvePath` in
`src/backends/filesystem.ts:73-96`, which calls
`validatePathInProject(resolved)`. The guard prevents the agent from
accessing files outside its project root.

Project root is resolved by `getProjectRoot()` in
`src/utils/path-utils.ts` using a 7-strategy hybrid:

0. `SIA_PROJECT_ROOT` env var — host override
1. Module location — walk up from the source file
2. Yarn workspaces marker — `package.json` with `workspaces`
3. Git repository root — `.git` directory
4. Project markers — `langgraph.json` or `CLAUDE.md`
5. Legacy directory name — back-compat with the monorepo lift; no-op
   in this standalone repo
6. Fall back to `process.cwd()`

Always use `getProjectRoot()` for the project root. Never hardcode
paths or use relative paths in tool/middleware code. Attempts to read
`/etc`, `/tmp`, parent directories, or anywhere outside the project
root are rejected with `Security Error: Path access denied`.

## Skills system

Skills live in `skills/` (flat structure). Each skill is a `SKILL.md`
file with YAML frontmatter for discoverability. Loaded on demand by
the agent via the `load_skill` tool — the progressive-disclosure
pattern keeps token usage bounded while exposing a wide capability
surface.

Current skills (16): `bash-usage`, `checklist`, `code-execution`,
`codebase-navigation`, `find-replace`, `memory-management`,
`meta-awareness`, `planning`, `prompt-engineering`, `rapids-research`,
`research`, `solid`, `system-prompt-review`, `task-delegation`,
`task-management`, `web-search`. Plus `skills/README.md` for orientation.

To add a skill: create `skills/<name>/SKILL.md` with the required
frontmatter (see existing skills for the schema). The agent will
discover it on the next `load_skill` call.

## Host contract

The agent has no runtime dependency on any specific host. To run it
inside one (siad, your own process supervisor, etc.):

- Stamp the env vars listed in [`docs/HOST_CONTRACT.md`](docs/HOST_CONTRACT.md)
  at spawn time.
- Optionally expose `POST /v1/agent/events/usage` on loopback so the
  agent can report token-usage telemetry. Best-effort; the agent
  works without it.

Standalone use needs neither — only an LLM API key.

## Code execution

The `execute_code` tool runs TypeScript/JavaScript via `tsx`.
TypeScript only — Python will fail. Default timeout 60s, max 5 min.
Sessions are thread-isolated at `.code-workspace/{thread_id}/`. See
`skills/code-execution/SKILL.md` for the full guide.

## Implementation patterns

- **Tool definition**: `DynamicStructuredTool` with `name`,
  `description`, Zod `schema`, and `func`. See `src/tools/` for
  examples.
- **Streaming events**: Use `dispatchCustomEvent` from
  `@langchain/core/callbacks/dispatch`. Middleware emitting
  `streamMode: "custom"` chunks must use `request.runtime.writer`, not
  the global `writer()` from `@langchain/langgraph` (the latter
  silently no-ops).
- **File paths**: Absolute paths only. Use `getProjectRoot()` from
  `src/utils/path-utils.ts`.
- **Error handling**: Tool errors are returned as strings in the
  result, not thrown as exceptions. Throws bubble up to the runtime
  and crash the turn.

## System prompt guidelines

When editing files in `prompts/`:

- **Right altitude**: principles over prescriptions. The agent should
  handle unexpected scenarios, not follow a script.
- **RFC 2119 keywords**: `MUST` (hard), `SHOULD` (strong), `MAY`
  (optional).
- **Avoid**: conflicting constraints, hardcoded step sequences,
  implicit assumptions ("use best practices"), mixing abstraction
  levels.
- **For reasoning models (Claude)**: high-level guidance works better
  than prescriptive steps. Trust the model to fill in the how.

Before saving: Is it flexible? Is the intent clear? Can anything be
removed? Does it hold up with diverse phrasings?

## Technologies

- **Runtime**: LangChain Deep Agents + LangGraph (graph execution),
  TypeScript throughout, Zod (schema validation), `tsx` (TypeScript
  execution)
- **LLM providers**: OpenRouter (default), OpenAI, vLLM, Ollama, LM
  Studio, custom. Provider-agnostic via `LLM_PROVIDER` env var. See
  [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).
- **Testing**: Jest with `ts-jest`
- **Tooling**: Yarn 1, ESLint flat config, `@vscode/ripgrep` (with
  system ripgrep fallback — `brew install ripgrep` if needed)

## Testing

Three test surfaces under `tests/`:

| Dir | Run with | Purpose |
|---|---|---|
| `tests/unit/` | `yarn test` | Pure unit tests — no network, no LLM calls |
| `tests/integration/` | `yarn test:integration` | Cross-module tests — gated on `RUN_INTEGRATION=true` |
| `tests/debugging/` | `yarn test` | Smoke / ad-hoc debugging tests included in the default run |

`yarn test` runs the unit + debugging suites by default and skips the
integration suite. Full suite is ~9 seconds at present (~955 tests).

## Updating from upstream DeepAgents

The runtime tracks `langchain-ai/deepagentsjs`. Current pin is roughly
v1.3.1 (commit `08ed740`) plus an additional middleware port from
2026-01-30. See [`docs/UPDATE_WORKFLOW.md`](docs/UPDATE_WORKFLOW.md)
for the upstream-sync playbook.

## Git workflow

- **`main`** is the default branch and protected by a GitHub ruleset:
  PRs required (direct pushes rejected), non-fast-forward blocked,
  deletion blocked. 0 required approvals — solo maintainer can
  self-merge their own PRs.
- Branch names: descriptive, kebab-case. Don't carry internal ticket
  IDs into this repo (use the PR body if you need to reference one).
- Commit messages: imperative, lowercase first word, reference files
  by path. Don't include AI co-author trailers (we don't credit the
  tool in this repo).

## Graph-memory service spec stubs (`src/vendor/svc-rpc/graph-memory/`)

The graph-memory tools target a service that the host process owns.
The files under `src/vendor/svc-rpc/graph-memory/` are the spec
stubs — pure types, codec, and handlers — that the agent compiles
against:

- `adapter-interface.ts` — `IGraphMemoryAdapter`: verb-level contract
- `entity-shape.ts` — LLM-facing ↔ service-wire codec
- `tool-handlers.ts` — per-tool logic (pre-search, edge wiring, response shaping)
- `ir-types.ts` — request/response TypeScript types
- `schema-hash.ts` — pinned schema identifier the host validates

These are generated artifacts owned by the platform — treat them as
read-only. `src/vendor/svc-rpc/VENDOR_SHA` records the upstream
revision they were sourced from. When the platform publishes an
updated spec, refresh all files in lockstep (do NOT edit one in
isolation) and bump `VENDOR_SHA`.

The agent ships its own concrete adapter
(`src/tools/siad-graph-memory-adapter.ts`) that satisfies
`IGraphMemoryAdapter` by calling the host at `SIA_DAEMON_URL`. Any
host that accepts the documented contract works; standalone hosts
can plug in their own adapter implementation.

## Reference documentation

- **LangGraph / LangChain (JS/TS)**: when available, use the
  `mcp__docs-langchain__search_docs_by_lang_chain` MCP tool.
- **Other libraries and APIs**: when available, use the `Ref` MCP tool
  (`mcp__Ref__ref_search_documentation`, `mcp__Ref__ref_read_url`).

Both MCP servers are optional — the repo doesn't require them. They
just speed up doc lookups when present.

## Rules

- **No git operations unless explicitly requested.** Don't stage,
  commit, push, or revert without the user asking.
- **No `yarn test:integration` unless explicitly requested.**
  Integration tests are gated for a reason — they're slower and may
  hit external services.
- **Don't claim work is done without fresh verification.** Run the
  build / typecheck / tests against your current change and read the
  output before reporting status.
