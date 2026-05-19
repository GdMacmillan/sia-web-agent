/**
 * Type definitions for the skills system.
 *
 * Skills follow Anthropic's pattern with YAML front matter and markdown body.
 * Each skill is a directory containing a SKILL.md file with:
 * - YAML frontmatter (name, description required)
 * - Markdown instructions for the agent
 * - Optional supporting files (scripts, configs, etc.)
 */

/**
 * Metadata parsed from a skill's YAML front matter.
 */
export interface SkillMetadata {
  /** Name of the skill (from YAML front matter) */
  name: string;

  /** Description of what the skill does (from YAML front matter) */
  description: string;

  /** Absolute path to the SKILL.md file */
  path: string;
}

/**
 * Options for configuring the skills loader.
 */
export interface SkillsLoaderOptions {
  /** Absolute path to the skills directory (e.g., /path/to/project/skills) */
  skillsDir: string;
}

/**
 * Options for configuring the skills middleware.
 */
export interface SkillsMiddlewareOptions {
  /** Absolute path to the skills directory */
  skillsDir: string;
}
