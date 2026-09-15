/**
 * The component SDK: the internals namespace and the exposable-tool filter.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { tool } from "langchain";
import { z } from "zod/v4";
import semver from "semver";
import {
  SDK_VERSION,
  buildInternals,
  getExposableTools,
} from "../../../src/components/sdk.js";
import { MIDDLEWARE_ONLY_TOOL_NAMES } from "../../../src/components/names.js";
import {
  _resetComponentsForTests,
  setActiveToolPool,
} from "../../../src/components/registry.js";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "../../../src/code-execution/index.js";

function stubTool(name: string) {
  return tool(async () => name, {
    name,
    description: name,
    schema: z.object({}),
  });
}

describe("component SDK", () => {
  afterEach(() => {
    _resetComponentsForTests();
  });

  it("is a 1.x version that satisfies the seed manifest range", () => {
    expect(semver.valid(SDK_VERSION)).toBe(SDK_VERSION);
    expect(semver.satisfies(SDK_VERSION, "^1.0.0")).toBe(true);
    expect(semver.gte(SDK_VERSION, "1.1.0")).toBe(true);
  });

  it("carries the code-execution internals the seed entry uses", () => {
    const { codeExecution } = buildInternals();
    expect(typeof codeExecution.ToolEnabledExecutor).toBe("function");
    expect(typeof codeExecution.validateCode).toBe("function");
    expect(typeof codeExecution.formatCodePreview).toBe("function");
    expect(codeExecution.DEFAULT_TIMEOUT_MS).toBe(DEFAULT_TIMEOUT_MS);
    expect(codeExecution.MAX_TIMEOUT_MS).toBe(MAX_TIMEOUT_MS);
    expect(codeExecution.getExposableTools).toBe(getExposableTools);
  });

  describe("getExposableTools", () => {
    it("is empty before assembly records a pool", () => {
      expect(getExposableTools()).toEqual([]);
    });

    it("drops the middleware-only tools and keeps everything else, in order", () => {
      const pool = [
        stubTool("bash"),
        stubTool("write_todos"),
        stubTool("read_file"),
        stubTool("execute_code"),
        stubTool("task"),
        stubTool("load_skill"),
        stubTool("eval"),
        stubTool("web_search"),
      ];
      setActiveToolPool(pool);
      expect(getExposableTools().map((t) => t.name)).toEqual([
        "bash",
        "read_file",
        "web_search",
      ]);
      for (const name of MIDDLEWARE_ONLY_TOOL_NAMES) {
        expect(getExposableTools().map((t) => t.name)).not.toContain(name);
      }
    });

    it("returns the same tool objects the pool holds", () => {
      const bash = stubTool("bash");
      setActiveToolPool([bash, stubTool("execute_code")]);
      expect(getExposableTools()[0]).toBe(bash);
    });
  });
});
