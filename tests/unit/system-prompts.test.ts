/**
 * System Prompt Assembly Unit Tests
 *
 * Covers the capability-aware suffix: `createStandardTools()` withholds
 * `web_search` from the tool schema when no Tavily API key is configured,
 * and these prompts have to be told, or they plan around a tool that is
 * not in their tool list.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  jest,
} from "@jest/globals";

// The client is imported transitively for its `isConfigured()` check. The
// SDK is never called here, but mocking it keeps the module graph off the
// network under any future change.
jest.mock("@tavily/core", () => ({
  tavily: jest.fn(() => ({
    search: jest.fn(),
    extract: jest.fn(),
    crawl: jest.fn(),
  })),
}));

import { getSystemPrompt, clearPromptCache } from "../../src/system-prompts.js";
import { resetConfig } from "../../src/config/index.js";

const originalTavilyKey = process.env.TAVILY_API_KEY;

/** A phrase unique to `prompts/no-web-search.md`. */
const NOTICE_MARKER = "web search is unavailable";

/**
 * Pin TAVILY_API_KEY explicitly rather than inheriting it. jest.config
 * loads a local `.env`, so a developer with a real key would otherwise
 * exercise the opposite branch from CI.
 */
function setTavilyKey(key: string | undefined): void {
  if (key === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = key;
  resetConfig();
}

beforeEach(() => {
  clearPromptCache();
});

afterAll(() => {
  setTavilyKey(originalTavilyKey);
  clearPromptCache();
});

describe("getSystemPrompt — web-search capability notice", () => {
  describe("with no Tavily API key configured", () => {
    beforeEach(() => {
      setTavilyKey(undefined);
    });

    it("appends the notice to the answer prompt", async () => {
      const prompt = await getSystemPrompt("answer");
      expect(prompt.toLowerCase()).toContain(NOTICE_MARKER);
    });

    it("appends the notice to the manager prompt", async () => {
      const prompt = await getSystemPrompt("manager");
      expect(prompt.toLowerCase()).toContain(NOTICE_MARKER);
    });

    it("appends the notice LAST, after the manager's environment context", async () => {
      // Ordering is load-bearing: the notice contradicts what the base
      // prompt says about reaching the internet, so it has to come after.
      const { loadPromptFile } =
        await import("../../src/utils/prompt-loader.js");
      const notice = loadPromptFile("no-web-search").trimEnd();

      for (const name of ["manager", "answer"] as const) {
        const prompt = await getSystemPrompt(name);
        expect(prompt.toLowerCase()).toContain(NOTICE_MARKER);
        // The notice is the TAIL of the assembled prompt — for the
        // manager that means it lands after `buildSystemContext()` too.
        expect(prompt.trimEnd().endsWith(notice)).toBe(true);
      }
    });

    it("tells the agent not to plan around the tool", async () => {
      const prompt = (await getSystemPrompt("answer")).toLowerCase();
      expect(prompt).toContain("absent from your tool list");
      expect(prompt).toContain("must not plan around it");
      // Names the alternatives it DOES have.
      expect(prompt).toContain("graph memory");
    });

    it("does NOT append the notice to prompts that never mention web_search", async () => {
      // planner/researcher don't reference the tool, so the notice would
      // just be noise in their context window.
      for (const name of [
        "plan",
        "planner",
        "research",
        "researcher",
      ] as const) {
        const prompt = await getSystemPrompt(name);
        expect(prompt.toLowerCase()).not.toContain(NOTICE_MARKER);
      }
    });
  });

  describe("with a Tavily API key configured", () => {
    beforeEach(() => {
      setTavilyKey("tvly-test-key");
    });

    it("omits the notice from the answer prompt", async () => {
      const prompt = await getSystemPrompt("answer");
      expect(prompt.toLowerCase()).not.toContain(NOTICE_MARKER);
    });

    it("omits the notice from the manager prompt", async () => {
      const prompt = await getSystemPrompt("manager");
      expect(prompt.toLowerCase()).not.toContain(NOTICE_MARKER);
    });

    it("leaves the key-present prompts byte-for-byte unchanged", async () => {
      // The suffix is the empty string on this path, so the answer prompt
      // is exactly its `.md` file and nothing else.
      const { loadPromptFile } =
        await import("../../src/utils/prompt-loader.js");
      expect(await getSystemPrompt("answer")).toBe(loadPromptFile("answer"));
    });
  });
});
