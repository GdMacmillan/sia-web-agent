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

    // Add the pattern and search path
    args.push(pattern);
    args.push(searchPath);

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
    description: `Search codebase for patterns using ripgrep.

WHEN TO USE: - Find all occurrences of a pattern in the codebase - Locate files containing specific
text or patterns - Search before making changes to understand scope - Look for references to code
being modified

HOW TO USE: 1. Provide a search pattern (regex or literal string) 2. Optionally specify file types
to limit search 3. Optionally use case-sensitive search

FEATURES: - Fast ripgrep-based search across entire codebase - Returns
filename:line_number:match_text format - Supports regex patterns (Rust-flavored regex) - Can filter
by file type (e.g., 'ts', 'tsx', 'js') - Case-insensitive by default (use case_sensitive=true for
case-sensitive) - Limits results to 100 matches to prevent huge output

LIMITATIONS: - Matches limited to 100 results (use more specific patterns for large result sets) -
Pattern must be valid regex syntax - Returns results without context lines (use file_read for
context)

TIPS: - Use simple patterns like "functionName" for literal matches - Use regex like "import.*from"
for pattern matching - Combine with file_type filter for faster searches - Use case_sensitive=true
for exact matches

Working directory: ${projectRoot}`,
    schema: z.object({
      pattern: z
        .string()
        .describe("Search pattern (regex or literal string to find)"),
      fileType: z
        .string()
        .optional()
        .describe("File type to search (e.g., 'ts', 'tsx', 'js', 'json')"),
      caseSensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to search case-sensitively"),
    }),
    func: async ({ pattern, fileType, caseSensitive }) => {
      try {
        const result = await runRipgrep(pattern, projectRoot, {
          type: fileType,
          caseSensitive: caseSensitive,
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
