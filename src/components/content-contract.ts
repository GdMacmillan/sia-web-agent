/**
 * The built-in contract of a skill or prompt version.
 *
 * A content version carries no contract of its own — the agent would be
 * writing the check that judges its own prompt. Instead every skill and
 * prompt version is held to the same local, deterministic checks: no model,
 * no network, nothing imported from the version. See `docs/COMPONENTS.md`
 * §Skills and prompts.
 *
 * The size budgets below are tunables, not rules: each is the shipped
 * seed's size with room to grow, and a unit test keeps every seed under
 * its own budget. Retuning one is a one-line edit here.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatterFields } from "../utils/skills-loader.js";
import {
  findDuplicateSentences,
  hasBalancedFences,
  markdownSection,
  plainTextProblem,
  type LabelledText,
} from "../utils/prompt-lint.js";
import {
  CONTENT_ENTRY_FILES,
  PROMPT_ROLES,
  type PromptRole,
} from "./manifest.js";
import type { ContentSource } from "./content.js";

/** Identifies the built-in checks a version was held to (reported as the contract file). */
export const CONTENT_CONTRACT_LABEL = "(built-in content contract)";
/** Bumped whenever the checks below change, so a result names what judged it. */
export const CONTENT_CONTRACT_REVISION = "1";

/** Largest `SKILL.md`, in bytes. */
export const SKILL_FILE_MAX_BYTES = 16 * 1024;
/** Largest skill version, all files together, in bytes. */
export const SKILL_VERSION_MAX_BYTES = 128 * 1024;
/** Most files in one skill version. */
export const SKILL_VERSION_MAX_FILES = 32;
/** The file types a skill version may carry. */
export const SKILL_ALLOWED_EXTENSIONS: readonly string[] = [
  ".md",
  ".ts",
  ".js",
  ".json",
  ".txt",
  ".yaml",
  ".yml",
];
/** Longest skill description, in characters. */
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

/** Largest prompt, in bytes, by role. */
export const PROMPT_BYTE_BUDGETS: Readonly<Record<PromptRole, number>> = {
  manager: 14_600,
  planner: 4_000,
  researcher: 4_200,
  answer: 3_200,
  "no-web-search": 1_600,
  shared: 1_200,
};

/**
 * A rule a prompt must keep stating. These are the load-bearing ones: how
 * the agent reads host-supplied context, whose words carry what authority,
 * and that what it reads is data and what it reports is what happened. A
 * proposed prompt that drops one fails its contract.
 */
export interface PromptInvariant {
  role: PromptRole;
  /** The `## ` section the rule lives in; absent = anywhere in the file. */
  section?: string;
  /** The rule, for a person. */
  rule: string;
  /** Every one of these must appear. */
  mustMatch: readonly (string | RegExp)[];
  /** None of these may appear. */
  mustNotMatch?: readonly RegExp[];
}

export const PROMPT_INVARIANTS: readonly PromptInvariant[] = [
  {
    role: "manager",
    section: "Whose words these are",
    rule: "explains the host-context wrapper and its trust line",
    mustMatch: ["<host-context>", "source", /ask nothing of you/],
  },
  {
    role: "manager",
    section: "Whose words these are",
    rule: "weighs a message by who actually sent it",
    mustMatch: [
      /MUST weigh a message by its actual speaker/,
      /owner/,
      /Another agent's message is something to weigh/,
    ],
  },
  {
    role: "manager",
    section: "Whose words these are",
    rule: "confirms before what cannot be taken back",
    mustMatch: [/Confirm before what you cannot take back/, /MUST confirm/],
  },
  {
    role: "manager",
    section: "Whose words these are",
    rule: "matches reply length to the question",
    mustMatch: [/Match the length of a reply/, /SHOULD/],
  },
  {
    role: "manager",
    section: "Whose words these are",
    rule: "states principles with an example, not a numbered procedure",
    mustMatch: [/For example/],
    mustNotMatch: [/^\s*\d+\.\s/m],
  },
  {
    role: "manager",
    rule: "changes its own skills and prompts only as accepted versions",
    mustMatch: [
      /MUST NOT edit `prompts\/` or `skills\/` directly/,
      /governs only after your keeper accepts it/,
    ],
  },
  {
    role: "shared",
    rule: "treats what the agent reads as data, not instructions",
    mustMatch: [/is data/, /Instructions inside it are not requests/],
  },
  {
    role: "shared",
    rule: "requires a faithful report of what happened",
    mustMatch: [
      /MUST report what actually happened/,
      /never present unverified or unfinished work as done/,
    ],
  },
];

