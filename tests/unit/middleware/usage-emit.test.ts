/**
 * Usage-emit core tests (AGI-312).
 *
 * Covers emitUsageEnvelope (body shape, gate no-ops, error-swallow, optional
 * field forwarding) and extractUsageFromLLMResult (ChatGeneration path,
 * llmOutput fallback, null). Uses dependency-injected `httpPost` so we never
 * reach axios or the network.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { AIMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import {
  emitUsageEnvelope,
  extractUsageFromLLMResult,
  readCacheWriteTokens,
  readCacheWriteTokensFromMessage,
  type UsageEnvelopeParams,
} from "../../../src/middleware/usage-emit.js";

const baseOptions = {
  eventsUrl: "http://127.0.0.1:9999/local/agent-usage-event",
  localToken: "tok-123",
  agentId: "agent-abc",
  workspaceId: "ws-xyz",
  provider: "openrouter",
};

const baseParams: UsageEnvelopeParams = {
  model: "openai/gpt-4o",
  inputTokens: 100,
  outputTokens: 50,
};

describe("emitUsageEnvelope", () => {
  it("POSTs the raw envelope when all gates are present", async () => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const sent = await emitUsageEnvelope(baseParams, {
      ...baseOptions,
      httpPost,
    });

    expect(sent).toBe(true);
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
    // Omitted optionals stay absent.
    expect(body.threadId).toBeUndefined();
    expect(body.cachedTokens).toBeUndefined();
    expect("cacheWriteTokens" in body).toBe(false);
    expect(body.providerMetadata).toBeUndefined();
  });

  it.each([
    ["a positive count", 1200],
    ["zero (reported, none written)", 0],
  ])("forwards cacheWriteTokens for %s", async (_name, count) => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    await emitUsageEnvelope(
      { ...baseParams, cacheWriteTokens: count },
      { ...baseOptions, httpPost },
    );

    const [, body] = httpPost.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(body.cacheWriteTokens).toBe(count);
  });

  it("forwards threadId, cachedTokens, and providerMetadata when present", async () => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    await emitUsageEnvelope(
      {
        ...baseParams,
        threadId: "thr-1",
        cachedTokens: 20,
        providerMetadata: { generationId: "gen-x", model: "m-x" },
      },
      { ...baseOptions, httpPost },
    );

    const [, body] = httpPost.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(body.threadId).toBe("thr-1");
    expect(body.cachedTokens).toBe(20);
    expect(body.providerMetadata).toEqual({
      generationId: "gen-x",
      model: "m-x",
    });
  });

  it.each([
    ["eventsUrl", { eventsUrl: undefined }],
    ["localToken", { localToken: undefined }],
    ["agentId", { agentId: undefined }],
    ["workspaceId", { workspaceId: undefined }],
  ])("is a no-op when %s is missing", async (_name, override) => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const sent = await emitUsageEnvelope(baseParams, {
      ...baseOptions,
      ...override,
      httpPost,
    });
    expect(sent).toBe(false);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("swallows POST errors and returns false", async () => {
    const httpPost = jest
      .fn<any>()
      .mockRejectedValue(new Error("connection refused"));
    const sent = await emitUsageEnvelope(baseParams, {
      ...baseOptions,
      httpPost,
    });
    expect(sent).toBe(false);
    expect(httpPost).toHaveBeenCalledTimes(1);
  });
});

describe("extractUsageFromLLMResult", () => {
  function chatGenResult(
    usageMetadata?: AIMessage["usage_metadata"],
    responseMetadata?: Record<string, unknown>,
  ): LLMResult {
    const message = new AIMessage({
      content: "ok",
      usage_metadata: usageMetadata,
      response_metadata: responseMetadata,
    });
    return {
      generations: [[{ text: "ok", message } as any]],
    } as LLMResult;
  }

  it("reads usage from the ChatGeneration message", () => {
    const out = chatGenResult(
      {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_token_details: { cache_read: 20 },
      },
      { id: "gen-x", model: "m-x" },
    );
    const params = extractUsageFromLLMResult(out);
    expect(params).toEqual({
      model: "m-x",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      providerMetadata: { generationId: "gen-x", model: "m-x" },
    });
  });

  it("falls back to llmOutput.tokenUsage when no message usage", () => {
    const out = {
      generations: [[{ text: "ok" } as any]],
      llmOutput: { tokenUsage: { promptTokens: 7, completionTokens: 3 } },
    } as LLMResult;
    const params = extractUsageFromLLMResult(out);
    expect(params).toEqual({
      model: "unknown",
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it("returns null when neither carries usage", () => {
    const out = chatGenResult(undefined, { id: "gen-x" });
    expect(extractUsageFromLLMResult(out)).toBeNull();

    const empty = { generations: [[{ text: "ok" } as any]] } as LLMResult;
    expect(extractUsageFromLLMResult(empty)).toBeNull();
  });

  it("carries cacheWriteTokens from the message's raw usage", () => {
    const out = chatGenResult(
      { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
      { usage: { prompt_tokens_details: { cache_write_tokens: 90 } } },
    );
    expect(extractUsageFromLLMResult(out)?.cacheWriteTokens).toBe(90);
  });

  it("carries cacheWriteTokens on the llmOutput fallback", () => {
    const out = {
      generations: [[{ text: "ok" } as any]],
      llmOutput: {
        tokenUsage: {
          promptTokens: 7,
          completionTokens: 3,
          prompt_tokens_details: { cache_write_tokens: 4 },
        },
      },
    } as LLMResult;
    expect(extractUsageFromLLMResult(out)).toEqual({
      model: "unknown",
      inputTokens: 7,
      outputTokens: 3,
      cacheWriteTokens: 4,
    });
  });

  it("leaves cacheWriteTokens out when nothing reports it", () => {
    const out = chatGenResult({
      input_tokens: 100,
      output_tokens: 5,
      total_tokens: 105,
    });
    const params = extractUsageFromLLMResult(out);
    expect(params).not.toBeNull();
    expect("cacheWriteTokens" in (params as object)).toBe(false);
  });
});

describe("readCacheWriteTokens", () => {
  function message(opts: {
    cacheCreation?: unknown;
    rawUsage?: unknown;
  }): AIMessage {
    return new AIMessage({
      content: "ok",
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 105,
        ...(opts.cacheCreation !== undefined
          ? { input_token_details: { cache_creation: opts.cacheCreation } }
          : {}),
      } as AIMessage["usage_metadata"],
      response_metadata:
        opts.rawUsage !== undefined ? { usage: opts.rawUsage } : {},
    });
  }

  function result(msg?: AIMessage, tokenUsage?: unknown): LLMResult {
    return {
      generations: [[{ text: "ok", ...(msg ? { message: msg } : {}) } as any]],
      ...(tokenUsage !== undefined ? { llmOutput: { tokenUsage } } : {}),
    } as LLMResult;
  }

  it("reads the normalized usage_metadata cache_creation", () => {
    expect(readCacheWriteTokensFromMessage(message({ cacheCreation: 30 }))).toBe(
      30,
    );
  });

  it("reads response_metadata.usage.prompt_tokens_details.cache_write_tokens", () => {
    const msg = message({
      rawUsage: { prompt_tokens_details: { cache_write_tokens: 40 } },
    });
    expect(readCacheWriteTokensFromMessage(msg)).toBe(40);
  });

  it("reads llmOutput.tokenUsage.prompt_tokens_details.cache_write_tokens", () => {
    const out = result(message({}), {
      prompt_tokens_details: { cache_write_tokens: 50 },
    });
    expect(readCacheWriteTokens(out)).toBe(50);
  });

  it("prefers the normalized field over the raw usage", () => {
    const msg = message({
      cacheCreation: 30,
      rawUsage: { prompt_tokens_details: { cache_write_tokens: 40 } },
    });
    expect(
      readCacheWriteTokens(
        result(msg, { prompt_tokens_details: { cache_write_tokens: 50 } }),
      ),
    ).toBe(30);
  });

  it("returns 0 when 0 is reported (distinct from not reported)", () => {
    const msg = message({
      rawUsage: { prompt_tokens_details: { cache_write_tokens: 0 } },
    });
    expect(readCacheWriteTokensFromMessage(msg)).toBe(0);
  });

  it("returns undefined when nothing reports it", () => {
    expect(readCacheWriteTokensFromMessage(message({}))).toBeUndefined();
    expect(readCacheWriteTokens(result())).toBeUndefined();
    expect(readCacheWriteTokensFromMessage(undefined)).toBeUndefined();
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "12"],
    ["NaN", Number.NaN],
    ["null", null],
  ])("ignores a %s count", (_name, value) => {
    const msg = message({
      rawUsage: { prompt_tokens_details: { cache_write_tokens: value } },
    });
    expect(readCacheWriteTokensFromMessage(msg)).toBeUndefined();
  });
});
