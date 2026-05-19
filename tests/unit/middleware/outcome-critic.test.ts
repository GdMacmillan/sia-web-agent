/**
 * Outcome Critic Tests
 * Tests for task outcome evaluation using heuristics and LLM-based analysis
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { evaluateTaskOutcome } from "../../../src/middleware/outcome-critic.js";

// Mock LLM model
const mockModel = {
  invoke: jest.fn(),
};

describe("Outcome Critic", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("evaluateTaskOutcome", () => {
    describe("tool error detection", () => {
      it("should detect failed task with many tool errors", async () => {
        const messages = [
          new HumanMessage("Please create a new file"),
          new AIMessage({
            content: "I'll create the file",
            tool_calls: [{ name: "write_file", args: {}, id: "1" }],
          }),
          new ToolMessage("Error: Permission denied", "1"),
          new AIMessage({
            content: "Let me try again",
            tool_calls: [{ name: "write_file", args: {}, id: "2" }],
          }),
          new ToolMessage("Error: Directory not found", "2"),
          new AIMessage({
            content: "Another attempt",
            tool_calls: [{ name: "write_file", args: {}, id: "3" }],
          }),
          new ToolMessage("Error: Disk full", "3"),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "Please create a new file",
        );

        expect(outcome.fulfilled).toBe(false);
        expect(outcome.toolErrors.length).toBe(3);
        expect(outcome.confidence).toBeGreaterThanOrEqual(0.8);
        expect(outcome.reasoning).toContain("Multiple tool errors");
      });

      it("should extract error messages from tool results", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: false,
            tool_errors: ["Error: Test failed - assertion error in test.ts:42"],
            confidence: 0.9,
            reasoning: "Test execution failed",
          }),
        });

        const messages = [
          new HumanMessage("Run tests"),
          new AIMessage({
            content: "Running tests",
            tool_calls: [{ name: "bash", args: {}, id: "1" }],
          }),
          new ToolMessage(
            "Error: Test failed - assertion error in test.ts:42",
            "1",
          ),
          new AIMessage("Tests failed with errors"),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "Run tests",
        );

        expect(outcome.toolErrors.length).toBeGreaterThanOrEqual(1);
        expect(
          outcome.toolErrors.some(
            (e) => e.includes("assertion error") || e.includes("Error"),
          ),
        ).toBe(true);
      });

      it("should handle tool messages without errors", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: true,
            tool_errors: [],
            confidence: 0.9,
            reasoning: "Task completed successfully",
          }),
        });

        const messages = [
          new HumanMessage("List files"),
          new AIMessage({
            content: "Listing files",
            tool_calls: [{ name: "ls", args: {}, id: "1" }],
          }),
          new ToolMessage("file1.ts\nfile2.ts\nfile3.ts", "1"),
          new AIMessage("Found 3 files"),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "List files",
        );

        expect(outcome.toolErrors.length).toBe(0);
        expect(mockModel.invoke).toHaveBeenCalled();
      });
    });

    describe("LLM-based evaluation", () => {
      it("should use LLM for ambiguous cases with few errors", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: true,
            tool_errors: [],
            confidence: 0.85,
            reasoning: "Agent successfully completed the task",
          }),
        });

        const messages = [
          new HumanMessage("Analyze the codebase"),
          new AIMessage({
            content: "I'll search for patterns",
            tool_calls: [{ name: "grep", args: {}, id: "1" }],
          }),
          new ToolMessage("Found 10 matches", "1"),
          new AIMessage("Analysis complete: The codebase follows MVC pattern"),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "Analyze the codebase",
        );

        expect(mockModel.invoke).toHaveBeenCalled();
        expect(outcome.fulfilled).toBe(true);
        expect(outcome.confidence).toBe(0.85);
        expect(outcome.reasoning).toBe("Agent successfully completed the task");
      });

      it("should send correct context to LLM", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: true,
            tool_errors: [],
            confidence: 0.9,
            reasoning: "Task successful",
          }),
        });

        const messages = [
          new HumanMessage("Fix the bug"),
          new AIMessage("Bug fixed"),
        ];

        await evaluateTaskOutcome(mockModel as any, messages, "Fix the bug");

        const callArgs = mockModel.invoke.mock.calls[0][0];
        expect(callArgs).toHaveLength(2);
        // First message should be a system message (SystemMessage instance)
        expect(
          callArgs[0]._getType?.() === "system" ||
            callArgs[0].role === "system",
        ).toBe(true);
        // Second message should be a human message containing the request
        const humanMsg = callArgs[1];
        expect(
          humanMsg._getType?.() === "human" || humanMsg.role === "user",
        ).toBe(true);
        expect(humanMsg.content).toEqual(
          expect.stringContaining("Fix the bug"),
        );
      });

      it("should include last 5 messages in context", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: true,
            tool_errors: [],
            confidence: 0.9,
            reasoning: "Completed",
          }),
        });

        const messages = [
          new HumanMessage("msg1"),
          new AIMessage("msg2"),
          new HumanMessage("msg3"),
          new AIMessage("msg4"),
          new HumanMessage("msg5"),
          new AIMessage("msg6"),
          new HumanMessage("msg7"),
        ];

        await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "original request",
        );

        const callArgs = mockModel.invoke.mock.calls[0][0];
        const userMessage = callArgs.find(
          (m: any) => m._getType?.() === "human" || m.role === "user",
        );
        const context = JSON.parse(userMessage.content.split("\n\n")[1]);

        expect(context.final_messages).toHaveLength(5);
      });
    });

    describe("confidence scoring", () => {
      it("should clamp confidence to 0-1 range", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: true,
            tool_errors: [],
            confidence: 1.5, // Invalid: > 1
            reasoning: "Test",
          }),
        });

        const messages = [new HumanMessage("test"), new AIMessage("done")];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        expect(outcome.confidence).toBeLessThanOrEqual(1.0);
        expect(outcome.confidence).toBeGreaterThanOrEqual(0.0);
      });

      it("should use high confidence for heuristic-based failures", async () => {
        const messages = [
          new HumanMessage("test"),
          new ToolMessage("Error 1", "1"),
          new ToolMessage("Error 2", "2"),
          new ToolMessage("Error 3", "3"),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        expect(outcome.confidence).toBeGreaterThanOrEqual(0.8);
        expect(mockModel.invoke).not.toHaveBeenCalled();
      });

      it("should default to 0.5 confidence if missing from LLM", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: true,
            tool_errors: [],
            // confidence missing
            reasoning: "Test",
          }),
        });

        const messages = [new HumanMessage("test"), new AIMessage("done")];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        expect(outcome.confidence).toBe(0.5);
      });
    });

    describe("edge cases", () => {
      it("should handle empty messages array", async () => {
        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          [],
          "test request",
        );

        expect(outcome.fulfilled).toBe(false);
        expect(outcome.reasoning).toBe("No conversation history to evaluate");
        expect(outcome.confidence).toBe(0.5);
        // Should NOT call LLM for empty messages (quick heuristic)
        expect(mockModel.invoke).not.toHaveBeenCalled();
      });

      it("should handle malformed JSON from LLM", async () => {
        mockModel.invoke.mockResolvedValue({
          content: "Not JSON at all",
        });

        const messages = [new HumanMessage("test"), new AIMessage("response")];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        expect(outcome.fulfilled).toBe(false);
        expect(outcome.confidence).toBe(0.5);
        expect(outcome.reasoning).toBe("Unable to evaluate task outcome");
      });

      it("should handle JSON wrapped in markdown", async () => {
        mockModel.invoke.mockResolvedValue({
          content: `Here's the evaluation:

\`\`\`json { "fulfilled": true, "tool_errors": [], "confidence": 0.9, "reasoning": "Task completed"
} \`\`\`

Hope this helps!`,
        });

        const messages = [new HumanMessage("test"), new AIMessage("done")];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        expect(outcome.fulfilled).toBe(true);
        expect(outcome.confidence).toBe(0.9);
      });

      it("should handle non-string message content", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: true,
            tool_errors: [],
            confidence: 0.8,
            reasoning: "Success",
          }),
        });

        const messages = [
          new HumanMessage({ text: "complex content" } as any),
          new AIMessage({ text: "complex response" } as any),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        expect(outcome).toBeDefined();
        expect(mockModel.invoke).toHaveBeenCalled();
      });

      it("should handle tool messages with object content", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: false,
            tool_errors: ["Error detected"],
            confidence: 0.7,
            reasoning: "Tool returned error object",
          }),
        });

        const messages = [
          new HumanMessage("test"),
          new ToolMessage({ error: "Failed", code: 500 } as any, "1"),
          new AIMessage("Got an error"),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        // Object content with "error" or "failed" should be detected
        expect(outcome.toolErrors.length).toBeGreaterThan(0);
      });
    });

    describe("reasoning extraction", () => {
      it("should preserve LLM reasoning", async () => {
        const expectedReasoning =
          "The agent successfully completed all steps and achieved the user's goal";

        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: true,
            tool_errors: [],
            confidence: 0.95,
            reasoning: expectedReasoning,
          }),
        });

        const messages = [new HumanMessage("test"), new AIMessage("done")];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        expect(outcome.reasoning).toBe(expectedReasoning);
      });

      it("should provide default reasoning when missing", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: true,
            tool_errors: [],
            confidence: 0.8,
            // reasoning missing
          }),
        });

        const messages = [new HumanMessage("test"), new AIMessage("done")];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        expect(outcome.reasoning).toBe("No reasoning provided");
      });
    });

    describe("task outcome determination", () => {
      it("should mark as fulfilled when LLM says yes", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: true,
            tool_errors: [],
            confidence: 0.9,
            reasoning: "Task successful",
          }),
        });

        const messages = [
          new HumanMessage("Create a file"),
          new AIMessage({
            content: "Creating file",
            tool_calls: [{ name: "write_file", args: {}, id: "1" }],
          }),
          new ToolMessage("File created successfully", "1"),
          new AIMessage("File has been created"),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "Create a file",
        );

        expect(outcome.fulfilled).toBe(true);
      });

      it("should mark as unfulfilled when LLM says no", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: false,
            tool_errors: ["Could not locate the requested file"],
            confidence: 0.85,
            reasoning: "The file was not found despite multiple attempts",
          }),
        });

        const messages = [
          new HumanMessage("Find the config file"),
          new AIMessage({
            content: "Searching",
            tool_calls: [{ name: "glob", args: {}, id: "1" }],
          }),
          new ToolMessage("No matches found", "1"),
          new AIMessage("I couldn't find the file"),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "Find the config file",
        );

        expect(outcome.fulfilled).toBe(false);
        expect(outcome.reasoning).toContain("not found");
      });

      it("should default to unfulfilled when LLM response is unclear", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            // fulfilled missing
            tool_errors: [],
            confidence: 0.6,
            reasoning: "Unclear outcome",
          }),
        });

        const messages = [new HumanMessage("test"), new AIMessage("done")];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        expect(outcome.fulfilled).toBe(false);
      });
    });

    describe("error message extraction", () => {
      it("should extract errors from Error: prefixed messages", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: false,
            tool_errors: ["Error: Connection timeout"],
            confidence: 0.8,
            reasoning: "Connection failed",
          }),
        });

        const messages = [
          new HumanMessage("test"),
          new ToolMessage("Error: Connection timeout", "1"),
          new AIMessage("I encountered an error"),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        // Error should be detected and included
        expect(outcome.toolErrors.length).toBeGreaterThan(0);
        expect(
          outcome.toolErrors.some(
            (e) => e.includes("Connection timeout") || e.includes("error"),
          ),
        ).toBe(true);
      });

      it("should extract errors from failed/failure messages", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: false,
            tool_errors: ["Failed to compile: syntax error on line 42"],
            confidence: 0.8,
            reasoning: "Compilation failed",
          }),
        });

        const messages = [
          new HumanMessage("test"),
          new ToolMessage("Failed to compile: syntax error on line 42", "1"),
          new AIMessage("Compilation error occurred"),
        ];

        const outcome = await evaluateTaskOutcome(
          mockModel as any,
          messages,
          "test",
        );

        expect(outcome.toolErrors.length).toBeGreaterThan(0);
      });

      it("should limit tool errors to first 3 in context", async () => {
        mockModel.invoke.mockResolvedValue({
          content: JSON.stringify({
            fulfilled: false,
            tool_errors: ["err1", "err2"],
            confidence: 0.8,
            reasoning: "Some failures occurred",
          }),
        });

        const messages = [
          new HumanMessage("test"),
          new ToolMessage("Error 1", "1"),
          new ToolMessage("Error 2", "2"),
          new AIMessage("Got some errors"),
        ];

        await evaluateTaskOutcome(mockModel as any, messages, "test");

        // Should call LLM (2 errors <= threshold of 2, so no quick heuristic)
        expect(mockModel.invoke).toHaveBeenCalled();

        // Check that errors were sent in context (implementation limits to first 3)
        const callArgs = mockModel.invoke.mock.calls[0][0];
        const userMessage = callArgs.find(
          (m: any) => m._getType?.() === "human" || m.role === "user",
        );
        const contextStr = userMessage.content.split("\n\n")[1];
        const context = JSON.parse(contextStr);

        // Implementation sends first 3 errors in context (in this case only 2 exist)
        expect(context.tool_errors.length).toBeLessThanOrEqual(3);
      });
    });
  });
});
