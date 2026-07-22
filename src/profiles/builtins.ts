/**
 * Built-in harness profiles + model-string resolver.
 *
 * Profiles are matched to a model string by pattern (OpenRouter-style, e.g.
 * `anthropic/claude-sonnet-4-6`). The resolver honors a `HARNESS_PROFILE`
 * override: `off` disables profiles entirely; a name selects a specific
 * built-in.
 */
import {
  createHarnessProfile,
  EMPTY_HARNESS_PROFILE,
  type HarnessProfile,
} from "./harness.js";

/**
 * Universal Claude guidance (parallel tool calls / investigate-before-answering
 * / tool-result reflection). Adapted from upstream's
 * `builtins/anthropic-sonnet-4-6.ts` three-block suffix.
 */
const ANTHROPIC_CLAUDE_SUFFIX = `\
<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel. Prioritize calling tools simultaneously whenever the actions can be done in parallel rather than sequentially. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. Maximize use of parallel tool calls where possible to increase speed and efficiency. However, if some tool calls depend on previous calls to inform dependent values like the parameters, do NOT call these tools in parallel and instead call them sequentially. Never use placeholders or guess missing parameters in tool calls.
</use_parallel_tool_calls>

<investigate_before_answering>
Never speculate about code you have not opened. If the user references a specific file, you MUST read the file before answering. Make sure to investigate and read relevant files BEFORE answering questions about the codebase. Never make any claims about code before investigating unless you are certain of the correct answer - give grounded and hallucination-free answers.
</investigate_before_answering>

<tool_result_reflection>
After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding. Use your thinking to plan and iterate based on this new information, and then take the best next action.
</tool_result_reflection>`;

interface BuiltinProfileEntry {
  /** Stable name for the `HARNESS_PROFILE=<name>` override. */
  name: string;
  /** Does this profile apply to the given model string? */
  matches: (modelString: string) => boolean;
  /** Lazily-built frozen profile. */
  build: () => HarnessProfile;
}

/**
 * Registry of built-in profiles, checked in order. First match wins.
 */
const BUILTIN_PROFILES: BuiltinProfileEntry[] = [
  {
    name: "anthropic-claude",
    // OpenRouter Anthropic Claude models, e.g. "anthropic/claude-sonnet-4-6".
    matches: (m) => /(^|\/)anthropic\/claude-/.test(m) || /^claude-/.test(m),
    build: () =>
      createHarnessProfile({ systemPromptSuffix: ANTHROPIC_CLAUDE_SUFFIX }),
  },
];

const BUILTIN_BY_NAME = new Map(BUILTIN_PROFILES.map((e) => [e.name, e]));

/**
 * Resolve the harness profile for a model string.
 *
 * - `override === "off"` (or `HARNESS_PROFILE=off`) → no profile ({@link EMPTY_HARNESS_PROFILE}).
 * - `override === "<name>"` → that built-in by name (falls back to empty if unknown).
 * - otherwise → the first built-in whose pattern matches `modelString`, or empty.
 *
 * @param modelString - The configured model (e.g. `anthropic/claude-sonnet-4-6`).
 * @param override - Optional explicit selection (typically `HARNESS_PROFILE`).
 */
export function resolveHarnessProfile(
  modelString: string,
  override?: string,
): HarnessProfile {
  const normalized = override?.trim().toLowerCase();
  if (normalized === "off") {
    return EMPTY_HARNESS_PROFILE;
  }
  if (normalized && normalized.length > 0) {
    const entry = BUILTIN_BY_NAME.get(normalized);
    return entry ? entry.build() : EMPTY_HARNESS_PROFILE;
  }
  const match = BUILTIN_PROFILES.find((e) => e.matches(modelString));
  return match ? match.build() : EMPTY_HARNESS_PROFILE;
}

/** Names of the registered built-in profiles (for docs / diagnostics). */
export function builtinProfileNames(): string[] {
  return BUILTIN_PROFILES.map((e) => e.name);
}
