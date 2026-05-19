/**
 * IPC Bridge
 *
 * Provides IPC (Inter-Process Communication) between the code execution
 * subprocess and the parent process for tool calls.
 *
 * Protocol: JSON-RPC 2.0 over Unix domain socket
 * - Request: { id, method: "tool_call", params: { tool_name, input } }
 * - Response: { id, result } or { id, error: { code, message, data? } }
 */

import { createServer, type Server, type Socket } from "net";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * IPC Request structure (JSON-RPC 2.0 inspired)
 */
export interface IPCRequest {
  id: string;
  method: "tool_call";
  params: {
    tool_name: string;
    input: any;
  };
}

/**
 * IPC Response structure
 */
export interface IPCResponse {
  id: string;
  result?: any;
  error?: IPCError;
}

/**
 * IPC Error structure
 */
export interface IPCError {
  code: number;
  message: string;
  data?: any;
}

/**
 * Error codes for IPC communication
 */
export const IPCErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TOOL_NOT_FOUND: -32000,
  TOOL_EXECUTION_ERROR: -32001,
} as const;

/**
 * Tool registry for IPC bridge
 */
export interface ToolRegistry {
  /** Get a tool by name */
  getTool(name: string): StructuredToolInterface | undefined;
  /** List all tool names */
  listTools(): string[];
}

/**
 * Simple in-memory tool registry
 */
export class SimpleToolRegistry implements ToolRegistry {
  private tools = new Map<string, StructuredToolInterface>();

  constructor(tools: StructuredToolInterface[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  getTool(name: string): StructuredToolInterface | undefined {
    return this.tools.get(name);
  }

  listTools(): string[] {
    return Array.from(this.tools.keys());
  }
}

/**
 * Options for creating an IPC bridge
 */
export interface IPCBridgeOptions {
  /** Path to the Unix domain socket */
  socketPath: string;
  /** Tool registry for handling tool calls */
  toolRegistry: ToolRegistry;
  /** Callback for logging (optional) */
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

/**
 * IPC Bridge Server
 *
 * Creates a Unix domain socket server that handles tool call requests
 * from code execution subprocesses.
 */
export class IPCBridge {
  private server: Server | null = null;
  private socketPath: string;
  private toolRegistry: ToolRegistry;
  private connections = new Set<Socket>();
  private isShuttingDown = false;
  private onLog: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => void;

  constructor(options: IPCBridgeOptions) {
    this.socketPath = options.socketPath;
    this.toolRegistry = options.toolRegistry;
    this.onLog = options.onLog || (() => {});
  }

  /**
   * Start the IPC server
   */
  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    // Ensure socket directory exists
    const socketDir = dirname(this.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true });
    }

    // Remove existing socket file if present
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", (err) => {
        this.onLog("error", `IPC server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        this.onLog("info", `IPC bridge listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  /**
   * Handle a new client connection
   */
  private handleConnection(socket: Socket): void {
    this.connections.add(socket);
    this.onLog("debug", "IPC client connected");

    let messageBuffer = "";

    socket.on("data", (data) => {
      messageBuffer += data.toString();

      // Process complete messages (newline-delimited JSON)
      const lines = messageBuffer.split("\n");
      messageBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        // Handle async processing without blocking the event loop
        void (async () => {
          try {
            const request = JSON.parse(line) as IPCRequest;
            const response = await this.handleRequest(request);
            socket.write(JSON.stringify(response) + "\n");
          } catch (error) {
            const parseError: IPCResponse = {
              id: "unknown",
              error: {
                code: IPCErrorCodes.PARSE_ERROR,
                message: `Failed to parse request: ${error instanceof Error ? error.message : String(error)}`,
              },
            };
            socket.write(JSON.stringify(parseError) + "\n");
          }
        })();
      }
    });

    socket.on("close", () => {
      this.connections.delete(socket);
      this.onLog("debug", "IPC client disconnected");
    });

    socket.on("error", (err) => {
      this.onLog("warn", `IPC socket error: ${err.message}`);
      this.connections.delete(socket);
    });
  }

  /**
   * Handle an IPC request
   */
  private async handleRequest(request: IPCRequest): Promise<IPCResponse> {
    const { id, method, params } = request;

    // Validate request structure
    if (!id || typeof id !== "string") {
      return {
        id: id || "unknown",
        error: {
          code: IPCErrorCodes.INVALID_REQUEST,
          message: "Missing or invalid request id",
        },
      };
    }

    if (method !== "tool_call") {
      return {
        id,
        error: {
          code: IPCErrorCodes.METHOD_NOT_FOUND,
          message: `Unknown method: ${method}`,
        },
      };
    }

    if (!params || !params.tool_name) {
      return {
        id,
        error: {
          code: IPCErrorCodes.INVALID_PARAMS,
          message: "Missing tool_name in params",
        },
      };
    }

    const { tool_name, input } = params;

    // Find the tool
    const tool = this.toolRegistry.getTool(tool_name);
    if (!tool) {
      return {
        id,
        error: {
          code: IPCErrorCodes.TOOL_NOT_FOUND,
          message: `Tool not found: ${tool_name}. Available tools: ${this.toolRegistry.listTools().join(", ")}`,
        },
      };
    }

    // Execute the tool
    try {
      this.onLog("debug", `Executing tool: ${tool_name}`);
      const result = await tool.invoke(input);
      this.onLog("debug", `Tool ${tool_name} completed successfully`);

      return {
        id,
        result,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.onLog("warn", `Tool ${tool_name} failed: ${errorMessage}`);

      return {
        id,
        error: {
          code: IPCErrorCodes.TOOL_EXECUTION_ERROR,
          message: errorMessage,
          data:
            error instanceof Error
              ? {
                  name: error.name,
                  stack: error.stack,
                }
              : undefined,
        },
      };
    }
  }

  /**
   * Stop the IPC server
   */
  async stop(): Promise<void> {
    if (!this.server || this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    this.onLog("info", "Stopping IPC bridge...");

    // Close all connections
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        this.isShuttingDown = false;

        // Clean up socket file
        if (existsSync(this.socketPath)) {
          try {
            unlinkSync(this.socketPath);
          } catch {
            // Ignore cleanup errors
          }
        }

        this.onLog("info", "IPC bridge stopped");
        resolve();
      });
    });
  }

  /**
   * Get the socket path
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Check if the server is running
   */
  isRunning(): boolean {
    return this.server !== null && !this.isShuttingDown;
  }
}

/**
 * Generate a unique socket path for a session
 *
 * Note: Unix domain sockets have a path length limit (~104 chars on macOS).
 * We use a short hash to keep paths within limits.
 */
export function generateSocketPath(baseDir: string, threadId: string): string {
  // Sanitize thread ID for use in filename
  const sanitizedId = threadId.replace(/[^a-zA-Z0-9-_]/g, "_");

  // Create a short hash from the base dir to keep path short
  let hash = 0;
  for (let i = 0; i < baseDir.length; i++) {
    hash = (hash << 5) - hash + baseDir.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  const shortHash = Math.abs(hash).toString(36).slice(0, 6);

  // Use /tmp for sockets to avoid long path issues
  const tmpDir = join("/tmp", `code-exec-${shortHash}`);
  return join(tmpDir, `${sanitizedId}.sock`);
}

/**
 * Create an IPC bridge for a set of tools
 */
export function createIPCBridge(
  socketPath: string,
  tools: StructuredToolInterface[],
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void,
): IPCBridge {
  return new IPCBridge({
    socketPath,
    toolRegistry: new SimpleToolRegistry(tools),
    onLog,
  });
}
