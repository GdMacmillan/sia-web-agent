/**
 * Middleware for providing filesystem tools to an agent.
 *
 * Provides ls, read_file, write_file, edit_file, glob, and grep tools with support for:
 * - Pluggable backends (StateBackend, StoreBackend, FilesystemBackend, CompositeBackend)
 * - Tool result eviction for large outputs
 */

import { createMiddleware, tool, ToolMessage } from "langchain";
import { Command, isCommand, getCurrentTaskInput } from "@langchain/langgraph";
import { z } from "zod/v3";
import { withLangGraph } from "@langchain/langgraph/zod";
import type {
  BackendProtocol,
  BackendFactory,
  FileData,
  StateAndStore,
} from "../backends/protocol.js";
import { StateBackend } from "../backends/state.js";
import {
  sanitizeToolCallId,
  formatContentWithLineNumbers,
} from "../backends/utils.js";

/**
 * Tools that should be excluded from the large result eviction logic.
 *
 * This array contains tools that should NOT have their results evicted to the filesystem
 * when they exceed token limits. Tools are excluded for different reasons:
 *
 * 1. Tools with built-in truncation (ls, glob, grep):
 *    These tools truncate their own output when it becomes too large. When these tools
 *    produce truncated output due to many matches, it typically indicates the query
 *    needs refinement rather than full result preservation. In such cases, the truncated
 *    matches are potentially more like noise and the LLM should be prompted to narrow
 *    its search criteria instead.
 *
 * 2. Tools with problematic truncation behavior (read_file):
 *    read_file is tricky to handle as the failure mode here is single long lines
 *    (e.g., imagine a jsonl file with very long payloads on each line). If we try to
 *    truncate the result of read_file, the agent may then attempt to re-read the
 *    truncated file using read_file again, which won't help.
 *
 * 3. Tools that never exceed limits (edit_file, write_file):
 *    These tools return minimal confirmation messages and are never expected to produce
 *    output large enough to exceed token limits, so checking them would be unnecessary.
 */
export const TOOLS_EXCLUDED_FROM_EVICTION = [
  "ls",
  "glob",
  "grep",
  "read_file",
  "edit_file",
  "write_file",
] as const;

/**
 * Approximate number of characters per token for truncation calculations.
 * Using 4 chars per token as a conservative approximation (actual ratio varies by content)
 * This errs on the high side to avoid premature eviction of content that might fit.
 */
export const NUM_CHARS_PER_TOKEN = 4;

/**
 * Create a preview of content showing head and tail with truncation marker.
 *
 * @param contentStr - The full content string to preview.
 * @param headLines - Number of lines to show from the start (default: 5).
 * @param tailLines - Number of lines to show from the end (default: 5).
 * @returns Formatted preview string with line numbers.
 */
export function createContentPreview(
  contentStr: string,
  headLines: number = 5,
  tailLines: number = 5,
): string {
  const lines = contentStr.split("\n");

  if (lines.length <= headLines + tailLines) {
    // If file is small enough, show all lines
    const previewLines = lines.map((line) => line.substring(0, 1000));
    return formatContentWithLineNumbers(previewLines, 1);
  }

  // Show head and tail with truncation marker
  const head = lines.slice(0, headLines).map((line) => line.substring(0, 1000));
  const tail = lines.slice(-tailLines).map((line) => line.substring(0, 1000));

  const headSample = formatContentWithLineNumbers(head, 1);
  const truncationNotice = `\n... [${lines.length - headLines - tailLines} lines truncated] ...\n`;
  const tailSample = formatContentWithLineNumbers(
    tail,
    lines.length - tailLines + 1,
  );

  return headSample + truncationNotice + tailSample;
}

/**
 * Message template for evicted tool results.
 */
const TOO_LARGE_TOOL_MSG = `Tool result too large, the result of this tool call {tool_call_id} was saved in the filesystem at
this path: {file_path} You can read the result from the filesystem by using the read_file tool, but
make sure to only read part of the result at a time. You can do this by specifying an offset and
limit in the read_file tool call. For example, to read the first 100 lines, you can use the
read_file tool with offset=0 and limit=100.

Here is a preview showing the head and tail of the result (lines of the form ... [N lines truncated]
... indicate omitted lines in the middle of the content):

{content_sample}`;

