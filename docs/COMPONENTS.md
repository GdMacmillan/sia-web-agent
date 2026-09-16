# Components

A **component** is a versioned unit of agent code that lives on disk, outside
the agent's own source tree, and is assembled into the agent at boot. Each
component ships with a **manifest** that describes it, a **contract** that
proves a version works, and an **entry** that builds the thing it contributes.

This document is the spec for the component loader and for the runtime
registration of remote tools. The loader, SDK and contract runner are
implemented in `src/components/`; the remote-tool registrar (§7) is not
built yet. The rejected alternatives are recorded so they are not
re-litigated.

Vocabulary used here: *component*, *version*, *manifest*, *contract*,
*scope*, *server*. Nothing else.

---

## 1. Why

Three things drive the design:

- **Prompt-shaped capabilities already hot-load.** Skills are discovered on
  disk (`src/utils/skills-loader.ts`) and re-read on every agent turn
  (`src/middleware/skills.ts`, `beforeAgent`). Code-shaped capabilities do
  not: they are welded into the source tree and change only with a release.
  Components give code the same on-disk, versioned life that skills have.
- **Component code cannot import anything.** Only the agent's own source
  tree has `node_modules`. A file loaded from anywhere else that says
  `import { z } from "zod"` fails with `ERR_MODULE_NOT_FOUND`. So a
  component receives everything it needs as an argument (**dependency
  injection**) and imports nothing.
- **A version must prove itself before it is trusted.** Test runners are
  dev dependencies and are absent from a production install; `tsx` is
  present. So the contract is a plain module the agent itself can run, in
  the same process, on demand.

The first component is the `execute_code` wrapper: the middleware that
defines the tool, formats results, and manages the executor lifecycle. It
ships as the seed `components/execute-code` (registered as
`CodeExecutionMiddleware`, with a six-case black-box contract), and the
bundled registration in `src/middleware/code-execution.ts` evaluates a
byte-identical in-tree twin of the same entry (see §2, *The seed and its
in-tree twin*). The heavy internals (session manager, IPC bridge, tool-API
generator) stay in the source tree and reach the component through the
SDK. The next change to the wrapper is a new `.versions/<version>/`
directory, not a source edit.

---

## 2. Layout and discovery

Two roots are consulted, in order:

| Root | Source | Purpose |
|---|---|---|
| `SIA_COMPONENTS_DIR` | env var, stamped by the host | Host-managed versions. Optional. |
| `<projectRoot>/components` | shipped with the agent source | The **seed** set: the versions the agent boots with when nothing else is present. |

A component name found in the first root shadows the same name in the
second. When `SIA_COMPONENTS_DIR` is unset only the seed root is read.
A name found in neither root falls back to whatever the source tree
bundles (for `execute_code`, the bundled middleware) — so a missing
component directory can never remove a capability, only fail to override it.

Inside a root:

```
<root>/
  <name>/
    current -> .versions/<version>       # the pointer: a link, a junction, or
                                         # a one-line file naming the version
    .versions/
      0.1.0/
        component.json                   # manifest
        entry.ts                         # factory (default export)
        contract.ts                      # contract (default export)
      0.2.0/
        ...
```

The loader lists `<root>/*/current/component.json`. It never reads
`.versions/` directly. Flipping `current` is the whole act of switching
versions; old versions are never deleted by the loader, so a revert is a
pointer flip back.

**Two pointer forms.** `current` is either a link (or junction) to the
version directory, or a regular file whose single line names the
`.versions/<version>` directory (`0.1.0\n`). The file form exists for
source trees that ship through archives to platforms where creating a
link needs a privilege; the seed root uses it. Its content must match
`^[0-9A-Za-z][0-9A-Za-z.+-]*$` — no separators, never `.` or `..` — and it
resolves under exactly the containment rules a link does.

**Containment.** Every path the loader touches is resolved with
`realpathSync` and must remain inside the root (`relative(root, real)` must
not start with `..`). This is the same check `isSafePath` applies to skills
(`src/utils/skills-loader.ts`, exported for this purpose). A `current` link
that escapes the root, or that lands anywhere but inside `.versions/`, is
skipped with a warning. Manifests over 10 MB are skipped.

