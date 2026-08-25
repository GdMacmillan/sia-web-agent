/**
 * Tools API Round-Trip Tests
 *
 * End-to-end tests that execute real code importing the generated tools-api
 * through the full stack: workspace generation, IPC bridge, tsx subprocess,
 * and tool dispatch. These pin the documented import forms from the
 * code-execution skill — a regression here means the tools-api surface is
 * unusable even though generation-only tests still pass.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolEnabledExecutor } from "../../../src/code-execution/tool-enabled-executor.js";

/** Execution timeout: well under the jest timeout so a hang reports as timedOut */
const EXEC_TIMEOUT_MS = 30000;

describe("Tools API round-trip", () => {
  let tmpDir: string;
  let executor: ToolEnabledExecutor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tools-api-roundtrip-"));
    const echoTool = new DynamicStructuredTool({
      name: "echo_message",
      description: "Echo a message back",
      schema: z.object({ message: z.string().describe("Message to echo") }),
      func: async ({ message }) => `Echo: ${message}`,
    });
    executor = new ToolEnabledExecutor({
      projectRoot: tmpDir,
      tools: [echoTool],
    });
  });

  afterEach(async () => {
    await executor.cleanup();
    if (tmpDir && existsSync(tmpDir)) {
      // Give subprocess/socket handles a moment to release before rm
      await new Promise((resolve) => setTimeout(resolve, 100));
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("executes the documented double-quoted tools-api import end-to-end", async () => {
    const code = [
      'import { echoMessage } from "./tools-api/misc";',
      'const result = await echoMessage({ message: "round-trip" });',
      'console.log("TOOL_RESULT=" + result);',
    ].join("\n");

    const result = await executor.execute("roundtrip-static", code, EXEC_TIMEOUT_MS);

    expect(result.output).toContain("TOOL_RESULT=Echo: round-trip");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  }, 60000);

  it("supports dynamic import of tools-api", async () => {
    const code = [
      "const api = await import('./tools-api/misc');",
      "const result = await api.echoMessage({ message: 'dynamic' });",
      "console.log('TOOL_RESULT=' + result);",
    ].join("\n");

    const result = await executor.execute("roundtrip-dynamic", code, EXEC_TIMEOUT_MS);

    expect(result.output).toContain("TOOL_RESULT=Echo: dynamic");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  }, 60000);

  it("supports the #tools-api subpath-import alias", async () => {
    const code = [
      'import { echoMessage } from "#tools-api/misc";',
      'const result = await echoMessage({ message: "aliased" });',
      'console.log("TOOL_RESULT=" + result);',
    ].join("\n");

    const result = await executor.execute("roundtrip-alias", code, EXEC_TIMEOUT_MS);

    expect(result.output).toContain("TOOL_RESULT=Echo: aliased");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  }, 60000);
});