/**
 * Zod v4 schema for FileData (re-export from backends)
 */
const FileDataSchema = z.object({
  content: z.array(z.string()),
  created_at: z.string(),
  modified_at: z.string(),
});

export type { FileData };

/**
 * Merge file updates with support for deletions.
 */
function fileDataReducer(
  left: Record<string, FileData> | undefined,
  right: Record<string, FileData | null>,
): Record<string, FileData> {
  if (left === undefined) {
    const result: Record<string, FileData> = {};
    for (const [key, value] of Object.entries(right)) {
      if (value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  const result = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Shared filesystem state schema.
 * Defined at module level to ensure the same object identity is used across all agents,
 * preventing "Channel already exists with different type" errors when multiple agents
 * use createFilesystemMiddleware.
 */
const FilesystemStateSchema = z.object({
  files: withLangGraph(
    z.record(z.string(), FileDataSchema).default({}) as any,
    {
      reducer: {
        fn: fileDataReducer,
        schema: z.record(z.string(), FileDataSchema.nullable()),
      },
    },
  ) as any,
});

/**
 * Resolve backend from factory or instance.
 *
 * @param backend - Backend instance or factory function
 * @param stateAndStore - State and store container for backend initialization
 */
function getBackend(
  backend: BackendProtocol | BackendFactory,
  stateAndStore: StateAndStore,
): BackendProtocol {
  if (typeof backend === "function") {
    return backend(stateAndStore);
  }
  return backend;
}

// System prompts
const FILESYSTEM_SYSTEM_PROMPT = `You have access to the real filesystem and can make actual code changes. Use absolute paths like
/absolute/path/to/project/src/file.ts or relative paths like
src/file.ts from the project root.

- ls: list files in a directory
- read_file: read a file from the filesystem
- write_file: write to a new file in the filesystem
- edit_file: edit an existing file by replacing specific content
- glob: find files matching a pattern (e.g., "**/*.ts")
- grep: search for text within files using regex patterns

All changes are made to real files and persist to disk. The human developer controls what gets
committed to version control.`;

// Tool descriptions
export const LS_TOOL_DESCRIPTION = "List files and directories in a directory";
export const READ_FILE_TOOL_DESCRIPTION = "Read the contents of a file";
export const WRITE_FILE_TOOL_DESCRIPTION =
  "Write content to a new file. Returns an error if the file already exists";
export const EDIT_FILE_TOOL_DESCRIPTION =
  "Edit a file by replacing a specific string with a new string";
export const GLOB_TOOL_DESCRIPTION =
  "Find files matching a glob pattern (e.g., '**/*.py' for all Python files)";
export const GREP_TOOL_DESCRIPTION =
  "Search for a regex pattern in files. Returns matching files and line numbers";

/**
 * Create ls tool using backend.
 */
function createLsTool(
  backend: BackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
  },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      try {
        const stateAndStore: StateAndStore = {
          state: getCurrentTaskInput(config),
          store: (config as any).store,
        };
        const resolvedBackend = getBackend(backend, stateAndStore);
        const path = input.path || "";
        const infos = await resolvedBackend.lsInfo(path);

        if (infos.length === 0) {
          return `No files found in ${path}`;
        }

        // Format output
        const lines: string[] = [];
        for (const info of infos) {
          if (info.is_dir) {
            lines.push(`${info.path} (directory)`);
          } else {
            const size = info.size ? ` (${info.size} bytes)` : "";
            lines.push(`${info.path}${size}`);
          }
        }
        return lines.join("\n");
      } catch (error) {
        // Return errors as messages so the agent can recover
        const message = error instanceof Error ? error.message : String(error);
        return `Error: ${message}`;
      }
    },
    {
      name: "ls",
      description: customDescription || LS_TOOL_DESCRIPTION,
      schema: z.object({
        path: z.string().describe("Directory path to list"),
      }),
    },
  );
}

/**
 * Create read_file tool using backend.
 */
function createReadFileTool(
  backend: BackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
  },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      try {
        const stateAndStore: StateAndStore = {
          state: getCurrentTaskInput(config),
          store: (config as any).store,
        };
        const resolvedBackend = getBackend(backend, stateAndStore);
        const { file_path, offset = 0, limit = 2000 } = input;
        return await resolvedBackend.read(file_path, offset, limit);
      } catch (error) {
        // Return errors as messages so the agent can recover
        const message = error instanceof Error ? error.message : String(error);
        return `Error: ${message}`;
      }
    },
    {
      name: "read_file",
      description: customDescription || READ_FILE_TOOL_DESCRIPTION,
      schema: z.object({
        file_path: z.string().describe("Absolute path to the file to read"),
        offset: z
          .number({ coerce: true })
          .describe(
            "Line offset to start reading from (0-indexed, use 0 for beginning)",
          ),
        limit: z
          .number({ coerce: true })
          .describe("Maximum number of lines to read (use 2000 for default)"),
      }),
    },
  );
}

