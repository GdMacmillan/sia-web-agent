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
        "Creates structured implementation plans. Receives requirements, constraints, and target files. Returns JSON with ordered steps (each with description, expectedOutcome, fileChanges, dependencies), risks, and assumptions. Use for planning complex implementations that need structured, actionable steps.",
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
        "Performs deep, systematic codebase investigation. Receives depth (shallow/medium/deep), taskType (architecture/dependency/logic/pattern/comparison), and focusAreas. Returns JSON with summary, codebaseStructure, findings (with file paths and line numbers), recommendations, and issues. Use for multi-file exploration requiring systematic investigation.",
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
        "Deep web research for questions requiring current external information. Uses search, extraction, and synthesis to provide comprehensive answers with cited sources. Use when questions need up-to-date information from the web, external documentation, or recent developments.",
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
