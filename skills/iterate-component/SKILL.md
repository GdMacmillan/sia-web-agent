---
name: iterate-component
description: Write, check and announce a new version of one of your own components (tools such as execute_code) in response to a stated need — "a tool is broken", "execute_code should also say X", "change what <tool> returns", "iterate <name>", "new component version" — or a first version of a tool you do not have yet ("build yourself a tool that does X"), which is a new component. The work runs in a self-task thread. If this thread opened as a self-task, you are already in it: do the work here. Only in the conversation where a person raised the need do you start one, with start_self_task and skill "iterate-component", instead of editing anything. Never edits the running version or the source tree.
license: MIT
metadata:
  author: self-improving-agent
  version: "1.5.0"
---

# Iterate a component

You are producing the next version of one of your components: a copy of the current version with
one change that answers a stated need, proven by its contract, described so a person can decide
whether to activate it. When the need is for a tool you do not have, the "next version" is the
first one: a brand-new component whose `0.1.0` starts from a stub that already passes its contract.
Either way the version you write is **described now and runs only after the host activates it and
you restart**. A passing contract ran the candidate inside this agent's own process, beside the
live version, without loading it into the agent; nothing you do here changes what is live.

## Tools

| Tool                         | Purpose                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `describe_component`         | Which root wins, the current version, the versions present, the manifest, the paths         |
| `create_component`           | Lay out `.versions/<version>/` of a component with no live version anywhere: a manifest with no parent, an entry with one stub tool that echoes its input, and a contract that invokes it. `<version>` is `0.1.0` for a genuinely new name, or the next minor above whatever is already staged when the host removed an earlier lineage for it |
| `prepare_component_version`  | Lay out `.versions/<next>/` under the host-managed root with the manifest already rewritten |
| `run_component_contract`     | Run a version's contract in this process, apart from the live agent; pass/fail with the error text |
| `announce_component_version` | Tell the host about the candidate (and, when enabled, post one announcement linking this thread to the room the need was raised in; a need raised in a direct conversation stays there) |

Plus `read_file` / `edit_file` / `write_file` for the copied `entry.ts` and `contract.ts`, and
`search_entities` / `retrieve_entity` / `traverse_graph` for reading the lineage graph memory keeps.

