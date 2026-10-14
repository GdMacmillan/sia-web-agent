/**
 * Serving skills and prompts through their components: what `load_skill`,
 * the skills list and the prompt loader read. Each asks
 * `resolveContent` for the version to serve — an activated host version
 * that still passes its built-in contract, else the file shipped with the
 * source tree — so a skill or prompt the keeper accepted is what the agent
 * reads after its restart, and one that is broken never is.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SkillMetadata } from "../types/skill.js";
import { logger } from "../utils/logger.js";
import {
  MAX_SKILL_FILE_SIZE,
  getSkillContent,
  isSafePath,
  listSkills,
  parseSkillMetadata,
} from "../utils/skills-loader.js";
import {
  listEffectiveSkillBases,
  resolveContent,
  type ContentSource,
  type ResolveContentOptions,
} from "./content.js";

export interface ServeContentOptions {
  /** The component roots to search, in precedence order (default: the roots as they are now). */
  roots?: () => readonly string[];
}

interface ServedSkill {
  metadata: SkillMetadata;
  /** The skill's directory name: its component is `skill-<base>`. */
  base: string;
}

/**
 * Per skills directory, the list last built and the seed list it was built
 * from. `listSkills` returns the same array until its cache is cleared, so
 * a new seed array means rebuild — `clearSkillsCache()` clears both.
 */
const servedCache = new Map<
  string,
  { seed: SkillMetadata[]; skills: ServedSkill[] }
>();

/** The seed root a skills directory belongs to, when it is a `skills/` directory. */
function seedRootOf(skillsDir: string): string | null {
  const resolved = path.resolve(skillsDir);
  return path.basename(resolved) === "skills" ? path.dirname(resolved) : null;
}

function resolveOptions(
  seedRoot: string,
  opts: ServeContentOptions,
): ResolveContentOptions {
  return {
    seedRoot,
    ...(opts.roots !== undefined ? { roots: opts.roots() } : {}),
  };
}

function servedSkills(
  skillsDir: string,
  opts: ServeContentOptions,
): ServedSkill[] {
  const seed = listSkills(skillsDir);
  const asServed = (): ServedSkill[] =>
    seed.map((metadata) => ({
      metadata,
      base: path.basename(path.dirname(metadata.path)),
    }));
  const seedRoot = seedRootOf(skillsDir);
  if (seedRoot === null) {
    return asServed();
  }
  const cached = servedCache.get(skillsDir);
  if (cached !== undefined && cached.seed === seed) {
    return cached.skills;
  }
  const byBase = new Map(asServed().map((s) => [s.base, s]));
  const resolveOpts = resolveOptions(seedRoot, opts);
  for (const base of listEffectiveSkillBases(resolveOpts)) {
    const source = resolveContent("skill", base, resolveOpts);
    if (source === null || source.origin !== "version") {
      continue;
    }
    const metadata = parseSkillMetadata(source.file);
    if (metadata !== null) {
      byBase.set(base, { metadata, base });
    }
  }
  const skills = [...byBase.values()].sort((a, b) =>
    a.base < b.base ? -1 : a.base > b.base ? 1 : 0,
  );
  servedCache.set(skillsDir, { seed, skills });
  return skills;
}

/**
 * The skills to list, one entry per skill: the activated version's
 * frontmatter where one is served, else the seed's. Read once per process
 * (until `clearSkillsCache()`), so the list stays byte-identical turn to turn.
 */
export function listServedSkills(
  skillsDir: string,
  opts: ServeContentOptions = {},
): SkillMetadata[] {
  return servedSkills(skillsDir, opts).map((s) => s.metadata);
}

export interface ServedSkillContent {
  metadata: SkillMetadata;
  content: string;
  /** Where the content came from; null when served outside any component (a plain skills directory). */
  source: ContentSource | null;
}

/**
 * A skill's full `SKILL.md`, by name, resolved on every call. Null when no
 * listed skill has that name or its file cannot be read.
 */
export function getServedSkillContent(
  skillsDir: string,
  skillName: string,
  opts: ServeContentOptions = {},
): ServedSkillContent | null {
  const seedRoot = seedRootOf(skillsDir);
  if (seedRoot === null) {
    const plain = getSkillContent(skillsDir, skillName);
    return plain === null ? null : { ...plain, source: null };
  }
  const listed = servedSkills(skillsDir, opts).find(
    (s) => s.metadata.name === skillName,
  );
  if (listed === undefined) {
    return null;
  }
  const source = resolveContent(
    "skill",
    listed.base,
    resolveOptions(seedRoot, opts),
  );
  if (source === null) {
    return null;
  }
  try {
    if (
      source.origin === "seed" &&
      !isSafePath(source.file, path.resolve(skillsDir))
    ) {
      logger.warn(
        { skillPath: source.file },
        "Unsafe skill path in getServedSkillContent",
      );
      return null;
    }
    const size = statSync(source.file).size;
    if (size > MAX_SKILL_FILE_SIZE) {
      logger.warn(`Skill file too large (${size} bytes): ${source.file}`);
      return null;
    }
    const content = readFileSync(source.file, "utf-8");
    const metadata = parseSkillMetadata(source.file) ?? listed.metadata;
    return { metadata, content, source };
  } catch (error: unknown) {
    logger.warn(
      { error, skillPath: source.file },
      "Error reading skill content",
    );
    return null;
  }
}

/** Forget the served skills lists (tests; `clearSkillsCache()` already invalidates them). */
export function clearServedSkillsCache(): void {
  servedCache.clear();
}
