/**
 * Prompt-cache write count through a real ChatOpenRouter (AGI-491).
 *
 * ChatOpenRouter does not normalise OpenRouter's
 * `usage.prompt_tokens_details.cache_write_tokens` into
 * `usage_metadata.input_token_details.cache_creation`, so the emitters read it
 * from the raw usage instead. These tests stub `fetch` with an OpenRouter
 * completion that reports 1200 cache-write tokens and assert both emit paths
 * forward it — pinning where the field really lands rather than relying on a
 * reading of the library.
 */

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { createAgent } from "langchain";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createUsageEventsMiddleware } from "../../../src/middleware/usage-events.js";
import { createUsageEnvelopeCallbackHandler } from "../../../src/middleware/usage-callback-handler.js";

const baseOptions = {
  eventsUrl: "http://127.0.0.1:9999/local/agent-usage-event",
  localToken: "tok-123",
  agentId: "agent-abc",
  workspaceId: "ws-xyz",
  provider: "openrouter",
};

function completion(promptTokensDetails?: Record<string, unknown>) {
  return {
    id: "gen-1",
    model: "anthropic/claude-haiku-4.5",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "done" },
      },
    ],
    usage: {
      prompt_tokens: 1500,
      completion_tokens: 4,
      total_tokens: 1504,
      ...(promptTokensDetails
        ? { prompt_tokens_details: promptTokensDetails }
        : {}),
    },
  };
}

function stubFetch(body: unknown) {
  jest.spyOn(globalThis, "fetch").mockImplementation((async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as any);
}

function model() {
  return new ChatOpenRouter({
    model: "anthropic/claude-haiku-4.5",
    apiKey: "test-key",
  });
}

function postedBodies(httpPost: jest.Mock<any>): Record<string, unknown>[] {
  return httpPost.mock.calls.map((c) => c[1] as Record<string, unknown>);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("cache-write tokens from a real ChatOpenRouter response", () => {
  it("the usage-events middleware forwards cacheWriteTokens", async () => {
    stubFetch(completion({ cached_tokens: 0, cache_write_tokens: 1200 }));
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const agent = createAgent({
      model: model(),
      tools: [],
      middleware: [createUsageEventsMiddleware({ ...baseOptions, httpPost })],
    });

    await agent.invoke({ messages: [{ role: "user", content: "hi" }] });

    const [body] = postedBodies(httpPost);
    expect(body).toBeDefined();
    expect(body.inputTokens).toBe(1500);
    expect(body.cachedTokens).toBe(0);
    expect(body.cacheWriteTokens).toBe(1200);
  });

  it("the usage-envelope callback handler forwards cacheWriteTokens", async () => {
    stubFetch(completion({ cached_tokens: 0, cache_write_tokens: 1200 }));
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const handler = createUsageEnvelopeCallbackHandler({
      ...baseOptions,
      httpPost,
    });
    // Await the handler so the POST is observable when invoke resolves.
    handler.awaitHandlers = true;

    await model().invoke("hi", { callbacks: [handler] });

    const [body] = postedBodies(httpPost);
    expect(body).toBeDefined();
    expect(body.cacheWriteTokens).toBe(1200);
  });

  it("omits cacheWriteTokens when OpenRouter reports none", async () => {
    stubFetch(completion());
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const agent = createAgent({
      model: model(),
      tools: [],
      middleware: [createUsageEventsMiddleware({ ...baseOptions, httpPost })],
    });

    await agent.invoke({ messages: [{ role: "user", content: "hi" }] });

    const [body] = postedBodies(httpPost);
    expect(body).toBeDefined();
    expect("cacheWriteTokens" in body).toBe(false);
  });
});
