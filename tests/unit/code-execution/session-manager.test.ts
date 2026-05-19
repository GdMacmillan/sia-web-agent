/**
 * Code Execution Session Manager Tests
 *
 * Tests for TypeScript code execution with session isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CodeExecutionSession,
  CodeExecutionSessionManager,
  clipOutput,
} from "../../../src/code-execution/session-manager.js";
import {
  CodeExecutor,
  validateCode,
  formatCodePreview,
} from "../../../src/code-execution/executor.js";

describe("Code Execution", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create temporary directory for tests
    tmpDir = mkdtempSync(join(tmpdir(), "code-exec-test-"));
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("clipOutput", () => {
    it("should return content unchanged if under limit", () => {
      const content = "Hello, world!";
      expect(clipOutput(content)).toBe(content);
    });

    it("should truncate content over limit", () => {
      const content = "x".repeat(40000);
      const result = clipOutput(content, 30000);

      expect(result.length).toBeLessThan(content.length);
      expect(result).toContain("...[output truncated at 30KB]...");
    });

    it("should respect custom limit", () => {
      const content = "x".repeat(200);
      const result = clipOutput(content, 100);

      expect(result.length).toBeLessThanOrEqual(150); // 100 + truncation message
      expect(result).toContain("...[output truncated at 30KB]...");
    });
  });

  describe("CodeExecutionSession", () => {
    it("should create workspace directory on construction", () => {
      const session = new CodeExecutionSession("test-thread", tmpDir);
      const workspaceDir = session.getWorkspaceDir();

      expect(existsSync(workspaceDir)).toBe(true);
      expect(workspaceDir).toContain("test-thread");

      session.cleanup();
    });

    it("should execute simple console.log", async () => {
      const session = new CodeExecutionSession("test-simple", tmpDir);

      const result = await session.execute('console.log("Hello, world!")');

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Hello, world!");
      expect(result.timedOut).toBe(false);

      session.cleanup();
    }, 30000);

    it("should execute TypeScript with imports", async () => {
      const session = new CodeExecutionSession("test-imports", tmpDir);

      // prettier-ignore
      const code = "import fs from 'fs';\nconsole.log('fs module loaded:', typeof fs.readdirSync === 'function');";

      const result = await session.execute(code);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("fs module loaded: true");

      session.cleanup();
    }, 30000);

    it("should capture stderr output", async () => {
      const session = new CodeExecutionSession("test-stderr", tmpDir);

      const code = 'console.error("This is an error");';
      const result = await session.execute(code);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("This is an error");

      session.cleanup();
    }, 30000);

    it("should report non-zero exit codes", async () => {
      const session = new CodeExecutionSession("test-exit-code", tmpDir);

      const code = "process.exit(42);";
      const result = await session.execute(code);

      expect(result.exitCode).toBe(42);
      expect(result.timedOut).toBe(false);

      session.cleanup();
    }, 30000);

    it("should handle syntax errors", async () => {
      const session = new CodeExecutionSession("test-syntax-error", tmpDir);

      const code = "const x = {"; // Invalid syntax
      const result = await session.execute(code);

      expect(result.exitCode).not.toBe(0);
      expect(result.output.toLowerCase()).toMatch(/error|unexpected/i);

      session.cleanup();
    }, 30000);

    it("should timeout long-running code", async () => {
      const session = new CodeExecutionSession("test-timeout", tmpDir);

      // prettier-ignore
      const code = "const start = Date.now();\nwhile (Date.now() - start < 5000) {}\nconsole.log('Done');";

      // Use 1 second timeout
      const result = await session.execute(code, 1000);

      expect(result.timedOut).toBe(true);

      session.cleanup();
    }, 30000);

    it("should prevent concurrent execution", async () => {
      const session = new CodeExecutionSession("test-concurrent", tmpDir);

      // Start first execution
      const promise1 = session.execute(
        'await new Promise(r => setTimeout(r, 500)); console.log("first");',
      );

      // Immediately try second execution
      const result2 = await session.execute('console.log("second");');

      expect(result2.error).toBe("Session busy");

      // Wait for first to complete
      const result1 = await promise1;
      expect(result1.output).toContain("first");

      session.cleanup();
    }, 30000);

    it("should clean up workspace on cleanup()", () => {
      const session = new CodeExecutionSession("test-cleanup", tmpDir);
      const workspaceDir = session.getWorkspaceDir();

      expect(existsSync(workspaceDir)).toBe(true);

      session.cleanup();

      expect(existsSync(workspaceDir)).toBe(false);
    });
  });

  describe("CodeExecutionSessionManager", () => {
    it("should create sessions for different threads", async () => {
      const manager = new CodeExecutionSessionManager(tmpDir);

      const session1 = manager.getSession("thread-1");
      const session2 = manager.getSession("thread-2");

      expect(session1).not.toBe(session2);
      expect(session1.getWorkspaceDir()).not.toBe(session2.getWorkspaceDir());
      expect(manager.getSessionCount()).toBe(2);

      await manager.cleanup();
    });

    it("should return same session for same thread", async () => {
      const manager = new CodeExecutionSessionManager(tmpDir);

      const session1 = manager.getSession("thread-1");
      const session2 = manager.getSession("thread-1");

      expect(session1).toBe(session2);
      expect(manager.getSessionCount()).toBe(1);

      await manager.cleanup();
    });

    it("should execute code via manager", async () => {
      const manager = new CodeExecutionSessionManager(tmpDir);

      const result = await manager.execute(
        "thread-test",
        'console.log("via manager");',
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("via manager");

      await manager.cleanup();
    }, 30000);

    it("should cleanup specific session", async () => {
      const manager = new CodeExecutionSessionManager(tmpDir);

      manager.getSession("thread-1");
      manager.getSession("thread-2");

      expect(manager.getSessionCount()).toBe(2);

      await manager.cleanup("thread-1");

      expect(manager.getSessionCount()).toBe(1);

      await manager.cleanup();
    });

    it("should cleanup all sessions", async () => {
      const manager = new CodeExecutionSessionManager(tmpDir);

      manager.getSession("thread-1");
      manager.getSession("thread-2");
      manager.getSession("thread-3");

      expect(manager.getSessionCount()).toBe(3);

      await manager.cleanup();

      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe("CodeExecutor", () => {
    it("should format successful result", async () => {
      const executor = new CodeExecutor(tmpDir);

      const result = await executor.execute('console.log("success");', {
        threadId: "test-success",
      });

      expect(result.success).toBe(true);
      expect(result.result).toContain("success");

      await executor.cleanup();
    }, 30000);

    it("should format timeout result", async () => {
      const executor = new CodeExecutor(tmpDir);

      // prettier-ignore
      const code = "const start = Date.now();\nwhile (Date.now() - start < 5000) {}";

      const result = await executor.execute(code, {
        threadId: "test-timeout",
        timeout: 1000,
      });

      expect(result.success).toBe(false);
      expect(result.result).toContain("timed out");

      await executor.cleanup();
    }, 30000);

    it("should format error result", async () => {
      const executor = new CodeExecutor(tmpDir);

      const result = await executor.execute('throw new Error("test error");', {
        threadId: "test-error",
      });

      expect(result.success).toBe(false);
      expect(result.result).toContain("test error");

      await executor.cleanup();
    }, 30000);
  });

  describe("validateCode", () => {
    it("should accept valid code", () => {
      expect(validateCode('console.log("hello");')).toBeNull();
      expect(validateCode("const x = 1 + 2;")).toBeNull();
      expect(validateCode("import fs from 'fs';")).toBeNull();
    });

    it("should reject empty code", () => {
      expect(validateCode("")).not.toBeNull();
      expect(validateCode("   ")).not.toBeNull();
    });

    it("should reject obvious infinite loops", () => {
      expect(validateCode("while(true){}")).not.toBeNull();
      expect(validateCode("for(;;){}")).not.toBeNull();
    });

    it("should accept loops with body", () => {
      // These have content after the loop, so they're allowed
      expect(validateCode("while(true) { break; }")).toBeNull();
      expect(validateCode("for(;;) { break; }")).toBeNull();
    });
  });

  describe("formatCodePreview", () => {
    it("should show first few lines with line numbers", () => {
      const code = "line1\nline2\nline3";
      const preview = formatCodePreview(code, 3);

      expect(preview).toContain("1:");
      expect(preview).toContain("line1");
      expect(preview).toContain("line3");
    });

    it("should indicate more lines when truncated", () => {
      const code = "line1\nline2\nline3\nline4\nline5\nline6";
      const preview = formatCodePreview(code, 3);

      expect(preview).toContain("3 more lines");
    });
  });

  describe("File Operations", () => {
    it("should read and write files in workspace", async () => {
      const manager = new CodeExecutionSessionManager(tmpDir);

      // prettier-ignore
      const writeCode = "import fs from 'fs';\nfs.writeFileSync('test.txt', 'Hello from code execution!');\nconsole.log('File written');";

      const writeResult = await manager.execute("file-test", writeCode);
      expect(writeResult.exitCode).toBe(0);

      // prettier-ignore
      const readCode = "import fs from 'fs';\nconst content = fs.readFileSync('test.txt', 'utf-8');\nconsole.log('Content:', content);";

      const readResult = await manager.execute("file-test", readCode);
      expect(readResult.exitCode).toBe(0);
      expect(readResult.output).toContain("Hello from code execution!");

      await manager.cleanup();
    }, 30000);

    it("should list files using fs.readdirSync", async () => {
      const manager = new CodeExecutionSessionManager(tmpDir);
      const session = manager.getSession("fs-test");
      const workspaceDir = session.getWorkspaceDir();

      // Create a file in the workspace first
      writeFileSync(join(workspaceDir, "existing.txt"), "test");

      // Use absolute workspace path since cwd may differ from workspace dir
      // prettier-ignore
      const code = `import fs from 'fs';\nconst files = fs.readdirSync(${JSON.stringify(workspaceDir)});\nconsole.log('Files:', files.join(', '));`;

      const result = await manager.execute("fs-test", code);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("existing.txt");

      await manager.cleanup();
    }, 30000);
  });
});
