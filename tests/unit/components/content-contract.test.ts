/**
 * The built-in contract of a skill or prompt version: every shipped seed
 * passes it (so each budget is a seed's size with room to grow), and each
 * check refuses what it exists to refuse.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  listSeedContent,
  seedContentSource,
  versionContentSource,
} from "../../../src/components/content.js";
import {
  PROMPT_BYTE_BUDGETS,
  SKILL_FILE_MAX_BYTES,
  SKILL_VERSION_MAX_BYTES,
  checkContent,
  contentBytes,
  promptInvariantViolations,
} from "../../../src/components/content-contract.js";
import { PROMPT_ROLES } from "../../../src/components/manifest.js";
import { makeRoot, removeRoot } from "./fixtures.js";
import { skillMd, writeContentVersion } from "./content-fixtures.js";

const otherPromptsThan = (role: string) =>
  PROMPT_ROLES.filter((r) => r !== role).map((r) => {
    const source = seedContentSource("prompt", r);
    return {
      label: `prompt-${r}@1.0.0`,
      text: source === null ? "" : readFileSync(source.file, "utf-8"),
    };
  });

describe("the shipped seeds", () => {
  it("ships every prompt role", () => {
    expect(listSeedContent("prompt")).toEqual([...PROMPT_ROLES]);
  });

  it.each(listSeedContent("skill"))("skill %s passes its contract", (base) => {
    const source = seedContentSource("skill", base);
    expect(source).not.toBeNull();
    expect(checkContent(source!)).toEqual([]);
    expect(contentBytes(source!)).toBeLessThanOrEqual(SKILL_VERSION_MAX_BYTES);
  });

  it.each([...PROMPT_ROLES])("prompt %s passes its contract", (role) => {
    const source = seedContentSource("prompt", role);
    expect(source).not.toBeNull();
    expect(
      checkContent(source!, { otherPrompts: otherPromptsThan(role) }),
    ).toEqual([]);
    expect(contentBytes(source!)).toBeLessThanOrEqual(
      PROMPT_BYTE_BUDGETS[role],
    );
  });
});

describe("checkContent — skills", () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot("content-contract-");
  });
  afterEach(() => removeRoot(root));

  const skill = (files: Record<string, string>, base = "probe") =>
    versionContentSource(
      "skill",
      base,
      "1.0.1",
      writeContentVersion(root, "skill", base, "1.0.1", { files }),
    );

  it("passes a minimal skill", () => {
    expect(checkContent(skill({ "SKILL.md": skillMd("probe") }))).toEqual([]);
  });

  it("needs a SKILL.md", () => {
    expect(checkContent(skill({ "notes.md": "x\n" }))).toEqual(["no SKILL.md"]);
  });

  it("needs frontmatter naming the directory, with a description", () => {
    expect(checkContent(skill({ "SKILL.md": "# no frontmatter\n" }))).toEqual([
      expect.stringContaining("no frontmatter"),
    ]);
    expect(checkContent(skill({ "SKILL.md": skillMd("other") }))).toEqual([
      expect.stringContaining('must be the skill\'s directory name "probe"'),
    ]);
    expect(
      checkContent(
        skill({ "SKILL.md": "---\nname: probe\ndescription:\n---\nbody\n" }),
      ),
    ).toEqual([expect.stringContaining("description is empty")]);
  });

  it("refuses a file type outside the allowlist", () => {
    const problems = checkContent(
      skill({ "SKILL.md": skillMd("probe"), "tool.sh": "echo hi\n" }),
    );
    expect(problems).toEqual([
      expect.stringContaining("tool.sh: file type not allowed"),
    ]);
  });

  it("refuses an oversized SKILL.md", () => {
    const big = skillMd(
      "probe",
      `${"word ".repeat(SKILL_FILE_MAX_BYTES / 4)}\n`,
    );
    expect(checkContent(skill({ "SKILL.md": big }))).toEqual([
      expect.stringContaining(`budget ${SKILL_FILE_MAX_BYTES}`),
    ]);
  });

  it("refuses control characters, a BOM and an unclosed fence", () => {
    expect(
      checkContent(skill({ "SKILL.md": `${skillMd("probe")}bell\u0007\n` })),
    ).toEqual([expect.stringContaining("control character U+0007")]);
    expect(
      checkContent(
        skill({
          "SKILL.md": `${String.fromCharCode(0xfeff)}${skillMd("probe")}`,
        }),
      ),
    ).toEqual([expect.stringContaining("byte-order mark")]);
    expect(
      checkContent(skill({ "SKILL.md": `${skillMd("probe")}\`\`\`ts\nx\n` })),
    ).toEqual([expect.stringContaining("unclosed ``` code fence")]);
  });

  it("refuses a symbolic link and never follows it", () => {
    const dir = writeContentVersion(root, "skill", "probe", "1.0.1", {
      files: { "SKILL.md": skillMd("probe") },
    });
    writeFileSync(path.join(root, "secret.md"), "outside\n");
    symlinkSync(path.join(root, "secret.md"), path.join(dir, "linked.md"));
    const problems = checkContent(
      versionContentSource("skill", "probe", "1.0.1", dir),
    );
    expect(problems).toEqual([
      expect.stringContaining("linked.md: is a symbolic link"),
    ]);
  });
});

describe("checkContent — prompts", () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot("content-contract-");
  });
  afterEach(() => removeRoot(root));

  const shippedManager = (): string =>
    readFileSync(seedContentSource("prompt", "manager")!.file, "utf-8");

  const prompt = (role: string, files: Record<string, string>) =>
    versionContentSource(
      "prompt",
      role,
      "1.0.1",
      writeContentVersion(root, "prompt", role, "1.0.1", { files }),
    );

  it("passes the shipped manager prompt as a version", () => {
    expect(
      checkContent(prompt("manager", { "prompt.md": shippedManager() }), {
        otherPrompts: otherPromptsThan("manager"),
      }),
    ).toEqual([]);
  });

  it("carries only prompt.md", () => {
    expect(
      checkContent(
        prompt("manager", { "prompt.md": shippedManager(), "extra.md": "x\n" }),
      ),
    ).toEqual([expect.stringContaining("also found: extra.md")]);
  });

  it("holds the prompt to its role's byte budget", () => {
    const padded = `${shippedManager()}\n${"pad ".repeat(PROMPT_BYTE_BUDGETS.manager / 4)}\n`;
    expect(checkContent(prompt("manager", { "prompt.md": padded }))).toEqual([
      expect.stringContaining(
        `budget for the manager prompt: ${PROMPT_BYTE_BUDGETS.manager}`,
      ),
    ]);
  });

  it("refuses a prompt that drops a load-bearing rule", () => {
    const dropped = shippedManager().replace(
      /MUST weigh a message by its actual speaker/,
      "may weigh messages",
    );
    expect(checkContent(prompt("manager", { "prompt.md": dropped }))).toEqual([
      expect.stringContaining("weighs a message by who actually sent it"),
    ]);
    const noSection = shippedManager().replace(
      "## Whose words these are",
      "## Something else",
    );
    expect(
      checkContent(prompt("manager", { "prompt.md": noSection })).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a manager prompt that lets the agent edit itself directly", () => {
    const loosened = shippedManager().replace(
      /You MUST NOT edit `prompts\/` or `skills\/` directly;/,
      "You may edit `prompts/` or `skills/` directly when it helps;",
    );
    expect(checkContent(prompt("manager", { "prompt.md": loosened }))).toEqual([
      expect.stringContaining(
        "changes its own skills and prompts only as accepted versions",
      ),
    ]);
  });

  it("refuses a sentence another prompt already states", () => {
    const shared = otherPromptsThan("manager").find(
      (p) => p.label === "prompt-shared@1.0.0",
    )!.text;
    const sentence = shared.match(
      /[^.\n]*MUST report what actually happened[^.\n]*\./,
    )![0];
    const repeated = `${shippedManager()}\n${sentence}\n`;
    expect(
      checkContent(prompt("manager", { "prompt.md": repeated }), {
        otherPrompts: otherPromptsThan("manager"),
      }),
    ).toEqual([
      expect.stringContaining("states a sentence twice across the prompts"),
    ]);
  });

  it("knows only the prompts the agent loads", () => {
    const dir = writeContentVersion(root, "prompt", "manager", "1.0.2", {
      files: { "prompt.md": "x\n" },
    });
    expect(
      checkContent(
        versionContentSource("prompt", "pirate" as never, "1.0.2", dir),
      ),
    ).toEqual([expect.stringContaining("is not a prompt the agent loads")]);
  });

  it("finds every invariant in the shipped prompts", () => {
    for (const role of PROMPT_ROLES) {
      const text = readFileSync(
        seedContentSource("prompt", role)!.file,
        "utf-8",
      );
      expect(promptInvariantViolations(role, text)).toEqual([]);
    }
  });
});
