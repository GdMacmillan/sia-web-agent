/**
 * Prompt Loader - Loads system prompts from markdown files
 *
 * Reads prompt content from markdown files in the prompts/ directory,
 * caching the results for performance. Uses getAgentPackageRoot() to
 * locate prompts, which respects SIA_PROJECT_ROOT in self-improve mode.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAgentPackageRoot } from "./path-utils.js";

/**
 * Cache for loaded prompt content
 */
const promptCache = new Map<string, string>();

/**
 * Valid prompt file names (without extension)
 */
export type PromptName = "manager" | "planner" | "researcher" | "answer";

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
  const promptPath = resolve(getAgentPackageRoot(), "prompts", `${name}.md`);

  if (!existsSync(promptPath)) {
    throw new Error(`Prompt file not found: ${promptPath}`);
  }

  const content = readFileSync(promptPath, "utf-8");
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
