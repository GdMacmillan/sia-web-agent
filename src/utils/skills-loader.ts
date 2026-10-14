/**
 * Skills loader for parsing and loading agent skills from SKILL.md files.
 *
 * This module implements Anthropic's agent skills pattern with YAML frontmatter parsing.
 * Based on the DeepAgents CLI Python implementation.
 *
 * Each skill is a directory containing a SKILL.md file with:
 * - YAML frontmatter (name, description required)
 * - Markdown instructions for the agent
 * - Optional supporting files (scripts, configs, etc.)
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import type { SkillMetadata } from "../types/skill.js";
import { logger } from "./logger.js";

// Maximum size for SKILL.md files (10MB)
export const MAX_SKILL_FILE_SIZE = 10 * 1024 * 1024;

// Cache for skills (invalidate when directory changes)
const skillsCache: Map<string, SkillMetadata[]> = new Map();

/**
 * Check if a path is safely contained within base directory.
 *
 * This prevents directory traversal attacks via symlinks or path manipulation.
 *
 * @param path - The path to validate
 * @param baseDir - The base directory that should contain the path
 * @returns True if the path is safely within baseDir, false otherwise
 */
export function isSafePath(path: string, baseDir: string): boolean {
  try {
    // Use realpathSync to resolve all symlinks to canonical paths
    // This ensures /var and /private/var are treated as the same path on macOS
    const realPath = realpathSync(path);
    const realBase = realpathSync(baseDir);

    // Check if the resolved path is within the base directory
    const rel = relative(realBase, realPath);

    // If the relative path starts with '..', it's outside the base directory
    // Empty string means same directory, which is valid
    return rel === "" || !rel.startsWith("..");
  } catch (_error) {
    // Error resolving paths (e.g., circular symlinks, too many levels, path doesn't exist)
    return false;
  }
}

/** A top-level `key:` line (column 0). YAML requires whitespace after the colon. */
const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;

/** A block scalar header: `|` or `>`, optional chomping and indentation indicators. */
const BLOCK_SCALAR_HEADER = /^([|>])([+-]?)([1-9]?)([+-]?)\s*(?:#.*)?$/;

/**
 * Parse the top-level scalar fields of a frontmatter block.
 *
 * A deliberately small, lenient reader rather than a YAML library: skill
 * authors (people and agents alike) write descriptions that strict YAML
 * rejects — an unquoted `: ` inside a plain value, for instance — and one
 * such file must never take the whole skills list down. It understands:
 *
 * - plain values, including continuation lines indented under the key
 *   (folded into one line, as YAML does);
 * - single- and double-quoted values;
 * - block scalars (`|` literal, `>` folded) with `-` / `+` chomping and an
 *   optional explicit indentation indicator.
 *
 * Nested mappings and sequences under a key are skipped. Only column-0 keys
 * are fields; a later duplicate key wins.
 *
 * @param frontmatter - The text between the `---` delimiters
 * @returns Field name to string value
 */
export function parseFrontmatterFields(
  frontmatter: string,
): Record<string, string> {
  const lines = frontmatter.split(/\r?\n/);
  const fields: Record<string, string> = {};

  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(TOP_LEVEL_KEY);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1];
    const rest = (match[2] ?? "").trim();

    // Everything up to the next column-0 line belongs to this key.
    let j = i + 1;
    while (
      j < lines.length &&
      (lines[j].trim() === "" || /^[ \t]/.test(lines[j]))
    ) {
      j++;
    }
    const body = lines.slice(i + 1, j);
    i = j;

    const header = rest.match(BLOCK_SCALAR_HEADER);
    if (header) {
      const chomping = header[2] || header[4];
      const explicitIndent = header[3] ? Number(header[3]) : undefined;
      fields[key] = readBlockScalar(
        body,
        header[1] === ">",
        chomping,
        explicitIndent,
      );
      continue;
    }

    const continuation = body.map((line) => line.trim()).filter(Boolean);
    if (rest === "") {
      // A nested mapping or sequence is not a scalar field; skip it.
      const first = body.find((line) => line.trim() !== "");
      if (first === undefined || /^\s+(?:-\s|[\w-]+:(?:\s|$))/.test(first)) {
        continue;
      }
      fields[key] = continuation.join(" ");
      continue;
    }

    fields[key] = unquote([rest, ...continuation].join(" "));
  }

  return fields;
}

