/**
 * execute-code — the `execute_code` tool as a component.
 *
 * Builds the middleware that lets the agent run TypeScript it has written:
 * each call runs in a fresh process inside a per-conversation workspace,
 * with a generated, typed API over the agent's other tools, and returns
 * the combined output as text.
 *
 * This file imports nothing at runtime. Everything it needs arrives on
 * `deps` (see `docs/COMPONENTS.md` §5); the type-only import below is
 * erased before execution and exists for editors and the type checker.
 */

import type { ComponentDeps } from "../../../../src/components/sdk.js";

/** Upper bound on any single execution, whatever timeout the call asks for. */
const MAX_EXECUTION_TIME_MS = 120000;

/** Shortest timeout a call may ask for. */
const MIN_TIMEOUT_MS = 1000;

/** Fallback thread when the run carries no `thread_id`. */
const DEFAULT_THREAD_ID = "default";

export default function (deps: ComponentDeps) {
  const {
    ToolEnabledExecutor,
    validateCode,
    formatCodePreview,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    getExposableTools,
  } = deps.internals.codeExecution;
  const { z, tool, createMiddleware, logger, config } = deps;

  // One executor per middleware instance, created on first use so the tool
  // pool it exposes is the one recorded after assembly. Sessions inside it
  // are keyed by thread id.
  let executor: InstanceType<typeof ToolEnabledExecutor> | null = null;
  const getExecutor = () => {
    if (executor === null) {
      executor = new ToolEnabledExecutor({
        projectRoot: config.projectRoot,
        tools: getExposableTools(),
        onLog: (level, message) => logger[level](message),
      });
    }
    return executor;
  };

  const executeCodeTool = tool(
    async (input, runConfig: any) => {
      try {
        const { code, timeout } = input;

        const validationError = validateCode(code);
        if (validationError) {
          return `Invalid code: ${validationError}\n\nCode preview:\n${formatCodePreview(code)}`;
        }

        // Apply the default here, not in the schema: a defaulted schema
        // field is advertised to the model as required.
        const effectiveTimeout = Math.min(
          Math.max(timeout || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
          Math.min(MAX_EXECUTION_TIME_MS, MAX_TIMEOUT_MS),
        );

        const threadId: string =
          runConfig?.configurable?.thread_id || DEFAULT_THREAD_ID;

        const result = await getExecutor().execute(
          threadId,
          code,
          effectiveTimeout,
        );

        if (result.timedOut) {
          return `Execution timed out after ${effectiveTimeout} ms:\n${result.output}`;
        }
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
          .describe(
            `Optional timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}ms, max: ${MAX_TIMEOUT_MS}ms)`,
          ),
      }),
    },
  );

  const middleware = createMiddleware({
    name: "CodeExecutionMiddleware",
    tools: [executeCodeTool],
  });

  // Not part of the middleware surface: lets the contract remove the
  // workspaces it created. Without a thread id every session goes.
  Object.defineProperty(middleware, "dispose", {
    value: async (threadId?: string): Promise<void> => {
      if (executor !== null) {
        await executor.cleanup(threadId);
      }
    },
    enumerable: false,
    configurable: true,
    writable: false,
  });

  return middleware;
}