Lineage is recorded for you. `prepare_component_version` stores a `component_version` entity titled
`<name>@<next>` (the need, this thread's id, the parent, `outcome: candidate`) linked `SUPERSEDES` to
the entity for `<name>@<previous>`, creating that one from its manifest if nobody has yet.
`create_component` stores the same entity for `<name>@<version>` with no parent and no `SUPERSEDES`
edge — a first version is always the root of its lineage, whatever its number. `announce_component_version` marks the entity
announced, or settles it as `failed`. The host's verdict —
`converged`, `reverted`, `rejected`, or later `removed` — is written by the process that comes back after the restart, not
by you. A version can also end up `abandoned`: that is not a verdict from anyone, just this side
noticing the story ended without one (the candidate was never announced — a restart caught it
mid-iteration — or a later candidate replaced it in the host's slot before it was decided). `removed`
is different from the rest: it lands on a version that already settled `converged` — the host took a
version that was live and removed it from the machine, later, and it carries no judgment on the
change itself, the same as `abandoned`. Each
tool's result carries a `lineage:` line saying what it recorded; read it, and continue either way —
memory being unreachable never stops an iteration.

## The three rules

- You MUST NOT write `current`. Activating a version is the host's deliberate step; a version you
  point at yourself was never checked. A new component has no `current` at all until the host
  activates `0.1.0`; until then `describe_component` reports it as present but not runnable, and
  its versions run only through `run_component_contract` with an explicit version.
- You MUST NOT write under the seed root shipped with the source tree. The host re-stages that tree;
  anything written there is lost and, until then, runs unreviewed. If `prepare_component_version`
  or `create_component` reports that no host-managed root is configured, stop and say so — there
  is nowhere to write.
- The root you write to is the one `prepare_component_version` or `create_component` returned, not
  the one `describe_component` said wins. The two differ on the first iteration: the winning root
  is the seed, and `prepare_component_version` copies the component into the host-managed root and
  returns paths under it.

## Working principles

0. **You are already inside the self-task.** A thread whose first message says it is a self-task
   is the one `start_self_task` created; calling it again here is refused. The person confirmed
   when this thread was started. Do not ask whether to proceed, and do not ask them anything else
   here — they are not in this thread. Proceed; your questions, if any, go into the announcement.
1. **Name the component from the need.** Tool names and component names differ (`execute_code` is
   the tool; `execute-code` is the component). `describe_component` shows the manifest `intent`,
   the current version, which root wins and the paths — read it before deciding what to change.
   If no component answers the need — `describe_component` says the name is unknown and none of
   your tools does the job — the need is for a **new component**: name it from the need
   (`parse-time-expression` for a `parse_time_expression` tool), state its intent in one sentence,
   and call `create_component` instead of `prepare_component_version`. If `describe_component`
   says the name exists but has no current version, check the lineage before assuming which case
   this is: a version whose entity is still `candidate` is one someone already created and waiting
   on a verdict — continue it, via `read_file` and `run_component_contract` with that version. A
   version whose entity reads `removed` means the host took the whole lineage back off the
   machine — that is a component you do not have, again, and `create_component` starts a fresh
   version above what is staged, not a continuation of it.
2. **Read the lineage before you propose, then prepare.** `search_entities` for `<name>` with
   `entity_type: "component_version"` and read what came before: a version settled `reverted` or
   `rejected` names, in its content, the need it answered and why it was turned down — do not
   propose it again unchanged, and say so in the announcement if the need is the same one. A
   version settled `abandoned` carries no such judgment — its content names the reason ("never
   announced" or "replaced by `<version>`"), not a rejection of the change — so it is fine to
   retry it unchanged or resume it where it left off. What memory says about a version is
   authoritative, including versions other agents in the workspace produced. Then call
   `prepare_component_version` with the need in the words of whoever raised it. If earlier
   candidates are still waiting under the host root, the new number simply follows them (`0.1.1` →
   `0.1.2`); the parent is still the current version, and a patch bump is right unless the need is
   genuinely larger. The result's `lineage:` line says whether the entity was recorded; a restart
   kills this thread, and that entity is the trace that survives.
3. **Change the entry, and make the contract prove it.** `read_file` the copied `entry.ts` and
   `contract.ts`. Make the smallest change to the entry that answers the need, and add a contract
   case that would fail without it — a version proves itself. Keep the manifest's `replaces` name;
   the loader uses it to swap the version in. For a new component the scaffolded stub passes its
   contract before you touch it — run it once to see that, then make the tool answer the need
   (widen its schema to the inputs it takes, replace the echo with the behaviour) and replace the
   echo case with cases that prove it. The tool's `description` is what you will read when deciding
   to call it later; write it for that reader.
4. **Run the contract against the version, not `current`.** `run_component_contract` with the
   version `prepare_component_version` or `create_component` returned. Read the error text; fix; run again. Stop after
   three edit/run rounds — a need that resists three attempts deserves a person's eyes, not a
   fourth guess.
5. **Announce once, from this thread.** On a pass, `announce_component_version` with a
   two-sentence summary: what changed and why. On exhaustion, announce with `outcome: "failed"` and
   what stood in the way — that summary becomes the recorded reason, so make it the one a future
   iteration needs to read. The announcement updates the lineage entity itself; there is nothing to
   store afterwards. Call it once: it is refused if this thread already announced a candidate for
   this component that is still awaiting a verdict, and refused from any thread that is not the
   self-task itself — the tool is how the work that produced a version tells the host about it, not
   a general-purpose way to talk about one.
6. **Say what is true.** In this thread and in the announcement: the version is described now and
   runs after the host activates it and you restart. The contract passed against the candidate in
   this process, without it ever being loaded into the agent; nothing is live. For a new component say also that you have no such tool yet:
   the announcement is for a tool you will gain, not one that changes.

## Calling an authenticated API

When the need is for a tool that talks to an API that needs a credential, the component never
holds that credential. The host keeps it and calls the API on the component's behalf, by an
**upstream name** it has configured: `deps.host.fetch("<name>", "/path?query", init)` returns the
API's `Response`, and `deps.host.upstreams()` lists the names this host offers.
`describe_component` and `create_component` print that list as `host upstreams:` when the host can
say.

- You MUST NOT ask anyone to paste a key, token or password into a conversation, a file, a
  memory or a component, and you MUST NOT put one in `init.headers` — the host replaces
  `Authorization` anyway.
- If the upstream you need is not listed, `deps.host.fetch` throws a message naming it and the ones
  that are. Do not work around it: tell the person which name to ask the host's owner to configure
  (say so in the announcement too), and make the contract fail with that message rather than
  pretend.
- A contract that calls the upstream proves the real thing — but it runs against the live API, so
  keep its cases read-only.

## What the seed component gives you

The `execute-code` entry exposes `dispose(threadId?)` for cleaning up the workspaces a contract
creates (the shipped contract calls it in a `finally`), and reaches the agent's other tools through
`deps.internals.codeExecution.getExposableTools()`. Keep both when you copy the entry; a contract
that leaks its workspaces fails the next run for the wrong reason.