function readBlockScalar(
  body: string[],
  folded: boolean,
  chomping: string,
  explicitIndent: number | undefined,
): string {
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const firstContent = body.find((line) => line.trim() !== "");
  const indent =
    explicitIndent ?? (firstContent === undefined ? 0 : indentOf(firstContent));
  const content = body.map((line) =>
    line.trim() === "" ? "" : line.slice(Math.min(indent, indentOf(line))),
  );

  let text: string;
  if (folded) {
    // Fold runs of lines into one; blank lines become newlines. More-indented
    // lines are kept as written, as YAML does.
    text = "";
    for (let k = 0; k < content.length; k++) {
      const line = content[k];
      const previous = k > 0 ? content[k - 1] : undefined;
      if (k === 0) {
        text = line;
      } else if (line === "" || previous === "" || /^\s/.test(line)) {
        text += `\n${line}`;
      } else {
        text += ` ${line}`;
      }
    }
  } else {
    text = content.join("\n");
  }

  const stripped = text.replace(/\n+$/, "");
  if (chomping === "-") return stripped;
  if (chomping === "+") return `${text}\n`;
  return stripped === "" ? "" : `${stripped}\n`;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\nt])/g, (_m, ch: string) =>
        ch === "n" ? "\n" : ch === "t" ? "\t" : ch,
      );
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 *
 * See `parseFrontmatterFields` for what the reader accepts. Only `name` and
 * `description` are used; both are required.
 *
 * @param skillMdPath - Absolute path to the SKILL.md file
 * @returns SkillMetadata with name, description, and path, or null if parsing fails
 */
export function parseSkillMetadata(skillMdPath: string): SkillMetadata | null {
  try {
    // Security: Check file size to prevent DoS attacks
    const stats = statSync(skillMdPath);
    if (stats.size > MAX_SKILL_FILE_SIZE) {
      logger.warn(`Skill file too large (${stats.size} bytes): ${skillMdPath}`);
      return null;
    }

    const content = readFileSync(skillMdPath, "utf-8");

    // Match YAML frontmatter between --- delimiters
    const frontmatterPattern = /^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)/s;
    const match = content.match(frontmatterPattern);

    if (!match) {
      logger.warn(`No YAML frontmatter found in: ${skillMdPath}`);
      return null;
    }

    const metadata = parseFrontmatterFields(match[1]);
    const name = metadata.name?.trim();
    const description = metadata.description?.trim();

    // Validate required fields
    if (!name || !description) {
      logger.warn(
        `Missing required fields (name, description) in: ${skillMdPath}`,
      );
      return null;
    }

    return {
      name,
      description,
      path: skillMdPath,
    };
  } catch (error) {
    // Silently skip malformed or inaccessible files
    logger.warn({ error, skillMdPath }, "Error parsing skill metadata");
    return null;
  }
}

/**
 * List all skills from a single skills directory (internal helper).
 *
 * Scans the skills directory for subdirectories containing SKILL.md files,
 * parses YAML frontmatter, and returns skill metadata.
 *
 * Skills are organized as:
 * skills/
 * ├── skill-name/
 * │   ├── SKILL.md        # Required: instructions with YAML frontmatter
 * │   ├── script.py       # Optional: supporting files
 * │   └── config.json     # Optional: supporting files
 *
 * @param skillsDir - Absolute path to the skills directory
 * @returns List of skill metadata with name, description, and path
 */
