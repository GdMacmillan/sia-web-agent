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
 *
 * The `execute_code` wrapper itself is the seed component
 * `components/execute-code` (`docs/COMPONENTS.md`). This module is the
 * bundled registration: it evaluates the component's in-tree twin
 * (`src/components/seed/execute-code/entry.ts`, kept byte-identical by
 * `yarn sync:seed` and the seed-parity test) with an in-tree dependency
 * bundle. With the seed root present the loader's instance replaces this
 * one by name; when the seed is absent or fails to load, this one runs,
 * so a broken component can never remove the tool.
 */

import { tool, type AgentMiddleware } from "langchain";
import { z } from "zod/v3";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  ToolEnabledExecutor,
  validateCode,
  formatCodePreview,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "../code-execution/index.js";
import { getConfig } from "../config/index.js";
import { buildComponentDeps, buildInternals } from "../components/sdk.js";
import type { ComponentManifest } from "../components/manifest.js";
import seedEntry from "../components/seed/execute-code/entry.js";

export { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };

/** The seed version the in-tree twin mirrors (`components/execute-code/current`). */
export const SEED_EXECUTE_CODE_VERSION = "0.1.0";

/** The name the bundled middleware registers under; the component's `replaces` target. */
export const CODE_EXECUTION_MIDDLEWARE_NAME = "CodeExecutionMiddleware";

/**
 * Options for creating code execution middleware
 */
export interface CodeExecutionMiddlewareOptions {
  /** Project root directory */
  projectRoot: string;
  /** Tools to expose via code execution API */
  tools: StructuredToolInterface[];
  /** Allowed tool patterns (regex) - if provided, only matching tools are exposed */
  allowedToolPatterns?: RegExp[];
}

/** The manifest the in-tree twin is evaluated with: the seed's, minus the file. */
const SEED_MANIFEST: ComponentManifest = {
  name: "execute-code",
  version: SEED_EXECUTE_CODE_VERSION,
  kind: "middleware",
  intent:
    "Run the TypeScript the agent writes, one fresh process per call in a per-conversation workspace with typed access to the agent's other tools, and hand back stdout, stderr and the exit status as text.",
  sdk: "^1.0.0",
  entry: "entry.ts",
  contract: "contract.ts",
  replaces: CODE_EXECUTION_MIDDLEWARE_NAME,
  depth: 0,
  lineage: { producedBy: "seed" },
};

/**
 * Create code execution middleware with tool API support.
 *
 * This middleware:
 * - Provides the `execute_code` tool for TypeScript execution
 * - Generates typed tool APIs from available tools
 * - Manages thread-isolated execution sessions with IPC bridges
 *
 * Evaluates the seed component's in-tree twin with a dependency bundle whose
 * exposable tools are the `tools` given here (filtered by
 * `allowedToolPatterns`) rather than the assembled pool.
 *
 * @param options Configuration options
 * @returns AgentMiddleware instance
 */
export function createCodeExecutionMiddleware(
  options: CodeExecutionMiddlewareOptions,
): AgentMiddleware {
  const { projectRoot, tools, allowedToolPatterns } = options;

  // Filter tools if patterns provided
  const exposedTools = allowedToolPatterns
    ? tools.filter((tool) =>
        allowedToolPatterns.some((pattern) => pattern.test(tool.name)),
      )
    : tools;

  const runtime = getConfig().runtime;
  const internals = buildInternals();
  const deps = buildComponentDeps({
    manifest: SEED_MANIFEST,
    // The version directory the twin mirrors; the entry never reads it.
    componentDir: `${projectRoot}/components/execute-code/.versions/${SEED_EXECUTE_CODE_VERSION}`,
    config: {
      agentId: runtime.agentId,
      agentName: runtime.agentName,
      projectRoot,
    },
    services: {},
    internals: {
      codeExecution: {
        ...internals.codeExecution,
        getExposableTools: () => exposedTools,
      },
    },
  });

  return seedEntry(deps) as AgentMiddleware;
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
