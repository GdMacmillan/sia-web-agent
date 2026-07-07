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
import { spawn } from "child_process";

/** Default command timeout (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120000;
/** Minimum command timeout (1 second). */
const MIN_TIMEOUT_MS = 1000;
/** Maximum command timeout (10 minutes). */
const MAX_TIMEOUT_MS = 600000;

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
    // agent-authored shell command is this tool's explicit purpose (a sandboxed
    // capability, like Claude Code's own bash tool) — the shell interpretation
    // is intended, not an injection sink.
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true,javascript.lang.security.detect-child-process.detect-child-process -- shell command execution is this tool's intended, documented purpose.
    const child = spawn(command, {
      cwd,
      env: { ...process.env },
      shell: true,
      signal: controller.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      try {
        child.kill();
      } catch {
        // best effort
      }
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
    description: `Execute a shell command.

WHEN TO USE: - Running build commands (yarn build, npm test, tsc, etc.) - Git operations (git
status, git diff, git log, git commit, etc.) - Package management (npm install, yarn add, etc.) -
System commands (ls, mkdir, cat, grep, find, etc.) - Any command requiring shell execution

WHEN NOT TO USE (prefer specialized tools): - Reading files: Use read_file tool instead of cat -
Editing files: Use edit_file tool instead of sed/awk - Writing new files: Use write_file tool
instead of echo/cat heredoc - Searching code: Use search or grep tools for better formatting

FEATURES: - Runs on the platform shell (cmd.exe on Windows, sh elsewhere) - Timeout support:
Default 2 minutes (120000ms), maximum 10 minutes (600000ms) - Output truncation: Results over
30000 characters are truncated - Exit code reporting: Non-zero exits are clearly indicated

COMMAND CHAINING: - Use && to chain commands (second runs only if first succeeds) - Use ; to chain
commands (second always runs regardless) - For independent commands, make separate tool calls
(enables parallel execution)

IMPORTANT: - Each call runs in its own shell; there is NO persisted state between calls - Working
directory does NOT persist — prefix with 'cd <dir> && …' when a command needs a directory -
Environment changes (export) do NOT persist between calls

Working directory: ${projectRoot}`,

    schema: z.object({
      command: z
        .string()
        .describe(
          "The shell command to execute. Can be a single command or multiple commands chained with && or ;",
        ),
      description: z
        .string()
        .optional()
        .describe(
          "Clear, concise description of what this command does (5-10 words) for observability",
        ),
      timeout: z
        .number()
        .optional()
        .default(DEFAULT_TIMEOUT_MS)
        .describe(
          "Optional timeout in milliseconds (default: 120000ms/2min, max: 600000ms/10min)",
        ),
    }),

    func: async ({ command, description: _description, timeout }) => {
      try {
        // Validate and clamp timeout
        const effectiveTimeout = Math.min(
          Math.max(timeout || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
          MAX_TIMEOUT_MS,
        );

        const result = await runCommand(
          command,
          effectiveTimeout,
          projectRoot,
        );

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
