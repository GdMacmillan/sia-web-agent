/**
 * Middleware for providing code execution capabilities to an agent.
 *
 * Enables agents to write TypeScript code that interacts with tools programmatically,
 * following the code execution pattern documented by Anthropic and Cloudflare.
 *
 * Benefits:
 * - Context efficiency: Process data in execution environment, not through model context
 * - Progressive tool discovery: Load only needed tool definitions on-demand
 * - Codebase knowledge: Agent "remembers" structure through indexed tool APIs
 * - MCP integration: Add any MCP tools without context bloat
 */

import { createMiddleware, tool, type AgentMiddleware } from "langchain";
import { z } from "zod/v3";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  ToolEnabledExecutor,
  validateCode,
  formatCodePreview,
} from "../code-execution/index.js";

/** Default timeout for code execution (60 seconds) */
const DEFAULT_TIMEOUT_MS = 60000;

/** Maximum timeout for code execution (5 minutes) */
const MAX_TIMEOUT_MS = 300000;

// System prompt removed - skill provides guidance via skills middleware

/**
 * Options for creating code execution middleware
 */
export interface CodeExecutionMiddlewareOptions {
  /** Project root directory */
  projectRoot: string;
  /** Tools to expose via code execution API */
  tools: StructuredToolInterface[];
  /** Maximum execution time in ms (default: 120000) */
  maxExecutionTime?: number;
  /** Allowed tool patterns (regex) - if provided, only matching tools are exposed */
  allowedToolPatterns?: RegExp[];
  /** Callback for logging (optional) */
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

/**
 * Create code execution middleware with tool API support.
 *
 * This middleware:
 * - Provides the `execute_code` tool for TypeScript execution
 * - Generates typed tool APIs from available tools
 * - Injects system prompt explaining code execution patterns
 * - Manages thread-isolated execution sessions with IPC bridges
 *
 * @param options Configuration options
 * @returns AgentMiddleware instance
 */
export function createCodeExecutionMiddleware(
  options: CodeExecutionMiddlewareOptions,
): AgentMiddleware {
  const {
    projectRoot,
    tools,
    maxExecutionTime = 120000,
    allowedToolPatterns,
    onLog,
  } = options;

  // Filter tools if patterns provided
  const exposedTools = allowedToolPatterns
    ? tools.filter((tool) =>
        allowedToolPatterns.some((pattern) => pattern.test(tool.name)),
      )
    : tools;

  // Create tool-enabled executor
  // This is created once and manages sessions per thread
  let executor: ToolEnabledExecutor | null = null;

  // Create the execute_code tool
  const executeCodeTool = tool(
    async (input, config: any) => {
      try {
        // Lazy initialization of executor
        if (!executor) {
          executor = new ToolEnabledExecutor({
            projectRoot,
            tools: exposedTools,
            onLog,
          });
        }

        const { code, description: _description, timeout } = input;

        // Validate code before execution
        const validationError = validateCode(code);
        if (validationError) {
          return `Invalid code: ${validationError}\n\nCode preview:\n${formatCodePreview(code)}`;
        }

        // Validate and cap timeout
        const effectiveTimeout = Math.min(
          Math.max(timeout || DEFAULT_TIMEOUT_MS, 1000),
          Math.min(maxExecutionTime, MAX_TIMEOUT_MS),
        );

        // Get thread ID from config for session isolation
        const threadId = config?.configurable?.thread_id || "default";

        // Execute code with tool access
        const result = await executor.execute(threadId, code, effectiveTimeout);

        // Format result
        if (result.exitCode !== 0) {
          return `Execution failed (exit code ${result.exitCode}):\n${result.output}`;
        }

        return result.output;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error executing code: ${message}`;
      }
    },
    {
      name: "execute_code",
      description:
        "Execute TypeScript/JavaScript code (NOT Python). Code runs from project root so relative paths like './file.csv' work. Use Node.js fs module or import tools from './tools-api/'.",
      schema: z.object({
        code: z
          .string()
          .describe(
            "TypeScript/JavaScript code to execute (NOT Python). Use Node.js syntax.",
          ),
        description: z
          .string()
          .optional()
          .describe(
            "Brief description of what this code does (for observability)",
          ),
        timeout: z
          .number()
          .optional()
          .default(DEFAULT_TIMEOUT_MS)
          .describe(
            `Optional timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}ms, max: ${MAX_TIMEOUT_MS}ms)`,
          ),
      }),
    },
  );

  return createMiddleware({
    name: "CodeExecutionMiddleware",
    tools: [executeCodeTool],
    // System prompt guidance provided by skills middleware (skills/global/code-execution/SKILL.md)
  });
}

/**
 * Create a standalone execute_code tool without middleware
 *
 * Useful for adding code execution to existing tool sets without
 * the full middleware wrapper.
 *
 * @param projectRoot Project root directory
 * @param tools Tools to expose via code execution API
 * @param options Additional options
 */
export function createCodeExecutionTool(
  projectRoot: string,
  tools: StructuredToolInterface[],
  options?: {
    maxExecutionTime?: number;
    onLog?: (
      level: "debug" | "info" | "warn" | "error",
      message: string,
    ) => void;
  },
) {
  let executor: ToolEnabledExecutor | null = null;
  const { maxExecutionTime = 120000, onLog } = options || {};

  return tool(
    async (input, config: any) => {
      try {
        if (!executor) {
          executor = new ToolEnabledExecutor({
            projectRoot,
            tools,
            onLog,
          });
        }

        const { code, description: _description, timeout } = input;

        const validationError = validateCode(code);
        if (validationError) {
          return `Invalid code: ${validationError}\n\nCode preview:\n${formatCodePreview(code)}`;
        }

        const effectiveTimeout = Math.min(
          Math.max(timeout || DEFAULT_TIMEOUT_MS, 1000),
          Math.min(maxExecutionTime, MAX_TIMEOUT_MS),
        );

        const threadId = config?.configurable?.thread_id || "default";
        const result = await executor.execute(threadId, code, effectiveTimeout);

        if (result.exitCode !== 0) {
          return `Execution failed (exit code ${result.exitCode}):\n${result.output}`;
        }

        return result.output;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error executing code: ${message}`;
      }
    },
    {
      name: "execute_code",
      description: `Execute TypeScript code with tool API access for efficient data processing.`,
      schema: z.object({
        code: z.string().describe("TypeScript code to execute"),
        description: z
          .string()
          .optional()
          .describe("Brief description of the code"),
        timeout: z.number().optional().default(DEFAULT_TIMEOUT_MS),
      }),
    },
  );
}
