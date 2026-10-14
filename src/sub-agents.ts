/**
 * Sub-Agent Definitions
 *
 * Lazy-loaded SubAgent instances for the plan and research agents.
 * These agents are specialized for specific tasks within the multi-agent system.
 *
 * Note: Tools are configured at the middleware level (createSubAgentMiddleware)
 * where all tools are available. GraphType defaults to "react" for all agents.
 * The plan and research agents are read-only: `createReadOnlyMiddleware`
 * withholds and refuses every write tool, including the ones the shared
 * sub-agent middleware inject.
 */

import type { SubAgent } from "./middleware/index.js";
import { createReadOnlyMiddleware } from "./middleware/read-only.js";
import { getSystemPrompt } from "./system-prompts.js";
import {
  createPlanModel,
  createResearchModel,
  createAnswerModel,
} from "./config/model-config.js";

// Cache for lazy-loaded sub-agents
let planSubAgentCache: SubAgent | null = null;
let researchSubAgentCache: SubAgent | null = null;
let answerSubAgentCache: SubAgent | null = null;

/**
 * Get the plan sub-agent (lazily loaded)
 *
 * The plan agent creates implementation plans:
 * - Receives its requirements, constraints and target files in the task description
 * - Can read the codebase (ls, read_file, grep, glob) and search for patterns
 * - Can read past learnings from memory
 * - Read-only: no file writes, memory writes or code execution reach it
 * - Returns a plan in prose (steps, risks, assumptions)
 */
export async function getPlanSubAgent(): Promise<SubAgent> {
  if (!planSubAgentCache) {
    planSubAgentCache = {
      name: "plan",
      description:
        "Read-only. Produces a structured implementation plan: ordered steps with expected outcomes and file changes, plus risks and assumptions. Put the requirements, constraints and target files in the task description.",
      systemPrompt: await getSystemPrompt("plan"),
      model: await createPlanModel(),
      // tools: populated at middleware level with getPlannerTools()
      middleware: [createReadOnlyMiddleware()],
    };
  }
  return planSubAgentCache;
}

/**
 * Get the research sub-agent (lazily loaded)
 *
 * The research agent performs deep, systematic codebase investigation:
 * - Receives its depth and focus areas in the task description
 * - Can search the codebase (grep, glob, read_file)
 * - Can read memory, for corroboration
 * - Read-only: no file writes, memory writes or code execution reach it
 * - Returns a report in prose (summary, findings, recommendations)
 */
export async function getResearchSubAgent(): Promise<SubAgent> {
  if (!researchSubAgentCache) {
    researchSubAgentCache = {
      name: "research",
      description:
        "Read-only, systematic codebase investigation across many files. Returns a summary, findings with file paths and line numbers, and recommendations. State the depth (shallow/medium/deep) and focus areas in the task description.",
      systemPrompt: await getSystemPrompt("research"),
      model: await createResearchModel(),
      // tools: populated at middleware level with getResearcherTools()
      middleware: [createReadOnlyMiddleware()],
    };
  }
  return researchSubAgentCache;
}

/**
 * Get the answer sub-agent (lazily loaded)
 *
 * The answer agent performs deep web research for questions requiring current information:
 * - Uses web_search tool for search, extract, and crawl operations
 * - Synthesizes comprehensive answers with cited sources
 * - Can access codebase for context (read-only)
 * - Can store/retrieve research findings in memory
 */
export async function getAnswerSubAgent(): Promise<SubAgent> {
  if (!answerSubAgentCache) {
    answerSubAgentCache = {
      name: "answer",
      description:
        "Web research for questions that need current external information, such as recent developments or external documentation. Returns a synthesized answer with cited sources, and may store what it learns in memory.",
      systemPrompt: await getSystemPrompt("answer"),
      model: await createAnswerModel(),
      // tools: populated at middleware level with getAnswerTools()
    };
  }
  return answerSubAgentCache;
}

// Backward compatibility aliases
/** @deprecated Use getPlanSubAgent instead */
export const getPlannerSubAgent = getPlanSubAgent;
/** @deprecated Use getResearchSubAgent instead */
export const getResearcherSubAgent = getResearchSubAgent;
