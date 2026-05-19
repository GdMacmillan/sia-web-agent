/**
 * Regression: Content Extraction from Array Content Blocks
 *
 * Pure unit tests extracted from the former regression.test.ts.
 * These verify message content parsing logic without any LLM calls.
 */

import { describe, it, expect } from "@jest/globals";
import { AIMessage } from "@langchain/core/messages";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";

describe("Content Extraction (Issue: Array vs String Formats)", () => {
  it("should handle AIMessage content as string", () => {
    const msg = new AIMessage({
      content:
        "This is a string response with meaningful content about the system.",
      tool_calls: [],
    });

    const stringContent = typeof msg.content === "string" ? msg.content : "";
    expect(stringContent.length).toBeGreaterThan(0);
    expect(stringContent).toContain("content");
  });

  it("should handle AIMessage content as array of blocks", () => {
    const arrayContent = [
      { type: "text", text: "This is text content." },
      { type: "text", text: "This is more content." },
    ];

    const msg = new AIMessage({
      content: arrayContent,
      tool_calls: [],
    });

    let extractedText = "";
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block.text) extractedText += block.text + "\n";
      }
    }

    expect(extractedText.trim().length).toBeGreaterThan(0);
    expect(extractedText).toContain("text content");
  });

  it("should handle mixed content blocks with thinking", () => {
    const arrayContent = [
      { type: "thinking", thinking: "Internal reasoning about the problem." },
      { type: "text", text: "Here is my response." },
    ];

    let extractedText = "";
    if (Array.isArray(arrayContent)) {
      for (const block of arrayContent as any[]) {
        if (block.text) extractedText += block.text + "\n";
        if (block.thinking) extractedText += block.thinking + "\n";
      }
    }

    expect(extractedText).toContain("reasoning");
    expect(extractedText).toContain("response");
  });

  it("should handle empty content blocks gracefully", () => {
    const arrayContent = [
      null,
      { type: "text", text: "" },
      { type: "text", text: "Valid content here." },
      undefined,
    ];

    let extractedText = "";
    if (Array.isArray(arrayContent)) {
      for (const block of arrayContent as any[]) {
        if (!block) continue;
        if (block.text) extractedText += block.text + "\n";
      }
    }

    expect(extractedText.length).toBeGreaterThan(0);
    expect(extractedText).toContain("Valid");
  });
});

describe("Project Root Marker Resolution", () => {
  it("langgraph.json exists at expected project root location", async () => {
    // Walk up from this test file to find the project root, identified by
    // langgraph.json (the standalone repo's only top-level marker file).
    let dir = path.resolve(__dirname, "../..");
    while (dir !== path.dirname(dir)) {
      const langgraphPath = path.join(dir, "langgraph.json");
      if (existsSync(langgraphPath)) {
        const stat = await fs.stat(langgraphPath);
        expect(stat.isFile()).toBe(true);
        return;
      }
      dir = path.dirname(dir);
    }
    // If we get here, we didn't find it — fail
    expect(true).toBe(false);
  });
});
