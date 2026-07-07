import { describe, it, expect, beforeEach } from "@jest/globals";
import { createBashTool } from "../../../src/tools/bash-tool.js";

describe("Bash Tool (one-shot execution)", () => {
  let bashTool: ReturnType<typeof createBashTool>;
  const projectRoot = process.cwd();

  beforeEach(() => {
    bashTool = createBashTool(projectRoot);
  });

  describe("Basic Command Execution", () => {
    it("should execute a simple echo command", async () => {
      const result = await bashTool.func({ command: "echo 'Hello, World!'" });
      expect(result).toContain("Hello, World!");
    });

    it("should run from the project root", async () => {
      const result = await bashTool.func({ command: "pwd" });
      expect(result).toContain(projectRoot);
    });

    it("should capture both stdout and stderr", async () => {
      const result = await bashTool.func({
        command: "echo 'stdout message' && echo 'stderr message' >&2",
      });
      expect(result).toContain("stdout message");
      expect(result).toContain("stderr message");
    });

    it("should handle multi-line output", async () => {
      const result = await bashTool.func({
        command: "echo 'Line 1' && echo 'Line 2' && echo 'Line 3'",
      });
      expect(result).toContain("Line 1");
      expect(result).toContain("Line 2");
      expect(result).toContain("Line 3");
    });
  });

  describe("Exit Code Handling", () => {
    it("should report a non-zero exit code from the native process", async () => {
      const result = await bashTool.func({ command: "exit 1" });
      expect(result).toContain("Command exited with code 1");
    });

    it("should report a specific exit code", async () => {
      const result = await bashTool.func({ command: "exit 42" });
      expect(result).toContain("Command exited with code 42");
    });

    it("should succeed with exit code 0 and not label it", async () => {
      const result = await bashTool.func({
        command: "echo 'success' && exit 0",
      });
      expect(result).toContain("success");
      expect(result).not.toContain("exited with code");
    });

    it("should stop a && chain on failure", async () => {
      const result = await bashTool.func({
        command: "exit 1 && echo 'should not appear'",
      });
      expect(result).not.toContain("should not appear");
      expect(result).toContain("Command exited with code 1");
    });
  });

  describe("No cross-call state", () => {
    it("should NOT persist working directory between calls", async () => {
      // cd in one call must not affect the next (one-shot model).
      await bashTool.func({ command: "cd /" });
      const result = await bashTool.func({ command: "pwd" });
      expect(result).toContain(projectRoot);
    });

    it("should NOT persist environment variables between calls", async () => {
      await bashTool.func({ command: "export TEST_VAR='persisted'" });
      const result = await bashTool.func({ command: "echo \"[$TEST_VAR]\"" });
      expect(result).not.toContain("persisted");
      expect(result).toContain("[]");
    });

    it("should compose directory context within a single call", async () => {
      const result = await bashTool.func({ command: "cd / && pwd" });
      // Resolves to the filesystem root (drive root on Windows).
      expect(result.trim().length).toBeGreaterThan(0);
      expect(result).not.toContain("Command exited with code");
    });
  });

  describe("Timeout Handling (fail fast, no hang)", () => {
    it("should time out a long-running command quickly", async () => {
      const start = Date.now();
      const result = await bashTool.func({
        command: "sleep 10",
        timeout: 1000,
      });
      const elapsed = Date.now() - start;

      expect(result).toContain("timed out");
      // Must not hang anywhere near the 10s sleep or the 2min default.
      expect(elapsed).toBeLessThan(5000);
    }, 8000);

    it("should complete a fast command well under the default timeout", async () => {
      const start = Date.now();
      const result = await bashTool.func({ command: "echo 'quick'" });
      const elapsed = Date.now() - start;

      expect(result).toContain("quick");
      expect(elapsed).toBeLessThan(5000);
    });

    it("should accept a large timeout without waiting for it", async () => {
      const result = await bashTool.func({
        command: "echo 'quick command'",
        timeout: 999999999,
      });
      expect(result).toContain("quick command");
    });
  });

  describe("Output Truncation", () => {
    it("should truncate very large output", async () => {
      const result = await bashTool.func({
        command:
          "for i in $(seq 1 2000); do echo 'This is a line of text repeated many times to create large output'; done",
      });
      expect(result.length).toBeLessThanOrEqual(30050);
      if (result.length > 30000) {
        expect(result).toContain("...[truncated]...");
      }
    }, 10000);

    it("should not truncate normal-sized output", async () => {
      const result = await bashTool.func({ command: "echo 'short output'" });
      expect(result).not.toContain("...[truncated]...");
      expect(result).toContain("short output");
    });
  });

  describe("Error Handling", () => {
    it("should handle a bogus command quickly without hanging", async () => {
      const start = Date.now();
      const result = await bashTool.func({ command: "nonexistentcommand123" });
      const elapsed = Date.now() - start;

      // Shell reports command-not-found (non-zero exit); no 120s hang.
      expect(
        result.includes("not found") ||
          result.includes("Command exited with code"),
      ).toBe(true);
      expect(elapsed).toBeLessThan(5000);
    });

    it("should handle special characters", async () => {
      const result = await bashTool.func({
        command: "echo 'Test with $pecial ch@racters!'",
      });
      expect(result).toContain("Test with $pecial ch@racters!");
    });

    it("should handle an empty command without crashing", async () => {
      const result = await bashTool.func({ command: "" });
      expect(typeof result).toBe("string");
    });
  });

  describe("Tool contract", () => {
    it("should expose a stable name and no-op cleanup", () => {
      expect(bashTool.name).toBe("bash");
      expect(typeof bashTool.cleanup).toBe("function");
      expect(() => bashTool.cleanup?.()).not.toThrow();
    });

    it("should accept an optional description parameter", async () => {
      const result = await bashTool.func({
        command: "echo 'test'",
        description: "Test command for verification",
      });
      expect(result).toContain("test");
    });
  });
});
