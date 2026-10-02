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

## Reporting a vulnerability

If you find a way for this agent's own tools to bypass `validatePathInProject`, or another gap in
what this repository itself is responsible for, please report it rather than assuming it's covered
by a host-level mitigation you may not control. Don't post a working exploit in a public issue:
open an issue that says you have a security report and asks for a private contact, and the
details can follow there.