**Reaching the roots from the agent.** The filesystem tools are bounded to
the project root (`validatePathInProject`, `src/utils/path-utils.ts`). At
assembly each component root that exists is added to the allowed roots
(`allowPathRoot`), both as given and fully resolved, so the agent can read
and author component versions that live outside its own source tree. The
allow-list is process-global by design; `prepare_component_version` admits
a host-managed root that appeared after assembly the same way (§6,
*Authoring a version*).

### The seed and its in-tree twin

The seed root ships `components/execute-code/.versions/0.1.0/` with a
one-line `current` file. The bundled `CodeExecutionMiddleware`
registration stays at both assembly sites: it is the `replaces` target and
the fallback that keeps the tool available when the seed is absent, fails
to load, or is shadowed by a broken host-managed version. To keep that
fallback from becoming a second, divergent wrapper, the bundled module
(`src/middleware/code-execution.ts`) does not carry the wrapper itself: it
evaluates `src/components/seed/execute-code/entry.ts` — a byte-for-byte
copy of the seed's current entry — with an in-tree dependency bundle whose
`getExposableTools` returns the call-site tools.

- `yarn sync:seed` (`scripts/sync-seed-components.mjs`) copies each seed's
  current `entry.ts` to its twin; `--check` reports drift without writing.
- `tests/unit/components/seed-parity.test.ts` fails when a twin differs
  from its seed, or the bundled version constant differs from `current`.
- The bundled module does not `import()` the seed at runtime on purpose:
  a seed that throws would then break boot, which §4 forbids.
- A source-tree TypeScript build cannot compile files under `components/`
  (they sit outside `rootDir`), which is the other reason the twin lives
  under `src/`.

With the seed root present, the loader's instance replaces the bundled one
by name at both sites and the bundled instance never runs; a host-managed
root shadows the seed by name.

---

## 3. Manifest

`component.json` is flat, strict (unknown keys are an error), and leans on
conventions so a minimal manifest is a handful of lines.

```ts
import { z } from "zod/v4";

export const ComponentManifestSchema = z
  .object({
    /** Directory name and registry key. */
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Semver. Must equal the `.versions/<version>` directory name. */
    version: z.string(),                        // validated as semver
    /** What this component contributes. Exactly one thing per component. */
    kind: z.enum(["middleware", "tools", "service"]),
    /** One paragraph, written for a person: what this version is for. */
    intent: z.string().min(1),
    /** Semver range the entry was written against. See §5. */
    sdk: z.string(),                            // validated as a semver range
    /** Relative to the version directory. */
    entry: z.string().default("entry.ts"),
    contract: z.string().default("contract.ts"),
    /**
     * `kind: middleware` only. Name of the bundled middleware this
     * component stands in for. Omit for a novel middleware.
     */
    replaces: z.string().optional(),
    /** Position in the component tree; 0 = top level. */
    depth: z.number().int().min(0).default(0),
    lineage: z
      .object({
        /** `name@version` this version was derived from, if any. */
        parent: z.string().optional(),
        /** The need that prompted this version, in the author's words. */
        need: z.string().optional(),
        /** Who or what produced it (a person, an agent id, a tool). */
        producedBy: z.string().min(1),
      })
      .strict(),
    /** Optional assembly tuning: the harness-profile config shape. */
    profile: harnessProfileConfigSchema.optional(),
  })
  .strict();
```

(`harnessProfileConfigSchema` is the strict zod/v4 schema in
`src/profiles/harness.ts`; `HarnessProfileOptions` is the matching TS
interface. `entry` and `contract` must be relative and may not contain
`..`.)

Rules the loader enforces beyond the schema:

- `name` must equal the directory name; `version` must equal the
  `.versions/<version>` directory the `current` link resolves to.
- `replaces` must name a middleware that exists in the assembled default
  stack and must not name one in `REQUIRED_MIDDLEWARE_NAMES`
  (`src/profiles/harness.ts`). Replacing scaffolding is refused. It is
  only valid on `kind: middleware`. The loader pre-checks it against
  `KNOWN_MIDDLEWARE_NAMES` (`src/agent.ts`, every name the stack can
  carry); the assembly site re-checks it against the stack it actually
  builds (§4).
- A `kind: middleware` component **without** `replaces` whose returned
  middleware carries the name of a bundled one is refused: a replacement
  is always declared, never inferred from `.name`.
- `depth` is recorded, not inferred. A parent may have been pruned; the
  tree shape is carried by every node so the whole tree can be listed
  without walking lineage.
