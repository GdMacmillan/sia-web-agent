/**
 * ReAct Agent Factory for Tool Integration Testing
 *
 * Creates a minimal ReAct agent using LangGraph's prebuilt create_react_agent
 * for testing tool execution with real LLM calls.
 */

import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { resolveProviderConfig } from "../../../src/config/llm-providers.js";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { createAgentWatcher } from "./watch-mode.js";
import { isVerboseMode } from "./test-observability.js";

const execAsync = promisify(exec);

// Global test context for observability
let currentTestWatcher: ReturnType<typeof createAgentWatcher> | null = null;

/**
 * Initialize test context for observability
 */
export function initTestContext(testName: string): void {
  console.log("[DEBUG] initTestContext called for:", testName);
  currentTestWatcher = createAgentWatcher("TestAgent", 0);
  console.log("[DEBUG] Watcher created:", !!currentTestWatcher);
}

/**
 * Reset test context
 */
export function resetTestContext(): void {
  currentTestWatcher = null;
}

/**
 * Resolve a file path safely within a workspace root, preventing path traversal.
 * Throws if the resolved path escapes the workspace boundary.
 */
function resolveSafePath(workspaceRoot: string, filePath: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolvedRoot = path.resolve(workspaceRoot);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath) // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    : path.resolve(resolvedRoot, filePath); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal

  if (
    !absolutePath.startsWith(resolvedRoot + path.sep) &&
    absolutePath !== resolvedRoot
  ) {
    throw new Error(
      `Path traversal blocked: ${filePath} resolves outside workspace ${resolvedRoot}`,
    );
  }

  return absolutePath;
}

/**
 * Create a bash execution tool for testing
 */
export function createBashTool(workspaceRoot: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "execute_bash",
    description: `Executes bash commands for file operations. Working directory: ${workspaceRoot}`,
    schema: z.object({
      command: z.string().describe("The bash command to execute"),
      description: z
        .string()
        .optional()
        .describe("Description of what this command does"),
    }),
    func: async ({ command }: { command: string; description?: string }) => {
      const startTime =
        currentTestWatcher?.streamToolCall(
          "execute_bash",
          { command },
          Date.now(),
        ) || Date.now();

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workspaceRoot,
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        });
        const result = stdout || stderr || "Success";

        currentTestWatcher?.streamToolResult(
          "execute_bash",
          result.slice(0, 200),
          startTime,
        );

        return result;
      } catch (error: any) {
        const errorMsg = `Error: ${error.stdout || error.stderr || error.message}`;
        currentTestWatcher?.streamError(errorMsg, "execute_bash");
        return errorMsg;
      }
    },
  });
}

/**
 * Create a grep/search tool for testing
 */
export function createGrepTool(workspaceRoot: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "search",
    description: `Search for patterns in files using ripgrep. Working directory: ${workspaceRoot}`,
    schema: z.object({
      pattern: z.string().describe("The pattern to search for"),
      filePattern: z
        .string()
        .optional()
        .describe("Glob pattern to filter files (e.g., '**/*.ts')"),
      caseSensitive: z
        .boolean()
        .optional()
        .describe("Case sensitive search (default: false)"),
      contextLines: z
        .number()
        .optional()
        .describe("Number of context lines around matches"),
    }),
    func: async ({
      pattern,
      filePattern,
      caseSensitive,
      contextLines,
    }: {
      pattern: string;
      filePattern?: string;
      caseSensitive?: boolean;
      contextLines?: number;
    }) => {
      const startTime =
        currentTestWatcher?.streamToolCall(
          "search",
          { pattern, filePattern, caseSensitive },
          Date.now(),
        ) || Date.now();

      try {
        const args = [
          pattern,
          "--line-number",
          "--with-filename",
          "--color=never",
          "--max-count=20",
        ];

        if (!caseSensitive) {
          args.push("--ignore-case");
        }

        if (contextLines && contextLines > 0) {
          args.push(`-C${contextLines}`);
        }

        if (filePattern) {
          args.push("--glob", filePattern);
        }

        args.push("--glob", "!node_modules/**");
        args.push(".");

        const command = `rg ${args.map((a) => (a.includes(" ") || a.includes("*") ? `"${a}"` : a)).join(" ")}`;

        const { stdout } = await execAsync(command, {
          cwd: workspaceRoot,
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        });

        const result = stdout || "No matches found";
        currentTestWatcher?.streamToolResult(
          "search",
          result.slice(0, 200),
          startTime,
        );

        return result;
      } catch (error: any) {
        // Exit code 1 means no matches (normal for rg)
        if (error.code === 1) {
          const result = "No matches found";
          currentTestWatcher?.streamToolResult("search", result, startTime);
          return result;
        }
        const errorMsg = `Error: ${error.stderr || error.message}`;
        currentTestWatcher?.streamError(errorMsg, "search");
        return errorMsg;
      }
    },
  });
}

