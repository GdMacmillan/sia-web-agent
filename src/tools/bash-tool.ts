/**
 * Bash Tool - One-shot Shell Command Execution
 *
 * Executes each command as a discrete child process via the platform shell.
 * There is no persistent session: state (working directory, environment
 * variables) does not carry between calls — compose with `cd x && …` when a
 * command needs a specific directory. This keeps the tool simple, robust, and
 * cross-platform (the shell is resolved per platform), and makes a
 * missing/broken shell fail fast instead of hanging.
 *
 * Features:
 * - Platform shell resolution (cmd.exe / sh) via `shell: true`
 * - Native exit-code reporting
 * - Timeout via AbortController (default 2min, clamp 1s–10min)
 * - Output truncation for large results (30KB limit)
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn, type ChildProcess } from "child_process";

/** Default command timeout (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120000;
/** Minimum command timeout (1 second). */
const MIN_TIMEOUT_MS = 1000;
/** Maximum command timeout (10 minutes). */
const MAX_TIMEOUT_MS = 600000;
/**
 * Grace period between SIGTERM and SIGKILL when reaping a timed-out
 * command's process group on POSIX. Gives well-behaved descendants a
 * moment to exit before the follow-up SIGKILL.
 */
const PROCESS_GROUP_KILL_GRACE_MS = 1000;

/**
 * Clip long strings to prevent token overflow
 */
function clipOutput(content: string, maxChars: number = 30000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n...[truncated]...";
}

/**
 * Combine stdout and stderr into a single output string
 */
function combineOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  return parts.join("\n").trim();
}

/**
 * Reap a timed-out command, matching each platform's process model.
 *
 * On Windows `detached` means "own console", not "own process group", and
 * negative PIDs aren't meaningful — so this stays a plain `child.kill()`,
 * same as before.
 *
 * On POSIX the child was spawned `detached`, which makes its pid double as
 * its process group id. A bare `child.kill()` only reaches the shell
 * itself; a command that backgrounds work (`sleep 30 &`) or forks a
 * long-running descendant leaves it running past the timeout. Killing the
 * negative pid reaches the whole group instead. SIGTERM first, then a
 * SIGKILL follow-up after a grace period for anything that ignored it.
 * Both signals are best-effort: the group (or the whole process) may
 * already be gone by the time either fires.
 */
function killTimedOutChild(child: ChildProcess): void {
  if (process.platform === "win32") {
    try {
      child.kill();
    } catch {
      // best effort
    }
    return;
  }

  if (child.pid === undefined) return; // spawn never produced a pid

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Group already gone (ESRCH) — nothing left to signal.
  }

  const pid = child.pid;
  const killer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already reaped by SIGTERM, or gone — harmless.
    }
  }, PROCESS_GROUP_KILL_GRACE_MS);
  killer.unref?.();
}

/**
 * Run a single command to completion in a fresh shell process.
 *
 * Resolves with the combined output (prefixed with an exit-code line when
 * non-zero), a timeout message if the command exceeds `timeoutMs`, or an error
 * message if the shell fails to start — the last case resolves immediately
 * rather than hanging.
 */
function runCommand(
  command: string,
  timeoutMs: number,
  cwd: string,
): Promise<string> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // `shell: true` resolves cmd.exe on Windows and /bin/sh elsewhere, so the
    // command string is interpreted natively on each platform. Running an
    // agent-authored shell command is this tool's explicit, documented
    // purpose — the shell interpretation is intended, not an injection sink.
    // This spawns an ordinary child process with the agent's own OS-level
    // privileges and environment; it has no sandboxing of its own. Any
    // confinement (container, restricted user, filesystem/network namespace)
    // has to come from whatever supervises the agent process.
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true,javascript.lang.security.detect-child-process.detect-child-process -- shell command execution is this tool's intended, documented purpose.
    const child = spawn(command, {
      cwd,
      env: { ...process.env },
      shell: true,
      signal: controller.signal,
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX only: leads its own process group (pid === gid) so a timeout
      // can reap the whole tree, not just the shell. Meaningless on
      // Windows, where it would instead open a new console.
      detached: process.platform !== "win32",
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // Node's own signal-to-spawn integration reaps the immediate shell
      // process and surfaces an AbortError on `child.on("error", ...)`
      // below; keeping it is harmless (the `settled` guard dedupes) and
      // preserves that path for anything relying on it. The explicit kill
      // below is what actually reaches the rest of a POSIX process group.
      controller.abort();
      killTimedOutChild(child);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (timedOut) {
        finish(`Command timed out after ${timeoutMs}ms`);
        return;
      }
      // Shell missing / failed to spawn — fail fast with a clear message.
      finish(`Error executing command: ${error.message}`);
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(`Command timed out after ${timeoutMs}ms`);
        return;
      }
      const combined = combineOutput(stdout, stderr);
      if (code === 0) {
        finish(combined || "(no output)");
      } else if (code === null) {
        finish(
          `Command terminated by signal ${signal}\n\n${combined || "(no output)"}`,
        );
      } else {
        finish(
          `Command exited with code ${code}\n\n${combined || "(no output)"}`,
        );
      }
    });
  });
}

/**
 * Create the bash tool for command execution.
 *
 * Returns a DynamicStructuredTool that runs each command as a one-shot shell
 * process from the project root.
 *
 * @param projectRoot The project root directory (working directory for commands)
 * @returns Configured bash tool
 */
export function createBashTool(projectRoot: string): DynamicStructuredTool & {
  cleanup?: () => void;
} {
  const tool = new DynamicStructuredTool({
    name: "bash",
    description: `Run a shell command in the project directory and return its output and exit code.

Use it for builds and tests, git inspection (status, diff, log), package management, and other commands that need a shell. To read, edit, write or search files, prefer read_file, edit_file, write_file, grep and search.

Each call runs in a fresh shell (cmd.exe on Windows, sh elsewhere): the working directory and exported variables do not persist, so prefix 'cd <dir> && ...' when a command needs one. Chain dependent commands with &&. Output over 30,000 characters is truncated.

Working directory: ${projectRoot}`,

    schema: z.object({
      command: z.string().describe("The command to run"),
      description: z
        .string()
        .optional()
        .describe("What the command does, in 5-10 words"),
      // No `.default()`: a defaulted field is advertised to the model as
      // required. The default is applied in `func`.
      timeout: z
        .number()
        .optional()
        .describe("Timeout in ms (default 120000, max 600000)"),
    }),

    func: async ({ command, description: _description, timeout }) => {
      try {
        // Validate and clamp timeout
        const effectiveTimeout = Math.min(
          Math.max(timeout || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
          MAX_TIMEOUT_MS,
        );

        const result = await runCommand(command, effectiveTimeout, projectRoot);

        // Truncate if necessary (30KB limit like Claude Code)
        return clipOutput(result, 30000);
      } catch (error: any) {
        return `Error executing bash command: ${error.message}`;
      }
    },
  });

  // No persistent sessions to tear down; keep a no-op cleanup for callers that
  // expect the previous session-based tool's shape.
  (tool as any).cleanup = () => {};

  return tool;
}