/**
 * Create write_file tool using backend.
 */
function createWriteFileTool(
  backend: BackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
  },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      try {
        const stateAndStore: StateAndStore = {
          state: getCurrentTaskInput(config),
          store: (config as any).store,
        };
        const resolvedBackend = getBackend(backend, stateAndStore);
        const { file_path, content } = input;
        const result = await resolvedBackend.write(file_path, content);

        if (result.error) {
          return result.error;
        }

        // If filesUpdate is present, return Command to update state
        const message = new ToolMessage({
          content: `Successfully wrote to '${file_path}'`,
          tool_call_id: config.toolCall?.id as string,
          name: "write_file",
          metadata: result.metadata,
        });

        if (result.filesUpdate) {
          return new Command({
            update: { files: result.filesUpdate, messages: [message] },
          });
        }

        return message;
      } catch (error) {
        // Return errors as messages so the agent can recover
        const message = error instanceof Error ? error.message : String(error);
        return `Error: ${message}`;
      }
    },
    {
      name: "write_file",
      description: customDescription || WRITE_FILE_TOOL_DESCRIPTION,
      schema: z.object({
        file_path: z.string().describe("Absolute path to the file to write"),
        content: z.string().describe("Content to write to the file"),
      }),
    },
  );
}

/**
 * Create edit_file tool using backend.
 */
function createEditFileTool(
  backend: BackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
  },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      try {
        const stateAndStore: StateAndStore = {
          state: getCurrentTaskInput(config),
          store: (config as any).store,
        };
        const resolvedBackend = getBackend(backend, stateAndStore);
        const {
          file_path,
          old_string,
          new_string,
          replace_all = false,
        } = input;
        const result = await resolvedBackend.edit(
          file_path,
          old_string,
          new_string,
          replace_all,
        );

        if (result.error) {
          return result.error;
        }

        const message = new ToolMessage({
          content: `Successfully replaced ${result.occurrences} occurrence(s) in '${file_path}'`,
          tool_call_id: config.toolCall?.id as string,
          name: "edit_file",
          metadata: result.metadata,
        });

        // If filesUpdate is present, return Command to update state
        if (result.filesUpdate) {
          return new Command({
            update: { files: result.filesUpdate, messages: [message] },
          });
        }

        return message;
      } catch (error) {
        // Return errors as messages so the agent can recover
        const message = error instanceof Error ? error.message : String(error);
        return `Error: ${message}`;
      }
    },
    {
      name: "edit_file",
      description: customDescription || EDIT_FILE_TOOL_DESCRIPTION,
      schema: z.object({
        file_path: z.string().describe("Absolute path to the file to edit"),
        old_string: z
          .string()
          .describe("String to be replaced (must match exactly)"),
        new_string: z.string().describe("String to replace with"),
        replace_all: z
          .boolean()
          .describe(
            "Whether to replace all occurrences (use false for single replacement)",
          ),
      }),
    },
  );
}

/**
 * Create glob tool using backend.
 */
