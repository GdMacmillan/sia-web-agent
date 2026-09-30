/**
 * Source-edit note middleware.
 *
 * When the agent runs from an installed copy of its own source (not a
 * version-controlled working tree), a successful `write_file` / `edit_file`
 * inside that tree is a change to the running agent that nothing reviews
 * and that the next install of the same tree will replace. The agent is
 * still allowed to make it. This middleware only tells it so: it appends a
 * one-paragraph note to the tool's own result.
 *
 * Design constraints, all load-bearing:
 *
 *   - **The tool result is sacred.** The handler always runs first and the
 *     request is never touched. Any failure while deciding whether to add
 *     the note returns the result unchanged; the middleware never throws.
 *   - **Only real edits of the source tree.** Failed writes, other tools,
 *     paths outside the project root, and scratch areas (`.code-workspace/`,
 *     `node_modules/`) get no note.
 *   - **Silent in a working tree.** A project root that holds `.git` is a
 *     developer's checkout, where editing source is the normal workflow.
 *   - **Links resolve.** The project root may be a symbolic link to a
 *     versioned directory; both sides are compared by real path.
 */
import fs from "node:fs";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { createMiddleware, ToolMessage } from "langchain";
import { getConfig } from "../config/index.js";
import { getProjectRoot } from "../utils/path-utils.js";
import { logger } from "../utils/logger.js";

/** Tools whose successful result may carry the note. */
export const SOURCE_EDIT_NOTE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
]);

/** Top-level directories of the project root that are scratch, not source. */
const EXCLUDED_TOP_DIRS: readonly string[] = [".code-workspace", "node_modules"];

export function sourceEditNoteText(relPath: string): string {
  return `Note: ${relPath} is part of this agent's installed source. An update of the installed version replaces this tree, so this edit will not carry forward, and until then it runs without review. To change a component, prepare a new component version instead.`;
}

export interface SourceEditNoteMiddlewareOptions {
  /** Override the configured `features.sourceEditNote.enabled`. */
  enabled?: boolean;
  /** Project root to compare against; defaults to `getProjectRoot()`. */
  projectRoot?: string;
  /** Real-path resolver; injectable for tests. */
  realpath?: (p: string) => string;
  /** Existence check; injectable for tests. */
  exists?: (p: string) => boolean;
}

function readEnabled(): boolean {
  try {
    return getConfig().features.sourceEditNote.enabled;
  } catch {
    return false;
  }
}

/**
 * Real path of `p`, resolving through the nearest existing ancestor so a
 * path that does not exist yet still compares correctly against a linked
 * root.
 */
function realpathNearest(p: string, realpath: (p: string) => string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpath(current), ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** The successful `ToolMessage` inside a tool result, or null. */
function successMessage(result: unknown): ToolMessage | null {
  let message: unknown = result;
  if (result instanceof Command) {
    const update = result.update as { messages?: unknown[] } | undefined;
    message = Array.isArray(update?.messages) ? update.messages[0] : undefined;
  }
  if (!(message instanceof ToolMessage)) return null;
  if (message.status === "error") return null;
  if (typeof message.content !== "string") return null;
  if (!message.content.startsWith("Successfully")) return null;
  return message;
}

export function createSourceEditNoteMiddleware(
  options: SourceEditNoteMiddlewareOptions = {},
) {
  const enabled = options.enabled ?? readEnabled();
  const realpath = options.realpath ?? ((p: string) => fs.realpathSync(p));
  const exists = options.exists ?? ((p: string) => fs.existsSync(p));

  /** Path of `filePath` relative to the source tree, or null when out of scope. */
  const relativeToSource = (filePath: string): string | null => {
    const root = options.projectRoot ?? getProjectRoot();
    if (exists(path.join(root, ".git"))) return null;
    const realRoot = realpathNearest(root, realpath);
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(root, filePath);
    const realFile = realpathNearest(absolute, realpath);
    const rel = path.relative(realRoot, realFile);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const top = rel.split(path.sep)[0];
    if (EXCLUDED_TOP_DIRS.includes(top)) return null;
    return rel.split(path.sep).join("/");
  };

  return createMiddleware({
    name: "sourceEditNoteMiddleware",
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (!enabled) return result;
      try {
        const toolName = request.toolCall?.name;
        if (!toolName || !SOURCE_EDIT_NOTE_TOOLS.has(toolName)) return result;
        const filePath = (request.toolCall.args as { file_path?: unknown })
          ?.file_path;
        if (typeof filePath !== "string" || filePath.length === 0) {
          return result;
        }
        const message = successMessage(result);
        if (!message) return result;
        const rel = relativeToSource(filePath);
        if (!rel) return result;
        message.content = `${message.content as string}\n\n${sourceEditNoteText(rel)}`;
      } catch (err) {
        logger.debug({ err }, "[SourceEditNote] skipped");
      }
      return result;
    },
  });
}
