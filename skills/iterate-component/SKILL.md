---
name: iterate-component
description: Write, check and announce a new version of one of your own components in response to a stated need — "improve a component", "a tool is broken", "iterate <name>", "new component version". Runs inside a self-task thread; never edits the running version.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.1.0"
---

# Iterate a component

You are producing the next version of one of your components: a copy of the current version with
one change that answers a stated need, proven by its contract, described so a person can decide
whether to activate it. The version you write is **described now and runs only after the host
activates it and you restart**. A passing contract ran the candidate out-of-process; nothing you
do here changes what is live.

## Tools

| Tool                         | Purpose                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `describe_component`         | Which root wins, the current version, the versions present, the manifest, the paths         |
| `prepare_component_version`  | Lay out `.versions/<next>/` under the host-managed root with the manifest already rewritten |
| `run_component_contract`     | Run a version's contract out-of-process; pass/fail with the error text                      |
| `announce_component_version` | Tell the host about the candidate (and, when enabled, post one announcement linking this thread to the room the need was raised in; a need raised in a direct conversation stays there) |

Plus `read_file` / `edit_file` / `write_file` for the copied `entry.ts` and `contract.ts`, and
`search_entities` / `retrieve_entity` / `traverse_graph` for reading the lineage graph memory keeps.

Lineage is recorded for you. `prepare_component_version` stores a `component_version` entity titled
`<name>@<next>` (the need, this thread's id, the parent, `outcome: candidate`) linked `SUPERSEDES` to
the entity for `<name>@<previous>`, creating that one from its manifest if nobody has yet.
`announce_component_version` marks it announced, or settles it as `failed`. The host's verdict —
`converged`, `reverted`, `rejected` — is written by the process that comes back after the restart, not
by you. Each tool's result carries a `lineage:` line saying what it recorded; read it, and continue
either way — memory being unreachable never stops an iteration.

## The three rules

- You MUST NOT write `current`. Activating a version is the host's deliberate step; a version you
  point at yourself was never checked.
- You MUST NOT write under the seed root shipped with the source tree. The host re-stages that tree;
  anything written there is lost and, until then, runs unreviewed. If `prepare_component_version`
  reports that no host-managed root is configured, stop and say so — there is nowhere to write.
- The root you write to is the one `prepare_component_version` returned, not the one
  `describe_component` said wins. The two differ on the first iteration: the winning root is the
  seed, and `prepare_component_version` copies the component into the host-managed root and
  returns paths under it.

## Working principles

0. **You are already inside the self-task.** The person confirmed when this thread was started.
   Do not ask whether to proceed, and do not ask them anything else here — they are not in this
   thread. Proceed; your questions, if any, go into the announcement.
1. **Name the component from the need.** Tool names and component names differ (`execute_code` is
   the tool; `execute-code` is the component). `describe_component` shows the manifest `intent`,
   the current version, which root wins and the paths — read it before deciding what to change.
2. **Read the lineage before you propose, then prepare.** `search_entities` for `<name>` with
   `entity_type: "component_version"` and read what came before: a version settled `reverted` or
   `rejected` names, in its content, the need it answered and why it was turned down — do not
   propose it again unchanged, and say so in the announcement if the need is the same one. What
   memory says about a version is authoritative, including versions other agents in the workspace
   produced. Then call `prepare_component_version` with the need in the words of whoever raised
   it. If earlier candidates are still waiting under the host root, the new number simply follows
   them (`0.1.1` → `0.1.2`); the parent is still the current version, and a patch bump is right
   unless the need is genuinely larger. The result's `lineage:` line says whether the entity was
   recorded; a restart kills this thread, and that entity is the trace that survives.
3. **Change the entry, and make the contract prove it.** `read_file` the copied `entry.ts` and
   `contract.ts`. Make the smallest change to the entry that answers the need, and add a contract
   case that would fail without it — a version proves itself. Keep the manifest's `replaces` name;
   the loader uses it to swap the version in.
4. **Run the contract against the version, not `current`.** `run_component_contract` with the
   version `prepare_component_version` returned. Read the error text; fix; run again. Stop after
   three edit/run rounds — a need that resists three attempts deserves a person's eyes, not a
   fourth guess.
5. **Announce once.** On a pass, `announce_component_version` with a two-sentence summary: what
   changed and why. On exhaustion, announce with `outcome: "failed"` and what stood in the way —
   that summary becomes the recorded reason, so make it the one a future iteration needs to read.
   The announcement updates the lineage entity itself; there is nothing to store afterwards.
6. **Say what is true.** In this thread and in the announcement: the version is described now and
   runs after the host activates it and you restart. The contract passed against the candidate,
   out-of-process; nothing is live.

## What the seed component gives you

The `execute-code` entry exposes `dispose(threadId?)` for cleaning up the workspaces a contract
creates (the shipped contract calls it in a `finally`), and reaches the agent's other tools through
`deps.internals.codeExecution.getExposableTools()`. Keep both when you copy the entry; a contract
that leaks its workspaces fails the next run for the wrong reason.