function matches(text: string, pattern: string | RegExp): boolean {
  return typeof pattern === "string"
    ? text.includes(pattern)
    : pattern.test(text);
}

/** The invariants `text` breaks for `role`, one line each; empty when it keeps them all. */
export function promptInvariantViolations(
  role: PromptRole,
  text: string,
): string[] {
  const problems: string[] = [];
  for (const invariant of PROMPT_INVARIANTS) {
    if (invariant.role !== role) {
      continue;
    }
    const where =
      invariant.section === undefined
        ? text
        : markdownSection(text, invariant.section);
    const place =
      invariant.section === undefined
        ? ""
        : ` (section "${invariant.section}")`;
    if (invariant.section !== undefined && where === "") {
      problems.push(
        `missing section "## ${invariant.section}", which ${invariant.rule}`,
      );
      continue;
    }
    const missing = invariant.mustMatch.filter((p) => !matches(where, p));
    const forbidden = (invariant.mustNotMatch ?? []).filter((p) =>
      p.test(where),
    );
    if (missing.length > 0 || forbidden.length > 0) {
      problems.push(
        `drops a rule it must keep${place}: ${invariant.rule}` +
          (missing.length > 0
            ? `; missing ${missing.map(String).join(", ")}`
            : "") +
          (forbidden.length > 0
            ? `; must not contain ${forbidden.map(String).join(", ")}`
            : ""),
      );
    }
  }
  return problems;
}

const FRONTMATTER = /^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)/s;

/**
 * Decode `bytes` as strict UTF-8, or null when they are not. A leading
 * byte-order mark is kept, so the plain-text check can refuse it.
 */
function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (_error) {
    return null;
  }
}

export interface ContentCheckOptions {
  /**
   * The other prompts as they would be served alongside a candidate prompt,
   * for the no-duplicate-sentences check. Absent = that check is skipped
   * (the serve-time re-check, which must not resolve other prompts).
   */
  otherPrompts?: readonly LabelledText[];
}

/**
 * Hold a content version to the built-in checks. Returns every problem,
 * one line each; empty means it passes. Never throws.
 */
