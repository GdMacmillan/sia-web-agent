/**
 * Skills Middleware Tests
 *
 * Tests for createSkillsMiddleware - the middleware that loads skills from
 * the filesystem, appends static usage instructions to the system prompt, and
 * sends the skills list as a session context message at the head of the
 * request.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createSkillsMiddleware } from "../../../src/middleware/skills.js";
import { clearSkillsCache } from "../../../src/utils/skills-loader.js";
import { wrapHostContext } from "../../../src/utils/host-context.js";

const SKILL_TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

# ${name}

Skill content here.`;

interface Captured {
  systemPrompt: string;
  messages: BaseMessage[];
}

/**
 * Invoke wrapModelCall and capture what the handler receives.
 */
async function captureRequest(
  middleware: ReturnType<typeof createSkillsMiddleware>,
  existingPrompt = "",
  messages: BaseMessage[] = [new HumanMessage("hello")],
): Promise<Captured> {
  let captured: Captured = { systemPrompt: "", messages: [] };

  const mockHandler = async (req: {
    systemPrompt?: string;
    messages: BaseMessage[];
  }) => {
    captured = { systemPrompt: req.systemPrompt || "", messages: req.messages };
    return new AIMessage({ content: "mock" });
  };

  await middleware.wrapModelCall!(
    { systemPrompt: existingPrompt, messages } as any,
    mockHandler as any,
  );

  return captured;
}

function headText(captured: Captured): string {
  return captured.messages[0].text;
}

function writeSkill(skillsDir: string, name: string, description: string) {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, SKILL_TEMPLATE(name, description));
  return file;
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

  describe("with an empty skills directory", () => {
    it("says no skills are available in the session message", async () => {
      const middleware = createSkillsMiddleware({ skillsDir });

      const captured = await captureRequest(middleware);

      expect(headText(captured)).toContain("(No skills available yet.)");
      expect(captured.systemPrompt).toContain("## Skills System");
      expect(captured.systemPrompt).not.toContain("(No skills available yet.)");
    });
  });

  describe("with a skill", () => {
    it("lists name and description (not path) in the session message only", async () => {
      const skillPath = writeSkill(
        skillsDir,
        "test-skill",
        "A test skill for verification",
      );

      const middleware = createSkillsMiddleware({ skillsDir });
      const captured = await captureRequest(middleware);

      expect(headText(captured)).toContain("**test-skill**");
      expect(headText(captured)).toContain("A test skill for verification");
      expect(headText(captured)).not.toContain(skillPath);
      // The list never reaches the system prompt.
      expect(captured.systemPrompt).not.toContain("test-skill");
      expect(captured.systemPrompt).not.toContain(
        "A test skill for verification",
      );
    });

    it("renders a block-scalar description on one line", async () => {
      const dir = path.join(skillsDir, "multi-line");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---
name: multi-line
description: |
  First line of the description,
  second line of it.
---

body`,
      );

      const middleware = createSkillsMiddleware({ skillsDir });
      const captured = await captureRequest(middleware);

      expect(headText(captured)).toContain(
        "- **multi-line**: First line of the description, second line of it.",
      );
    });
  });

  describe("with multiple skills", () => {
    it("lists all skills in name order", async () => {
      writeSkill(skillsDir, "skill-b", "Second skill");
      writeSkill(skillsDir, "skill-a", "First skill");

      const middleware = createSkillsMiddleware({ skillsDir });
      const text = headText(await captureRequest(middleware));

      expect(text).toContain("**skill-a**");
      expect(text).toContain("**skill-b**");
      expect(text.indexOf("**skill-a**")).toBeLessThan(
        text.indexOf("**skill-b**"),
      );
    });
  });

  describe("session context message", () => {
    it("is a tagged human message placed before the conversation", async () => {
      writeSkill(skillsDir, "tagged", "Tagged skill");
      const conversation = [new HumanMessage("first"), new AIMessage("reply")];

      const middleware = createSkillsMiddleware({ skillsDir });
      const captured = await captureRequest(middleware, "", conversation);

      expect(captured.messages).toHaveLength(3);
      expect(HumanMessage.isInstance(captured.messages[0])).toBe(true);
      expect(headText(captured)).toBe(
        wrapHostContext(
          { source: "host", kind: "skills" },
          "**Available Skills:**\n\n- **tagged**: Tagged skill",
        ),
      );
      expect(captured.messages.slice(1)).toEqual(conversation);
    });

    it("is byte-identical across calls, along with the system prompt", async () => {
      writeSkill(skillsDir, "stable", "Stable skill");
      const middleware = createSkillsMiddleware({ skillsDir });

      const first = await captureRequest(middleware, "Base.");
      const second = await captureRequest(middleware, "Base.");

      expect(second.systemPrompt).toBe(first.systemPrompt);
      expect(headText(second)).toBe(headText(first));
    });

    it("reads the directory once per process until the cache is cleared", async () => {
      const middleware = createSkillsMiddleware({ skillsDir });
      const before = headText(await captureRequest(middleware));
      expect(before).toContain("(No skills available yet.)");

      writeSkill(skillsDir, "new-skill", "Dynamically added");
      // Still the list read at first use: the session message must not
      // change underneath a running process.
      expect(headText(await captureRequest(middleware))).toBe(before);

      clearSkillsCache();
      const after = headText(await captureRequest(middleware));
      expect(after).toContain("**new-skill**");
      expect(after).toContain("Dynamically added");
      expect(after).not.toContain("(No skills available yet.)");
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

      const loadSkill = middleware.tools![0];
      const result = await loadSkill.invoke({ skill_name: "test-skill" });

      expect(result).toBe(skillContent);
    });

    it("should return error with available skills when skill not found", async () => {
      writeSkill(skillsDir, "existing-skill", "An existing skill");

      const middleware = createSkillsMiddleware({ skillsDir });

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

      const captured = await captureRequest(middleware);
      expect(headText(captured)).toContain("(No skills available yet.)");
    });
  });

  describe("skills section injected into existing system prompt", () => {
    it("should append skills section to existing system prompt content", async () => {
      writeSkill(skillsDir, "appended-skill", "Appended skill");

      const middleware = createSkillsMiddleware({ skillsDir });
      const existingPrompt = "You are a helpful assistant.";

      const { systemPrompt } = await captureRequest(middleware, existingPrompt);

      // Original prompt should still be present
      expect(systemPrompt).toContain(existingPrompt);
      // Skills section should be appended
      expect(systemPrompt).toContain("## Skills System");
      // Original prompt should come before skills section
      const origIdx = systemPrompt.indexOf(existingPrompt);
      const skillsIdx = systemPrompt.indexOf("## Skills System");
      expect(origIdx).toBeLessThan(skillsIdx);
    });
  });
});