- `profile`, when present, is validated through `parseHarnessProfileConfig`
  (`src/profiles/harness.ts`) at parse time, so a required-middleware
  exclusion is a manifest failure rather than an assembly failure. It is
  applied at assembly (restart-gated, see §4) by folding it into the
  resolved harness profile with `mergeHarnessProfile`: excluded sets are
  unioned, prompt suffixes are joined, overrides are overlay-wins. A
  component's `excludedTools` applies at the main agent only — the
  tool-exclusion middleware is appended to the main stack alone.

Example — the seed `execute_code` component:

```json
{
  "name": "execute-code",
  "version": "0.1.0",
  "kind": "middleware",
  "intent": "Run the TypeScript the agent writes, one fresh process per call in a per-conversation workspace with typed access to the agent's other tools, and hand back stdout, stderr and the exit status as text — including a clear timeout message instead of a silent kill.",
  "sdk": "^1.0.0",
  "replaces": "CodeExecutionMiddleware",
  "depth": 0,
  "lineage": { "producedBy": "seed" }
}
```

**Rejected:** a manifest that may contribute several things at once (a
`path | array | inline` union per field). One component contributes one
thing; composition happens in the tree, not inside a manifest. Also
rejected: any registry or marketplace identity field, and inferring
`depth` from `parent`.

---

## 4. Loading and activation

The loader runs once at assembly (`prepareComponentAssembly`,
`src/components/assemble.ts`, called from `createDeepAgentWithDefaults`)
and yields four things:

- `middleware: AgentMiddleware[]` — from `kind: middleware` entries, plus
  `componentsMiddleware`, which re-reads the active manifests each turn.
- `tools: StructuredTool[]` — from `kind: tools` entries, appended after
  the built-in tools (built-ins first). They reach the main agent, the
  general-purpose sub-agent and the `execute_code` tool API; the named
  sub-agents select tools by fixed name lists (`src/tools/tool-sets.ts`)
  and do not see them. A component tool whose name collides with a
  built-in **or middleware-provided** tool (`read_file`, `execute_code`,
  `task`, `load_skill`, …) is skipped with a warning.
- `services: Record<string, unknown>` — from `kind: service` entries,
  published under `deps.services[name]` for other components to use.
  Services load **first**, so `deps.services` is populated for every later
  entry; each component receives a frozen snapshot, so no component can
  alter another's view.
- `profiles: HarnessProfile[]` — the `profile` of every loaded component,
  folded into the resolved harness profile in load order.

**Middleware replacement is name-based.** `mergeMiddlewareStack`
(`src/middleware/utils.ts`) already replaces a default middleware in place
when a custom one carries the same `name`, and inserts a novel one between
the default and tail segments. The loader passes its middleware as the
`customMiddleware` argument at **both** assembly sites — the main stack and
the sub-agent stack (`src/agent.ts`) — so a replacement swaps in both at
once. The loader asserts that the middleware an entry returns has
`.name === manifest.replaces`; a mismatch is a load failure for that
component.

Two things happen at the assembly site before the merge:

- `replaces` is re-validated against the stack actually built. A target
  that is absent there (a feature-gated middleware that is off, say) would
  otherwise merge as an addition; such an entry is dropped with a warning
  at both sites.
- At the sub-agent site, custom entries whose name exists only in the main
  stack (delegation, knowledge formation, the tail, `componentsMiddleware`)
  are filtered out first. Otherwise `mergeMiddlewareStack` would append
  them as novel entries and a "replacement" would become an addition the
  sub-agents never had.

**Rejected:** a `resolveComponent(name) ?? bundledDefault` call at each
registration site. It is a second primitive beside `mergeMiddlewareStack`,
has to be repeated per site, and cannot express `kind: tools`.

### Hot versus restart-gated

Two different things change at two different speeds:

| What | When it is read | Effect of a change |
|---|---|---|
| Manifest fields: `intent`, `depth`, `lineage`, `version` | every agent turn (`componentsMiddleware`, `beforeAgent`, like skills) | visible on the next turn |
| Code: `entry`, `contract`; manifest `profile` | once, at assembly | visible after restart |

`profile` is restart-gated because every point at which a profile is
applied lives inside `createDeepAgent`. The active set
(`src/components/registry.ts`) records each component's loaded version
beside its live manifest, so a flipped pointer is described immediately
while the loaded version stays what it was.

