/**
 * Usage-envelope callback handler tests (AGI-312).
 *
 * A fake LLMResult carrying an AIMessage with usage_metadata is fed to
 * handleLLMEnd; we assert exactly one raw-envelope POST fires through the
 * injected httpPost.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { AIMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { createUsageEnvelopeCallbackHandler } from "../../../src/middleware/usage-callback-handler.js";

const baseOptions = {
  eventsUrl: "http://127.0.0.1:9999/local/agent-usage-event",
  localToken: "tok-123",
  agentId: "agent-abc",
  workspaceId: "ws-xyz",
  provider: "openrouter",
};

function llmResult(): LLMResult {
  const message = new AIMessage({
    content: "ok",
    usage_metadata: { input_tokens: 42, output_tokens: 7, total_tokens: 49 },
    response_metadata: { id: "gen-1", model: "m-1" },
  });
  return { generations: [[{ text: "ok", message } as any]] } as LLMResult;
}

describe("UsageEnvelopeCallbackHandler", () => {
  it("exposes the expected handler name", () => {
    const handler = createUsageEnvelopeCallbackHandler();
    expect(handler.name).toBe("usageEnvelopeCallbackHandler");
  });

  it("POSTs one raw envelope from handleLLMEnd", async () => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const handler = createUsageEnvelopeCallbackHandler({
      ...baseOptions,
      httpPost,
    });

    await handler.handleLLMEnd(llmResult(), "run-1");

    expect(httpPost).toHaveBeenCalledTimes(1);
    const [, body] = httpPost.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(body).toMatchObject({
      agentId: "agent-abc",
      workspaceId: "ws-xyz",
      model: "m-1",
      inputTokens: 42,
      outputTokens: 7,
    });
  });

  it("attaches threadId from options when provided", async () => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const handler = createUsageEnvelopeCallbackHandler({
      ...baseOptions,
      threadId: "thr-9",
      httpPost,
    });

    await handler.handleLLMEnd(llmResult(), "run-2");

    const [, body] = httpPost.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(body.threadId).toBe("thr-9");
  });

  it("is a no-op when the result carries no usage", async () => {
    const httpPost = jest.fn<any>().mockResolvedValue(undefined);
    const handler = createUsageEnvelopeCallbackHandler({
      ...baseOptions,
      httpPost,
    });

    const empty = { generations: [[{ text: "ok" } as any]] } as LLMResult;
    await handler.handleLLMEnd(empty, "run-3");

    expect(httpPost).not.toHaveBeenCalled();
  });
});
