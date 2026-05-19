/**
 * Code Execution Session Manager
 *
 * Provides thread-isolated TypeScript execution sessions using tsx.
 * Follows the BashSessionManager pattern for consistency.
 *
 * Features:
 * - Persistent session state per thread
 * - Workspace directory isolation per session
 * - Timeout support (default 60s, max 5min)
 * - Output truncation (30KB limit)
 * - Clean process lifecycle management
 */

import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";

/** Maximum output size in characters before truncation */
const MAX_OUTPUT_CHARS = 30000;

/** Strip ANSI escape sequences from a string */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

/** Default timeout for code execution (60 seconds) */
const DEFAULT_TIMEOUT_MS = 60000;

/** Maximum timeout for code execution (5 minutes) */
const MAX_TIMEOUT_MS = 300000;

/**
 * Clip long strings to prevent token overflow
 */
export function clipOutput(
  content: string,
  maxChars: number = MAX_OUTPUT_CHARS,
): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n...[output truncated at 30KB]...";
}

/**
 * Result of code execution
 */
export interface ExecutionResult {
  /** Combined stdout/stderr output */
  output: string;
  /** Exit code (0 = success) */
  exitCode: number | null;
  /** Whether execution timed out */
  timedOut: boolean;
  /** Error message if execution failed to start */
  error?: string;
}

/**
 * CodeExecutionSession manages TypeScript execution for a single thread
 *
 * Each session has its own workspace directory for file isolation.
 * Uses tsx for TypeScript execution with completion marker pattern.
 *
 * Code runs with cwd=projectRoot so relative file paths work naturally.
 * Imports from './tools-api/' are rewritten to absolute paths.
 */
export class CodeExecutionSession {
  private workspaceDir: string;
  private projectRoot: string;
  private isExecuting = false;

