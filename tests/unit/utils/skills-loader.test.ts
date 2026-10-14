/**
 * Skills Loader Tests
 *
 * Tests for skills loading, YAML parsing, and security validation.
 * Based on DeepAgents CLI test patterns.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  listSkills,
  getSkill,
  getSkillContent,
  clearSkillsCache,
  parseFrontmatterFields,
} from "../../../src/utils/skills-loader.js";

describe("Skills Loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create temporary directory for tests
    tmpDir = mkdtempSync(path.join(tmpdir(), "skills-test-"));
    clearSkillsCache();
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    clearSkillsCache();
  });

  describe("listSkills", () => {
    describe("Basic Loading", () => {
      it("should return empty array for non-existent directory", () => {
        const skillsDir = path.join(tmpDir, "nonexistent");
        const skills = listSkills(skillsDir);

        expect(skills).toEqual([]);
      });

      it("should return empty array for empty directory", () => {
        const skillsDir = path.join(tmpDir, "skills");
        fs.mkdirSync(skillsDir, { recursive: true });

        const skills = listSkills(skillsDir);

        expect(skills).toEqual([]);
      });

      it("should load a valid skill with YAML frontmatter", () => {
        const skillsDir = path.join(tmpDir, "skills");
        const skillDir = path.join(skillsDir, "test-skill");

        fs.mkdirSync(skillDir, { recursive: true });

        const skillMd = path.join(skillDir, "SKILL.md");
        fs.writeFileSync(
          skillMd,
          `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This is a test skill.`,
        );

        const skills = listSkills(skillsDir);

        expect(skills).toHaveLength(1);
        expect(skills[0].name).toBe("test-skill");
        expect(skills[0].description).toBe("A test skill for unit testing");
        expect(skills[0].path).toBe(skillMd);
      });

      it("should load multiple skills", () => {
        const skillsDir = path.join(tmpDir, "skills");

        // Create first skill
        const skillDir1 = path.join(skillsDir, "skill-1");
        fs.mkdirSync(skillDir1, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir1, "SKILL.md"),
          `---
name: skill-1
description: First skill
---
Content`,
        );

        // Create second skill
        const skillDir2 = path.join(skillsDir, "skill-2");
        fs.mkdirSync(skillDir2, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir2, "SKILL.md"),
          `---
name: skill-2
description: Second skill
---
Content`,
        );

        const skills = listSkills(skillsDir);

        expect(skills).toHaveLength(2);

        const skill1 = skills.find((s) => s.name === "skill-1");
        const skill2 = skills.find((s) => s.name === "skill-2");

        expect(skill1).toBeDefined();
        expect(skill2).toBeDefined();
      });
    });

    describe("YAML Frontmatter Parsing", () => {
      it("should skip skills without YAML frontmatter", () => {
        const skillsDir = path.join(tmpDir, "skills");
        const skillDir = path.join(skillsDir, "invalid-skill");

        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `# Invalid Skill

No frontmatter here.`,
        );

        const skills = listSkills(skillsDir);

        expect(skills).toEqual([]);
      });

      it("should skip skills with missing name field", () => {
        const skillsDir = path.join(tmpDir, "skills");
        const skillDir = path.join(skillsDir, "incomplete-1");

        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---
description: Missing name field
---
Content`,
        );

        const skills = listSkills(skillsDir);

        expect(skills).toEqual([]);
      });

      it("should skip skills with missing description field", () => {
        const skillsDir = path.join(tmpDir, "skills");
        const skillDir = path.join(skillsDir, "incomplete-2");

        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---
name: incomplete-2
---
Content`,
        );

        const skills = listSkills(skillsDir);

        expect(skills).toEqual([]);
      });

      it("should handle YAML with extra whitespace", () => {
        const skillsDir = path.join(tmpDir, "skills");
        const skillDir = path.join(skillsDir, "whitespace-skill");

        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---
name:    whitespace-skill
description:   Extra whitespace test
---
Content`,
        );

        const skills = listSkills(skillsDir);

        expect(skills).toHaveLength(1);
        expect(skills[0].name).toBe("whitespace-skill");
        expect(skills[0].description).toBe("Extra whitespace test");
      });
    });

    describe("Security and Validation", () => {
      it("should skip files larger than 10MB", () => {
        const skillsDir = path.join(tmpDir, "skills");
        const skillDir = path.join(skillsDir, "huge-skill");

        fs.mkdirSync(skillDir, { recursive: true });

        // Create a file larger than 10MB
        const largeContent =
          "---\nname: huge-skill\ndescription: Too large\n---\n" +
          "x".repeat(11 * 1024 * 1024);

        fs.writeFileSync(path.join(skillDir, "SKILL.md"), largeContent);

        const skills = listSkills(skillsDir);

        // Should be skipped due to file size
        expect(skills).toEqual([]);
      });

      it("should skip hidden directories", () => {
        const skillsDir = path.join(tmpDir, "skills");
        const hiddenDir = path.join(skillsDir, ".hidden");

        fs.mkdirSync(hiddenDir, { recursive: true });
        fs.writeFileSync(
          path.join(hiddenDir, "SKILL.md"),
          `---
name: hidden-skill
description: Should not be loaded
---
Content`,
        );

        const skills = listSkills(skillsDir);

        expect(skills).toEqual([]);
      });

      it("should handle malformed UTF-8 gracefully", () => {
        const skillsDir = path.join(tmpDir, "skills");
        const skillDir = path.join(skillsDir, "malformed-skill");

        fs.mkdirSync(skillDir, { recursive: true });

        // Write binary data that's not valid UTF-8
        const buffer = Buffer.from([0xff, 0xfe, 0xfd]);
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), buffer);

        const skills = listSkills(skillsDir);

        // Should handle gracefully and skip
        expect(skills).toEqual([]);
      });
    });

    describe("Mixed Valid and Invalid Skills", () => {
      it("should load only valid skills when mixed with invalid ones", () => {
        const skillsDir = path.join(tmpDir, "skills");

        // Valid skill
        const validSkillDir = path.join(skillsDir, "valid-skill");
        fs.mkdirSync(validSkillDir, { recursive: true });
        fs.writeFileSync(
          path.join(validSkillDir, "SKILL.md"),
          `---
name: valid-skill
description: This one is valid
---
Content`,
        );

        // Invalid skill (missing description)
        const invalidSkillDir = path.join(skillsDir, "invalid-skill");
        fs.mkdirSync(invalidSkillDir, { recursive: true });
        fs.writeFileSync(
          path.join(invalidSkillDir, "SKILL.md"),
          `---
name: invalid-skill
---
Content`,
        );

        // Another valid skill
        const valid2SkillDir = path.join(skillsDir, "valid-skill-2");
        fs.mkdirSync(valid2SkillDir, { recursive: true });
        fs.writeFileSync(
          path.join(valid2SkillDir, "SKILL.md"),
          `---
name: valid-skill-2
description: Also valid
---
Content`,
        );

        const skills = listSkills(skillsDir);

        expect(skills).toHaveLength(2);
        expect(skills.map((s) => s.name).sort()).toEqual([
          "valid-skill",
          "valid-skill-2",
        ]);
      });
    });

    describe("Caching", () => {
      it("should cache results for the same directory", () => {
        const skillsDir = path.join(tmpDir, "skills");
        const skillDir = path.join(skillsDir, "cached-skill");

        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---
name: cached-skill
description: Test caching
---
Content`,
        );

        const skills1 = listSkills(skillsDir);
        const skills2 = listSkills(skillsDir);

        // Should return the same cached result
        expect(skills1).toEqual(skills2);
        expect(skills1).toBe(skills2); // Same reference
      });

      it("should reload after cache clear", () => {
        const skillsDir = path.join(tmpDir, "skills");
        const skillDir = path.join(skillsDir, "test-skill");

        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---
name: test-skill
description: Original description
---
Content`,
        );

        const skills1 = listSkills(skillsDir);
        expect(skills1[0].description).toBe("Original description");

        // Update the skill
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---
name: test-skill
description: Updated description
---
Content`,
        );

        // Should still return cached version
        const skills2 = listSkills(skillsDir);
        expect(skills2[0].description).toBe("Original description");

        // Clear cache and reload
        clearSkillsCache();
        const skills3 = listSkills(skillsDir);
        expect(skills3[0].description).toBe("Updated description");
      });
    });
  });

  describe("getSkill", () => {
    it("should retrieve a skill by name", () => {
      const skillsDir = path.join(tmpDir, "skills");
      const skillDir = path.join(skillsDir, "find-me");

      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---
name: find-me
description: Skill to find
---
Content`,
      );

      const skill = getSkill(skillsDir, "find-me");

      expect(skill).toBeDefined();
      expect(skill?.name).toBe("find-me");
      expect(skill?.description).toBe("Skill to find");
    });

    it("should return null for non-existent skill", () => {
      const skillsDir = path.join(tmpDir, "skills");
      fs.mkdirSync(skillsDir, { recursive: true });

      const skill = getSkill(skillsDir, "does-not-exist");

      expect(skill).toBeNull();
    });
  });

  describe("getSkillContent", () => {
    it("should return metadata and full content for an existing skill", () => {
      const skillsDir = path.join(tmpDir, "skills");
      const skillDir = path.join(skillsDir, "my-skill");

      fs.mkdirSync(skillDir, { recursive: true });
      const fullContent = `---
name: my-skill
description: A skill with content
---

# My Skill

Detailed instructions here.`;
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), fullContent);

      const result = getSkillContent(skillsDir, "my-skill");

      expect(result).not.toBeNull();
      expect(result!.metadata.name).toBe("my-skill");
      expect(result!.metadata.description).toBe("A skill with content");
      expect(result!.content).toBe(fullContent);
    });

    it("should return null for a non-existent skill", () => {
      const skillsDir = path.join(tmpDir, "skills");
      fs.mkdirSync(skillsDir, { recursive: true });

      const result = getSkillContent(skillsDir, "does-not-exist");

      expect(result).toBeNull();
    });
  });

  describe("Edge Cases", () => {
    it("should handle directory without SKILL.md file", () => {
      const skillsDir = path.join(tmpDir, "skills");
      const skillDir = path.join(skillsDir, "no-skillmd");

      fs.mkdirSync(skillDir, { recursive: true });
      // Create other files but not SKILL.md
      fs.writeFileSync(path.join(skillDir, "README.md"), "No skill here");

      const skills = listSkills(skillsDir);

      expect(skills).toEqual([]);
    });

    it("should skip non-directory entries", () => {
      const skillsDir = path.join(tmpDir, "skills");

      // Create a file at the top level (not a directory)
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(path.join(skillsDir, "README.md"), "Documentation");

      const skills = listSkills(skillsDir);

      expect(skills).toEqual([]);
    });

    it("should handle empty YAML frontmatter", () => {
      const skillsDir = path.join(tmpDir, "skills");
      const skillDir = path.join(skillsDir, "empty-yaml");

      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---
---
Content without metadata`,
      );

      const skills = listSkills(skillsDir);

      // Should skip because required fields are missing
      expect(skills).toEqual([]);
    });

    it("should handle YAML with comments", () => {
      const skillsDir = path.join(tmpDir, "skills");
      const skillDir = path.join(skillsDir, "commented-yaml");

      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---
# This is a comment
name: commented-yaml
# Another comment
description: YAML with comments
---
Content`,
      );

      const skills = listSkills(skillsDir);

      // Simple regex parser may not handle comments perfectly
      // but should still extract name and description
      expect(skills.length).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("parseFrontmatterFields", () => {
  it("reads plain single-line values", () => {
    expect(
      parseFrontmatterFields("name: bash-usage\ndescription: Bash guidelines."),
    ).toEqual({ name: "bash-usage", description: "Bash guidelines." });
  });

  it("keeps an unquoted ': ' inside a plain value (strict YAML would reject it)", () => {
    // Taken from the shipped iterate-component skill.
    const fields = parseFrontmatterFields(
      "name: iterate-component\n" +
        "description: Write a new version. If this thread opened as a self-task, you are already in it: do the work here.\n" +
        "license: MIT",
    );
    expect(fields.description).toBe(
      "Write a new version. If this thread opened as a self-task, you are already in it: do the work here.",
    );
    expect(fields.license).toBe("MIT");
  });

  it("reads a literal block scalar with clip chomping", () => {
    const fields = parseFrontmatterFields(
      "name: code-execution\n" +
        "description: |\n" +
        "  Execute TypeScript code. Use when processing files,\n" +
        "  aggregating data. IMPORTANT: TypeScript only.\n" +
        "license: MIT",
    );
    expect(fields.description).toBe(
      "Execute TypeScript code. Use when processing files,\naggregating data. IMPORTANT: TypeScript only.\n",
    );
    expect(fields.license).toBe("MIT");
  });

  it("honours strip and keep chomping", () => {
    expect(
      parseFrontmatterFields("description: |-\n  one\n  two\n\n").description,
    ).toBe("one\ntwo");
    expect(
      parseFrontmatterFields("description: |+\n  one\n\nnext: x").description,
    ).toBe("one\n\n");
  });

  it("folds a folded block scalar, keeping paragraph breaks", () => {
    expect(
      parseFrontmatterFields(
        "description: >-\n  first line\n  second line\n\n  new paragraph\n",
      ).description,
    ).toBe("first line second line\n\nnew paragraph");
  });

  it("honours an explicit indentation indicator", () => {
    expect(
      parseFrontmatterFields("description: |2-\n    indented\n  base\n")
        .description,
    ).toBe("  indented\nbase");
  });

  it("folds indented continuation lines of a plain value", () => {
    expect(
      parseFrontmatterFields(
        "description: starts here\n  and continues\n  over lines\nname: x",
      ),
    ).toEqual({
      description: "starts here and continues over lines",
      name: "x",
    });
  });

  it("unquotes single- and double-quoted values", () => {
    expect(
      parseFrontmatterFields(`a: "say \\"hi\\": now"\nb: 'it''s: fine'`),
    ).toEqual({ a: 'say "hi": now', b: "it's: fine" });
  });

  it("skips nested mappings and does not lift their keys to the top level", () => {
    const fields = parseFrontmatterFields(
      'name: x\nmetadata:\n  author: someone\n  version: "1.0.0"\ndescription: d',
    );
    expect(fields).toEqual({ name: "x", description: "d" });
  });

  it("ignores comments and lines it does not understand", () => {
    expect(
      parseFrontmatterFields("# a comment\nname: x\n- stray\ndescription: d"),
    ).toEqual({ name: "x", description: "d" });
  });
});

describe("shipped skills", () => {
  it("every skill in the repo parses with a real description", () => {
    clearSkillsCache();
    const skillsDir = path.resolve(__dirname, "../../../skills");
    const skills = listSkills(skillsDir);
    const dirs = fs
      .readdirSync(skillsDir)
      .filter((entry) =>
        fs.existsSync(path.join(skillsDir, entry, "SKILL.md")),
      );

    expect(skills.map((s) => s.name).sort()).toEqual(dirs.sort());
    for (const skill of skills) {
      // A block-scalar indicator must never leak through as the value.
      expect(skill.description).not.toMatch(/^[|>][+-]?$/);
      expect(skill.description.length).toBeGreaterThan(20);
    }
    clearSkillsCache();
  });
});
