/**
 * System Prompts - Loads and assembles system prompts for agents
 *
 * Prompts are stored as markdown files in the prompts/ directory and loaded
 * dynamically. The manager prompt gets environment context appended, and
 * prompts that reference `web_search` get a capability notice appended when
 * that tool is unavailable.
 *
 * Note: Static codebase context tools have been removed in favor of dynamic
 * discovery via filesystem tools and the codebase-navigation skill.
 */

import { loadPromptFile, clearPromptCache } from "./utils/prompt-loader.js";
import {
  buildSystemContext,
  type SystemContextOptions,
} from "./utils/system-context.js";
import { isConfigured as isWebSearchConfigured } from "./web-search/tavily-client.js";

/**
 * Prompts that reference `web_search` and therefore need telling when it
 * isn't there. The planner and researcher prompts don't name it, so
 * appending the notice to them would be noise.
 */
const WEB_SEARCH_AWARE_PROMPTS = new Set(["manager", "answer"]);

/**
 * Capability-aware suffix. `createStandardTools()` withholds `web_search`
 * from the tool schema when no Tavily API key is configured; this is how
 * the prompts that assume the tool exists find out that it doesn't.
 *
 * Assembled by string concatenation after load, matching how the manager
 * prompt already gets its environment context — the prompt loader reads
 * `.md` files verbatim and does no templating.
 */
function capabilityNotice(promptName: string): string {
  if (!WEB_SEARCH_AWARE_PROMPTS.has(promptName)) return "";
  if (isWebSearchConfigured()) return "";
  return `\n\n${loadPromptFile("no-web-search")}`;
}

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
  // Appended LAST so it overrides anything the base prompt says about
  // reaching the internet. Empty string when web search is available, so
  // the key-present path is byte-for-byte unchanged.
  const notice = capabilityNotice(normalizedName);

  // Only manager gets environment context appended
  if (normalizedName === "manager") {
    return `${basePrompt}\n\n${buildSystemContext(contextOptions)}${notice}`;
  }
  return `${basePrompt}${notice}`;
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
