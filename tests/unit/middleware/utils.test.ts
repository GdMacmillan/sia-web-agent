/**
 * Middleware Utils Tests
 *
 * Tests for utility functions in middleware/utils.ts
 */

import { describe, it, expect } from "@jest/globals";
import { SystemMessage } from "@langchain/core/messages";
import {
  appendToSystemMessage,
  prependToSystemMessage,
} from "../../../src/middleware/utils.js";

describe("Middleware Utils", () => {
  describe("appendToSystemMessage", () => {
    it("should create system message if none exists", () => {
      const result = appendToSystemMessage(null, "System content");

      expect(result).toBeInstanceOf(SystemMessage);
      expect(result.content).toBe("System content");
    });

    it("should create system message from undefined", () => {
      const result = appendToSystemMessage(undefined, "System content");

      expect(result).toBeInstanceOf(SystemMessage);
      expect(result.content).toBe("System content");
    });

    it("should append to existing system message", () => {
      const original = new SystemMessage({ content: "Original system" });
      const result = appendToSystemMessage(original, "Appended content");

      expect(result).toBeInstanceOf(SystemMessage);
      expect(result.content).toBe("Original system\n\nAppended content");
    });

    it("should not modify original message", () => {
      const original = new SystemMessage({ content: "Original" });
      const result = appendToSystemMessage(original, "New content");

      expect(original.content).toBe("Original");
      expect(result.content).toBe("Original\n\nNew content");
    });

    it("should handle empty string content", () => {
      const original = new SystemMessage({ content: "" });
      const result = appendToSystemMessage(original, "Appended");

      expect(result.content).toBe("Appended");
    });

    it("should handle array content by appending text block", () => {
      const original = new SystemMessage({
        content: [{ type: "text", text: "Block 1" }],
      });
      const result = appendToSystemMessage(original, "Appended");

      expect(Array.isArray(result.content)).toBe(true);
      expect((result.content as any[]).length).toBe(2);
    });
  });

  describe("prependToSystemMessage", () => {
    it("should create system message if none exists", () => {
      const result = prependToSystemMessage(null, "System content");

      expect(result).toBeInstanceOf(SystemMessage);
      expect(result.content).toBe("System content");
    });

    it("should create system message from undefined", () => {
      const result = prependToSystemMessage(undefined, "System content");

      expect(result).toBeInstanceOf(SystemMessage);
      expect(result.content).toBe("System content");
    });

    it("should prepend to existing system message", () => {
      const original = new SystemMessage({ content: "Original system" });
      const result = prependToSystemMessage(original, "Prepended content");

      expect(result).toBeInstanceOf(SystemMessage);
      expect(result.content).toBe("Prepended content\n\nOriginal system");
    });

    it("should not modify original message", () => {
      const original = new SystemMessage({ content: "Original" });
      const result = prependToSystemMessage(original, "New content");

      expect(original.content).toBe("Original");
      expect(result.content).toBe("New content\n\nOriginal");
    });

    it("should handle empty string content", () => {
      const original = new SystemMessage({ content: "" });
      const result = prependToSystemMessage(original, "Prepended");

      expect(result.content).toBe("Prepended");
    });

    it("should handle array content by prepending text block", () => {
      const original = new SystemMessage({
        content: [{ type: "text", text: "Block 1" }],
      });
      const result = prependToSystemMessage(original, "Prepended");

      expect(Array.isArray(result.content)).toBe(true);
      expect((result.content as any[]).length).toBe(2);
    });
  });

  describe("integration", () => {
    it("should allow chaining append and prepend", () => {
      let result = appendToSystemMessage(null, "Middle");
      result = prependToSystemMessage(result, "Start");
      result = appendToSystemMessage(result, "End");

      expect(result.content).toBe("Start\n\nMiddle\n\nEnd");
    });

    it("should preserve content order with multiple operations", () => {
      const original = new SystemMessage({ content: "Original" });

      let result = appendToSystemMessage(original, "Append1");
      result = appendToSystemMessage(result, "Append2");
      result = prependToSystemMessage(result, "Prepend");

      expect(result.content).toBe("Prepend\n\nOriginal\n\nAppend1\n\nAppend2");
    });
  });
});

// --- Middleware merge helpers (Phase 4) -------------------------------------
import {
  mergeMiddleware,
  mergeMiddlewareStack,
} from "../../../src/middleware/utils.js";
import type { AgentMiddleware } from "langchain";

/** Minimal named middleware stub for ordering/identity assertions. */
function mw(name: string): AgentMiddleware {
  return { name } as unknown as AgentMiddleware;
}
const names = (list: AgentMiddleware[]) => list.map((m) => m.name);

describe("mergeMiddleware", () => {
  it("keeps base order when there is no custom middleware", () => {
    const base = [mw("a"), mw("b"), mw("c")];
    expect(names(mergeMiddleware(base, []))).toEqual(["a", "b", "c"]);
  });

  it("replaces a same-name entry in place (identity swap, position kept)", () => {
    const base = [mw("a"), mw("b"), mw("c")];
    const replacement = mw("b");
    const merged = mergeMiddleware(base, [replacement]);
    expect(names(merged)).toEqual(["a", "b", "c"]);
    expect(merged[1]).toBe(replacement);
  });

  it("appends novel custom middleware after the base, in order", () => {
    const base = [mw("a")];
    expect(names(mergeMiddleware(base, [mw("x"), mw("y")]))).toEqual([
      "a",
      "x",
      "y",
    ]);
  });
});

describe("mergeMiddlewareStack", () => {
  const core = [mw("head"), mw("core1"), mw("core2")];
  const tail = [mw("tail1"), mw("tail2")];

  it("assembles core then tail with no custom middleware", () => {
    expect(names(mergeMiddlewareStack(core, [], tail))).toEqual([
      "head",
      "core1",
      "core2",
      "tail1",
      "tail2",
    ]);
  });

  it("inserts novel custom middleware between core and tail", () => {
    const merged = mergeMiddlewareStack(core, [mw("novel")], tail);
    expect(names(merged)).toEqual([
      "head",
      "core1",
      "core2",
      "novel",
      "tail1",
      "tail2",
    ]);
  });

  it("replaces a same-name core entry in place rather than appending", () => {
    const replacement = mw("core2");
    const merged = mergeMiddlewareStack(core, [replacement], tail);
    expect(names(merged)).toEqual([
      "head",
      "core1",
      "core2",
      "tail1",
      "tail2",
    ]);
    expect(merged[2]).toBe(replacement);
  });

  it("replaces a same-name tail entry in place", () => {
    const replacement = mw("tail1");
    const merged = mergeMiddlewareStack(core, [replacement], tail);
    expect(merged[3]).toBe(replacement);
    expect(names(merged)).toEqual([
      "head",
      "core1",
      "core2",
      "tail1",
      "tail2",
    ]);
  });

  it("appendNew:false drops novel custom middleware but still replaces", () => {
    const replacement = mw("core1");
    const merged = mergeMiddlewareStack(
      core,
      [mw("novel"), replacement],
      tail,
      { appendNew: false },
    );
    expect(names(merged)).toEqual(["head", "core1", "core2", "tail1", "tail2"]);
    expect(merged[1]).toBe(replacement);
  });
});
