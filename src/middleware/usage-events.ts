/**
 * Usage-events middleware (AGI-268, Phase 1 of AGI-261).
 *
 * The agent does not compute cost. After each model call it POSTs raw token
 * counts to the local events endpoint; everything downstream is a host
 * concern this module knows nothing about.
 *
 * No-op gates: the events endpoint / local token unset (standalone OSS mode),
 * agent / workspace identity unset, or the message carries no usage_metadata.
 *
 * Best-effort: every error is caught and dropped. Never throws, never
 * blocks the model call.
 *
 * AGI-312: the raw-emit core (envelope build, gates, POST) now lives in
 * usage-emit.ts so the same contract can be reused from a callback handler
 * for bare `model.invoke()` sites. This middleware keeps its AIMessage-aware
 * extraction (including the request-model fallback) and delegates the emit.
 */
import { createMiddleware, type AgentMiddleware } from "langchain";
import { AIMessage, isAIMessage } from "@langchain/core/messages";
import {
  emitUsageEnvelope,
  type HttpPost,
  type UsageEnvelopeParams,
} from "./usage-emit.js";

export interface UsageEventsMiddlewareOptions {
  /** Override for tests; default reads `process.env` at call time. */
  eventsUrl?: string;
  localToken?: string;
  agentId?: string;
  workspaceId?: string;
  provider?: string;
  /** Inject HTTP poster for tests. Defaults to axios. */
  httpPost?: HttpPost;
}

function extractAiMessage(response: unknown): AIMessage | null {
  if (isAIMessage(response as any)) return response as AIMessage;
  const r = response as {
    message?: any;
    generations?: Array<{ message?: any }>;
  };
  if (r?.message && isAIMessage(r.message)) return r.message;
  if (r?.generations?.[0]?.message && isAIMessage(r.generations[0].message)) {
    return r.generations[0].message as AIMessage;
  }
  return null;
}

function resolveRequestModel(request: any): string | undefined {
  const m = request?.model as { modelName?: string; model?: string };
  return m?.modelName ?? m?.model;
}

export function createUsageEventsMiddleware(
  options: UsageEventsMiddlewareOptions = {},
): AgentMiddleware {
  return createMiddleware({
    name: "usageEventsMiddleware",
    wrapModelCall: async (request: any, handler: any) => {
      const response = await handler(request);

      const aiMessage = extractAiMessage(response);
      if (!aiMessage) return response;
      const usage = aiMessage.usage_metadata;
      if (!usage) return response;

      const inputTokens =
        typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const outputTokens =
        typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      const cachedRead = usage.input_token_details?.cache_read;
      const cachedTokens =
        typeof cachedRead === "number" ? cachedRead : undefined;

      const meta = (aiMessage.response_metadata ?? {}) as Record<
        string,
        unknown
      >;
      const generationId = (meta.id ?? meta.generation_id) as
        | string
        | undefined;
      const responseModel = (meta.model ?? meta.model_name) as
        | string
        | undefined;
      const requestModel = resolveRequestModel(request);
      const model = responseModel ?? requestModel ?? "unknown";

      const threadId = (
        request?.runtime?.configurable as { thread_id?: string } | undefined
      )?.thread_id;

      const providerMetadata: Record<string, unknown> = {};
      if (generationId) providerMetadata.generationId = generationId;
      if (responseModel) providerMetadata.model = responseModel;

      const params: UsageEnvelopeParams = {
        model,
        inputTokens,
        outputTokens,
        cachedTokens,
        threadId,
        providerMetadata:
          Object.keys(providerMetadata).length > 0
            ? providerMetadata
            : undefined,
      };

      await emitUsageEnvelope(params, options);

      return response;
    },
  });
}
