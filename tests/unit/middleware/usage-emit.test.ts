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
    expect(body.providerMetadata).toBeUndefined();
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
});
