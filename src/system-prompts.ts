/**
 * System Prompts - Loads and assembles system prompts for agents
 *
 * Prompts are stored as markdown files in the prompts/ directory and loaded
 * dynamically. The manager prompt gets environment context appended.
 *
 * Note: Static codebase context tools have been removed in favor of dynamic
 * discovery via filesystem tools and the codebase-navigation skill.
 */

import { loadPromptFile, clearPromptCache } from "./utils/prompt-loader.js";
import {
  buildSystemContext,
  type SystemContextOptions,
} from "./utils/system-context.js";

/**
 * Supported agent names - includes both new (plan, research, answer) and legacy (planner, researcher)
 */
export type AgentName =
  | "manager"
  | "plan"
  | "research"
  | "answer"
  | "planner"
  | "researcher";

/**
 * Maps agent names to prompt file names.
 * Supports both new verb-based names (plan, research, answer) and legacy names (planner, researcher).
 */
const NAME_MAP: Record<
  AgentName,
  "manager" | "planner" | "researcher" | "answer"
> = {
  manager: "manager",
  plan: "planner",
  planner: "planner",
  research: "researcher",
  researcher: "researcher",
  answer: "answer",
};

/**
 * Get system prompt for a specific agent.
 *
 * Loads the base prompt from markdown files and, for the manager agent,
 * appends dynamic environment context.
 *
 * @param agentName - The agent to get the prompt for
 * @param contextOptions - Optional overrides for system context (manager only)
 * @returns The complete system prompt
 */
export async function getSystemPrompt(
  agentName: AgentName,
  contextOptions?: SystemContextOptions,
): Promise<string> {
  const normalizedName = NAME_MAP[agentName];
  const basePrompt = loadPromptFile(normalizedName);

  // Only manager gets environment context appended
  if (normalizedName === "manager") {
    return `${basePrompt}\n\n${buildSystemContext(contextOptions)}`;
  }
  return basePrompt;
}

/**
 * Get all system prompts.
 *
 * Returns prompts for all agents, with the manager prompt including
 * environment context.
 *
 * @returns Object with prompts keyed by agent name
 */
export async function getAllSystemPrompts(): Promise<Record<string, string>> {
  return {
    manager: await getSystemPrompt("manager"),
    planner: await getSystemPrompt("planner"),
    researcher: await getSystemPrompt("researcher"),
    answer: await getSystemPrompt("answer"),
  };
}

export { clearPromptCache };
