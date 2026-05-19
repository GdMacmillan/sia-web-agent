/**
 * Code Executor
 *
 * High-level interface for executing TypeScript code.
 * Wraps the session manager and provides formatted results for tool use.
 */

import {
  CodeExecutionSessionManager,
  type ExecutionResult,
  clipOutput,
} from "./session-manager.js";

/**
 * Formatted result suitable for returning from a tool
 */
export interface FormattedExecutionResult {
  /** Human-readable result string */
  result: string;
  /** Whether execution was successful (exit code 0) */
  success: boolean;
  /** Raw execution result for detailed inspection */
  raw: ExecutionResult;
}

/**
 * Options for code execution
 */
export interface ExecuteOptions {
  /** Thread ID for session isolation */
  threadId: string;
  /** Timeout in milliseconds (default: 60000, max: 300000) */
  timeout?: number;
  /** Optional description for logging */
  description?: string;
}

/**
 * CodeExecutor provides a high-level interface for executing TypeScript code
 *
 * Features:
 * - Session management via thread ID
 * - Formatted output suitable for tool results
 * - Error message formatting
 * - Timeout handling with clear messaging
 */
export class CodeExecutor {
  private sessionManager: CodeExecutionSessionManager;

  constructor(projectRoot: string, workspaceSubdir?: string) {
    this.sessionManager = new CodeExecutionSessionManager(
      projectRoot,
      workspaceSubdir,
    );
  }

  /**
   * Execute TypeScript code and return formatted result
   *
   * @param code TypeScript code to execute
   * @param options Execution options
   */
  async execute(
    code: string,
    options: ExecuteOptions,
  ): Promise<FormattedExecutionResult> {
    const { threadId, timeout, description: _description } = options;

    try {
      const result = await this.sessionManager.execute(threadId, code, timeout);
      return this.formatResult(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        result: `Error executing code: ${message}`,
        success: false,
        raw: {
          output: message,
          exitCode: 1,
          timedOut: false,
          error: message,
        },
      };
    }
  }

  /**
   * Format execution result for tool output
   */
  private formatResult(result: ExecutionResult): FormattedExecutionResult {
    if (result.timedOut) {
      return {
        result: `Execution timed out.\n\nPartial output:\n${result.output}`,
        success: false,
        raw: result,
      };
    }

    if (result.error) {
      return {
        result: `Execution error: ${result.error}\n\nOutput:\n${result.output}`,
        success: false,
        raw: result,
      };
    }

    if (result.exitCode !== 0 && result.exitCode !== null) {
      return {
        result: `Code exited with code ${result.exitCode}\n\n${result.output}`,
        success: false,
        raw: result,
      };
    }

    return {
      result: result.output,
      success: true,
      raw: result,
    };
  }

  /**
   * Get the underlying session manager for advanced usage
   */
  getSessionManager(): CodeExecutionSessionManager {
    return this.sessionManager;
  }

  /**
   * Clean up all sessions or a specific session
   */
  async cleanup(threadId?: string): Promise<void> {
    await this.sessionManager.cleanup(threadId);
  }
}

/**
 * Validate TypeScript code for basic syntax issues
 *
 * This is a lightweight check - real validation happens during execution.
 * Returns null if valid, error message if invalid.
 */
export function validateCode(code: string): string | null {
  // Check for empty code
  if (!code || !code.trim()) {
    return "Code cannot be empty";
  }

  // Check for obviously problematic patterns
  const dangerousPatterns = [
    // Prevent infinite loops in simple cases (heuristic only)
    /while\s*\(\s*true\s*\)\s*\{?\s*\}?$/m,
    /for\s*\(\s*;\s*;\s*\)\s*\{?\s*\}?$/m,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(code)) {
      return "Code appears to contain an infinite loop without body";
    }
  }

  return null;
}

/**
 * Format code for display in error messages
 * Shows first few lines with line numbers
 */
export function formatCodePreview(code: string, maxLines: number = 5): string {
  const lines = code.split("\n");
  const preview = lines.slice(0, maxLines);
  const numbered = preview.map(
    (line, i) => `${(i + 1).toString().padStart(3)}: ${line}`,
  );

  if (lines.length > maxLines) {
    numbered.push(`     ... (${lines.length - maxLines} more lines)`);
  }

  return numbered.join("\n");
}

// Re-export clipOutput for use by tool
export { clipOutput };
