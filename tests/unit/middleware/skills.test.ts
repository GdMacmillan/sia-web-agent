/**
 * Skills Middleware Tests
 *
 * Tests for createSkillsMiddleware - the middleware that loads skills
 * from the filesystem and injects them into the system prompt.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { AIMessage } from "@langchain/core/messages";
import { createSkillsMiddleware } from "../../../src/middleware/skills.js";
import { clearSkillsCache } from "../../../src/utils/skills-loader.js";

const SKILL_TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

# ${name}

Skill content here.`;

/**
 * Helper to invoke wrapModelCall and capture the systemPrompt passed to handler.
 * Returns the systemPrompt string that would be sent to the model.
 */
async function getInjectedSystemPrompt(
  middleware: ReturnType<typeof createSkillsMiddleware>,
  existingPrompt = "",
): Promise<string> {
  let capturedPrompt = "";

  const mockHandler = async (req: { systemPrompt?: string }) => {
    capturedPrompt = req.systemPrompt || "";
    return new AIMessage({ content: "mock" });
  };

  await middleware.wrapModelCall!(
    { systemPrompt: existingPrompt } as any,
    mockHandler as any,
  );

  return capturedPrompt;
}

describe("Skills Middleware", () => {
  let tmpDir: string;
  let skillsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "skills-middleware-test-"));
    skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    clearSkillsCache();
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    clearSkillsCache();
  });

  describe("wrapModelCall with empty skills directory", () => {
    it("should inject '(No skills available yet.)' when no skills exist", async () => {
      const middleware = createSkillsMiddleware({ skillsDir });
      await middleware.beforeAgent({});

      const prompt = await getInjectedSystemPrompt(middleware);

      expect(prompt).toContain("(No skills available yet.)");
      expect(prompt).toContain("## Skills System");
    });
  });

  describe("wrapModelCall with a skill", () => {
    it("should include skill name and description but not path", async () => {
      const skillDir = path.join(skillsDir, "test-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      fs.writeFileSync(
        skillPath,
        SKILL_TEMPLATE("test-skill", "A test skill for verification"),
      );

      const middleware = createSkillsMiddleware({ skillsDir });
      await middleware.beforeAgent({});

      const prompt = await getInjectedSystemPrompt(middleware);

      expect(prompt).toContain("**test-skill**");
      expect(prompt).toContain("A test skill for verification");
      // Paths are no longer shown in the prompt (use load_skill tool instead)
      expect(prompt).not.toContain(skillPath);
    });
  });

  describe("wrapModelCall with multiple skills", () => {
    it("should list all skills", async () => {
      const skillDir1 = path.join(skillsDir, "skill-a");
      fs.mkdirSync(skillDir1, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir1, "SKILL.md"),
        SKILL_TEMPLATE("skill-a", "First skill"),
      );

      const skillDir2 = path.join(skillsDir, "skill-b");
      fs.mkdirSync(skillDir2, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir2, "SKILL.md"),
        SKILL_TEMPLATE("skill-b", "Second skill"),
      );

      const middleware = createSkillsMiddleware({ skillsDir });
      await middleware.beforeAgent({});

      const prompt = await getInjectedSystemPrompt(middleware);

      expect(prompt).toContain("**skill-a**");
      expect(prompt).toContain("**skill-b**");
    });
  });

  describe("beforeAgent reloads skills", () => {
    it("should reload skills on each beforeAgent call", async () => {
      const middleware = createSkillsMiddleware({ skillsDir });

      // First call with no skills
      await middleware.beforeAgent({});
      const prompt1 = await getInjectedSystemPrompt(middleware);
      expect(prompt1).toContain("(No skills available yet.)");

      // Add a skill, clear cache so listSkills picks it up
      clearSkillsCache();
      const newSkillDir = path.join(skillsDir, "new-skill");
      fs.mkdirSync(newSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(newSkillDir, "SKILL.md"),
        SKILL_TEMPLATE("new-skill", "Dynamically added"),
      );

      // Second call should reload and find the new skill
      await middleware.beforeAgent({});
      const prompt2 = await getInjectedSystemPrompt(middleware);
      expect(prompt2).toContain("**new-skill**");
      expect(prompt2).toContain("Dynamically added");
      expect(prompt2).not.toContain("(No skills available yet.)");
    });
  });

  describe("load_skill tool", () => {
    it("should be provided by the middleware", () => {
      const middleware = createSkillsMiddleware({ skillsDir });

      expect(middleware.tools).toBeDefined();
      expect(middleware.tools).toHaveLength(1);
      expect(middleware.tools![0].name).toBe("load_skill");
    });

    it("should return skill content when skill exists", async () => {
      const skillDir = path.join(skillsDir, "test-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillContent = SKILL_TEMPLATE("test-skill", "A test skill");
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillContent);

      const middleware = createSkillsMiddleware({ skillsDir });
      await middleware.beforeAgent({});

      const loadSkill = middleware.tools![0];
      const result = await loadSkill.invoke({ skill_name: "test-skill" });

      expect(result).toBe(skillContent);
    });

    it("should return error with available skills when skill not found", async () => {
      const skillDir = path.join(skillsDir, "existing-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        SKILL_TEMPLATE("existing-skill", "An existing skill"),
      );

      const middleware = createSkillsMiddleware({ skillsDir });
      await middleware.beforeAgent({});

      const loadSkill = middleware.tools![0];
      const result = await loadSkill.invoke({ skill_name: "nonexistent" });

      expect(result).toContain('Skill "nonexistent" not found');
      expect(result).toContain("existing-skill");
    });
  });

  describe("non-existent directory", () => {
    it("should handle gracefully without crashing", async () => {
      const nonExistentDir = path.join(tmpDir, "does-not-exist");
      const middleware = createSkillsMiddleware({
        skillsDir: nonExistentDir,
      });

      await expect(middleware.beforeAgent({})).resolves.not.toThrow();

      const prompt = await getInjectedSystemPrompt(middleware);
      expect(prompt).toContain("(No skills available yet.)");
    });
  });

  describe("skills section injected into existing system prompt", () => {
    it("should append skills section to existing system prompt content", async () => {
      const skillDir = path.join(skillsDir, "appended-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        SKILL_TEMPLATE("appended-skill", "Appended skill"),
      );

      const middleware = createSkillsMiddleware({ skillsDir });
      const existingPrompt = "You are a helpful assistant.";

      await middleware.beforeAgent({});
      const prompt = await getInjectedSystemPrompt(middleware, existingPrompt);

      // Original prompt should still be present
      expect(prompt).toContain(existingPrompt);
      // Skills section should be appended
      expect(prompt).toContain("## Skills System");
      expect(prompt).toContain("**appended-skill**");
      // Original prompt should come before skills section
      const origIdx = prompt.indexOf(existingPrompt);
      const skillsIdx = prompt.indexOf("## Skills System");
      expect(origIdx).toBeLessThan(skillsIdx);
    });
  });
});
