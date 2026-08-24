/**
 * Deep Agent Setup Unit Tests
 *
 * Tests for createStandardTools and createDeepAgentComponents factory functions.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  jest,
} from "@jest/globals";

// Mock dependencies that make external calls
jest.mock("../../src/config/model-config.js", () => ({
  createChatModel: jest.fn().mockResolvedValue({
    invoke: jest.fn().mockResolvedValue({ content: "mock" }),
    bind: jest.fn(),
  }),
}));

jest.mock("../../src/backend-config.js", () => ({
  getProjectRoot: jest.fn().mockReturnValue("/mock/project/root"),
}));

import {
  createStandardTools,
  createDeepAgentComponents,
} from "../../src/deep-agent-setup.js";
import { getProjectRoot } from "../../src/backend-config.js";
import { resetConfig } from "../../src/config/index.js";

const EXPECTED_TOOL_NAMES = [
  "search",
  "bash",
  "web_search",
  "store_entity",
  "retrieve_entity",
  "search_entities",
  "list_entities",
  "update_entity_status",
  "update_entity",
  "promote_entities",
  "traverse_graph",
  "create_checklist",
  "get_checklist",
  "check_item",
  "uncheck_item",
  "set_dependencies",
  "get_ready_items",
  "delete_checklist",
];

/** Everything except `web_search`, which is key-gated. */
const EXPECTED_TOOL_NAMES_WITHOUT_WEB_SEARCH = EXPECTED_TOOL_NAMES.filter(
  (n) => n !== "web_search",
);

const originalTavilyKey = process.env.TAVILY_API_KEY;

/**
 * Pin TAVILY_API_KEY explicitly rather than inheriting it. jest.config
 * loads a local `.env`, so a developer with a real key would otherwise
 * see different tool sets than CI does.
 */
function setTavilyKey(key: string | undefined): void {
  if (key === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = key;
  // The config singleton caches env at first read.
  resetConfig();
}

afterAll(() => {
  setTavilyKey(originalTavilyKey);
});

describe("Deep Agent Setup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setTavilyKey("tvly-test-key");
  });

  describe("createStandardTools", () => {
    it("should return an array of tools with expected names", () => {
      const tools = createStandardTools("/test/project");
      const toolNames = tools.map((t) => t.name);

      for (const name of EXPECTED_TOOL_NAMES) {
        expect(toolNames).toContain(name);
      }
    });

    it("should return the correct number of tools", () => {
      const tools = createStandardTools("/test/project");
      expect(tools.length).toBe(EXPECTED_TOOL_NAMES.length);
    });

    it("should return tools that are all StructuredTool instances with name and description", () => {
      const tools = createStandardTools("/test/project");

      for (const tool of tools) {
        expect(typeof tool.name).toBe("string");
        expect(tool.name.length).toBeGreaterThan(0);
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });

    it("should have no duplicate tool names", () => {
      const tools = createStandardTools("/test/project");
      const names = tools.map((t) => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  /**
   * `web_search` is registered only when a Tavily API key is configured.
   * Without one the tool cannot succeed at anything, so advertising it in
   * the schema just invites the model to spend a turn finding that out.
   */
  describe("createStandardTools — web_search key gate", () => {
    it("omits web_search when no Tavily API key is configured", () => {
      setTavilyKey(undefined);

      const toolNames = createStandardTools("/test/project").map((t) => t.name);

      expect(toolNames).not.toContain("web_search");
      // Exactly one tool is withheld — the gate must not take anything
      // else with it.
      expect(toolNames.sort()).toEqual(
        [...EXPECTED_TOOL_NAMES_WITHOUT_WEB_SEARCH].sort(),
      );
    });

    it("omits web_search when the key is present but empty", () => {
      setTavilyKey("");

      const toolNames = createStandardTools("/test/project").map((t) => t.name);

      expect(toolNames).not.toContain("web_search");
    });

    it("includes web_search when a Tavily API key is configured", () => {
      setTavilyKey("tvly-test-key");

      const toolNames = createStandardTools("/test/project").map((t) => t.name);

      expect(toolNames).toContain("web_search");
      expect(toolNames.sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    });

    it("still returns valid StructuredTools with the gate closed", () => {
      setTavilyKey(undefined);

      for (const tool of createStandardTools("/test/project")) {
        expect(typeof tool.name).toBe("string");
        expect(tool.name.length).toBeGreaterThan(0);
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe("createDeepAgentComponents", () => {
    it("should return model, tools, and projectRoot", async () => {
      const components = await createDeepAgentComponents();

      expect(components).toHaveProperty("model");
      expect(components).toHaveProperty("tools");
      expect(components).toHaveProperty("projectRoot");
    });

    it("should use default projectRoot from getProjectRoot when not provided", async () => {
      const components = await createDeepAgentComponents();

      expect(components.projectRoot).toBe("/mock/project/root");
      expect(getProjectRoot).toHaveBeenCalled();
    });

    it("should use custom projectRoot when provided", async () => {
      const components = await createDeepAgentComponents({
        projectRoot: "/custom/root",
      });

      expect(components.projectRoot).toBe("/custom/root");
    });

    it("should use custom tools when provided", async () => {
      const mockTools = [{ name: "mock_tool" }] as any;
      const components = await createDeepAgentComponents({
        tools: mockTools,
      });

      expect(components.tools).toBe(mockTools);
      expect(components.tools).toHaveLength(1);
    });

    it("should create standard tools when none provided", async () => {
      const components = await createDeepAgentComponents();

      expect(components.tools.length).toBe(EXPECTED_TOOL_NAMES.length);
      const toolNames = components.tools.map((t) => t.name);
      expect(toolNames).toContain("search");
      expect(toolNames).toContain("bash");
    });

    it("should use custom model when provided", async () => {
      const mockModel = { invoke: jest.fn() } as any;
      const components = await createDeepAgentComponents({
        model: mockModel,
      });

      expect(components.model).toBe(mockModel);
    });
  });
});
