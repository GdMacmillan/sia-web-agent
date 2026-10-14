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
import { listSkills, getSkillContent } from "../utils/skills-loader.js";
import { wrapHostContext } from "../utils/host-context.js";

// Skills System Documentation Template
const SKILLS_SYSTEM_PROMPT = `

## Skills System

You have access to a skills library that provides specialized capabilities and standard operating
procedures (SOPs). The available skills are listed in the session context message at the start of
the conversation.

**How to Use Skills:**

1. **Recognize when a skill applies**: Check if the user's task matches any skill's description
2. **Load the skill**: Use the \`load_skill\` tool with the skill name to get full instructions
3. **Follow the skill's workflow**: The loaded content contains step-by-step procedures, best practices, and examples

**When to Use Skills:**
- When the user's request matches a skill's domain (e.g., "research X" → rapids-research skill)
- When you need specialized knowledge or structured workflows
- When a skill provides proven patterns for complex tasks

**Example Workflow:**

User: "Can you research the latest developments in quantum computing?"

1. Check the available skills list → See "rapids-research" skill
2. Use \`load_skill\` with skill_name "rapids-research" to get full instructions
3. Follow the skill's research workflow

Remember: Skills are tools to make you more capable and consistent. When in doubt, check if a skill
exists for the task!`;

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
      "session",
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

  const loadSkillTool = tool(
    async ({ skill_name }: { skill_name: string }) => {
      const result = getSkillContent(skillsDir, skill_name);
      if (result) {
        return result.content;
      }

      const available = listSkills(skillsDir)
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
     * The list comes from `listSkills`, which reads the directory once per
     * process, so the message is byte-identical from call to call. A skill
     * added on disk is picked up on the next restart.
     *
     * Uses wrapModelCall (not beforeModel) because both changes are to the
     * outgoing request only; nothing is written to state.
     */
    wrapModelCall: async (request, handler) => {
      const skillsMessage = buildSkillsContextMessage(listSkills(skillsDir));

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
