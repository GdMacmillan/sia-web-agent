/**
 * Code Execution Module
 *
 * Provides TypeScript code execution with thread isolation and optional tool API access.
 *
 * Basic Usage:
 * ```typescript * import { CodeExecutor } from "./code-execution"; * * const executor = new
CodeExecutor("/path/to/project"); * const result = await executor.execute( * 'console.log("Hello,
world!")', * { threadId: "thread-123" } * ); * console.log(result.result); // "Hello, world!" *```
 *
 * With Tool APIs:
 * ```typescript * import { ToolEnabledExecutor } from "./code-execution"; * import { myTools } from
"./tools"; * * const executor = new ToolEnabledExecutor({ * projectRoot: "/path/to/project", *
tools: myTools, * }); * * // Code can import and use tool APIs * const code =`
 *   import { readFile } from './tools-api/filesystem';
 *   const content = await readFile({ file_path: 'package.json' });
 *   console.log(content);
 * `; * * const result = await executor.execute("thread-123", code); *```
 */

// Session management
export {
  CodeExecutionSession,
  CodeExecutionSessionManager,
  clipOutput,
  type ExecutionResult,
} from "./session-manager.js";

// High-level executor (basic)
export {
  CodeExecutor,
  validateCode,
  formatCodePreview,
  type FormattedExecutionResult,
  type ExecuteOptions,
} from "./executor.js";

// Tool-enabled executor
export {
  ToolEnabledExecutor,
  createToolEnabledExecutor,
  executeWithTools,
  type ToolEnabledExecutorOptions,
} from "./tool-enabled-executor.js";

// IPC Bridge
export {
  IPCBridge,
  SimpleToolRegistry,
  createIPCBridge,
  generateSocketPath,
  type IPCRequest,
  type IPCResponse,
  type IPCError,
  type ToolRegistry,
  type IPCBridgeOptions,
  IPCErrorCodes,
} from "./ipc-bridge.js";

// Tool API Generator
export {
  generateToolAPIs,
  registerToolCategory,
  toFunctionName,
  toInterfaceName,
  zodToTypeScript,
  getToolCategory,
  type GenerateToolAPIsOptions,
} from "./tool-api-generator.js";
