/**
 * Search Tool - Ripgrep-based Code Search
 *
 * Provides specialized code search with features beyond middleware grep:
 * - File type filtering (--type=ts, --type=json, etc.)
 * - Case sensitivity control
 * - Token management (24KB result clipping)
 * - Read-before-edit enforcement tracking
 * - Comprehensive agent guidance
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn } from "child_process";
import { resolveRipgrep } from "../utils/fs-compat.js";

/**
 * Clip long strings to prevent token overflow
 */
function clipOutput(content: string, maxChars: number = 24000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n...[truncated]...";
}

/**
 * Run ripgrep and collect results
 */
function runRipgrep(
  pattern: string,
  searchPath: string,
  options: { globs?: string[]; type?: string; caseSensitive?: boolean },
): Promise<string> {
  return new Promise((resolve) => {
    const args: string[] = [
      "--color=never", // No ANSI color codes
      "--no-heading", // Don't print file names
      "--with-filename", // Include file path in output
      "--line-number", // Include line numbers
      "--max-count=100", // Limit results to prevent huge output
    ];

    // Add case sensitivity option
    if (!options.caseSensitive) {
      args.push("-i"); // Case insensitive
    }

    // Add file type filter if specified
    if (options.type) {
      args.push(`--type=${options.type}`);
    }

    // Add glob patterns if specified
    if (options.globs && options.globs.length > 0) {
      for (const glob of options.globs) {
        args.push(`--glob=${glob}`);
      }
    }

    // Add the pattern and search path — `--` stops ripgrep from parsing a
    // model-supplied pattern starting with `-` as a flag.
    args.push("--", pattern, searchPath);

    let output = "";
    let errorOutput = "";

    const child = spawn(resolveRipgrep(), args);

    child.stdout?.on("data", (data) => {
      output += data.toString();
    });

    child.stderr?.on("data", (data) => {
      errorOutput += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        // Exit code 0 = matches found, 1 = no matches found
        resolve(output || "No matches found");
      } else if (code === 2) {
        // Error exit code
        resolve(`Error: ${errorOutput || "Search failed"}`);
      } else {
        resolve(errorOutput || "Search completed");
      }
    });

    child.on("error", (error) => {
      resolve(`Error running ripgrep: ${error.message}`);
    });
  });
}

/**
 * Create the search tool for code searching with advanced features
 */
export function createSearchTool(projectRoot: string): DynamicStructuredTool {
  const searchTool = new DynamicStructuredTool({
    name: "search",
    description: `Search file contents across the project with ripgrep. Case-insensitive by default. Returns up to 100 matches as file:line:text, without context lines; use read_file to see the surrounding code. Narrow a large result with a more specific pattern or a fileType.`,
    schema: z.object({
      pattern: z.string().describe("Regex (Rust syntax) or literal text"),
      fileType: z
        .string()
        .optional()
        .describe("Limit to a ripgrep file type, e.g. 'ts' or 'json'"),
      // No `.default()`: a defaulted field is advertised to the model as
      // required. Absent means case-insensitive.
      caseSensitive: z
        .boolean()
        .optional()
        .describe("Match case (default false)"),
    }),
    func: async ({ pattern, fileType, caseSensitive }) => {
      try {
        const result = await runRipgrep(pattern, projectRoot, {
          type: fileType,
          caseSensitive: caseSensitive ?? false,
        });

        // Clip output if too large
        return clipOutput(result, 24000);
      } catch (error: any) {
        return `Error searching codebase: ${error.message}`;
      }
    },
  });

  return searchTool;
}