The code is loaded with a cache-busted dynamic `import()` so a restart
always sees the current pointer; there is no in-process module reload.
**The manifest is live; the code is not.** A tool or skill that flips
`current` must say so: the new version is described immediately and runs
after the next restart.

### Never break boot

An invalid component — unparsable manifest, containment failure, SDK range
mismatch, entry that throws, wrong `.name` — is **skipped with a warning**
and the bundled default (if any) stays in place. Nothing a component does
at load time can prevent the agent from starting. With no component roots
present at all, the agent behaves exactly as it does today.

---

## 5. The SDK (`ComponentDeps`)

`src/components/sdk.ts` defines the only surface component code sees.

```ts
export const SDK_VERSION = "1.1.0";

export interface ComponentDeps {
  sdkVersion: string;                 // SDK_VERSION
  z: typeof z;                        // zod/v4
  tool: typeof tool;                  // langchain `tool()`
  createMiddleware: typeof createMiddleware;
  dispatchCustomEvent: typeof dispatchCustomEvent;
  logger: Logger;
  config: Readonly<{ agentId: string; agentName: string; projectRoot: string }>;
  manifest: ComponentManifest;        // this component's parsed manifest
  componentDir: string;               // the resolved version directory
  services: Readonly<Record<string, unknown>>;  // frozen snapshot, see §4
  /** Bundled internals exposed for specific components. Unstable. */
  internals: {
    codeExecution: {
      ToolEnabledExecutor: typeof ToolEnabledExecutor;
      validateCode: typeof validateCode;
      formatCodePreview: typeof formatCodePreview;
      DEFAULT_TIMEOUT_MS: number;
      MAX_TIMEOUT_MS: number;
      /** The assembled pool minus the middleware-only tools. Since 1.1.0. */
      getExposableTools: () => StructuredToolInterface[];
    };
  };
}
```

`internals.codeExecution` carries exactly the symbols the `execute_code`
wrapper uses, so it needs nothing past the SDK. `getExposableTools()`
returns the tools a code-execution session may call through its generated
tool API: the assembled agent's pool (`getActiveToolPool`) minus
`MIDDLEWARE_ONLY_TOOL_NAMES` (`write_todos`, `load_skill`, `task`,
`execute_code`, `eval`) — a script cannot delegate, load a skill, or nest
another execution. It is empty before assembly and populated after, which
is why the wrapper creates its executor lazily on first call. `logger` is
a child of the agent's pino logger named `component:<name>`.

`entry.ts` is:

```ts
export default function (deps: ComponentDeps): AgentMiddleware | StructuredTool[] | unknown;
```

An entry may carry a **type-only** import of the SDK types for editors and
type checkers (`import type { ComponentDeps } from "<path to>/src/components/sdk.js"`).
Type-only imports are erased before execution, so the rule that an entry
imports nothing at runtime still holds; the path only has to resolve where
the file is type-checked. A value import of anything is still an error.

The return type follows `kind`: `middleware` → one `AgentMiddleware`;
`tools` → `StructuredTool[]`; `service` → any value, published as-is.

**Versioning.** Everything on `ComponentDeps` except `internals` is stable
across a major version of `SDK_VERSION`: additions bump the minor,
removals or signature changes bump the major. `internals` is the one
unstable namespace and is documented as such — a component that reaches
into it accepts that a minor SDK bump may break it. The manifest's `sdk`
range is checked against `SDK_VERSION` at load; a mismatch skips the
component with a warning (§4). History: 1.0.0 the initial surface; 1.1.0
added `internals.codeExecution.getExposableTools`.

**Component-to-component use** goes only through `deps.services`. There is
no import path between components.

---

## 6. Contracts

`contract.ts` proves a version works, black-box, through the real tool or
middleware:

```ts
export default async function (deps: ContractDeps): Promise<void>;

export type ContractDeps = ComponentDeps & {
  /** The value `entry.ts` returned for this version. */
  component: unknown;
  /** Invoke a tool by name; runs in a scratch thread unless one is named. */
  invoke: (
    toolName: string,
    args: unknown,
    opts?: { threadId?: string },
  ) => Promise<string>;
};
```

`invoke` resolves the name against the component's own tools first (the
tools of a `kind: tools` entry, or a middleware's `tools`), then the
assembled agent's full pool — so a candidate version is what gets
exercised even when an older version of it is active. The default thread
id is `contract-<name>-<uuid>`, minted once per run; passing `threadId`
lets a contract prove thread isolation. Results are flattened to a string
the way the `execute_code` tool API flattens them. An unknown name throws
(and so fails the contract) with the available names in the message.

