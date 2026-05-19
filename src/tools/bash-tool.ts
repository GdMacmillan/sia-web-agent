/**
 * Bash Tool - Persistent Shell Session Execution
 *
 * Provides bash command execution with persistent session state.
 * Inspired by Claude Code's bash tool implementation.
 *
 * Features:
 * - Persistent shell session maintains env vars and working directory
 * - Timeout support (default 2min, max 10min)
 * - Output truncation for large results (30KB limit)
 * - Exit code reporting
 * - Command chaining support (&&, ;)
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn, type ChildProcess } from "child_process";

/**
 * Clip long strings to prevent token overflow
 */
function clipOutput(content: string, maxChars: number = 30000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n...[truncated]...";
}

/**
 * BashSession manages a single persistent bash process
 *
 * Maintains state (environment variables, working directory) between commands.
 * Uses a completion marker pattern to detect when commands finish.
 */
class BashSession {
  private process: ChildProcess | null = null;
  private outputBuffer = "";
  private errorBuffer = "";
  private completionMarker: string;
  private cwd: string;
  private isExecuting = false;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.completionMarker = `__BASH_COMPLETE_${Date.now()}_${Math.random()}__`;
    this.startProcess();
  }

  /**
   * Start the bash process
   */
  private startProcess(): void {
    this.process = spawn("/bin/bash", [], {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Unref the process so it doesn't keep Jest from exiting
    this.process.unref();

    // Set up output handlers
    this.process.stdout?.on("data", (data) => {
      this.outputBuffer += data.toString();
    });

    this.process.stderr?.on("data", (data) => {
      this.errorBuffer += data.toString();
    });

    // Handle process exit
    this.process.on("exit", (_code, _signal) => {
      this.process = null;
    });

    this.process.on("error", (_error) => {
      this.process = null;
    });
  }

  /**
   * Execute a command in the persistent session
   *
   * @param command The bash command to execute
   * @param timeout Maximum execution time in milliseconds
   * @returns Command output and exit code
   */
  async execute(command: string, timeout: number): Promise<string> {
    // Prevent concurrent executions on the same session
    if (this.isExecuting) {
      return "Error: Session is busy executing another command. Please wait.";
    }

    this.isExecuting = true;

    try {
      // Ensure process is alive
      if (!this.process || this.process.exitCode !== null) {
        this.startProcess();
        // Give the process a moment to initialize
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Clear buffers
      this.outputBuffer = "";
      this.errorBuffer = "";

      // Write command with completion marker and exit code capture
      // The marker will appear in stdout when the command completes
      const wrappedCommand = `${command}\necho "${this.completionMarker} $?"\n`;
      this.process!.stdin?.write(wrappedCommand);

      // Wait for completion marker or timeout
      const result = await this.waitForCompletion(timeout);
      return result;
    } catch (error: any) {
      return `Error executing command: ${error.message}`;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Wait for command completion by polling for the marker
   */
  private waitForCompletion(timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let processExitHandler: ((code: number | null) => void) | null = null;

      // Set up timeout
      const timeoutId = setTimeout(() => {
        cleanup();
        // Try to kill the process
        if (this.process) {
          this.process.kill("SIGTERM");
        }
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);

      // Poll for completion marker
      const pollIntervalId = setInterval(() => {
        if (this.outputBuffer.includes(this.completionMarker)) {
          cleanup();
          const result = this.parseOutput();
          resolve(result);
        }
      }, 10);

      const cleanup = () => {
        clearTimeout(timeoutId);
        clearInterval(pollIntervalId);
        if (processExitHandler && this.process) {
          this.process.off("exit", processExitHandler);
        }
      };

      // Handle process exit (e.g., from `exit` command)
      processExitHandler = (code: number | null) => {
        cleanup();
        // Give a brief moment for any remaining output to flush
        setTimeout(() => {
          // Process exited, parse what we have
          const result = this.parseOutputOnExit(code);
          resolve(result);
        }, 10);
      };

      if (this.process) {
        this.process.once("exit", processExitHandler);
      }
    });
  }

  /**
   * Parse command output and extract exit code from marker line
   */
  private parseOutput(): string {
    // Find the marker line with exit code
    const markerRegex = new RegExp(`${this.completionMarker} (\\d+)`);
    const match = this.outputBuffer.match(markerRegex);

    if (!match) {
      // Marker not found in expected format - return raw output
      const combined = this.combineOutput(this.outputBuffer, this.errorBuffer);
      return combined || "Command completed but marker not found in output";
    }

    const exitCode = parseInt(match[1], 10);

    // Remove the marker line from output
    const outputBeforeMarker = this.outputBuffer
      .substring(0, this.outputBuffer.indexOf(this.completionMarker))
      .trim();

    // Combine stdout and stderr
    const combined = this.combineOutput(outputBeforeMarker, this.errorBuffer);

    // Format result based on exit code
    if (exitCode === 0) {
      return combined || "(no output)";
    } else {
      return `Command exited with code ${exitCode}\n\n${combined || "(no output)"}`;
    }
  }

  /**
   * Parse output when process exits unexpectedly (e.g., from `exit` command)
   */
  private parseOutputOnExit(exitCode: number | null): string {
    // Combine stdout and stderr
    const combined = this.combineOutput(this.outputBuffer, this.errorBuffer);

    // If there's a marker in the output, use normal parsing
    if (this.outputBuffer.includes(this.completionMarker)) {
      return this.parseOutput();
    }

    // Process exited without marker (likely due to `exit` command)
    if (exitCode === null) {
      // Unknown exit code
      return combined || "(no output)";
    } else if (exitCode === 0) {
      return combined || "(no output)";
    } else {
      return `Command exited with code ${exitCode}\n\n${combined || "(no output)"}`;
    }
  }

  /**
   * Combine stdout and stderr into a single output string
   */
  private combineOutput(stdout: string, stderr: string): string {
    const parts: string[] = [];

    if (stdout) {
      parts.push(stdout);
    }

    if (stderr) {
      parts.push(stderr);
    }

    return parts.join("\n").trim();
  }

  /**
   * Close the session and kill the process
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const process = this.process;
      this.process = null;

      // Close stdio pipes to release handles
      process.stdin?.end();
      process.stdout?.destroy();
      process.stderr?.destroy();

      // Wait for process to exit
      process.once("exit", () => resolve());

      // Kill the process
      process.kill("SIGTERM");

      // Fallback timeout in case process doesn't exit
      const fallbackTimeout = setTimeout(() => {
        if (!process.killed) {
          process.kill("SIGKILL");
        }
        resolve();
      }, 50);

      // Unref the timeout so it doesn't keep Jest from exiting
      fallbackTimeout.unref();
    });
  }

  /**
   * Check if the session is currently executing a command
   */
  isBusy(): boolean {
    return this.isExecuting;
  }
}

/**
 * BashSessionManager manages multiple bash sessions by thread ID
 *
 * Each thread gets its own persistent shell session, allowing
 * state to persist within a conversation but be isolated between conversations.
 */
class BashSessionManager {
  private sessions: Map<string, BashSession> = new Map();
  private defaultCwd: string;

  constructor(projectRoot: string) {
    this.defaultCwd = projectRoot;
  }

  /**
   * Get or create a session for a given thread ID
   */
  getSession(threadId: string): BashSession {
    if (!this.sessions.has(threadId)) {
      this.sessions.set(threadId, new BashSession(this.defaultCwd));
    }
    return this.sessions.get(threadId)!;
  }

  /**
   * Clean up sessions
   *
   * @param threadId Optional thread ID to clean up specific session
   */
  async cleanup(threadId?: string): Promise<void> {
    if (threadId) {
      const session = this.sessions.get(threadId);
      if (session) {
        await session.close();
        this.sessions.delete(threadId);
      }
    } else {
      // Clean up all sessions
      const closePromises = Array.from(this.sessions.values()).map((session) =>
        session.close(),
      );
      await Promise.all(closePromises);
      this.sessions.clear();
    }
  }

  /**
   * Get count of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}

/**
 * Create the bash tool for command execution
 *
 * Returns a DynamicStructuredTool that executes bash commands in a persistent session.
 *
 * @param projectRoot The project root directory (working directory for new sessions)
 * @returns Configured bash tool with cleanup method attached
 */
export function createBashTool(projectRoot: string): DynamicStructuredTool & {
  cleanup?: () => void;
} {
  const sessionManager = new BashSessionManager(projectRoot);

  const tool = new DynamicStructuredTool({
    name: "bash",
    description: `Execute bash commands in a persistent shell session.

WHEN TO USE: - Running build commands (yarn build, npm test, tsc, etc.) - Git operations (git
status, git diff, git log, git commit, etc.) - Package management (npm install, yarn add, etc.) -
System commands (ls, mkdir, cat, grep, find, etc.) - Docker operations (docker build, docker run,
etc.) - Any command requiring shell execution

WHEN NOT TO USE (prefer specialized tools): - Reading files: Use read_file tool instead of cat -
Editing files: Use edit_file tool instead of sed/awk - Writing new files: Use write_file tool
instead of echo/cat heredoc - Searching code: Use search or grep tools for better formatting

FEATURES: - Persistent session: Environment variables and working directory persist between calls -
Timeout support: Default 2 minutes (120000ms), maximum 10 minutes (600000ms) - Output truncation:
Results over 30000 characters are truncated - Exit code reporting: Non-zero exits are clearly
indicated

COMMAND CHAINING: - Use && to chain commands (second runs only if first succeeds) - Use ; to chain
commands (second always runs regardless) - For independent commands, make separate tool calls
(enables parallel execution)

PATH HANDLING: - Always quote paths with spaces: cd "/path/with spaces" - Prefer absolute paths for
clarity - Working directory changes persist between calls (cd is sticky)

IMPORTANT: - Session state persists within a conversation thread - Environment variables set with
export persist - cd commands change working directory for all subsequent commands - Each
conversation thread has its own isolated session

Working directory: ${projectRoot}`,

    schema: z.object({
      command: z
        .string()
        .describe(
          "The bash command to execute. Can be a single command or multiple commands chained with && or ;",
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
        .default(120000)
        .describe(
          "Optional timeout in milliseconds (default: 120000ms/2min, max: 600000ms/10min)",
        ),
    }),

    func: async (
      { command, description: _description, timeout },
      config: any,
    ) => {
      try {
        // Validate and cap timeout
        const effectiveTimeout = Math.min(
          Math.max(timeout || 120000, 1000),
          600000,
        );

        // Get thread ID from config for session management
        // Falls back to "default" if no thread_id in config
        const threadId = config?.configurable?.thread_id || "default";

        // Get or create session for this thread
        const session = sessionManager.getSession(threadId);

        // Execute command in the session
        const result = await session.execute(command, effectiveTimeout);

        // Truncate if necessary (30KB limit like Claude Code)
        return clipOutput(result, 30000);
      } catch (error: any) {
        return `Error executing bash command: ${error.message}`;
      }
    },
  });

  // Attach cleanup method for testing
  (tool as any).cleanup = () => sessionManager.cleanup();

  return tool;
}

/**
 * Export session manager for testing or advanced usage
 */
export { BashSessionManager, BashSession };
