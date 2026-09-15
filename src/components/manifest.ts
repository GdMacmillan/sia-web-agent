/**
 * Component manifest (`component.json`) — schema and the rules the loader
 * enforces beyond it. See `docs/COMPONENTS.md` §3.
 *
 * A manifest is flat and strict: unknown keys are an error, and a handful
 * of conventions (`entry.ts`, `contract.ts`, `depth: 0`) keep a minimal
 * manifest to a few lines.
 */

import { z } from "zod/v4";
import semver from "semver";
import path from "node:path";
import {
  parseHarnessProfileConfig,
  harnessProfileConfigSchema,
  type HarnessProfile,
} from "../profiles/harness.js";

/** What a component contributes. Exactly one thing per component. */
export const COMPONENT_KINDS = ["middleware", "tools", "service"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** Directory name and registry key rule, shared with remote server names. */
export const COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** A file reference inside the version directory: relative, no `..`. */
function isRelativeFileRef(value: string): boolean {
  if (!value || path.isAbsolute(value)) {
    return false;
  }
  const segments = value.split(/[\\/]/);
  return segments.every((segment) => segment !== "" && segment !== "..");
}

export const ComponentManifestSchema = z
  .object({
    /** Directory name and registry key. */
    name: z.string().regex(COMPONENT_NAME_PATTERN),
    /** Semver. Must equal the `.versions/<version>` directory name. */
    version: z.string().refine((value) => semver.valid(value) !== null, {
      message: "must be a valid semver version",
    }),
    /** What this component contributes. */
    kind: z.enum(COMPONENT_KINDS),
    /** One paragraph, written for a person: what this version is for. */
    intent: z.string().min(1),
    /** Semver range the entry was written against (checked against SDK_VERSION). */
    sdk: z.string().refine((value) => semver.validRange(value) !== null, {
      message: "must be a valid semver range",
    }),
    /** Relative to the version directory. */
    entry: z.string().default("entry.ts").refine(isRelativeFileRef, {
      message: "must be a relative path inside the version directory",
    }),
    contract: z.string().default("contract.ts").refine(isRelativeFileRef, {
      message: "must be a relative path inside the version directory",
    }),
    /**
     * `kind: middleware` only. Name of the bundled middleware this component
     * stands in for. Omit for a novel middleware.
     */
    replaces: z.string().min(1).optional(),
    /** Position in the component tree; 0 = top level. Recorded, not inferred. */
    depth: z.number().int().min(0).default(0),
    lineage: z
      .object({
        /** `name@version` this version was derived from, if any. */
        parent: z.string().optional(),
        /** The need that prompted this version, in the author's words. */
        need: z.string().optional(),
        /** Who or what produced it (a person, an agent id, a tool). */
        producedBy: z.string().min(1),
      })
      .strict(),
    /** Optional assembly tuning, the harness-profile config shape. */
    profile: harnessProfileConfigSchema.optional(),
  })
  .strict();

export type ComponentManifest = z.infer<typeof ComponentManifestSchema>;

export interface ParseManifestContext {
  /** The `<root>/<name>` directory name the manifest was found under. */
  dirName: string;
  /** The `.versions/<version>` directory name the `current` link resolves to. */
  versionDirName: string;
}

export type ParseManifestResult =
  | {
      ok: true;
      manifest: ComponentManifest;
      /** The manifest's `profile`, validated and constructed, when present. */
      profile: HarnessProfile | undefined;
    }
  | { ok: false; reason: string };

/** Render a zod error as one line per issue. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Parse and validate a raw manifest object against the schema and the
 * directory conventions. Never throws.
 */
export function parseComponentManifest(
  raw: unknown,
  context: ParseManifestContext,
): ParseManifestResult {
  const parsed = ComponentManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `invalid manifest: ${formatZodError(parsed.error)}`,
    };
  }
  const manifest = parsed.data;

  if (manifest.name !== context.dirName) {
    return {
      ok: false,
      reason: `manifest name "${manifest.name}" does not match directory name "${context.dirName}"`,
    };
  }
  if (manifest.version !== context.versionDirName) {
    return {
      ok: false,
      reason: `manifest version "${manifest.version}" does not match version directory "${context.versionDirName}"`,
    };
  }
  if (manifest.replaces !== undefined && manifest.kind !== "middleware") {
    return {
      ok: false,
      reason: `"replaces" is only valid for kind "middleware" (got kind "${manifest.kind}")`,
    };
  }

  let profile: HarnessProfile | undefined;
  if (manifest.profile !== undefined) {
    try {
      // Re-validates through the profile guard so a required-middleware
      // exclusion is a manifest failure, not an assembly failure.
      profile = parseHarnessProfileConfig(manifest.profile);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `invalid profile: ${message}` };
    }
  }

  return { ok: true, manifest, profile };
}
