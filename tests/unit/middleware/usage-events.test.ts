/**
 * Usage-Events Middleware Tests (AGI-268)
 *
 * Verifies the loopback POST contract sent to siad's
 * /local/agent-usage-event endpoint. Uses dependency-injected `httpPost`
 * so we never reach axios or the network.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { AIMessage } from "@langchain/core/messages";
import { createUsageEventsMiddleware } from "../../../src/middleware/usage-events.js";

function makeRequest(extra: Record<string, unknown> = {}) {
  return { model: { modelName: "openai/gpt-4o" }, ...extra };
}

function makeResponse(
  opts: {
    usageMetadata?: AIMessage["usage_metadata"];
    responseMetadata?: Record<string, unknown>;
  } = {},
) {
  return new AIMessage({
    content: "ok",
    usage_metadata: opts.usageMetadata,
    response_metadata: opts.responseMetadata,
  });
}

function invokeWrap(mw: any, request: any, response: unknown) {
  return mw.wrapModelCall(request, async () => response);
}

const baseOptions = {
  eventsUrl: "http://127.0.0.1:9999/local/agent-usage-event",
  localToken: "tok-123",
  agentId: "agent-abc",
  workspaceId: "ws-xyz",
  provider: "openrouter",
};

describe("createUsageEventsMiddleware", () => {
  it("POSTs raw token usage when all env is present", async () => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const mw = createUsageEventsMiddleware({ ...baseOptions, httpPost });

    const response = makeResponse({
      usageMetadata: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      },
    });
    const result = await invokeWrap(mw, makeRequest(), response);

    expect(result).toBe(response);
    expect(httpPost).toHaveBeenCalledTimes(1);
    const [url, body, headers, timeoutMs] = httpPost.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, string>,
      number,
    ];
    expect(url).toBe(baseOptions.eventsUrl);
    expect(headers.Authorization).toBe(`Bearer ${baseOptions.localToken}`);
    expect(timeoutMs).toBe(2000);
    expect(body).toMatchObject({
      agentId: "agent-abc",
      workspaceId: "ws-xyz",
      provider: "openrouter",
      model: "openai/gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(typeof body.timestamp).toBe("string");
    expect(typeof body.runId).toBe("string");
  });

  it("is a no-op when SIAD_EVENTS_URL is missing", async () => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const mw = createUsageEventsMiddleware({
      ...baseOptions,
      eventsUrl: undefined,
      httpPost,
    });

    const response = makeResponse({
      usageMetadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    const result = await invokeWrap(mw, makeRequest(), response);

    expect(result).toBe(response);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("is a no-op when SIAD_LOCAL_TOKEN is missing", async () => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const mw = createUsageEventsMiddleware({
      ...baseOptions,
      localToken: undefined,
      httpPost,
    });

    const response = makeResponse({
      usageMetadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    const result = await invokeWrap(mw, makeRequest(), response);

    expect(result).toBe(response);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("is a no-op when usage_metadata is absent", async () => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const mw = createUsageEventsMiddleware({ ...baseOptions, httpPost });

    const response = makeResponse();
    const result = await invokeWrap(mw, makeRequest(), response);

    expect(result).toBe(response);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("forwards generationId, responseModel, threadId, cachedTokens when present", async () => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const mw = createUsageEventsMiddleware({ ...baseOptions, httpPost });

    const response = makeResponse({
      usageMetadata: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_token_details: { cache_read: 20 },
      },
      responseMetadata: { id: "gen-x", model: "m-x" },
    });
    const request = makeRequest({
      runtime: { configurable: { thread_id: "thr-1" } },
    });

    await invokeWrap(mw, request, response);

    expect(httpPost).toHaveBeenCalledTimes(1);
    const [, body] = httpPost.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, string>,
      number,
    ];
    expect(body.threadId).toBe("thr-1");
    expect(body.cachedTokens).toBe(20);
    expect(body.providerMetadata).toEqual({
      generationId: "gen-x",
      model: "m-x",
    });
    expect(body.model).toBe("m-x");
  });

  it("swallows POST errors and returns the response", async () => {
    const httpPost = jest
      .fn<any>()
      .mockRejectedValue(new Error("connection refused"));
    const mw = createUsageEventsMiddleware({ ...baseOptions, httpPost });

    const response = makeResponse({
      usageMetadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    const result = await invokeWrap(mw, makeRequest(), response);

    expect(result).toBe(response);
    expect(httpPost).toHaveBeenCalledTimes(1);
  });
});
