/**
 * Middleware for loading and exposing agent skills to the system prompt.
 *
 * This middleware implements Anthropic's "Agent Skills" pattern with progressive disclosure:
 * 1. Parse YAML frontmatter from SKILL.md files at session start
 * 2. Inject skills metadata (name + description) into system prompt
 * 3. Agent reads full SKILL.md content when relevant to a task
 *
 * Based on the DeepAgents CLI Python implementation.
 */

import { createMiddleware, tool, type AgentMiddleware } from "langchain";
import { z } from "zod/v3";
import type { SkillMetadata, SkillsMiddlewareOptions } from "../types/skill.js";
import { listSkills, getSkillContent } from "../utils/skills-loader.js";

// Skills System Documentation Template
const SKILLS_SYSTEM_PROMPT = `

## Skills System

You have access to a skills library that provides specialized capabilities and standard operating
procedures (SOPs).

**Available Skills:**

{skills_list}

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

1. Check available skills above → See "rapids-research" skill
2. Use \`load_skill\` with skill_name "rapids-research" to get full instructions
3. Follow the skill's research workflow

Remember: Skills are tools to make you more capable and consistent. When in doubt, check if a skill
exists for the task!`;

/**
 * Format skills metadata for display in system prompt.
 *
 * @param skills - Array of skill metadata
 * @returns Formatted markdown string for system prompt injection
 */
function formatSkillsList(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return "(No skills available yet.)";
  }

  return skills
    .map((skill) => `- **${skill.name}**: ${skill.description}`)
    .join("\n");
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

  // Load skills once at middleware creation time
  let cachedSkills: SkillMetadata[] | null = null;

  const loadSkillTool = tool(
    async ({ skill_name }: { skill_name: string }) => {
      const result = getSkillContent(skillsDir, skill_name);
      if (result) {
        return result.content;
      }

      const available = (cachedSkills || listSkills(skillsDir))
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
     * Hook that runs before each agent execution.
     *
     * We load/reload skills here to capture any changes in the skills directory
     * since the last agent invocation.
     */
    beforeAgent: async () => {
      // Reload skills on every new interaction with the agent
      // This allows skills to be added/modified without restarting the server
      cachedSkills = listSkills(skillsDir);

      // No state modifications needed
      return {};
    },

    /**
     * Wraps model calls to inject skills documentation into the system prompt.
     *
     * Uses wrapModelCall (not beforeModel) because system prompt modification
     * requires access to the ModelRequest object, which only wrapModelCall provides.
     */
    wrapModelCall: async (request, handler) => {
      // Get skills (should be loaded by beforeAgent)
      const skills = cachedSkills || listSkills(skillsDir);

      // Format skills list
      const skillsList = formatSkillsList(skills);

      // Format the skills documentation
      const skillsSection = SKILLS_SYSTEM_PROMPT.replace(
        "{skills_list}",
        skillsList,
      );

      // Inject into system prompt (append to existing prompt)
      const currentPrompt = request.systemPrompt || "";
      const updatedPrompt = currentPrompt + "\n\n" + skillsSection;

      return handler({ ...request, systemPrompt: updatedPrompt });
    },
  });
}