/**
 * Create a ReAct agent for tool testing
 */
export async function createToolTestAgent(
  tools: DynamicStructuredTool[],
  _workspaceRoot: string,
) {
  const providerConfig = resolveProviderConfig();
  const modelName = providerConfig.model || "openai/gpt-4o-mini";

  // Create callbacks for observability
  const callbacks: any[] = [];

  // Add LLM monitoring callback
  // Note: Check if features are ENABLED (not if watcher exists yet)
  // Agent is created in beforeAll, watcher is created in beforeEach
  if (isVerboseMode() || process.env.WATCH_AGENTS === "true") {
    callbacks.push({
      handleLLMStart: async (_llm: any, prompts: string[]) => {
        console.log(
          "[DEBUG] handleLLMStart called, watcher exists:",
          !!currentTestWatcher,
        );
        // prompts is string[] but streamLLMCall expects string | BaseMessage[]
        // Convert to string for display
        const promptStr =
          prompts.length === 1 ? prompts[0] : `${prompts.length} prompts`;
        currentTestWatcher?.streamLLMCall(promptStr, modelName, 0.2);
      },
      handleLLMEnd: async (output: any) => {
        const response = output.generations[0][0].text;
        currentTestWatcher?.streamLLMResponse(response);
      },
      handleLLMError: async (error: Error) => {
        currentTestWatcher?.streamError(error, "LLM call");
      },
    });
  }

  const model = new ChatOpenAI({
    model: modelName,
    apiKey: providerConfig.apiKey,
    temperature: 0.2,
    maxTokens: 2000,
    configuration: {
      baseURL: providerConfig.baseUrl,
      defaultHeaders: {
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Self-Improving Agent - Tool Integration Tests",
      },
    },
    callbacks: callbacks.length > 0 ? callbacks : undefined,
  });

  // Use the actual programmer agent system prompt
  const { getSystemPrompt } = await import("../../../system-prompts.js");
  const programmerPrompt = await getSystemPrompt("programmer");

  return createReactAgent({
    llm: model,
    tools: tools,
    messageModifier: programmerPrompt,
  });
}

/**
 * Extract tool calls from agent result
 */
export function extractToolCalls(
  result: any,
): Array<{ name: string; args: any }> {
  const toolCalls: Array<{ name: string; args: any }> = [];

  if (!result.messages) {
    return toolCalls;
  }

  for (const message of result.messages) {
    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        toolCalls.push({
          name: tc.name,
          args: tc.args,
        });
      }
    }
  }

  return toolCalls;
}

/**
 * Find specific tool call by name
 */
export function findToolCall(
  result: any,
  toolName: string,
): { name: string; args: any } | null {
  const toolCalls = extractToolCalls(result);
  return toolCalls.find((tc) => tc.name === toolName) || null;
}

/**
 * Check if tool was called
 */
