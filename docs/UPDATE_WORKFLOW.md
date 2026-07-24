# Upstream Update Workflow

A systematic workflow for porting updates from the upstream DeepAgents
repositories into this repo. Designed for autonomous execution by the
agent itself (its primary use) and for manual execution by developers.

---

## Table of Contents

1. [Overview](#overview)
2. [Current upstream pin](#current-upstream-pin)
3. [Upstream repositories](#upstream-repositories)
4. [State graph for autonomous execution](#state-graph-for-autonomous-execution)
5. [Workflow phases](#workflow-phases)
6. [Decision trees](#decision-trees)
7. [Architecture differences](#architecture-differences)
8. [Worked example: FilesystemStateSchema fix](#worked-example-filesystemstateschema-fix)
9. [Memory integration](#memory-integration)

---

## Overview

This document describes how to discover, evaluate, and port changes from
the upstream DeepAgents repositories into the agent. The agent is built
on `deepagentsjs` and periodically falls behind; this workflow is the way
back to parity.

### Purpose

- **Maintain parity** with upstream DeepAgents innovations.
- **Prevent divergence** from proven patterns.
- **Adapt selectively** based on architectural differences.
- **Document decisions** so the agent can build on them next cycle.

### When to run this workflow

- **Periodic sync**: every 2–4 weeks.
- **Major releases**: when upstream tags a new version.
- **Bug reports**: when an issue might already be fixed upstream.
- **Feature requests**: when a desired feature exists upstream.

---

## Current upstream pin

**Baseline:** deepagentsjs **v1.3.1** (upstream commit
[`08ed740`](https://github.com/langchain-ai/deepagentsjs/commit/08ed740)),
plus one unpinned middleware-utilities port made shortly after.

**Current pin:** deepagentsjs **v1.11.1** (upstream commit
[`b215e70`](https://github.com/langchain-ai/deepagentsjs/commit/b215e70))
— 387 commits ahead of the baseline. **Status: sync complete** — all 6
phases landed (see phase status lines below).

### Monorepo restructure (read this before diffing)

Between the baseline and the target, upstream migrated from a flat
`src/` layout to a **pnpm monorepo**. Paths changed:

- Core SDK: `src/...` → `libs/deepagents/src/...`
- Providers (sandboxes, code interpreter): `libs/providers/...`
  (e.g. QuickJS lives at `libs/providers/quickjs/src/...`).

**Always read upstream via `git show origin/main:<path>`** — a local
working tree may be stale. A v1→v2 backend compat shim, if ever needed,
exists upstream as `adaptBackendProtocol` at
`libs/deepagents/src/backends/utils.ts`.

### Scoping large drifts

A drift this large (387 commits) **must** be scoped as multiple sync
cycles rather than one mega-PR. This sync is broken into **6 phases**,
each a kebab-case branch + PR verified with
`yarn typecheck && yarn test && yarn lint`:

| Phase | Branch | Status |
|---|---|---|
| 0 — docs: record the sync plan | `docs-upstream-sync-scope` | completed |
| 1 — QuickJS code interpreter (vendored) | `quickjs-code-interpreter` | completed |
| 2 — filesystem permissions + allowlist | `filesystem-permissions` | completed |
| 3 — backend protocol v2 (in-place) | `backend-protocol-v2` | completed |
| 4 — agent.ts prompt config + middleware merge | `agent-prompt-and-middleware-merge` | completed |
| 5 — harness profiles (slim + serializable) | `harness-profiles-slim` | completed |
| 6 — final docs + pin close-out | folded into each phase | completed |

### Classification (what to adopt vs skip this cycle)

| Theme | Decision | Rationale / vision tie-in |
|---|---|---|
| QuickJS code interpreter (PTC) | **Adopt — vendored** | Sandboxed programmatic tool-calling + parallel subagent fan-out; substrate for fitness-evaluation suites |
| Backend protocol v2 + BaseSandbox | **Port — full, in-place** | Current upstream shape for future syncs; BaseSandbox anchors future remote/distributed execution |
| Filesystem permissions + tool allowlist | **Port** | Policy layer for experiment worktree isolation + future marketplace component trust |
| agent.ts safe wins (prompt config, middleware merge, ordering) | **Port** | Name-addressable middleware stack is a genome prerequisite (swap/toggle/add/remove operators) |
| Harness profiles | **Adapt — slim + serialization** | Profile ≈ proto-genome; keep zod config schema (poisoned-key guard) for genome/blueprint serialization; skip global registry |
| Async subagents (remote Agent Protocol) | **Skip** | No remote LangGraph deployment need |
| ACP package (IDE integration) | **Skip** | Not a CLI/IDE product |
| Daytona/Modal/LangSmith sandboxes, ContextHub, node-vfs | **Skip** | No third-party infra dependency wanted |
| Python-side (harbor, CLI features) | **Skip** | CLI-specific per existing workflow policy |

To sync forward:

1. `cd` into a local checkout of `langchain-ai/deepagentsjs`
   (`~/projects/deepagentsjs`).
2. `git fetch origin`, then `git show origin/main:<path>` to read
   upstream files (do not trust the working tree).
3. Apply per the phases below; update the phase status line in this
   table as each PR merges.

Each successful sync should update the "current upstream pin" stated
above so the next cycle starts from a fresh baseline.

---

## Upstream repositories

### deepagentsjs (TypeScript SDK)

**Repository:** https://github.com/langchain-ai/deepagentsjs

**Relationship:** Direct dependency — the SDK is the agent's foundation.

**Porting strategy:**

- Bugfixes: **port immediately**.
- Features: **evaluate for applicability**.
- Breaking changes: **test thoroughly before adopting**.

### deepagents (Python SDK)

**Repository:** https://github.com/langchain-ai/deepagents

**Relationship:** Reference implementation (the Python CLI agent is the
gold standard for behavior, but we don't run it).

**Porting strategy:**

- Patterns: **adapt for TypeScript / agent runtime**.
- CLI-specific behavior: **skip** (architecture mismatch).
- Core concepts: **evaluate for inspiration**.

---

## State graph for autonomous execution

```text
START
  ↓
discover_updates
  ↓
classify_change ─┬─→ SKIP (log & exit)
                 ├─→ EVALUATE → assess_applicability ─┐
                 └─→ URGENT (bugfix) ─────────────────┘
                                      ↓
                                 plan_changes
                                      ↓
                                  implement
                                      ↓
                                   verify ─┬─→ PASSED → document ─┐
                                           ├─→ FAILED → revert    │
                                           └─→ PARTIAL ───────────┘
                                                                   ↓
                                                            store_learning
                                                                   ↓
                                                                  END
```

### Node descriptions

- **discover_updates** — check upstream repos for new commits, fetch git
  log and diffs, parse `CHANGELOG.md` for version changes.
- **classify_change** — analyze each commit; classify as bugfix,
  feature, refactor, breaking, or skip; route based on classification.
- **assess_applicability** — map changed upstream files to local
  equivalents; check for architecture conflicts.
- **plan_changes** — identify affected local files, design the adaptation
  strategy, build an implementation checklist, estimate effort and risk.
- **implement** — apply changes following local patterns; commit messages
  link back to the upstream SHA.
- **verify** — run `yarn typecheck`, `yarn test:unit`, `yarn lint`.
- **document** — update repo docs that reference changed APIs.
- **store_learning** — record outcomes, patterns, and skipped-with-reason
  decisions to graph memory (see [Memory integration](#memory-integration)).

---

## Workflow phases

### Phase 1: Discovery

**Objective:** Identify what has changed upstream.

**Actions:**

1. Navigate to the upstream repo.
2. Check the local pin: `git log -1 --oneline`.
3. Pull latest: `git pull origin main` (or `master`).
4. Review the log: `git log <pin>..HEAD --oneline`.
5. Review diffs: `git diff <pin>..HEAD --stat`.
6. Check `CHANGELOG.md` for version bumps.

**Output:**

- List of commits with messages.
- File-change summary (added, modified, deleted).
- Version deltas (e.g. 1.3.0 → 1.3.1).

**Memory storage:** record each discovered update as
`entity_type="upstream-update"` with tags for repo, version, and urgency.

### Phase 2: Analysis

**Objective:** Understand what each change does and why.

**Actions:**

1. Read full diffs.
2. Classify the change:
   - **Bugfix** — fixes incorrect behavior.
   - **Feature** — adds new capability.
   - **Refactor** — improves code without behavior change.
   - **Breaking** — changes public API or behavior.
   - **Skip** — docs only, tests only, or otherwise irrelevant.
3. Map upstream files to local equivalents.
4. Check for architectural conflicts (see [Architecture differences](#architecture-differences)).

**Output:** classification per commit, upstream→local file map,
applicability assessment (high/medium/low/skip).

### Phase 3: Planning

**Objective:** Design how to port applicable changes.

**Actions:**

1. For each applicable change:
   - Identify exact local files to modify.
   - Decide direct port vs adaptation.
   - Plan test strategy.
   - Estimate risk (low/medium/high).
2. Build an implementation checklist.
3. Order implementation; bugfixes first.

**Output:** step-by-step plan, risk assessment, test coverage plan.

### Phase 4: Implementation

**Objective:** Apply changes to the local codebase.

**Actions:**

1. Create a feature branch: `git checkout -b update/deepagents-<version>`.
2. Implement changes following local patterns:
   - Use existing code style and conventions.
   - Preserve local adaptations and customizations.
   - Maintain type safety and lint rules.
3. Update inline documentation (JSDoc, comments) as you go.
4. Link each commit message to the upstream commit SHA being ported.

**Output:** modified files, commits with descriptive messages linking to
upstream.

### Phase 5: Verification

**Objective:** Ensure changes work correctly.

```bash
yarn typecheck     # type safety
yarn test:unit     # correctness
yarn lint          # code style
yarn test:integration   # only if applicable and the user permits
```

**Success criteria:**

- All type checks pass.
- All unit tests pass.
- No new ESLint errors.
- Pre-commit hooks pass (if configured).

**Output:** verification result (passed / failed / partial).

### Phase 6: Documentation

**Objective:** Record what changed and why.

Update repo docs when:

- A new tool or middleware lands → update `docs/ARCHITECTURE.md`.
- Public API changes → update the README and any affected doc.
- Memory tools change → update `docs/GRAPH_MEMORY.md`.
- A new pattern emerges → consider whether `docs/SELF_MODIFICATION.md` or
  this file needs a new section.

After each successful cycle, **update the "Current upstream pin" section
at the top of this file** to reflect the new baseline.

### Phase 7: Memory storage

**Objective:** Build institutional knowledge.

Store 1–3 entities per cycle:

- A **learning** — what was technically learned about the codebase.
- A **pattern** — anything reusable about the porting process itself.
- A **decision** — anything notable that was skipped (and why).

Link related entities so the next cycle can find them.

---

## Decision trees

### When to port a change

```text
Is it a bugfix affecting shared TypeScript SDK code?
├─ YES → port immediately (high priority)
└─ NO  → continue

Is it a feature in deepagentsjs?
├─ YES → evaluate architectural fit
│        ├─ fits agent runtime → port with adaptation
│        └─ CLI-only          → skip
└─ NO  → continue

Is it Python SDK only?
├─ YES → evaluate for conceptual patterns
│        ├─ transferable concept → adapt to TypeScript
│        └─ CLI-specific         → skip
└─ NO  → skip (docs / test-only changes)
```

### Architectural fit assessment

```text
Does the change require:
├─ Clipboard access                → skip (agent has no clipboard)
├─ Terminal UI (rich, prompt_toolkit) → skip (agent has no UI)
├─ Direct local-filesystem access  → evaluate (the agent uses backends)
├─ Core middleware / tools         → port (shared architecture)
├─ State management patterns       → port (shared LangGraph foundation)
└─ Memory / persistence            → evaluate (we have graph memory)
```

---

## Architecture differences

### sia-web-agent vs DeepAgents CLI

| Aspect | DeepAgents CLI | sia-web-agent |
|---|---|---|
| **Interface** | Terminal (stdin/stdout) | LangGraph server, host-mediated |
| **User input** | `prompt_toolkit` session | Host RPC / message stream |
| **Output display** | Rich terminal (colors, panels) | Streamed events to host |
| **Approval UI** | Arrow-key navigation | Host-mediated interrupts |
| **Session management** | In-process `thread_id` | LangGraph server checkpointer |
| **Memory** | Optional (filesystem `.md` files) | Core (graph-memory backend) |
| **Skills** | Progressive disclosure | Progressive disclosure |
| **Sub-agents** | Dynamic (runtime specs) | Pre-compiled (planner, researcher, answer, general-purpose) |
| **Middleware** | Python functions | TypeScript factories |
| **Backend** | `BaseBackend` protocol | `BackendProtocol` interface |

### Shared patterns (directly portable)

- Middleware architecture.
- Tool definitions and validation.
- Sub-agent delegation via the `task` tool.
- State management (`MessagesAnnotation`).
- Filesystem backends (State / Store / Filesystem / Composite).
- Summarization and token management.
- Human-in-the-loop interrupts.

### Skip categories

1. **Terminal UI** — rich panels, `prompt_toolkit`, colored output.
2. **Clipboard operations** — `pngpaste`, `osascript`, image paste.
3. **Python-specific** — `asyncio`, `TypedDict`, `dataclasses`.
4. **CLI commands** — slash commands (`/help`, `/tokens`, etc.).
5. **Shell integration** — `!` prefix for bash, env passthrough.

---

## Worked example: FilesystemStateSchema fix

A real port, walked end-to-end, to show how the workflow phases play out.

### Discovery

**Upstream commit:** deepagentsjs `08ed740`
**Version:** 1.3.0 → 1.3.1
**Type:** Bugfix (patch version).

**Change summary:**

```
CHANGELOG.md: "Fix 'Channel files already exists with different type.' error"
src/middleware/fs.ts: Move FilesystemStateSchema to module level
```

### Analysis

**Problem:**
`FilesystemStateSchema` was defined inside `createFilesystemMiddleware()`.
Each call creates a new object instance. When multiple agents use the
same middleware, LangGraph compares object identity for state-schema
validation. Different instances → error.

**Root cause:**

```typescript
// BEFORE (inside the factory)
export function createFilesystemMiddleware(options) {
  const FilesystemStateSchema = z3.object({ ... }); // NEW INSTANCE per call
  return createMiddleware({ stateSchema: FilesystemStateSchema });
}
```

**Local status:** confirmed the same bug exists at the analogous site in
`src/middleware/fs.ts`.

**Applicability:** HIGH — affects multi-agent systems, which this agent
uses extensively (planner, researcher, answer, general-purpose).

### Planning

**Implementation steps:**

1. Move `FilesystemStateSchema` to module level (after `fileDataReducer`).
2. Add a JSDoc explaining *why* it lives at module level.
3. Remove the duplicate definition from inside the factory.
4. Verify all references use the shared schema.

**Risk:** LOW — pure refactor, no behavior change.

**Test strategy:** existing unit tests should pass. Optionally add a test
asserting schema object identity across multiple `create…` calls.

### Implementation

**File:** `src/middleware/fs.ts`

**Change 1 — add the module-level definition:**

```typescript
/**
 * Shared filesystem state schema.
 *
 * Defined at module level so every agent that uses
 * createFilesystemMiddleware sees the same object identity. LangGraph
 * compares schemas by identity; per-call instances trigger "Channel
 * already exists with different type" errors when multiple agents are
 * composed.
 */
const FilesystemStateSchema = z3.object({
  files: withLangGraph(
    z3.record(z3.string(), FileDataSchema).default({}) as any,
    {
      reducer: {
        fn: fileDataReducer,
        schema: z3.record(z3.string(), FileDataSchema.nullable()),
      },
    },
  ) as any,
});
```

**Change 2 — remove the duplicate definition** from inside the factory.

### Verification

```bash
yarn typecheck   # ✓ passed
yarn test:unit   # ✓ all tests passed
yarn lint        # ✓ no new errors
```

### Documentation

- This document — added the example below the workflow phases.
- `docs/ARCHITECTURE.md` — no changes (implementation detail).

### Memory storage

**Learning:**

```ts
{
  entity_type: "learning",
  title: "Module-level schema for middleware state identity",
  content: "When creating middleware that adds state schemas, define the schema at module level. LangGraph compares schemas by object identity; per-call instances trigger 'Channel already exists with different type' across composed agents.",
  context: "middleware",
  tags: ["bug-fix", "langgraph", "state-schema", "object-identity"],
  priority: "high",
}
```

(Pattern and decision entities follow the same shape — see [Memory
integration](#memory-integration) for the entity-type catalog.)

---

## Memory integration

### Entity types for the update workflow

- **upstream-update** (discovery) — discovered commits from upstream.
  Status: `pending` | `in-progress` | `completed` | `skipped`. Tags:
  repo, version, urgency.
- **learning** (after implementation) — technical knowledge gained from
  porting. Tags: technical domain, component affected.
- **pattern** (meta) — recurring approaches in porting, workflow
  improvements discovered. Tags: `workflow`, `automation`, `porting`.
- **decision** (architectural) — why certain changes were skipped or
  adapted. Tags: `architecture`, `tradeoff`, upstream repo.

### Search queries for context

Before starting a port, pull prior learnings:

```ts
// Previous ports touching the same file
search_entities({
  query: "FilesystemMiddleware deepagents upstream",
  entity_type: "learning",
  limit: 5,
});

// Previous decisions about Python SDK / CLI patterns
search_entities({
  query: "Python SDK CLI patterns not applicable",
  entity_type: "decision",
  limit: 3,
});
```

### Update status tracking

```ts
update_entity_status({
  entity_id: "update-123",
  status: "in-progress",
  notes: "Implementing FilesystemStateSchema fix",
});

update_entity_status({
  entity_id: "update-123",
  status: "completed",
  notes: "Fix applied, all tests pass",
});
```

The tool names above match the agent's native memory tools (see
`src/tools/memory-tools.ts`). The agent calls them directly; no MCP
intermediary is involved.

---

## Future enhancements

### Automation opportunities

1. **Scheduled checks** — GitHub Actions to check for upstream updates weekly.
2. **Diff analysis** — LLM-based classification of upstream diffs.
3. **Port suggestions** — auto-open PRs with suggested ports.
4. **Regression detection** — sandbox-test new upstream versions before merge.

### State-graph implementation

The workflow is currently documented but not implemented as a LangGraph
`StateGraph`. A future cycle could:

1. Author `src/graphs/upstream-update-graph.ts`.
2. Define `UpstreamUpdateState`.
3. Implement one node per phase.
4. Add routing for the decision trees.
5. Wire to graph memory for persistence.

### Monitoring

- Track porting lag (how far behind upstream we are).
- Alert on upstream security fixes (treat as URGENT).
- Surface update status + coverage in a dashboard.

---

## References

- DeepAgents TypeScript SDK: https://github.com/langchain-ai/deepagentsjs
- DeepAgents Python SDK: https://github.com/langchain-ai/deepagents
- LangGraph: https://langchain-ai.github.io/langgraph/
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — agent runtime architecture.
- [`GRAPH_MEMORY.md`](./GRAPH_MEMORY.md) — memory tool reference.
- [`SELF_MODIFICATION.md`](./SELF_MODIFICATION.md) — the agent's self-modification capability.
