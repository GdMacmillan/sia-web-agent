/**
 * Prompt Loader - Loads system prompts from markdown files
 *
 * Reads prompt content from markdown files in the prompts/ directory,
 * caching the results for performance. Uses getAgentPackageRoot() to
 * locate prompts, which respects SIA_PROJECT_ROOT in self-improve mode.
 *
 * Each prompt is also a component (`prompt-<name>`): when the host has
 * activated a version of it that passes its built-in contract, that
 * version is what loads; otherwise the file in prompts/ does. See
 * `docs/COMPONENTS.md` §Skills and prompts.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveContent } from "../components/content.js";
import { getAgentPackageRoot } from "./path-utils.js";

/**
 * Cache for loaded prompt content
 */
const promptCache = new Map<string, string>();

/**
 * Valid prompt file names (without extension).
 *
 * `no-web-search` and `shared` are FRAGMENTS, not agent prompts: each is
 * appended to an agent's prompt rather than loaded on its own. See
 * `system-prompts.ts`.
 */
export type PromptName =
  | "manager"
  | "planner"
  | "researcher"
  | "answer"
  | "no-web-search"
  | "shared";

/**
 * Load a prompt file by name from the prompts directory.
 *
 * Uses getAgentPackageRoot() which respects SIA_PROJECT_ROOT env var,
 * ensuring prompts are loaded from the correct location in self-improve mode.
 *
 * @param name - The prompt name (manager, planner, or researcher)
 * @returns The prompt content as a string
 * @throws Error if the prompt file is not found
 */
export function loadPromptFile(name: PromptName): string {
  const cached = promptCache.get(name);
  if (cached) return cached;

  // Uses getAgentPackageRoot() which respects SIA_PROJECT_ROOT in self-improve mode
  const seedRoot = getAgentPackageRoot();
  const source = resolveContent("prompt", name, { seedRoot });
  if (source === null) {
    throw new Error(
      `Prompt file not found: ${resolve(seedRoot, "prompts", `${name}.md`)}`,
    );
  }

  const content = readFileSync(source.file, "utf-8");
  promptCache.set(name, content);
  return content;
}

/**
 * Clear the prompt cache.
 * Useful for testing or when prompts may have changed.
 */
export function clearPromptCache(): void {
  promptCache.clear();
}