export function wasToolCalled(result: any, toolName: string): boolean {
  return findToolCall(result, toolName) !== null;
}

/**
 * Create file_read tool for testing
 */
export function createFileReadTool(
  workspaceRoot: string,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "file_read",
    description: `Read file contents. Working directory: ${workspaceRoot}`,
    schema: z.object({
      filePath: z.string().describe("Path to file to read"),
    }),
    func: async ({ filePath }) => {
      try {
        const absolutePath = resolveSafePath(workspaceRoot, filePath);
        const content = await fs.readFile(absolutePath, "utf-8");
        return content;
      } catch (error: any) {
        if (error.code === "ENOENT") {
          return `Error: File not found: ${filePath}`;
        }
        return `Error reading file: ${error.message}`;
      }
    },
  });
}

/**
 * Create file_create tool for testing
 */
export function createFileCreateTool(
  workspaceRoot: string,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "file_create",
    description: `Create new file with content. Fails if file exists. Working directory: ${workspaceRoot}`,
    schema: z.object({
      filePath: z.string().describe("Path where file should be created"),
      content: z.string().describe("Content to write to the file"),
    }),
    func: async ({ filePath, content }) => {
      try {
        const absolutePath = resolveSafePath(workspaceRoot, filePath);

        const dir = path.dirname(absolutePath);
        await fs.mkdir(dir, { recursive: true });

        await fs.writeFile(absolutePath, content, {
          encoding: "utf-8",
          flag: "wx",
        });
        return `Success: Created file at ${absolutePath}`;
      } catch (error: any) {
        if (error.code === "EEXIST") {
          return `Error: File already exists: ${filePath}`;
        }
        return `Error creating file: ${error.message}`;
      }
    },
  });
}

/**
 * Create file_edit tool for testing
 */
export function createFileEditTool(
  workspaceRoot: string,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "file_edit",
    description: `Edit existing file with exact snippet replacement. Working directory: ${workspaceRoot}`,
    schema: z.object({
      filePath: z.string().describe("Path to file to edit"),
      originalSnippet: z.string().describe("Exact text to find and replace"),
      replacedSnippet: z.string().describe("New text to replace with"),
    }),
    func: async ({ filePath, originalSnippet, replacedSnippet }) => {
      try {
        const absolutePath = resolveSafePath(workspaceRoot, filePath);

        // Read current content
        const content = await fs.readFile(absolutePath, "utf-8");

        // Verify snippet exists
        if (!content.includes(originalSnippet)) {
          return `Error: Original snippet not found in ${filePath}`;
        }

        // Check for multiple occurrences
        const occurrences = content.split(originalSnippet).length - 1;
        if (occurrences > 1) {
          return `Error: Found ${occurrences} occurrences of snippet in ${filePath}`;
        }

        // Replace (only first occurrence)
        const newContent = content.replace(originalSnippet, replacedSnippet);

        // Write new content
        await fs.writeFile(absolutePath, newContent, "utf-8");

        return `Success: Edited ${filePath}`;
      } catch (error: any) {
        if (error.code === "ENOENT") {
          return `Error: File not found: ${filePath}`;
        }
        return `Error editing file: ${error.message}`;
      }
    },
  });
}

/**
 * Create file_delete tool for testing
 */
export function createFileDeleteTool(
  workspaceRoot: string,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "file_delete",
    description: `Delete file. Working directory: ${workspaceRoot}`,
    schema: z.object({
      filePath: z.string().describe("Path to file to delete"),
    }),
    func: async ({ filePath }) => {
      try {
        const absolutePath = resolveSafePath(workspaceRoot, filePath);
        await fs.unlink(absolutePath);
        return `Success: Deleted file at ${absolutePath}`;
      } catch (error: any) {
        if (error.code === "ENOENT") {
          return `Error: File not found: ${filePath}`;
        }
        return `Error deleting file: ${error.message}`;
      }
    },
  });
}
