/**
 * On-disk fixtures for the skill and prompt component tests: a seed root
 * (`skills/<dir>/SKILL.md`, `prompts/<role>.md`) and host versions under a
 * component root (`<root>/<name>/.versions/<v>/{component.json,SKILL.md|prompt.md}`).
 */

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A minimal valid `SKILL.md` for skill `base`. */
export function skillMd(base: string, body = "Use this skill well.\n"): string {
  return `---\nname: ${base}\ndescription: The ${base} skill.\n---\n\n# ${base}\n\n${body}`;
}

/** Write `skills/<base>/` under a seed root, `SKILL.md` plus any extra files. */
export function writeSeedSkill(
  seedRoot: string,
  base: string,
  files: Record<string, string> = {},
): string {
  const dir = path.join(seedRoot, "skills", base);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), files["SKILL.md"] ?? skillMd(base));
  for (const [rel, text] of Object.entries(files)) {
    if (rel === "SKILL.md") continue;
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** Write `prompts/<role>.md` under a seed root. */
export function writeSeedPrompt(
  seedRoot: string,
  role: string,
  text: string,
): string {
  const file = path.join(seedRoot, "prompts", `${role}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

export interface ContentVersionOptions {
  /** Files of the version besides the manifest, by relative path. */
  files: Record<string, string>;
  /** Point `current` at this version (default false: a staged candidate). */
  current?: boolean;
  /** Manifest overrides. */
  manifest?: Record<string, unknown>;
}

/** Write a host version of `skill-<base>` / `prompt-<role>` under `root`. */
export function writeContentVersion(
  root: string,
  kind: "skill" | "prompt",
  base: string,
  version: string,
  options: ContentVersionOptions,
): string {
  const name = `${kind}-${base}`;
  const componentDir = path.join(root, name);
  const versionDir = path.join(componentDir, ".versions", version);
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, "component.json"),
    JSON.stringify(
      {
        name,
        version,
        kind,
        intent: `A test ${kind}.`,
        sdk: "^1.0.0",
        entry: kind === "skill" ? "SKILL.md" : "prompt.md",
        lineage: { parent: `${name}@1.0.0`, producedBy: "test" },
        ...options.manifest,
      },
      null,
      2,
    ),
  );
  for (const [rel, text] of Object.entries(options.files)) {
    mkdirSync(path.dirname(path.join(versionDir, rel)), { recursive: true });
    writeFileSync(path.join(versionDir, rel), text);
  }
  if (options.current === true) {
    symlinkSync(
      path.join(".versions", version),
      path.join(componentDir, "current"),
      "dir",
    );
  }
  return versionDir;
}
