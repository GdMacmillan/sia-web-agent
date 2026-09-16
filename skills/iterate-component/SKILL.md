---
name: iterate-component
description: Write, check and announce a new version of one of your own components in response to a stated need — "improve a component", "a tool is broken", "iterate <name>", "new component version". Runs inside a self-task thread; never edits the running version.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.0.0"
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
| `announce_component_version` | Tell the host about the candidate (and, when enabled, post one message linking this thread) |

Plus `read_file` / `edit_file` / `write_file` for the copied `entry.ts` and `contract.ts`, and
`search_entities` / `store_entity` / `update_entity` for lineage.

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
2. **Prepare, then record lineage immediately.** Call `prepare_component_version` with the need in
   the words of whoever raised it. If earlier candidates are still waiting under the host root,
   the new number simply follows them (`0.1.1` → `0.1.2`); the parent is still the current
   version, and a patch bump is right unless the need is genuinely larger. Then, before editing anything, `store_entity` a
   `component_version` entity titled `<name>@<next>` whose content holds the need, this thread's
   id and "in progress"; link it with `SUPERSEDES` to the entity for `<name>@<previous>` if
   `search_entities` finds one. A restart kills this thread; the entity is the trace that survives.
3. **Change the entry, and make the contract prove it.** `read_file` the copied `entry.ts` and
   `contract.ts`. Make the smallest change to the entry that answers the need, and add a contract
   case that would fail without it — a version proves itself. Keep the manifest's `replaces` name;
   the loader uses it to swap the version in.
4. **Run the contract against the version, not `current`.** `run_component_contract` with the
   version `prepare_component_version` returned. Read the error text; fix; run again. Stop after
   three edit/run rounds — a need that resists three attempts deserves a person's eyes, not a
   fourth guess.
5. **Announce once.** On a pass, `announce_component_version` with a two-sentence summary: what
   changed and why. On exhaustion, announce with `outcome: "failed"` and what stood in the way.
   Then `update_entity` on the lineage entity with the outcome.
6. **Say what is true.** In this thread and in the announcement: the version is described now and
   runs after the host activates it and you restart. The contract passed against the candidate,
   out-of-process; nothing is live.

## What the seed component gives you

The `execute-code` entry exposes `dispose(threadId?)` for cleaning up the workspaces a contract
creates (the shipped contract calls it in a `finally`), and reaches the agent's other tools through
`deps.internals.codeExecution.getExposableTools()`. Keep both when you copy the entry; a contract
that leaks its workspaces fails the next run for the wrong reason.
