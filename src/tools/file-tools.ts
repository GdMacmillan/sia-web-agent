/**
 * Native File Operation Tools
 *
 * Provides explicit file operations (read, create, update, delete) as DynamicStructuredTools.
 * These tools replace ambiguous bash heredoc syntax with clear, type-safe file operations.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import { detectEol, toLf, toEol } from "../utils/eol.js";
import { resolveRipgrep } from "../utils/fs-compat.js";

/**
 * Validate that a file path is within the project root (prevent traversal).
 *
 * Uses the same cross-platform containment algorithm as
 * `validatePathInProject` (path.relative + `..`), which is correct across
 * drive-letter case, sibling-prefix paths, and separator differences — unlike
 * the previous `startsWith(projectRoot)` test.
 *
 * Exported for unit testing of the containment behavior.
 */
export function validatePath(filePath: string, projectRoot: string): string {
  // Convert to an absolute, normalized path.
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- containment enforced by the path.relative check below.
      path.join(projectRoot, filePath);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- containment enforced by the path.relative check below.
  const resolved = path.resolve(absolute);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- resolving the trusted root for the containment comparison.
  const resolvedRoot = path.resolve(projectRoot);

  const rel = path.relative(resolvedRoot, resolved);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path outside project root not allowed: ${filePath}`);
  }

  return resolved;
}

/**
 * Clip long strings to prevent token overflow
 */
function clipOutput(content: string, maxChars: number = 24000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n...[truncated]...";
}

/**
 * Normalize whitespace for comparison (replace all whitespace sequences with single space)
 */
function normalizeWhitespace(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}

/**
 * Check if two strings are equal when whitespace is normalized
 */
function equalsIgnoringWhitespace(str1: string, str2: string): boolean {
  return normalizeWhitespace(str1) === normalizeWhitespace(str2);
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
 * Generate unified diff between old and new content
 */
function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  // Normalize EOL for a clean, line-ending-agnostic diff view.
  const oldLines = toLf(oldContent).split("\n");
  const newLines = toLf(newContent).split("\n");

  const diff: string[] = [];
  diff.push(`--- a/${filePath}`);
  diff.push(`+++ b/${filePath}`);

  // Simple diff implementation - finds first difference
  let firstDiff = 0;

  // Find first differing line
  while (
    firstDiff < Math.min(oldLines.length, newLines.length) &&
    oldLines[firstDiff] === newLines[firstDiff]
  ) {
    firstDiff++;
  }

  // Find last differing line from end
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (
    oldEnd >= firstDiff &&
    newEnd >= firstDiff &&
    oldLines[oldEnd] === newLines[newEnd]
  ) {
    oldEnd--;
    newEnd--;
  }

  // Show context lines around change
  const contextLines = 3;
  const startLine = Math.max(0, firstDiff - contextLines);
  const oldEndLine = Math.min(oldLines.length - 1, oldEnd + contextLines);
  const newEndLine = Math.min(newLines.length - 1, newEnd + contextLines);

  diff.push(
    `@@ -${startLine + 1},${oldEndLine - startLine + 1} +${startLine + 1},${newEndLine - startLine + 1} @@`,
  );

  // Add context before change
  for (let i = startLine; i < firstDiff; i++) {
    diff.push(` ${oldLines[i]}`);
  }

  // Add removed lines
  for (let i = firstDiff; i <= oldEnd; i++) {
    diff.push(`-${oldLines[i]}`);
  }

  // Add added lines
  for (let i = firstDiff; i <= newEnd; i++) {
    diff.push(`+${newLines[i]}`);
  }

  // Add context after change
  for (let i = oldEnd + 1; i <= oldEndLine; i++) {
    if (i < oldLines.length) {
      diff.push(` ${oldLines[i]}`);
    }
  }

  return diff.join("\n");
}

/**
 * Global context offloader for tool outputs
 */

/**
 * Global file read tracking for read-before-edit enforcement
 * Tracks when files were last read to ensure agents read before editing
 */
const fileReadTimestamps = new Map<string, number>();

/**
 * Record that a file was read (for read-before-edit enforcement)
 */
function recordFileRead(filePath: string): void {
  fileReadTimestamps.set(filePath, Date.now());
}

/**
 * Check if a file was read before attempting to edit it
 */
function wasFileRead(filePath: string): boolean {
  return fileReadTimestamps.has(filePath);
}

/**
 * Get the last read time for a file (for debugging/logging)
 */
export function getLastReadTime(filePath: string): number | null {
  return fileReadTimestamps.get(filePath) ?? null;
}

/**
 * Clear file read tracking (for testing or session reset)
 */
export function clearFileReadTracking(): void {
  fileReadTimestamps.clear();
}

/**
 * Create all 4 file operation tools
 */
export function createFileTools(projectRoot: string): DynamicStructuredTool[] {
  // Tool 1: file_read - Read file contents
  const fileReadTool = new DynamicStructuredTool({
    name: "file_read",
    description: `Read file contents.

WHEN TO USE: - View source code, configuration files, or text data - Before editing any file
(REQUIRED for file_edit) - Examine existing implementations

HOW TO USE: Provide the file path (relative to project root or absolute).

FEATURES: - Returns file content with proper formatting - Automatically offloads large files to
prevent context overflow - Tracks file reads for read-before-edit enforcement

LIMITATIONS: - Files >100KB rejected (use grep_code to search large files instead) - Binary files
not supported - Content may be offloaded if >5KB (preview shown with reference)

TIPS: - Always read before editing (file_edit requires this) - Use grep_code to search large
codebases - Read files to understand exact formatting (tabs vs spaces)

Working directory: ${projectRoot}`,
    schema: z.object({
      filePath: z
        .string()
        .describe(
          "Path to file to read (relative to project root or absolute)",
        ),
    }),
    func: async ({ filePath }) => {
      try {
        const absolutePath = validatePath(filePath, projectRoot);
        const content = await fs.readFile(absolutePath, "utf-8");

        // Record file read for read-before-edit enforcement
        recordFileRead(absolutePath);

        // Reject extremely large files
        if (content.length > 100000) {
          return `File ${filePath} is too large (${content.length} chars). Use grep_code to search it instead.`;
        }

        // Return content directly (with safety clipping)
        return clipOutput(content, 24000);
      } catch (error: any) {
        if (error.code === "ENOENT") {
          return `Error: File not found: ${filePath}`;
        } else if (error.code === "EACCES") {
          return `Error: Permission denied: ${filePath}`;
        } else if (error.message?.includes("outside project root")) {
          return `Error: ${error.message}`;
        } else {
          return `Error reading file: ${error.message}`;
        }
      }
    },
  });

  // Tool 2: file_edit - Edit existing file with exact snippet replacement
  const fileEditTool = new DynamicStructuredTool({
    name: "file_edit",
    description: `Edit existing files by finding and replacing exact text snippets. Use this to modify code, fix bugs, or update specific sections. The originalSnippet must match the file content exactly, including all whitespace. For new files, use file_create instead. Working directory: ${projectRoot}`,
    schema: z.object({
      filePath: z
        .string()
        .describe(
          "Path to file to edit (relative to project root or absolute)",
        ),
      originalSnippet: z
        .string()
        .describe(
          "Exact text to find and replace (must match file content exactly, including whitespace)",
        ),
      replacedSnippet: z.string().describe("New text to replace with"),
    }),
    func: async ({
      filePath,
      originalSnippet: originalSnippetRaw,
      replacedSnippet: replacedSnippetRaw,
    }) => {
      try {
        const absolutePath = validatePath(filePath, projectRoot);

        // Check if file exists first (before read-before-edit check)
        try {
          await fs.access(absolutePath);
        } catch (error: any) {
          if (error.code === "ENOENT") {
            return `Error: File not found: ${filePath}

Use file_create to create a new file, or check the file path.`;
          }
          throw error;
        }

        // Enforce read-before-edit: file must be read first
        if (!wasFileRead(absolutePath)) {
          return `Error: You must read the file before editing it. Use file_read first to see the exact content and formatting.`;
        }

        // Read current content. Match/replace on an LF-normalized copy so a
        // CRLF checkout still matches an LF snippet; the file's original EOL is
        // restored on write so its line-ending style is preserved.
        const rawContent = await fs.readFile(absolutePath, "utf-8");
        const fileEol = detectEol(rawContent);
        const content = toLf(rawContent);
        const originalSnippet = toLf(originalSnippetRaw);
        const replacedSnippet = toLf(replacedSnippetRaw);

        // Verify snippet exists
        if (!content.includes(originalSnippet)) {
          // Check if it would match if whitespace were normalized
          const whitespaceMatch =
            equalsIgnoringWhitespace(content, originalSnippet) ||
            content
              .split("\n")
              .some((line) => equalsIgnoringWhitespace(line, originalSnippet));

          if (whitespaceMatch) {
            return `Error: Snippet not found in ${filePath}. The content exists but whitespace differs (tabs vs spaces, or line endings). Use file_read to get exact formatting.`;
          }

          // Show file preview for context
          const lines = content.split("\n");
          const preview = lines.slice(0, Math.min(5, lines.length)).join("\n");

          return `Error: Snippet not found in ${filePath}. Your snippet doesn't match the file. Use file_read first to
see actual content.

File preview: ${clipOutput(preview, 300)}`;
        }

        // Check for multiple occurrences
        const occurrences = content.split(originalSnippet).length - 1;
        if (occurrences > 1) {
          return `Error: Found ${occurrences} occurrences in ${filePath}. Provide larger snippet with surrounding context to match uniquely.`;
        }

        // Replace (only first occurrence) on the normalized content.
        const newContentLf = content.replace(originalSnippet, replacedSnippet);

        // Generate unified diff from the normalized (LF) forms.
        const diff = generateUnifiedDiff(content, newContentLf, filePath);

        // Restore the file's original EOL style before writing back.
        const newContent = toEol(newContentLf, fileEol);
        await fs.writeFile(absolutePath, newContent, "utf-8");

        // Clip output
        const clippedDiff = clipOutput(diff, 10000);

        return `Success: Edited ${filePath}

Diff: ${clippedDiff}`;
      } catch (error: any) {
        if (error.code === "ENOENT") {
          return `Error: File not found: ${filePath}

Use file_create to create a new file, or check the file path.`;
        } else if (error.code === "EACCES") {
          return `Error: Permission denied: ${filePath}

Check file permissions or try a different location.`;
        } else if (error.message?.includes("outside project root")) {
          return `Error: ${error.message}

File must be within the project directory.`;
        } else {
          return `Error editing file: ${error.message}`;
        }
      }
    },
  });

  // Tool 3: file_create - Create new file (fails if exists)
  const fileCreateTool = new DynamicStructuredTool({
    name: "file_create",
    description: `Create new files.

WHEN TO USE: - Create a new file that doesn't exist yet - Generate new source code, configuration,
or documentation files - Initialize new components or modules

HOW TO USE: 1. Provide the file path (relative to project root or absolute) 2. Provide the complete
file content

FEATURES: - Creates parent directories automatically if they don't exist - Fails safely if file
already exists (prevents accidental overwrites) - Validates path is within project root (security)

LIMITATIONS: - Fails if file already exists (use file_edit to modify existing files) - Cannot create
directories (only files with parent dirs auto-created) - Path must be within project root

TIPS: - Use grep_code or file_read first to check if file exists - For existing files, use file_edit
instead - Ensure proper file extension for syntax highlighting

Working directory: ${projectRoot}`,
    schema: z.object({
      filePath: z
        .string()
        .describe(
          "Path where file should be created (relative to project root or absolute)",
        ),
      content: z.string().describe("Content to write to the file"),
    }),
    func: async ({ filePath, content }) => {
      try {
        const absolutePath = validatePath(filePath, projectRoot);

        // Ensure parent directory exists
        const dir = path.dirname(absolutePath);
        await fs.mkdir(dir, { recursive: true });

        // Use wx flag to fail if file exists (exclusive write)
        await fs.writeFile(absolutePath, content, {
          encoding: "utf-8",
          flag: "wx",
        });

        return `Success: Created file at ${absolutePath}`;
      } catch (error: any) {
        if (error.code === "EEXIST") {
          return `Error: File already exists: ${filePath}\n\nUse file_edit to modify existing files.`;
        } else if (error.code === "EACCES") {
          return `Error: Permission denied: ${filePath}`;
        } else if (error.message?.includes("outside project root")) {
          return `Error: ${error.message}`;
        } else {
          return `Error creating file: ${error.message}`;
        }
      }
    },
  });

  // Tool 4: file_delete - Delete file
  const fileDeleteTool = new DynamicStructuredTool({
    name: "file_delete",
    description: `Delete files.

WHEN TO USE: - Remove files that are no longer needed - Clean up temporary or generated files -
Remove duplicate or obsolete code

HOW TO USE: Provide the file path (relative to project root or absolute).

FEATURES: - Safely deletes single files - Validates path is within project root (security) -
Provides clear error messages

LIMITATIONS: - Cannot delete directories (only files) - Path must be within project root - Operation
is permanent (no undo)

TIPS: - Use file_read first to verify you're deleting the right file - Be careful with file deletion
- it's permanent - Use grep_code to find all references before deleting

Working directory: ${projectRoot}`,
    schema: z.object({
      filePath: z
        .string()
        .describe(
          "Path to file to delete (relative to project root or absolute)",
        ),
    }),
    func: async ({ filePath }) => {
      try {
        const absolutePath = validatePath(filePath, projectRoot);
        await fs.unlink(absolutePath);
        return `Success: Deleted file at ${absolutePath}`;
      } catch (error: any) {
        if (error.code === "ENOENT") {
          return `Error: File not found: ${filePath}`;
        } else if (error.code === "EACCES") {
          return `Error: Permission denied: ${filePath}`;
        } else if (error.message?.includes("outside project root")) {
          return `Error: ${error.message}`;
        } else {
          return `Error deleting file: ${error.message}`;
        }
      }
    },
  });

  // Tool 5: search - Search codebase using ripgrep
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

  return [
    fileReadTool,
    fileEditTool,
    fileCreateTool,
    fileDeleteTool,
    searchTool,
  ];
}

/**
 * Cleanup file tool context (for testing or manual cleanup)
 */
export function cleanupFileToolContext(): void {
  clearFileReadTracking();
}
