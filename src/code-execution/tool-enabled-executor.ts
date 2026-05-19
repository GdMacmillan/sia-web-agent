/**
 * Tool-Enabled Code Executor
 *
 * Extends the basic code executor with tool API support via IPC bridge.
 * Enables executed code to call agent tools through generated TypeScript APIs.
 *
 * Features:
 * - Tool API generation from StructuredTool definitions
 * - IPC bridge for tool calls from subprocess
 * - Thread-isolated sessions with tool access
 * - Automatic cleanup of IPC resources
 */

import { join } from "path";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  CodeExecutionSessionManager,
  type ExecutionResult,
} from "./session-manager.js";
import {
  IPCBridge,
  SimpleToolRegistry,
  generateSocketPath,
} from "./ipc-bridge.js";
import { generateToolAPIs } from "./tool-api-generator.js";

/**
 * Options for creating a tool-enabled executor
 */
export interface ToolEnabledExecutorOptions {
  /** Project root directory */
  projectRoot: string;
  /** Tools available for execution */
  tools: StructuredToolInterface[];
  /** Subdirectory for workspaces (default: .code-workspace) */
  workspaceSubdir?: string;
  /** Callback for logging (optional) */
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

/**
 * Tool-enabled session that wraps a basic session with IPC bridge
 */
interface ToolSession {
  /** IPC bridge for this session */
  bridge: IPCBridge;
  /** Whether tool APIs have been generated */
  apisGenerated: boolean;
}

/**
 * ToolEnabledExecutor provides code execution with tool API access
 *
 * This executor:
 * 1. Creates a workspace for each thread
 * 2. Generates typed TypeScript tool APIs in the workspace
 * 3. Starts an IPC bridge for tool calls
 * 4. Routes tool calls from subprocess to actual tool implementations
 */
export class ToolEnabledExecutor {
  private sessionManager: CodeExecutionSessionManager;
  private tools: StructuredToolInterface[];
  private toolSessions = new Map<string, ToolSession>();
  private onLog: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => void;

  constructor(options: ToolEnabledExecutorOptions) {
    const { projectRoot, tools, workspaceSubdir, onLog } = options;

    this.tools = tools;
    this.onLog = onLog || (() => {});
    this.sessionManager = new CodeExecutionSessionManager(
      projectRoot,
      workspaceSubdir,
    );
  }

  /**
   * Execute code with tool API access
   *
   * @param threadId Thread ID for session isolation
   * @param code TypeScript code to execute
   * @param timeout Optional timeout in milliseconds
   */
  async execute(
    threadId: string,
    code: string,
    timeout?: number,
  ): Promise<ExecutionResult> {
    // Ensure tool session is set up
    await this.ensureToolSession(threadId);

    // Execute the code
    return this.sessionManager.execute(threadId, code, timeout);
  }

  /**
   * Ensure tool session is ready (IPC bridge running, APIs generated)
   */
  private async ensureToolSession(threadId: string): Promise<void> {
    if (this.toolSessions.has(threadId)) {
      const session = this.toolSessions.get(threadId)!;

      // Ensure bridge is running
      if (!session.bridge.isRunning()) {
        await session.bridge.start();
      }

      return;
    }

    // Get the basic session (creates workspace directory)
    const basicSession = this.sessionManager.getSession(threadId);
    const workspaceDir = basicSession.getWorkspaceDir();

    // Create IPC socket path
    const socketPath = generateSocketPath(workspaceDir, "tools");

    // Create IPC bridge
    const bridge = new IPCBridge({
      socketPath,
      toolRegistry: new SimpleToolRegistry(this.tools),
      onLog: this.onLog,
    });

    // Start the bridge
    await bridge.start();

    // Generate tool APIs
    const toolsApiDir = join(workspaceDir, "tools-api");
    await generateToolAPIs({
      tools: this.tools,
      outputDir: toolsApiDir,
      ipcSocketPath: socketPath,
    });

    this.onLog(
      "info",
      `Tool APIs generated for thread ${threadId} with ${this.tools.length} tools`,
    );

    // Store the tool session
    this.toolSessions.set(threadId, {
      bridge,
      apisGenerated: true,
    });
  }

  /**
   * Get the tools API directory for a session
   */
  getToolsApiDir(threadId: string): string {
    const session = this.sessionManager.getSession(threadId);
    return join(session.getWorkspaceDir(), "tools-api");
  }

  /**
   * Get the workspace directory for a session
   */
  getWorkspaceDir(threadId: string): string {
    return this.sessionManager.getSession(threadId).getWorkspaceDir();
  }

  /**
   * Clean up a specific session or all sessions
   */
  async cleanup(threadId?: string): Promise<void> {
    if (threadId) {
      // Clean up specific session
      const toolSession = this.toolSessions.get(threadId);
      if (toolSession) {
        await toolSession.bridge.stop();
        this.toolSessions.delete(threadId);
      }
      await this.sessionManager.cleanup(threadId);
    } else {
      // Clean up all sessions
      for (const [id, session] of this.toolSessions) {
        await session.bridge.stop();
        this.toolSessions.delete(id);
      }
      await this.sessionManager.cleanup();
    }
  }

  /**
   * Get the underlying session manager
   */
  getSessionManager(): CodeExecutionSessionManager {
    return this.sessionManager;
  }

  /**
   * Get count of active tool sessions
   */
  getToolSessionCount(): number {
    return this.toolSessions.size;
  }

  /**
   * Check if a thread has an active tool session
   */
  hasToolSession(threadId: string): boolean {
    return this.toolSessions.has(threadId);
  }
}

/**
 * Create a tool-enabled executor
 *
 * @param projectRoot Project root directory
 * @param tools Tools available for execution
 * @param options Additional options
 */
export function createToolEnabledExecutor(
  projectRoot: string,
  tools: StructuredToolInterface[],
  options?: Partial<Omit<ToolEnabledExecutorOptions, "projectRoot" | "tools">>,
): ToolEnabledExecutor {
  return new ToolEnabledExecutor({
    projectRoot,
    tools,
    ...options,
  });
}

/**
 * Execute code with tool API access (one-shot execution)
 *
 * Creates a temporary executor, runs the code, and cleans up.
 * Use ToolEnabledExecutor directly for repeated executions.
 */
export async function executeWithTools(
  projectRoot: string,
  threadId: string,
  code: string,
  tools: StructuredToolInterface[],
  options?: { timeout?: number },
): Promise<ExecutionResult> {
  const executor = new ToolEnabledExecutor({ projectRoot, tools });

  try {
    return await executor.execute(threadId, code, options?.timeout);
  } finally {
    await executor.cleanup(threadId);
  }
}
