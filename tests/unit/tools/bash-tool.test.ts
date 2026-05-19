import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createBashTool } from "../../../src/tools/bash-tool.js";

describe("Bash Tool", () => {
  let bashTool: ReturnType<typeof createBashTool>;
  const projectRoot = process.cwd();

  beforeEach(() => {
    bashTool = createBashTool(projectRoot);
  });

  afterEach(async () => {
    // Clean up all bash sessions to prevent Jest from hanging
    if (bashTool && bashTool.cleanup) {
      await bashTool.cleanup();
    }
  });

  describe("Basic Command Execution", () => {
    it("should execute simple echo command", async () => {
      const result = await bashTool.func(
        {
          command: "echo 'Hello, World!'",
        },
        { configurable: { thread_id: "test-1" } },
      );

      expect(result).toContain("Hello, World!");
    });

    it("should execute pwd and return current directory", async () => {
      const result = await bashTool.func(
        {
          command: "pwd",
        },
        { configurable: { thread_id: "test-2" } },
      );

      expect(result).toContain(projectRoot);
    });

    it("should capture both stdout and stderr", async () => {
      const result = await bashTool.func(
        {
          command: "echo 'stdout message' && echo 'stderr message' >&2",
        },
        { configurable: { thread_id: "test-3" } },
      );

      expect(result).toContain("stdout message");
      expect(result).toContain("stderr message");
    });

    it("should handle multi-line output", async () => {
      const result = await bashTool.func(
        {
          command: "echo 'Line 1' && echo 'Line 2' && echo 'Line 3'",
        },
        { configurable: { thread_id: "test-4" } },
      );

      expect(result).toContain("Line 1");
      expect(result).toContain("Line 2");
      expect(result).toContain("Line 3");
    });
  });

  describe("Exit Code Handling", () => {
    it("should report non-zero exit codes", async () => {
      const result = await bashTool.func(
        {
          command: "exit 1",
        },
        { configurable: { thread_id: "test-5" } },
      );

      expect(result).toContain("Command exited with code 1");
    });

    it("should report specific exit codes", async () => {
      const result = await bashTool.func(
        {
          command: "exit 42",
        },
        { configurable: { thread_id: "test-6" } },
      );

      expect(result).toContain("Command exited with code 42");
    });

    it("should succeed with exit code 0", async () => {
      const result = await bashTool.func(
        {
          command: "echo 'success' && exit 0",
        },
        { configurable: { thread_id: "test-7" } },
      );

      expect(result).toContain("success");
      expect(result).not.toContain("exited with code");
    });
  });

  describe("Session Persistence", () => {
    it("should maintain working directory between commands", async () => {
      const threadId = "test-persist-1";

      // Change to /tmp directory
      await bashTool.func(
        {
          command: "cd /tmp",
        },
        { configurable: { thread_id: threadId } },
      );

      // Check that we're still in /tmp
      const result = await bashTool.func(
        {
          command: "pwd",
        },
        { configurable: { thread_id: threadId } },
      );

      expect(result).toContain("/tmp");
    });

    it("should maintain environment variables between commands", async () => {
      const threadId = "test-persist-2";

      // Set an environment variable
      await bashTool.func(
        {
          command: "export TEST_VAR='test_value'",
        },
        { configurable: { thread_id: threadId } },
      );

      // Check that the variable persists
      const result = await bashTool.func(
        {
          command: "echo $TEST_VAR",
        },
        { configurable: { thread_id: threadId } },
      );

      expect(result).toContain("test_value");
    });

    it("should isolate sessions by thread_id", async () => {
      // Set variable in thread 1
      await bashTool.func(
        {
          command: "export THREAD_VAR='thread1'",
        },
        { configurable: { thread_id: "test-thread-1" } },
      );

      // Set different variable in thread 2
      await bashTool.func(
        {
          command: "export THREAD_VAR='thread2'",
        },
        { configurable: { thread_id: "test-thread-2" } },
      );

      // Check thread 1 still has its value
      const result1 = await bashTool.func(
        {
          command: "echo $THREAD_VAR",
        },
        { configurable: { thread_id: "test-thread-1" } },
      );

      // Check thread 2 has its value
      const result2 = await bashTool.func(
        {
          command: "echo $THREAD_VAR",
        },
        { configurable: { thread_id: "test-thread-2" } },
      );

      expect(result1).toContain("thread1");
      expect(result2).toContain("thread2");
    });
  });

  describe("Command Chaining", () => {
    it("should support && chaining (conditional)", async () => {
      const result = await bashTool.func(
        {
          command: "echo 'first' && echo 'second'",
        },
        { configurable: { thread_id: "test-8" } },
      );

      expect(result).toContain("first");
      expect(result).toContain("second");
    });

    it("should stop && chain on failure", async () => {
      const result = await bashTool.func(
        {
          command: "exit 1 && echo 'should not appear'",
        },
        { configurable: { thread_id: "test-9" } },
      );

      expect(result).not.toContain("should not appear");
      expect(result).toContain("Command exited with code 1");
    });

    it("should support ; chaining (unconditional)", async () => {
      const result = await bashTool.func(
        {
          command: "echo 'first'; echo 'second'",
        },
        { configurable: { thread_id: "test-10" } },
      );

      expect(result).toContain("first");
      expect(result).toContain("second");
    });
  });

  describe("Timeout Handling", () => {
    it("should respect default timeout", async () => {
      const startTime = Date.now();
      const result = await bashTool.func(
        {
          command: "sleep 1 && echo 'done'",
        },
        { configurable: { thread_id: "test-11" } },
      );
      const elapsed = Date.now() - startTime;

      expect(result).toContain("done");
      expect(elapsed).toBeGreaterThan(1000);
      expect(elapsed).toBeLessThan(5000); // Should not timeout
    }, 10000);

    it("should timeout long-running commands", async () => {
      const result = await bashTool.func(
        {
          command: "sleep 10",
          timeout: 1000, // 1 second timeout
        },
        { configurable: { thread_id: "test-12" } },
      );

      expect(result).toContain("timed out");
    }, 5000);

    it("should cap timeout at maximum 600000ms", async () => {
      // This test just verifies the tool accepts a large timeout
      // without actually waiting for it
      const result = await bashTool.func(
        {
          command: "echo 'quick command'",
          timeout: 999999999, // Try to set very large timeout
        },
        { configurable: { thread_id: "test-13" } },
      );

      expect(result).toContain("quick command");
    });
  });

  describe("Output Truncation", () => {
    it("should truncate large output", async () => {
      // Generate output larger than 30KB
      const result = await bashTool.func(
        {
          command:
            "for i in {1..2000}; do echo 'This is a line of text that will be repeated many times to create large output'; done",
        },
        { configurable: { thread_id: "test-14" } },
      );

      // Should be truncated
      expect(result.length).toBeLessThanOrEqual(30050); // 30000 + some buffer for truncation message
      if (result.length > 30000) {
        expect(result).toContain("...[truncated]...");
      }
    }, 10000);

    it("should not truncate normal-sized output", async () => {
      const result = await bashTool.func(
        {
          command: "echo 'short output'",
        },
        { configurable: { thread_id: "test-15" } },
      );

      expect(result).not.toContain("...[truncated]...");
      expect(result).toContain("short output");
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid commands gracefully", async () => {
      const result = await bashTool.func(
        {
          command: "nonexistentcommand123",
        },
        { configurable: { thread_id: "test-16" } },
      );

      // Should contain error indication (either exit code or error message)
      expect(
        result.includes("not found") ||
          result.includes("Command exited with code"),
      ).toBe(true);
    });

    it("should handle commands with special characters", async () => {
      const result = await bashTool.func(
        {
          command: "echo 'Test with $pecial ch@racters!'",
        },
        { configurable: { thread_id: "test-17" } },
      );

      expect(result).toContain("Test with $pecial ch@racters!");
    });

    it("should handle empty commands", async () => {
      const result = await bashTool.func(
        {
          command: "",
        },
        { configurable: { thread_id: "test-18" } },
      );

      // Should not crash, may return empty or marker
      expect(typeof result).toBe("string");
    });
  });

  describe("Description Parameter", () => {
    it("should accept optional description parameter", async () => {
      const result = await bashTool.func(
        {
          command: "echo 'test'",
          description: "Test command for verification",
        },
        { configurable: { thread_id: "test-19" } },
      );

      expect(result).toContain("test");
    });
  });

  describe("Default Thread ID", () => {
    it("should use default thread when no thread_id provided", async () => {
      const result = await bashTool.func(
        {
          command: "echo 'no thread id'",
        },
        {},
      );

      expect(result).toContain("no thread id");
    });
  });
});
