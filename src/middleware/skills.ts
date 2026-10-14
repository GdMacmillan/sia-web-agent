/**
 * Middleware for loading and exposing agent skills.
 *
 * This middleware implements Anthropic's "Agent Skills" pattern with progressive disclosure:
 * 1. Parse YAML frontmatter from SKILL.md files (once per process)
 * 2. Expose skills metadata (name + description) to the model
 * 3. Agent reads full SKILL.md content when relevant to a task
 *
 * The how-to-use instructions are static and go in the system prompt. The
 * list itself is sent as a session context message at the head of every
 * request, so the system prompt's bytes don't depend on which skills are
 * installed.
 *
 * Based on the DeepAgents CLI Python implementation.
 */

import { createMiddleware, tool, type AgentMiddleware } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod/v3";
import type { SkillMetadata, SkillsMiddlewareOptions } from "../types/skill.js";
import {
  getServedSkillContent,
  listServedSkills,
} from "../components/content-serving.js";
import { wrapHostContext } from "../utils/host-context.js";

// Skills System Documentation Template. The one home for how to use skills;
// the agent prompts do not repeat it.
const SKILLS_SYSTEM_PROMPT = `

## Skills System

Skills are written procedures for particular kinds of work, kept out of your context until you need
them. The installed skills are listed in the context message at the start of the conversation.
When a task falls within a skill's description, load it with \`load_skill\` before you start and
follow it, adapting it where your task differs. For example, asked to research recent developments
in a field, you would load "rapids-research" first.`;

/**
 * Format skills metadata as a markdown list, one line per skill.
 *
 * @param skills - Array of skill metadata
 * @returns Formatted markdown list
 */
function formatSkillsList(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return "(No skills available yet.)";
  }

  return skills
    .map(
      (skill) =>
        `- **${skill.name}**: ${skill.description.replace(/\s+/g, " ").trim()}`,
    )
    .join("\n");
}

/**
 * Build the session context message carrying the skills list.
 *
 * @param skills - Array of skill metadata
 * @returns The tagged message sent at the head of each request
 */
export function buildSkillsContextMessage(
  skills: SkillMetadata[],
): HumanMessage {
  return new HumanMessage({
    content: wrapHostContext(
      { source: "host", kind: "skills" },
      `**Available Skills:**\n\n${formatSkillsList(skills)}`,
    ),
  });
}

/**
 * Create skills middleware for loading and exposing agent skills.
 *
 * This middleware:
 * - Loads skills metadata (name, description) from YAML frontmatter on initialization
 * - Injects skills list into system prompt for discoverability
 * - Agent reads full SKILL.md content when a skill is relevant (progressive disclosure)
 *
 * @param options - Configuration options
 * @returns AgentMiddleware instance
 */
export function createSkillsMiddleware(
  options: SkillsMiddlewareOptions,
): AgentMiddleware {
  const { skillsDir } = options;
  const serveOpts =
    options.componentRoots !== undefined
      ? { roots: options.componentRoots }
      : {};

  const loadSkillTool = tool(
    async ({ skill_name }: { skill_name: string }) => {
      const result = getServedSkillContent(skillsDir, skill_name, serveOpts);
      if (result) {
        // A skill served from a version is not where the source tree keeps
        // it; say where, so its supporting files are read from there.
        return result.source?.origin === "version"
          ? `(Served from ${result.source.name}@${result.source.version}, in ${result.source.dir}; read any supporting files it names from there.)\n\n${result.content}`
          : result.content;
      }

      const available = listServedSkills(skillsDir, serveOpts)
        .map((s) => s.name)
        .join(", ");
      return `Skill "${skill_name}" not found. Available skills: ${available}`;
    },
    {
      name: "load_skill",
      description:
        "Load full instructions for a skill by name. Returns the complete SKILL.md content.",
      schema: z.object({
        skill_name: z
          .string()
          .describe(
            "Name of the skill to load (e.g., 'rapids-research', 'code-execution')",
          ),
      }),
    },
  );

  return createMiddleware({
    name: "skillsMiddleware",
    tools: [loadSkillTool],

    /**
     * Wraps model calls: appends the static skills instructions to the system
     * prompt and puts the skills list in a context message at the head of the
     * request's messages.
     *
     * The list comes from `listServedSkills` — the skills directory plus
     * any skill version the host has activated — read once per process, so
     * the message is byte-identical from call to call. A skill added on
     * disk, or a version activated, is picked up on the next restart.
     *
     * Uses wrapModelCall (not beforeModel) because both changes are to the
     * outgoing request only; nothing is written to state.
     */
    wrapModelCall: async (request, handler) => {
      const skillsMessage = buildSkillsContextMessage(
        listServedSkills(skillsDir, serveOpts),
      );

      // Inject into system prompt (append to existing prompt)
      const currentPrompt = request.systemPrompt || "";
      const updatedPrompt = currentPrompt + "\n\n" + SKILLS_SYSTEM_PROMPT;

      return handler({
        ...request,
        systemPrompt: updatedPrompt,
        messages: [skillsMessage, ...request.messages],
      });
    },
  });
}
