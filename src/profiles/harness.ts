/**
 * Harness profiles — slim, serializable.
 *
 * A HarnessProfile shapes agent behavior at assembly time — prompt tuning,
 * tool visibility, middleware composition, tool-description overrides — without
 * touching model selection. It is a **proto-genome**: a small, JSON-round-trippable
 * unit of agent configuration.
 *
 * Ported (slimmed) from upstream deepagents `profiles/harness`. Kept: the profile
 * shape, `createHarnessProfile`, the required-middleware guard, and the full zod
 * serialization surface (config schema + poisoned-key rejection) — the latter is
 * what lets profiles serve as genome snapshots/blueprints. Dropped from upstream:
 * the global-symbol registry, the merge machinery, `extraMiddleware`, and the
 * general-purpose-subagent config (not needed by this fork's slim usage).
 */
import { z } from "zod/v4";

/**
 * Middleware names that provide essential agent capabilities and cannot be
 * excluded via `excludedMiddleware`.
 */
export const REQUIRED_MIDDLEWARE_NAMES = new Set([
  "FilesystemMiddleware",
  "subAgentMiddleware",
]);

/**
 * User-facing options for creating a {@link HarnessProfile}. All optional — an
 * empty object produces a no-op profile.
 */
export interface HarnessProfileOptions {
  /** Replaces the default base agent prompt when set. Prefer `systemPromptSuffix`. */
  baseSystemPrompt?: string;
  /** Text appended to the base prompt with a blank-line separator. */
  systemPromptSuffix?: string;
  /** Per-tool description replacements keyed by tool name. */
  toolDescriptionOverrides?: Record<string, string>;
  /** Tool names to remove from the visible tool set. */
  excludedTools?: string[];
  /** Middleware names to remove from the assembled stack (required names rejected). */
  excludedMiddleware?: string[];
}

/**
 * Frozen runtime harness profile. Collection fields are narrowed (arrays →
 * `Set`, record frozen) and all fields are present.
 */
export interface HarnessProfile {
  baseSystemPrompt: string | undefined;
  systemPromptSuffix: string | undefined;
  toolDescriptionOverrides: Record<string, string>;
  excludedTools: Set<string>;
  excludedMiddleware: Set<string>;
}

/**
 * Validate a single `excludedMiddleware` entry at construction time.
 * Ported from upstream: non-empty, no `:` class-path syntax, no `_` prefix,
 * and not a required scaffolding name.
 */
function validateExcludedMiddlewareName(name: string): void {
  if (!name || !name.trim()) {
    throw new Error(
      "excludedMiddleware entries must be non-empty, non-whitespace strings.",
    );
  }
  if (name.includes(":")) {
    throw new Error(
      `excludedMiddleware entries must be plain middleware names; ` +
        `class-path syntax is not supported, got "${name}".`,
    );
  }
  if (name.startsWith("_")) {
    throw new Error(
      `excludedMiddleware entry "${name}" cannot start with "_" ` +
        `(underscore-prefixed names refer to private middleware not part of ` +
        `the public exclusion surface).`,
    );
  }
  if (REQUIRED_MIDDLEWARE_NAMES.has(name)) {
    throw new Error(
      `Cannot exclude required middleware "${name}" — it provides essential ` +
        `agent capabilities that the runtime depends on.`,
    );
  }
}

/**
 * Create a frozen {@link HarnessProfile} from user-provided options. Validates
 * excluded-middleware names, converts collections to frozen counterparts.
 */
export function createHarnessProfile(
  options: HarnessProfileOptions = {},
): HarnessProfile {
  for (const name of options.excludedMiddleware ?? []) {
    validateExcludedMiddlewareName(name);
  }

  const toolDescriptionOverrides = Object.freeze(
    Object.assign(
      Object.create(null) as Record<string, string>,
      options.toolDescriptionOverrides,
    ),
  );

  return Object.freeze({
    baseSystemPrompt: options.baseSystemPrompt,
    systemPromptSuffix: options.systemPromptSuffix,
    toolDescriptionOverrides,
    excludedTools: new Set(options.excludedTools),
    excludedMiddleware: new Set(options.excludedMiddleware),
  });
}

/** An empty no-op profile used as the default when nothing matches. */
export const EMPTY_HARNESS_PROFILE: HarnessProfile = createHarnessProfile();

// ============================================================================
// Serialization (genome snapshots / blueprints)
// ============================================================================

const POISONED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Zod schema for a harness profile from an external JSON/YAML config. `.strict()`
 * rejects unknown keys (catches typos). Ported from upstream.
 */
export const harnessProfileConfigSchema = z
  .object({
    baseSystemPrompt: z.string().optional(),
    systemPromptSuffix: z.string().optional(),
    toolDescriptionOverrides: z.record(z.string(), z.string()).optional(),
    excludedTools: z.array(z.string()).optional(),
    excludedMiddleware: z.array(z.string()).optional(),
  })
  .strict();

/** JSON/YAML-compatible shape of a harness profile. */
export type HarnessProfileConfigData = z.infer<
  typeof harnessProfileConfigSchema
>;

/**
 * Recursively reject prototype-pollution keys (`__proto__`, `constructor`,
 * `prototype`) at any depth, before schema validation. Ported from upstream.
 */
function rejectPoisonedKeys(value: unknown, path = ""): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (POISONED_KEYS.has(key)) {
      throw new Error(
        `Rejected dangerous key "${key}" at ${path || "root"} in harness profile config.`,
      );
    }
    rejectPoisonedKeys(
      (value as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
    );
  }
}

/**
 * Parse an untrusted JSON/YAML object into a validated {@link HarnessProfile}.
 * Combines poisoned-key rejection, zod schema validation, and profile
 * construction. Use for any config from files, network, or user input.
 */
export function parseHarnessProfileConfig(data: unknown): HarnessProfile {
  rejectPoisonedKeys(data);
  const parsed = harnessProfileConfigSchema.parse(data);
  return createHarnessProfile(parsed);
}

/**
 * Serialize a {@link HarnessProfile} to a JSON-compatible object, omitting
 * `undefined`/empty fields. Round-trips with {@link parseHarnessProfileConfig}.
 */
export function serializeProfile(
  profile: HarnessProfile,
): HarnessProfileConfigData {
  const result: HarnessProfileConfigData = {};
  if (profile.baseSystemPrompt !== undefined) {
    result.baseSystemPrompt = profile.baseSystemPrompt;
  }
  if (profile.systemPromptSuffix !== undefined) {
    result.systemPromptSuffix = profile.systemPromptSuffix;
  }
  if (Object.keys(profile.toolDescriptionOverrides).length > 0) {
    result.toolDescriptionOverrides = { ...profile.toolDescriptionOverrides };
  }
  if (profile.excludedTools.size > 0) {
    result.excludedTools = [...profile.excludedTools];
  }
  if (profile.excludedMiddleware.size > 0) {
    result.excludedMiddleware = [...profile.excludedMiddleware];
  }
  return result;
}