function createGlobTool(
  backend: BackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
  },
) {
  const { customDescription } = options;

  return tool(
    async (input, config) => {
      try {
        const stateAndStore: StateAndStore = {
          state: getCurrentTaskInput(config),
          store: (config as any).store,
        };
        const resolvedBackend = getBackend(backend, stateAndStore);
        const { pattern, path } = input;
        const infos = await resolvedBackend.globInfo(pattern, path);

        if (infos.length === 0) {
          return `No files found matching pattern '${pattern}'`;
        }

        return infos.map((info) => info.path).join("\n");
      } catch (error) {
        // Return errors as messages so the agent can recover
        const message = error instanceof Error ? error.message : String(error);
        return `Error: ${message}`;
      }
    },
    {
      name: "glob",
      description: customDescription || GLOB_TOOL_DESCRIPTION,
      schema: z.object({
        pattern: z.string().describe("Glob pattern (e.g., '*.py', '**/*.ts')"),
        path: z
          .string()
          .describe("Base path to search from (use project root if unsure)"),
      }),
    },
  );
}

/**
 * Create standalone filesystem tools for use outside middleware.
 *
 * Useful for passing to code execution middleware which needs
 * direct access to tool instances.
 *
 * @param backend - Backend instance or factory function
 * @param options - Optional configuration including custom tool descriptions
 * @returns Array of filesystem tools (ls, read_file, write_file, edit_file, glob, grep)
 */
export function createFilesystemTools(
  backend: BackendProtocol | BackendFactory,
  options?: { customToolDescriptions?: Record<string, string> | null },
) {
  const customToolDescriptions = options?.customToolDescriptions ?? null;
  return [
    createLsTool(backend, { customDescription: customToolDescriptions?.ls }),
    createReadFileTool(backend, {
      customDescription: customToolDescriptions?.read_file,
    }),
    createWriteFileTool(backend, {
      customDescription: customToolDescriptions?.write_file,
    }),
    createEditFileTool(backend, {
      customDescription: customToolDescriptions?.edit_file,
    }),
    createGlobTool(backend, {
      customDescription: customToolDescriptions?.glob,
    }),
    createGrepTool(backend, {
      customDescription: customToolDescriptions?.grep,
    }),
  ];
}

/**
 * Create grep tool using backend.
 */
function createGrepTool(
  backend: BackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
  },
) {
  const { customDescription } = options;

  return tool(
    async (input, config) => {
      try {
        const stateAndStore: StateAndStore = {
          state: getCurrentTaskInput(config),
          store: (config as any).store,
        };
        const resolvedBackend = getBackend(backend, stateAndStore);
        const { pattern, path, glob } = input;
        // Treat "*" as no filter (backward compatible with optional glob)
        const globFilter = glob === "*" ? null : glob;
        const result = await resolvedBackend.grepRaw(pattern, path, globFilter);

        // If string, it's an error
        if (typeof result === "string") {
          return result;
        }

        if (result.length === 0) {
          return `No matches found for pattern '${pattern}'`;
        }

        // Format output: group by file
        const lines: string[] = [];
        let currentFile: string | null = null;
        for (const match of result) {
          if (match.path !== currentFile) {
            currentFile = match.path;
            lines.push(`\n${currentFile}:`);
          }
          lines.push(`  ${match.line}: ${match.text}`);
        }

        return lines.join("\n");
      } catch (error) {
        // Return errors as messages so the agent can recover
        const message = error instanceof Error ? error.message : String(error);
        return `Error: ${message}`;
      }
    },
    {
      name: "grep",
      description: customDescription || GREP_TOOL_DESCRIPTION,
      schema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z
          .string()
          .describe("Base path to search from (use project root if unsure)"),
        glob: z
          .string()
          .describe(
            "Glob pattern to filter files (e.g., '*.py'), use '*' for all files",
          ),
      }),
    },
  );
}

/**
 * Options for creating filesystem middleware.
 */
export interface FilesystemMiddlewareOptions {
  /** Backend instance or factory (default: StateBackend) */
  backend?: BackendProtocol | BackendFactory;
  /** Optional custom system prompt override */
  systemPrompt?: string | null;
  /** Optional custom tool descriptions override */
  customToolDescriptions?: Record<string, string> | null;
  /** Optional token limit before evicting a tool result to the filesystem (default: 20000 tokens, ~80KB) */
  toolTokenLimitBeforeEvict?: number | null;
  /** Pre-created tools (if provided, skips internal tool creation) */
  tools?: ReturnType<typeof createFilesystemTools>;
}

/**
 * Create filesystem middleware with all tools and features.
 */
