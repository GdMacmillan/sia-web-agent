# Components

A **component** is a versioned unit of agent code that lives on disk, outside
the agent's own source tree, and is assembled into the agent at boot. Each
component ships with a **manifest** that describes it, a **contract** that
proves a version works, and an **entry** that builds the thing it contributes.

This document is the spec for the component loader and for the runtime
registration of remote tools. It is written to be implementable without
further decisions; the rejected alternatives are recorded so they are not
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
defines the tool, formats results, and manages the executor lifecycle
(`src/middleware/code-execution.ts`, registered as `CodeExecutionMiddleware`).
The heavy internals (session manager, IPC bridge, tool-API generator) stay
in the source tree and reach the component through the SDK.

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
    current -> .versions/<version>       # symlink (or junction); the pointer
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

**Containment.** Every path the loader touches is resolved with
`realpathSync` and must remain inside the root (`relative(root, real)` must
not start with `..`). This is the same check `isSafePath` applies to skills
(`src/utils/skills-loader.ts`). A `current` link that escapes the root is
skipped with a warning. Manifests over 10 MB are skipped.

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
    /** Optional assembly tuning, same shape as `HarnessProfileOptions`. */
    profile: HarnessProfileOptionsSchema.optional(),
  })
  .strict();
```

Rules the loader enforces beyond the schema:

- `name` must equal the directory name; `version` must equal the
  `.versions/<version>` directory the `current` link resolves to.
- `replaces` must name a middleware that exists in the assembled default
  stack and must not name one in `REQUIRED_MIDDLEWARE_NAMES`
  (`src/profiles/harness.ts`). Replacing scaffolding is refused.
- `depth` is recorded, not inferred. A parent may have been pruned; the
  tree shape is carried by every node so the whole tree can be listed
  without walking lineage.
- `profile`, when present, is validated by the existing harness-profile
  schema (`src/profiles/harness.ts`) and applied at assembly like any other
  profile input.

Example — the seed `execute_code` component:

```json
{
  "name": "execute-code",
  "version": "0.1.0",
  "kind": "middleware",
  "intent": "Run TypeScript the agent writes, in an isolated session per thread, and return stdout, stderr and the final value as text.",
  "sdk": "^1.0.0",
  "replaces": "CodeExecutionMiddleware",
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

The loader runs once at assembly (`createDeepAgentWithDefaults`,
`src/deep-agent-setup.ts`) and yields three things:

- `customMiddleware: AgentMiddleware[]` — from `kind: middleware` entries.
- `tools: StructuredTool[]` — from `kind: tools` entries, handed to the same
  registrar that carries remote tools (§7).
- `services: Record<string, unknown>` — from `kind: service` entries,
  published under `deps.services[name]` for other components to use.

**Middleware replacement is name-based.** `mergeMiddlewareStack`
(`src/middleware/utils.ts`) already replaces a default middleware in place
when a custom one carries the same `name`, and inserts a novel one between
the default and tail segments. The loader passes its middleware as the
`customMiddleware` argument at **both** assembly sites — the main stack and
the sub-agent stack (`src/agent.ts`) — so a replacement swaps in both at
once. The loader asserts that the middleware an entry returns has
`.name === manifest.replaces`; a mismatch is a load failure for that
component.

**Rejected:** a `resolveComponent(name) ?? bundledDefault` call at each
registration site. It is a second primitive beside `mergeMiddlewareStack`,
has to be repeated per site, and cannot express `kind: tools`.

### Hot versus restart-gated

Two different things change at two different speeds:

| What | When it is read | Effect of a change |
|---|---|---|
| Manifest fields: `intent`, `profile`, `depth`, `lineage` | every agent turn (`beforeAgent`, like skills) | visible on the next turn |
| Code: `entry`, `contract` | once, at assembly | visible after restart |

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
export const SDK_VERSION = "1.0.0";

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
  services: Record<string, unknown>;  // published by `kind: service` components
  /** Bundled internals exposed for specific components. Unstable. */
  internals: {
    codeExecution: {
      createExecutor: typeof createToolEnabledExecutor;
      sessionManager: SessionManager;
      // …whatever the execute-code wrapper needs, and nothing else
    };
  };
}
```

`entry.ts` is:

```ts
export default function (deps: ComponentDeps): AgentMiddleware | StructuredTool[] | unknown;
```

The return type follows `kind`: `middleware` → one `AgentMiddleware`;
`tools` → `StructuredTool[]`; `service` → any value, published as-is.

**Versioning.** Everything on `ComponentDeps` except `internals` is stable
across a major version of `SDK_VERSION`: additions bump the minor,
removals or signature changes bump the major. `internals` is the one
unstable namespace and is documented as such — a component that reaches
into it accepts that a minor SDK bump may break it. The manifest's `sdk`
range is checked against `SDK_VERSION` at load; a mismatch skips the
component with a warning (§4).

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
  /** Invoke a tool by name through the assembled agent, in a scratch thread. */
  invoke: (toolName: string, args: unknown) => Promise<string>;
};
```

Any throw is a failure. Any normal return is a pass. There is no test
framework: assertions are plain `if (…) throw new Error(…)`.

### The runner

```ts
export async function runComponentContract(
  name: string,
  opts?: { timeoutMs?: number },   // default 30_000
): Promise<{
  ok: boolean;
  durationMs: number;
  version: string | null;
  sdkVersion: string;
  error?: string;
}>;
```

Exported from `src/graph.ts` beside `graph`. A host that only knows about
`graph` never sees it; a host that does can call it. The same function is
used in-process by the agent (before it announces a candidate version) and
by a host at boot (to gate a restart).

**Fail-closed invariants** — every one of these is `ok: false`, never a
throw:

- timeout elapsed
- no contract file, or one that fails to load
- unknown component name, or no `current` pointer
- SDK range mismatch
- the contract throws for any reason

The runner never throws. Anything that cannot be classified is
`ok: false` with the error text.

**Rejected:** running the contract over the agent's chat endpoint (a
contract is not a conversation), and shipping a test runner to production
installs.

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