  constructor(threadId: string, baseWorkspaceDir: string, projectRoot: string) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    this.workspaceDir = join(baseWorkspaceDir, threadId);
    this.projectRoot = projectRoot;
    this.ensureWorkspaceDir();
  }

  /**
   * Get the workspace directory for this session
   */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  /**
   * Ensure workspace directory exists
   */
  private ensureWorkspaceDir(): void {
    if (!existsSync(this.workspaceDir)) {
      mkdirSync(this.workspaceDir, { recursive: true });
    }
  }

  /**
   * Execute TypeScript code in the session
   *
   * @param code The TypeScript code to execute
   * @param timeout Maximum execution time in milliseconds
   * @returns Execution result with output and exit code
   */
  async execute(
    code: string,
    timeout: number = DEFAULT_TIMEOUT_MS,
  ): Promise<ExecutionResult> {
    // Prevent concurrent executions on the same session
    if (this.isExecuting) {
      return {
        output:
          "Error: Session is busy executing another command. Please wait.",
        exitCode: 1,
        timedOut: false,
        error: "Session busy",
      };
    }

    this.isExecuting = true;

    try {
      // Validate and cap timeout
      const effectiveTimeout = Math.min(
        Math.max(timeout, 1000),
        MAX_TIMEOUT_MS,
      );

      // Execute the code
      const result = await this.runTsx(code, effectiveTimeout);
      return result;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Rewrite ./tools-api/ imports to use absolute workspace path.
   *
   * This allows code to run with cwd=projectRoot (so relative file paths work)
   * while still finding the generated tool APIs in the workspace directory.
   */
  private rewriteToolsApiImports(code: string): string {
    const absoluteToolsApiPath = join(this.workspaceDir, "tools-api");
    // Rewrite various import patterns:
    // - from './tools-api/...'
    // - from "./tools-api/..."
    // - require('./tools-api/...')
    // - require("./tools-api/...")
    return code
      .replace(/from\s+['"]\.\/tools-api\//g, `from '${absoluteToolsApiPath}/`)
      .replace(
        /require\s*\(\s*['"]\.\/tools-api\//g,
        `require('${absoluteToolsApiPath}/`,
      );
  }

  /**
   * Run TypeScript code via tsx subprocess
   */
  private runTsx(code: string, timeout: number): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      let outputBuffer = "";
      let errorBuffer = "";
      let timedOut = false;
      let processExited = false;

      // Rewrite ./tools-api/ imports to absolute paths so they work from projectRoot
      const processedCode = this.rewriteToolsApiImports(code);

      // Spawn tsx with --eval to execute code directly
      // Use npx to ensure tsx is found from node_modules
      // cwd is projectRoot so relative file paths (like ./data.csv) work naturally
      const tsxProcess: ChildProcess = spawn(
        "npx",
        ["tsx", "--eval", processedCode],
        {
          cwd: this.projectRoot,
          env: {
            ...process.env,
            // Ensure consistent behavior
            NODE_ENV: process.env.NODE_ENV || "development",
            // Prevent interactive prompts
            CI: "true",
            // Remove NODE_OPTIONS to prevent parent preloads (e.g. dotenv)
            // from injecting output into the subprocess
            NODE_OPTIONS: "",
            // Suppress ANSI color codes in subprocess output
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      // Unref so process doesn't keep Node alive
      tsxProcess.unref();

      // Collect stdout
      tsxProcess.stdout?.on("data", (data) => {
        outputBuffer += data.toString();
      });

      // Collect stderr
      tsxProcess.stderr?.on("data", (data) => {
        errorBuffer += data.toString();
      });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (!processExited) {
          timedOut = true;
          tsxProcess.kill("SIGTERM");
          // Force kill after 1 second if still running
          setTimeout(() => {
            if (!processExited && !tsxProcess.killed) {
              tsxProcess.kill("SIGKILL");
            }
          }, 1000).unref();
        }
      }, timeout);
      timeoutId.unref();

      // Handle process completion
      tsxProcess.on("exit", (exitCode) => {
        processExited = true;
        clearTimeout(timeoutId);

        const combinedOutput = this.combineOutput(outputBuffer, errorBuffer);

        resolve({
          output: clipOutput(combinedOutput),
          exitCode: exitCode,
          timedOut,
        });
      });

      // Handle process error (e.g., tsx not found)
      tsxProcess.on("error", (error) => {
        processExited = true;
        clearTimeout(timeoutId);

        resolve({
          output: `Error starting tsx: ${error.message}`,
          exitCode: 1,
          timedOut: false,
          error: error.message,
        });
      });

      // Close stdin as we're not sending input
      tsxProcess.stdin?.end();
    });
  }

  /**
   * Combine stdout and stderr into a single output string
   */
  private combineOutput(stdout: string, stderr: string): string {
    const parts: string[] = [];

    const cleanStdout = stripAnsi(stdout).trim();
    const cleanStderr = stripAnsi(stderr).trim();

    if (cleanStdout) {
      parts.push(cleanStdout);
    }

    if (cleanStderr) {
      // Prefix stderr to distinguish from stdout
      if (parts.length > 0) {
        parts.push("\n[stderr]:\n" + cleanStderr);
      } else {
        parts.push(cleanStderr);
      }
    }

    return parts.join("\n") || "(no output)";
  }

  /**
   * Check if the session is currently executing code
   */
  isBusy(): boolean {
    return this.isExecuting;
  }

  /**
   * Clean up the session's workspace directory
   */
  cleanup(): void {
    try {
      if (existsSync(this.workspaceDir)) {
        rmSync(this.workspaceDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * CodeExecutionSessionManager manages multiple sessions by thread ID
 *
 * Each thread gets its own isolated workspace and execution session.
 * Code runs with cwd=projectRoot so relative file paths work naturally.
 */
export class CodeExecutionSessionManager {
  private sessions: Map<string, CodeExecutionSession> = new Map();
  private baseWorkspaceDir: string;
  private projectRoot: string;

  /**
   * Create a new session manager
   *
   * @param projectRoot The project root directory
   * @param workspaceSubdir Subdirectory for workspaces (default: .code-workspace)
   */
  constructor(
    projectRoot: string,
    workspaceSubdir: string = ".code-workspace",
  ) {
    this.projectRoot = projectRoot;
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    this.baseWorkspaceDir = join(projectRoot, workspaceSubdir);
    this.ensureBaseWorkspaceDir();
  }

  /**
   * Ensure base workspace directory exists
   */
  private ensureBaseWorkspaceDir(): void {
    if (!existsSync(this.baseWorkspaceDir)) {
      mkdirSync(this.baseWorkspaceDir, { recursive: true });
    }
  }

  /**
   * Get or create a session for a given thread ID
   */
  getSession(threadId: string): CodeExecutionSession {
    if (!this.sessions.has(threadId)) {
      this.sessions.set(
        threadId,
        new CodeExecutionSession(
          threadId,
          this.baseWorkspaceDir,
          this.projectRoot,
        ),
      );
    }
    return this.sessions.get(threadId)!;
  }

  /**
   * Execute code in a session for a given thread
   *
   * @param threadId The thread ID to execute in
   * @param code The TypeScript code to execute
   * @param timeout Optional timeout in milliseconds
   */
  async execute(
    threadId: string,
    code: string,
    timeout?: number,
  ): Promise<ExecutionResult> {
    const session = this.getSession(threadId);
    return session.execute(code, timeout);
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
        session.cleanup();
        this.sessions.delete(threadId);
      }
    } else {
      // Clean up all sessions
      for (const session of this.sessions.values()) {
        session.cleanup();
      }
      this.sessions.clear();
    }
  }

  /**
   * Get the base workspace directory
   */
  getBaseWorkspaceDir(): string {
    return this.baseWorkspaceDir;
  }

  /**
   * Get count of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