export function createFilesystemMiddleware(
  options: FilesystemMiddlewareOptions = {},
) {
  const {
    backend = (stateAndStore: StateAndStore) => new StateBackend(stateAndStore),
    systemPrompt: customSystemPrompt = null,
    customToolDescriptions = null,
    toolTokenLimitBeforeEvict = 20000,
    tools: preCreatedTools,
  } = options;

  const systemPrompt = customSystemPrompt || FILESYSTEM_SYSTEM_PROMPT;

  // Use pre-created tools or create new ones
  const tools =
    preCreatedTools ??
    createFilesystemTools(backend, { customToolDescriptions });

  return createMiddleware({
    name: "FilesystemMiddleware",
    stateSchema: FilesystemStateSchema as any,
    tools,
    wrapModelCall: systemPrompt
      ? async (request, handler: any) => {
          const currentSystemPrompt = request.systemPrompt || "";
          const newSystemPrompt = currentSystemPrompt
            ? `${currentSystemPrompt}\n\n${systemPrompt}`
            : systemPrompt;
          return handler({ ...request, systemPrompt: newSystemPrompt });
        }
      : undefined,
    wrapToolCall: toolTokenLimitBeforeEvict
      ? ((async (request: any, handler: any) => {
          // Check if this tool is excluded from eviction before calling handler
          const toolName = request.toolCall?.name;
          if (
            toolName &&
            TOOLS_EXCLUDED_FROM_EVICTION.includes(
              toolName as (typeof TOOLS_EXCLUDED_FROM_EVICTION)[number],
            )
          ) {
            return handler(request);
          }

          const result = await handler(request);

          async function processToolMessage(msg: ToolMessage) {
            if (
              typeof msg.content === "string" &&
              msg.content.length >
                toolTokenLimitBeforeEvict! * NUM_CHARS_PER_TOKEN
            ) {
              // Build StateAndStore from request
              const stateAndStore: StateAndStore = {
                state: request.state || {},
                store: request.config?.store,
              };
              const resolvedBackend = getBackend(backend, stateAndStore);
              const sanitizedId = sanitizeToolCallId(
                request.toolCall?.id || msg.tool_call_id,
              );
              const evictPath = `/large_tool_results/${sanitizedId}`;

              const writeResult = await resolvedBackend.write(
                evictPath,
                msg.content,
              );

              if (writeResult.error) {
                return { message: msg, filesUpdate: null };
              }

              // Create preview showing head and tail of the result
              const contentSample = createContentPreview(msg.content);
              const replacementText = TOO_LARGE_TOOL_MSG.replace(
                "{tool_call_id}",
                msg.tool_call_id,
              )
                .replace("{file_path}", evictPath)
                .replace("{content_sample}", contentSample);

              const truncatedMessage = new ToolMessage({
                content: replacementText,
                tool_call_id: msg.tool_call_id,
                name: msg.name,
              });

              return {
                message: truncatedMessage,
                filesUpdate: writeResult.filesUpdate,
              };
            }
            return { message: msg, filesUpdate: null };
          }

          if (result instanceof ToolMessage) {
            const processed = await processToolMessage(result);

            if (processed.filesUpdate) {
              return new Command({
                update: {
                  files: processed.filesUpdate,
                  messages: [processed.message],
                },
              });
            }

            return processed.message;
          }

          if (isCommand(result)) {
            const update = result.update as any;
            if (!update?.messages) {
              return result;
            }

            let hasLargeResults = false;
            const accumulatedFiles: Record<string, FileData> = {
              ...(update.files || {}),
            };
            const processedMessages: ToolMessage[] = [];

            for (const msg of update.messages) {
              if (msg instanceof ToolMessage) {
                const processed = await processToolMessage(msg);
                processedMessages.push(processed.message);

                if (processed.filesUpdate) {
                  hasLargeResults = true;
                  Object.assign(accumulatedFiles, processed.filesUpdate);
                }
              } else {
                processedMessages.push(msg);
              }
            }

            if (hasLargeResults) {
              return new Command({
                update: {
                  ...update,
                  messages: processedMessages,
                  files: accumulatedFiles,
                },
              });
            }
          }

          return result;
        }) as any)
      : undefined,
  });
}
