# Security model

This agent is designed to be given real capabilities — it can run shell commands (`bash`),
execute arbitrary TypeScript/JavaScript (`execute_code`), read and write files, and rewrite its
own prompts, skills, and tools. It is also driven by an LLM, which means anything it reads — a web
page, a file, a message from another agent — is a potential prompt-injection vector. Treat the
agent's own process as **untrusted by design**, not as a bug to fix.

## What this repo's own guard covers, and what it doesn't

All filesystem _tool_ operations (`read_file`, `write_file`, `edit_file`, `ls`, `grep`, `glob`)
flow through `FilesystemBackend.resolvePath` (`src/backends/filesystem.ts`), which calls
`validatePathInProject` and rejects any path outside the resolved project root
(`getProjectRoot()`, `src/backend-config.ts`). This is a real guard and the hard filesystem
boundary the agent enforces on itself; the policy layer in `src/middleware/fs.ts` sits above it,
not in place of it.

It does **not** cover the agent's shell or code-execution tools. `bash` and `execute_code` spawn
real child processes with the full privileges, filesystem access, and network reachability of
whatever user account is running the agent. A command run through `bash` is not passed through
`validatePathInProject` — it can read, write, or exfiltrate anything the OS-level user account can,
and it can open any network connection that account can. There is no code in this repository that
restricts what a shell command or an `execute_code` script can do.

**In short: the path guard bounds the file _tools_, not the process.** Nothing in this repository
is, or is meant to be, an OS-level sandbox.

## Why confinement belongs in the host, not here

This agent's own code — including this security model, the path guard above, and every prompt and
skill in this repo — is itself something the agent is designed to read and rewrite as part of
normal self-improvement. A security control that lives inside the agent's own editable surface is
not a control a motivated adversary (or a sufficiently confused self-edit) has to work very hard
to remove.

Real confinement has to come from **whatever process spawns this agent as a child** — a host
daemon, a container runtime, a desktop app's process supervisor, whatever embeds this repo. That
host, not this code, is in a position to:

- Spawn the agent inside an OS-level sandbox (e.g. a generated seccomp/Landlock profile on Linux,
  a Seatbelt profile on macOS, a container or VM elsewhere) that bounds what the agent's process
  tree can read, write, and reach on the network — independent of anything the agent's own code
  says.
- Control what environment variables the spawned process inherits, so the agent's shell can't read
  secrets that belong to the host (API keys, credentials, tokens) out of its own environment.
- Broker outbound network access rather than handing the agent raw credentials for the services it
  talks to, so a compromised agent process never holds a real upstream secret it could leak.
- Authenticate any loopback or local API the host exposes to the agent, so the agent can't use its
  own process to reach the host's privileged operations.

If you're embedding this agent and want to make claims to your own users about what it can and
can't touch, those claims need to be backed by controls at **your** spawn point — not by anything
inside this repository, however carefully it's written. A host that spawns this agent with a full,
unrestricted environment and no OS-level sandbox should assume the agent can do anything its OS
user account can do, including reading arbitrary files, making arbitrary network connections, and
exfiltrating anything it can read through its own LLM provider traffic (the model call itself is
an unavoidable channel for anything the agent has read, no matter how the rest of the process is
confined).

## When the reference host runs it

The reference host, `siad` (see [`docs/HOST_CONTRACT.md`](docs/HOST_CONTRACT.md)), applies each
of the controls above at its own spawn point. What that buys depends on the operating system:

| Platform | What the host enforces around the agent's whole process tree                                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | A generated Seatbelt profile: reads limited to system paths plus the agent's own tree, writes limited to its source tree, component store and a private temp dir, and network limited to loopback on the host's port and the agent's own. Reported as `enforced`.                                                         |
| Linux    | Landlock + seccomp, plus user and mount namespaces where the kernel allows them. Files are fenced on any Landlock-capable kernel; outbound TCP is restricted by port only on Landlock ABI 4+ (kernel 6.7+); local sockets outside the agent's tree are hidden by the namespace tier or, on ABI 9+, by Landlock. Reported as `partial`. |
| Windows  | No OS sandbox yet. The curated environment and authenticated local API still apply, but a shell command can read anything the user account can — including the host's own files — so neither is a boundary against a hostile agent. Reported as `not_enforced`.                                                         |

On every platform the host gives the agent an allowlisted environment with no upstream API keys:
the agent's LLM and search clients point at the host (`{PREFIX}_BASE_URL`, `TAVILY_BASE_URL`),
which injects the real key on the way out. Credentials for the other APIs a component calls are
held the same way: the host configures each as a named upstream, and the agent gets the use of it
through the host's egress route (`deps.host.fetch`, [`docs/HOST_CONTRACT.md`](docs/HOST_CONTRACT.md)
§3.7) — never the value, which the host also scrubs from every response. Where there is no OS
sandbox (Windows, above) the host's own credential store is as readable as any of its files, so
this keeps credentials out of the agent's env and conversation but is not a boundary against a
hostile agent. The agent's bearer token is scoped to that one agent and refused on the host's administrative routes, including the one that accepts a new component
version. The host reports each agent's sandbox status and any gaps it knows of, so a weaker
posture is visible rather than silent.

If you are a SIA user rather than someone embedding this repo, the plain-language version — and
how to check your own machine — is at <https://sia-web.fly.dev/docs/security>. The full threat
model for the hosted platform (what is protected, from whom, per-OS guarantees and accepted gaps)
is at <https://sia-web.fly.dev/docs/security-model>.

## Reporting a vulnerability

If you find a way for this agent's own tools to bypass `validatePathInProject`, or another gap in
what this repository itself is responsible for, please report it rather than assuming it's covered
by a host-level mitigation you may not control. Please don't open a public issue. Report it
privately through GitHub's private vulnerability reporting — the repository's **Security** tab →
**Report a vulnerability**, or directly at
<https://github.com/gdmacmillan/sia-web-agent/security/advisories/new>. Only the maintainers can
see the report, and we can work on a fix with you there before anything is published.

If the gap is in the hosted SIA platform rather than in this repository, you can also use **Report
a problem** in the SIA app (choose "Something else" and start the description with "Security:").
Either way reaches the same people.
