/**
 * Middleware Isolation Test
 *
 * Systematically tests each middleware to isolate the 400 Provider error.
 * Run with: RUN_INTEGRATION=true yarn jest tests/integration/middleware-isolation.test.ts
 */

/* eslint-disable no-console */
import "./setup-env.js";
import { describe, it, expect, jest } from "@jest/globals";
import { HumanMessage } from "@langchain/core/messages";
import {
  createAgent,
  todoListMiddleware,
  summarizationMiddleware,
  anthropicPromptCachingMiddleware,
} from "langchain";
import { createChatModel } from "../../src/config/model-config.js";
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createKnowledgeFormationMiddleware,
} from "../../src/middleware/index.js";
import { defaultBackendFactory } from "../../src/backend-config.js";

const hasApiKey = !!process.env.OPENROUTER_API_KEY;
const runIntegration = process.env.RUN_INTEGRATION === "true";
const describeIntegration =
  hasApiKey && runIntegration ? describe : describe.skip;

describeIntegration("Middleware Isolation Tests", () => {
  jest.setTimeout(120000);

  let model: any;

  beforeAll(async () => {
    model = await createChatModel();
    console.log("Model created:", model.model);
  });

  it("should work with NO middleware (baseline)", async () => {
    console.log("\n=== Test: No middleware ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-no-middleware" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ No middleware works");
  });

  it("should work with todoListMiddleware only", async () => {
    console.log("\n=== Test: todoListMiddleware only ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [todoListMiddleware()],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-todo" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ todoListMiddleware works");
  });

  it("should work with FilesystemMiddleware only", async () => {
    console.log("\n=== Test: FilesystemMiddleware only ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [
        createFilesystemMiddleware({ backend: defaultBackendFactory }),
      ],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-fs" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ FilesystemMiddleware works");
  });

  it("should work with patchToolCallsMiddleware only", async () => {
    console.log("\n=== Test: patchToolCallsMiddleware only ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [createPatchToolCallsMiddleware()],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-patch" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ patchToolCallsMiddleware works");
  });

  it("should work with summarizationMiddleware only", async () => {
    console.log("\n=== Test: summarizationMiddleware only ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [
        summarizationMiddleware({
          model,
          trigger: { tokens: 170000 },
          keep: { messages: 20 },
        }),
      ],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-summarization" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ summarizationMiddleware works");
  });

  it("should work with anthropicPromptCachingMiddleware only", async () => {
    console.log("\n=== Test: anthropicPromptCachingMiddleware only ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [
        anthropicPromptCachingMiddleware({
          unsupportedModelBehavior: "ignore",
        }),
      ],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-caching" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ anthropicPromptCachingMiddleware works");
  });

  it("should work with knowledgeFormationMiddleware only", async () => {
    console.log("\n=== Test: knowledgeFormationMiddleware only ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [
        createKnowledgeFormationMiddleware({
          model,
          agentType: "test",
        }),
      ],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-knowledge" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ knowledgeFormationMiddleware works");
  });

  it("should work with todo + filesystem middleware", async () => {
    console.log("\n=== Test: todo + filesystem ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [
        todoListMiddleware(),
        createFilesystemMiddleware({ backend: defaultBackendFactory }),
      ],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-todo-fs" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ todo + filesystem works");
  });

  it("should work with subAgentMiddleware (minimal config)", async () => {
    console.log("\n=== Test: subAgentMiddleware (minimal) ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [
        createSubAgentMiddleware({
          defaultModel: model,
          defaultTools: [],
          defaultMiddleware: [], // No nested middleware
          subagents: [],
          generalPurposeAgent: false,
        }),
      ],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-subagent-minimal" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ subAgentMiddleware (minimal) works");
  });

  it("should work with subAgentMiddleware (with nested todoListMiddleware)", async () => {
    console.log("\n=== Test: subAgentMiddleware + nested todo ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [
        createSubAgentMiddleware({
          defaultModel: model,
          defaultTools: [],
          defaultMiddleware: [todoListMiddleware()],
          subagents: [],
          generalPurposeAgent: false,
        }),
      ],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-subagent-todo" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ subAgentMiddleware + nested todo works");
  });

  it("should work with full middleware stack WITHOUT subAgentMiddleware", async () => {
    console.log("\n=== Test: Full stack minus subAgentMiddleware ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [
        todoListMiddleware(),
        createFilesystemMiddleware({ backend: defaultBackendFactory }),
        summarizationMiddleware({
          model,
          trigger: { tokens: 170000 },
          keep: { messages: 20 },
        }),
        anthropicPromptCachingMiddleware({
          unsupportedModelBehavior: "ignore",
        }),
        createPatchToolCallsMiddleware(),
        createKnowledgeFormationMiddleware({
          model,
          agentType: "test",
        }),
      ],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-full-no-subagent" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ Full stack minus subAgentMiddleware works");
  });

  it("should work with COMPLETE middleware stack", async () => {
    console.log("\n=== Test: COMPLETE middleware stack ===");
    const agent = createAgent({
      model,
      systemPrompt: "You are helpful.",
      tools: [],
      middleware: [
        todoListMiddleware(),
        createFilesystemMiddleware({ backend: defaultBackendFactory }),
        createSubAgentMiddleware({
          defaultModel: model,
          defaultTools: [],
          defaultMiddleware: [
            todoListMiddleware(),
            createFilesystemMiddleware({ backend: defaultBackendFactory }),
            summarizationMiddleware({
              model,
              trigger: { tokens: 170000 },
              keep: { messages: 20 },
            }),
            anthropicPromptCachingMiddleware({
              unsupportedModelBehavior: "ignore",
            }),
            createPatchToolCallsMiddleware(),
          ],
          subagents: [],
          generalPurposeAgent: true,
        }),
        summarizationMiddleware({
          model,
          trigger: { tokens: 170000 },
          keep: { messages: 20 },
        }),
        anthropicPromptCachingMiddleware({
          unsupportedModelBehavior: "ignore",
        }),
        createPatchToolCallsMiddleware(),
        createKnowledgeFormationMiddleware({
          model,
          agentType: "test",
        }),
      ],
    });

    const result = await agent.graph.invoke(
      { messages: [new HumanMessage("Say hi")] },
      { configurable: { thread_id: "test-complete" } },
    );

    expect(result.messages.length).toBeGreaterThan(1);
    console.log("✓ COMPLETE middleware stack works");
  });
});