Any throw is a failure. Any normal return is a pass. There is no test
framework: assertions are plain `if (…) throw new Error(…)`.

### The runner

```ts
export async function runComponentContract(
  name: string,
  opts?: {
    version?: string;     // target `.versions/<version>` instead of `current`
    timeoutMs?: number,   // default 30_000
  },
): Promise<{
  ok: boolean;
  durationMs: number;
  version: string | null;
  sdkVersion: string;
  error?: string;
}>;
```

Implemented in `src/components/contract.ts` and exported from
`src/graph.ts` beside `graph`. A host that only knows about `graph` never
sees it; a host that does can call it. The same function is used
in-process by the agent (before it announces a candidate version) and by a
host at boot (to gate a restart). With `version` set, the runner targets
`<root>/<name>/.versions/<version>/` directly under the first root that
carries the component, so a version that has just been written can be
checked before its pointer is flipped. The entry and the contract are
imported fresh (cache-busted) on every run; the timer is unreferenced so a
pending contract never keeps the process alive.

**Fail-closed invariants** — every one of these is `ok: false`, never a
throw:

- timeout elapsed
- no contract file, or one that fails to load
- unknown component name, or no `current` pointer
- SDK range mismatch
- the contract throws for any reason
- the requested `version` does not exist, or is not a valid version

The runner never throws. Anything that cannot be classified is
`ok: false` with the error text.

**Rejected:** running the contract over the agent's chat endpoint (a
contract is not a conversation), and shipping a test runner to production
installs.

**Which roots the runner searches.** In precedence order: the host-managed
root as configured at the time of the call, then the roots recorded at
assembly, then whatever else exists on disk now — deduplicated by real
path. A host-managed root that appeared after assembly is therefore
searched first, which is what lets a version written during this process
be checked (see *Authoring a version* below).

### Authoring a version

The agent can write the next version of one of its components itself. The
pure part is `src/components/authoring.ts`; four tools
(`src/tools/component-tools.ts`) put it in the agent's hands, and the
`iterate-component` skill (`skills/iterate-component/SKILL.md`) is the
procedure. A version is authored in a thread of the agent's own — see
`start_self_task` (`src/tools/self-task-tool.ts`), which opens a thread on
the agent's own server and starts a run in it.

**Host-managed root only.** A new version is written under
`SIA_COMPONENTS_DIR`, never under the seed root shipped with the source
tree (the host re-stages that tree, and anything written there would run
unreviewed until it did). With no host-managed root configured,
`prepare_component_version` refuses; there is nowhere to write.

**Layout.** On the first iteration the whole component directory is
copied from the root that currently wins into the host-managed root —
`current` (still naming the previous version) and `.versions/<previous>/`
travel with it — and then `.versions/<next>/` is written from the previous
version with its manifest rewritten: `version`, `lineage.parent =
"<name>@<previous>"`, `lineage.need`, `lineage.producedBy`; everything else
(intent, kind, `replaces`, `depth`, profile) is carried over untouched for
the author to edit. The copy is self-contained on purpose: the runner and
the loader stop at the first root that carries `<name>/`, so a host copy
holding only the new version would hide the previous one from both. The
seed then shows up as *shadowed* — the intended precedence.

```
$SIA_COMPONENTS_DIR/
  execute-code/
    current                 # copied; still names 0.1.0
    .versions/
      0.1.0/                # copied from the seed
      0.1.1/                # the candidate: entry.ts, contract.ts, component.json
```

**`current` is never written by the agent.** Activating a version is the
host's deliberate, separate step, after which the agent restarts. The
version is described now and runs after activation and restart; a passing
contract ran it out-of-process and proves behaviour, not liveness.

**The tools.**

| Tool | What it does |
|---|---|
| `describe_component({ name })` | Read-only: which root wins and why, the current version, the versions present, the manifest and the paths. Root precedence is not visible through `read_file`. |
| `prepare_component_version({ name, need, bump? })` | The layout above under the host-managed root (created if missing), then admits that root for the filesystem tools. Returns the paths and the next step. |
| `run_component_contract({ name, version? })` | `runComponentContract` on the named version; `contract passed for …` / `contract FAILED for …: <error>`. |
| `announce_component_version({ name, version, summary, outcome?, channel? })` | Tells the host about the candidate and, when `SIA_ANNOUNCE_TO_CHAT` is on, posts one message with a link to the thread (`HOST_CONTRACT.md` §3.4). Best-effort: a host without those endpoints is reported, never thrown. |

