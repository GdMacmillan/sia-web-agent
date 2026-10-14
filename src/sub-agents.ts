/**
 * Sub-Agent Definitions
 *
 * Lazy-loaded SubAgent instances for the plan and research agents.
 * These agents are specialized for specific tasks within the multi-agent system.
 *
 * Note: Tools are configured at the middleware level (createSubAgentMiddleware)
 * where all tools are available. GraphType defaults to "react" for all agents.
 */

import type { SubAgent } from "./middleware/index.js";
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
 * The plan agent creates structured implementation plans:
 * - Receives structured input (requirements, constraints, targetFiles)
 * - Can read codebase (ls, read_file, grep, glob)
 * - Can search for patterns
 * - Can retrieve past learnings from memory
 * - Cannot modify files (read-only constraint)
 * - Returns structured JSON output (steps, risks, assumptions)
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
    };
  }
  return planSubAgentCache;
}

/**
 * Get the research sub-agent (lazily loaded)
 *
 * The research agent performs deep, systematic codebase investigation:
 * - Receives structured input (depth, taskType, focusAreas)
 * - Can search codebase (grep, glob, read_file)
 * - Can access memory tools (retrieve only, for corroboration)
 * - Cannot modify files (read-only constraint)
 * - Returns structured JSON output (summary, findings, recommendations, issues)
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
        "Web research for questions that need current external information, such as recent developments or external documentation. Returns a synthesized answer with cited sources.",
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