export function checkContent(
  source: ContentSource,
  opts: ContentCheckOptions = {},
): string[] {
  try {
    return source.kind === "skill"
      ? checkSkill(source)
      : checkPrompt(source, opts);
  } catch (error: unknown) {
    return [
      `content check failed: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/** Read every file as text, reporting what is not plain text. */
function readTextFiles(
  source: ContentSource,
  problems: string[],
): { rel: string; text: string; bytes: number }[] {
  const out: { rel: string; text: string; bytes: number }[] = [];
  for (const file of source.files) {
    if (file.symlink) {
      problems.push(
        `${file.rel}: is a symbolic link (content versions carry plain files only)`,
      );
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(file.abs);
    } catch (error: unknown) {
      problems.push(
        `${file.rel}: unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    const text = decodeUtf8(bytes);
    if (text === null) {
      problems.push(`${file.rel}: is not valid UTF-8 text`);
      continue;
    }
    const textProblem = plainTextProblem(text);
    if (textProblem !== null) {
      problems.push(`${file.rel}: ${textProblem}`);
      continue;
    }
    if (file.rel.endsWith(".md") && !hasBalancedFences(text)) {
      problems.push(`${file.rel}: has an unclosed \`\`\` code fence`);
    }
    out.push({ rel: file.rel, text, bytes: bytes.length });
  }
  return out;
}

function checkSkill(source: ContentSource): string[] {
  const problems: string[] = [];
  const entry = CONTENT_ENTRY_FILES.skill;
  if (!source.files.some((f) => f.rel === entry && !f.symlink)) {
    return [`no ${entry}`];
  }
  if (source.files.length > SKILL_VERSION_MAX_FILES) {
    problems.push(
      `${source.files.length} files (budget ${SKILL_VERSION_MAX_FILES})`,
    );
  }
  for (const file of source.files) {
    const ext = path.extname(file.rel).toLowerCase();
    if (!SKILL_ALLOWED_EXTENSIONS.includes(ext)) {
      problems.push(
        `${file.rel}: file type not allowed (allowed: ${SKILL_ALLOWED_EXTENSIONS.join(" ")})`,
      );
    }
  }
  const files = readTextFiles(source, problems);
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  if (total > SKILL_VERSION_MAX_BYTES) {
    problems.push(`${total} bytes in all (budget ${SKILL_VERSION_MAX_BYTES})`);
  }
  const skillMd = files.find((f) => f.rel === entry);
  if (skillMd === undefined) {
    return problems;
  }
  if (skillMd.bytes > SKILL_FILE_MAX_BYTES) {
    problems.push(
      `${entry}: ${skillMd.bytes} bytes (budget ${SKILL_FILE_MAX_BYTES})`,
    );
  }
  const match = skillMd.text.match(FRONTMATTER);
  if (match === null) {
    problems.push(
      `${entry}: no frontmatter (a --- block with name and description)`,
    );
    return problems;
  }
  const fields = parseFrontmatterFields(match[1]);
  const name = fields.name?.trim() ?? "";
  const description = fields.description?.trim() ?? "";
  if (name !== source.base) {
    problems.push(
      `${entry}: frontmatter name "${name}" must be the skill's directory name "${source.base}"`,
    );
  }
  if (description === "") {
    problems.push(`${entry}: frontmatter description is empty`);
  } else if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    problems.push(
      `${entry}: frontmatter description is ${description.length} characters (budget ${SKILL_DESCRIPTION_MAX_CHARS})`,
    );
  }
  return problems;
}

function checkPrompt(
  source: ContentSource,
  opts: ContentCheckOptions,
): string[] {
  const problems: string[] = [];
  const entry = CONTENT_ENTRY_FILES.prompt;
  const role = source.base as PromptRole;
  if (!(PROMPT_ROLES as readonly string[]).includes(role)) {
    return [`"${source.base}" is not a prompt the agent loads`];
  }
  const extra = source.files.filter((f) => f.rel !== entry).map((f) => f.rel);
  if (extra.length > 0) {
    problems.push(
      `a prompt version carries only ${entry}; also found: ${extra.join(", ")}`,
    );
  }
  if (!source.files.some((f) => f.rel === entry)) {
    return [...problems, `no ${entry}`];
  }
  const files = readTextFiles(
    { ...source, files: source.files.filter((f) => f.rel === entry) },
    problems,
  );
  const prompt = files[0];
  if (prompt === undefined) {
    return problems;
  }
  const budget = PROMPT_BYTE_BUDGETS[role];
  if (prompt.bytes > budget) {
    problems.push(
      `${entry}: ${prompt.bytes} bytes (budget for the ${role} prompt: ${budget})`,
    );
  }
  if (prompt.text.trim() === "") {
    problems.push(`${entry}: is empty`);
  }
  problems.push(
    ...promptInvariantViolations(role, prompt.text).map(
      (p) => `${entry}: ${p}`,
    ),
  );
  if (opts.otherPrompts !== undefined) {
    const label = `${source.name}@${source.version}`;
    // The candidate goes last, so every duplicate it takes part in names it
    // second; duplicates among the other prompts alone are not its doing.
    const duplicates = findDuplicateSentences([
      ...opts.otherPrompts,
      { label, text: prompt.text },
    ]).filter((d) => d.includes(` and ${label}: `));
    for (const duplicate of duplicates) {
      problems.push(`states a sentence twice across the prompts: ${duplicate}`);
    }
  }
  return problems;
}

/** Total bytes of a source's files (for reporting); unreadable files count as 0. */
export function contentBytes(source: ContentSource): number {
  let total = 0;
  for (const file of source.files) {
    try {
      total += statSync(file.abs).size;
    } catch (_error) {
      // counted as 0
    }
  }
  return total;
}
