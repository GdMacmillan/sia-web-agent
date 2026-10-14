/**
 * System Prompt Cache Middleware Tests
 *
 * For an Anthropic model behind OpenRouter the system prompt must reach the
 * wire as a content block carrying `cache_control`; for any other model the
 * request must be unchanged.
 */

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { createAgent } from "langchain";
import { ChatOpenRouter } from "@langchain/openrouter";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import {
  createSystemPromptCacheMiddleware,
  isAnthropicModelId,
} from "../../../src/middleware/system-prompt-cache.js";

const SYSTEM = "You are a byte-stable system prompt.";

function completion() {
  return {
    id: "gen-1",
    model: "m",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "done" },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

/** Run one agent turn against `modelId` and return the request bodies sent. */
async function sentBodies(modelId: string): Promise<any[]> {
  const bodies: any[] = [];
  const fetchMock = jest.fn(
    async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(completion()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  jest.spyOn(globalThis, "fetch").mockImplementation(fetchMock as any);

  const agent = createAgent({
    model: new ChatOpenRouter({ model: modelId, apiKey: "test-key" }),
    systemPrompt: SYSTEM,
    tools: [],
    middleware: [createSystemPromptCacheMiddleware()],
  });
  await agent.invoke({ messages: [{ role: "user", content: "hi" }] });
  return bodies;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("isAnthropicModelId", () => {
  it.each([
    ["anthropic/claude-sonnet-4.5", true],
    ["Anthropic/Claude-Opus-4", true],
    ["bedrock/us.anthropic.claude-3-haiku", true],
    ["claude-3-5-sonnet-latest", true],
    ["openai/gpt-4o-mini", false],
    ["deepseek/deepseek-chat", false],
    ["", false],
    [undefined, false],
  ])("%s -> %s", (id, expected) => {
    expect(isAnthropicModelId(id as string | undefined)).toBe(expected);
  });
});

describe("createSystemPromptCacheMiddleware on the wire", () => {
  it("marks the system prompt as a cache breakpoint for an Anthropic model", async () => {
    const [body] = await sentBodies("anthropic/claude-sonnet-4.5");

    expect(body.messages[0]).toEqual({
      role: "system",
      content: [
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
      ],
    });
  });

  it("leaves a non-Anthropic model's request unchanged", async () => {
    const [body] = await sentBodies("openai/gpt-4o-mini");

    // LangChain's own system message shape, with no breakpoint added.
    expect(body.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: SYSTEM }],
    });
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });
});

describe("createSystemPromptCacheMiddleware request handling", () => {
  async function run(request: Record<string, unknown>, modelId?: string) {
    let seen: any;
    await createSystemPromptCacheMiddleware({ modelId }).wrapModelCall!(
      request as any,
      (async (req: unknown) => {
        seen = req;
        return new AIMessage("ok");
      }) as any,
    );
    return seen;
  }

  it("keeps systemPrompt and swaps only the system message", async () => {
    const seen = await run({
      model: { model: "anthropic/claude-haiku-4.5" },
      systemPrompt: SYSTEM,
      messages: [],
    });

    expect(seen.systemPrompt).toBe(SYSTEM);
    expect(SystemMessage.isInstance(seen.systemMessage)).toBe(true);
    expect(seen.systemMessage.content[0].cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("falls back to the configured id when the model object carries none", async () => {
    const seen = await run(
      { model: {}, systemPrompt: SYSTEM, messages: [] },
      "anthropic/claude-haiku-4.5",
    );
    expect(seen.systemMessage).toBeDefined();
  });

  it("passes a native ChatAnthropic model through untouched", async () => {
    const request = {
      model: { model: "claude-sonnet-4-5", getName: () => "ChatAnthropic" },
      systemPrompt: SYSTEM,
      messages: [],
    };
    expect(await run(request)).toBe(request);
  });

  it("passes an empty system prompt through untouched", async () => {
    const request = {
      model: { model: "anthropic/claude-haiku-4.5" },
      systemPrompt: "",
      messages: [],
    };
    expect(await run(request)).toBe(request);
  });
});