function listSkillsFromDirectory(skillsDir: string): SkillMetadata[] {
  // Check if skills directory exists
  if (!existsSync(skillsDir)) {
    return [];
  }

  // Resolve base directory to canonical path for security checks
  let resolvedBase: string;
  try {
    resolvedBase = resolve(skillsDir);
  } catch (error) {
    // Can't resolve base directory, fail safe
    logger.warn({ error, skillsDir }, "Cannot resolve skills directory");
    return [];
  }

  const skills: SkillMetadata[] = [];

  try {
    // Iterate through skill directories
    // Sorted so the list's order (and so its bytes) doesn't depend on the
    // filesystem's directory order.
    const entries = readdirSync(skillsDir).sort();

    for (const entryName of entries) {
      const entryPath = resolve(skillsDir, entryName);

      // Security: Catch symlinks pointing outside the skills directory
      if (!isSafePath(entryPath, resolvedBase)) {
        logger.warn({ entryPath }, "Unsafe skill path (symlink?)");
        continue;
      }

      // Skip if not a directory or if it's a hidden directory
      if (!statSync(entryPath).isDirectory() || entryName.startsWith(".")) {
        continue;
      }

      // Look for SKILL.md file
      const skillMdPath = resolve(entryPath, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        continue;
      }

      // Security: Validate SKILL.md path is safe before reading
      if (!isSafePath(skillMdPath, resolvedBase)) {
        logger.warn({ skillMdPath }, "Unsafe SKILL.md path (symlink?)");
        continue;
      }

      // Parse metadata
      const metadata = parseSkillMetadata(skillMdPath);
      if (metadata) {
        skills.push(metadata);
      }
    }
  } catch (error) {
    logger.warn({ error, skillsDir }, "Error scanning skills directory");
  }

  return skills;
}

/**
 * List all skills from the skills directory.
 *
 * This function scans the skills directory for SKILL.md files, parses their
 * YAML frontmatter, and returns metadata for all discovered skills.
 *
 * Skills are read once per skills directory and cached for the life of the
 * process, so the list the model sees stays byte-identical from turn to turn.
 * A skill added or edited on disk is picked up on the next restart (or after
 * `clearSkillsCache()`).
 *
 * @param skillsDir - Absolute path to the skills directory
 * @returns Array of skill metadata
 */
export function listSkills(skillsDir: string): SkillMetadata[] {
  // Check cache first
  const cached = skillsCache.get(skillsDir);
  if (cached) {
    return cached;
  }

  // Load skills from directory
  const skills = listSkillsFromDirectory(skillsDir);

  // Cache results
  skillsCache.set(skillsDir, skills);

  return skills;
}

/**
 * Clear the skills cache.
 *
 * Call this when you know skills have been added, removed, or modified.
 */
export function clearSkillsCache(): void {
  skillsCache.clear();
}

/**
 * Get a specific skill by name.
 *
 * @param skillsDir - Absolute path to the skills directory
 * @param skillName - Name of the skill to retrieve
 * @returns SkillMetadata if found, null otherwise
 */
export function getSkill(
  skillsDir: string,
  skillName: string,
): SkillMetadata | null {
  const skills = listSkills(skillsDir);
  return skills.find((skill) => skill.name === skillName) || null;
}

/**
 * Get a skill's full SKILL.md content by name.
 *
 * Looks up the skill using cached metadata, validates the file path,
 * and reads the full content. Reuses existing security checks
 * (MAX_SKILL_FILE_SIZE, isSafePath).
 *
 * @param skillsDir - Absolute path to the skills directory
 * @param skillName - Name of the skill to retrieve content for
 * @returns Object with metadata and full content, or null if not found
 */
export function getSkillContent(
  skillsDir: string,
  skillName: string,
): { metadata: SkillMetadata; content: string } | null {
  const skill = getSkill(skillsDir, skillName);
  if (!skill) {
    return null;
  }

  try {
    // Security: validate path is within skills directory
    if (!isSafePath(skill.path, skillsDir)) {
      logger.warn(
        { skillPath: skill.path },
        "Unsafe skill path in getSkillContent",
      );
      return null;
    }

    // Security: check file size
    const stats = statSync(skill.path);
    if (stats.size > MAX_SKILL_FILE_SIZE) {
      logger.warn(`Skill file too large (${stats.size} bytes): ${skill.path}`);
      return null;
    }

    const content = readFileSync(skill.path, "utf-8");
    return { metadata: skill, content };
  } catch (error) {
    logger.warn(
      { error, skillPath: skill.path },
      "Error reading skill content",
    );
    return null;
  }
}