Lineage lives in two places: `manifest.lineage` on disk, and a
`component_version` entity the skill stores in memory as soon as the
version directory exists (linked with `SUPERSEDES` to its parent). The
entity is written early on purpose: a self-task thread lives only as long
as the process, and a restart mid-iteration must still leave a trace.

---

## 7. Remote tools

Tools can also come from **servers** the agent talks to over the Model
Context Protocol. The same registrar carries them and the `kind: tools`
components of §4.

### Configuration

`SIA_SERVERS_FILE` names a JSON file. When unset it defaults to
`$SIA_COMPONENTS_DIR/servers.json`; when neither exists, no remote tools are
registered. The file is subject to the same containment rule as manifests
(it must resolve inside the components root) and, like manifests, is
re-read on every agent turn.

```json
{
  "<server>": {
    "transport": "stdio" | "http",
    "command": "…",  "args": ["…"],      // stdio
    "url": "http://127.0.0.1:…",         // http
    "scope": ["tag-a", "tag-b"]          // optional
  }
}
```

Server names follow the same `^[a-z][a-z0-9-]*$` rule as component names.
The client is `MultiServerMCPClient` from `@langchain/mcp-adapters` (already
a dependency), one connection per server, sessions established per call.

**Rejected:** a JSON blob in an environment variable (the config is
otherwise flat scalars and env is not re-readable at runtime), and a server
list inside each component (a server is not a version of anything).

### Scopes

A server with no `scope` is always active. A server with scopes is active
for a run only if at least one of them appears in
`config.configurable.scopes` (a `string[]` the caller passes per
invocation). The agent never interprets a scope; it is an opaque tag that
the caller and the server agree on.

### Naming and ordering

Every remote tool is registered as `mcp__<server>__<tool>`. The tool pool
presented to the model is: built-in tools first, then tools from
components and servers, deduplicated by name with the first occurrence
winning. The order is stable across turns so prompt caches stay warm.

### Exclusion grammar

`excludedTools` (harness profile and manifest `profile`) currently matches
exact tool names. It is widened so that an entry may be:

| Entry | Excludes |
|---|---|
| `some_tool` | that tool |
| `mcp__<server>` | every tool from that server |
| `mcp__<server>__*` | same, explicit form |
| `mcp__<server>__<tool>` | that one remote tool |

Matching becomes a function in `src/middleware/tool_exclusion.ts` rather
than a `Set.has` lookup.

### The registrar

`createRemoteToolsMiddleware` (`src/middleware/remote-tools.ts`) does both
halves that runtime tool registration requires:

- `wrapModelCall` appends the active tools to `request.tools`.
- `wrapToolCall` routes a call whose name matches a registered tool to the
  server (or to the component's `StructuredTool`), and passes everything
  else through.

It is inserted as a novel middleware, which places it before the tail
segment — and therefore before the tool-exclusion middleware, so exclusions
apply to remote tools too.

### Not built yet

Deferred tool schemas (advertising a name and loading the schema on first
use) are a known optimisation for large tool pools. The naming and ordering
rules above leave room for them; nothing here depends on them.

---

## 8. Safety invariants

These are the properties every change that touches this area must keep:

1. **Never break boot.** A bad component is skipped, never fatal (§4).
2. **Fail closed on contracts.** Every unclassifiable outcome is
   `ok: false` (§6).
3. **Containment.** Nothing is read from outside a component root, through
   any link (§2). The servers file is inside the root too (§7).
4. **The code is restart-gated.** No in-process hot swap of loaded modules;
   the manifest is the only live surface (§4).
5. **Scaffolding cannot be replaced.** `replaces` never names a required
   middleware (§3).
6. **Unchanged when absent.** With no component roots and no servers file,
   the agent behaves exactly as before.

---

## 9. Deferred

Explicitly not part of this design, so nobody has to decide them again
before the loader ships:

- deferred tool schemas (§7)
- lifecycle hooks around tool calls or turns
- permission modes or approval prompts for tools
- any registry or marketplace of components
- in-process hot swap of loaded code
- component-to-component imports (only `deps.services`)
