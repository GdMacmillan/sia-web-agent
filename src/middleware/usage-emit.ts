/**
 * Raw usage-emit core (AGI-312).
 *
 * Extracted from usage-events.ts so the same loopback POST contract can be
 * reused from a callback handler (for bare `model.invoke()` sites that sit
 * outside the middleware stack). Behavior is identical to the middleware's
 * original inline implementation.
 *
 * The emit POSTs raw token counts to the local events endpoint. Everything
 * downstream is a host concern this module is deliberately blind to — it only
 * forwards token counts, never cost.
 *
 * No-op gates: SIAD_EVENTS_URL/SIAD_LOCAL_TOKEN unset (standalone OSS mode),
 * SIA_AGENT_ID/SIA_WORKSPACE_ID unset, or no usage in the result.
 *
 * Best-effort: every error is caught and dropped. Never throws.
 */
import type { LLMResult, ChatGeneration } from "@langchain/core/outputs";
import { isAIMessage } from "@langchain/core/messages";
import axios from "axios";
import { getConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";

export const POST_TIMEOUT_MS = 2000;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type HttpPost = (
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<void>;

export const defaultPost: HttpPost = async (url, body, headers, timeoutMs) => {
  await axios({
    method: "POST",
    url,
    data: body,
    headers: { "Content-Type": "application/json", ...headers },
    timeout: timeoutMs,
  });
};

export function generateRunId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/** Gate/identity overrides. Each falls back to the matching env var. */
export interface UsageEmitOptions {
  eventsUrl?: string;
  localToken?: string;
  agentId?: string;
  workspaceId?: string;
  provider?: string;
  /** Inject HTTP poster for tests. Defaults to axios. */
  httpPost?: HttpPost;
}

interface ResolvedEnv {
  eventsUrl?: string;
  localToken?: string;
  agentId?: string;
  workspaceId?: string;
  provider: string;
}

/** Resolve gate vars + provider from explicit options, else `process.env`. */
export function resolveEnv(options: UsageEmitOptions = {}): ResolvedEnv {
  return {
    eventsUrl: options.eventsUrl ?? process.env.SIAD_EVENTS_URL,
    localToken: options.localToken ?? process.env.SIAD_LOCAL_TOKEN,
    agentId: options.agentId ?? process.env.SIA_AGENT_ID,
    workspaceId: options.workspaceId ?? process.env.SIA_WORKSPACE_ID,
    provider: options.provider ?? getConfig().llm.provider,
  };
}

/** Normalized token usage forwarded in the raw envelope. */
export interface UsageEnvelopeParams {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  threadId?: string;
  providerMetadata?: Record<string, unknown>;
}

/**
 * Build the raw envelope, apply the no-op gates, and POST it best-effort.
 * Never throws. Returns true when a POST was attempted, false on a no-op.
 */
export async function emitUsageEnvelope(
  params: UsageEnvelopeParams,
  options: UsageEmitOptions = {},
): Promise<boolean> {
  try {
    const { eventsUrl, localToken, agentId, workspaceId, provider } =
      resolveEnv(options);

    if (!eventsUrl || !localToken) return false;
    if (!agentId || !workspaceId) return false;

    const body: Record<string, unknown> = {
      agentId,
      workspaceId,
      timestamp: new Date().toISOString(),
      provider,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      runId: generateRunId(),
    };
    if (params.threadId) body.threadId = params.threadId;
    if (params.cachedTokens !== undefined)
      body.cachedTokens = params.cachedTokens;
    if (
      params.providerMetadata &&
      Object.keys(params.providerMetadata).length > 0
    ) {
      body.providerMetadata = params.providerMetadata;
    }

    const httpPost = options.httpPost ?? defaultPost;
    await httpPost(
      eventsUrl,
      body,
      { Authorization: `Bearer ${localToken}` },
      POST_TIMEOUT_MS,
    );
    logger.debug(
      `[UsageEmit] posted model=${params.model} in=${params.inputTokens} out=${params.outputTokens}`,
    );
    return true;
  } catch (err) {
    logger.debug("[UsageEmit] dropped: " + errMsg(err));
    return false;
  }
}

/**
 * Extract normalized token usage from a LangChain `LLMResult`. Mirrors the
 * middleware's read of an `AIMessage`, but works from the raw result so it
 * covers `.withStructuredOutput()` sites (where `.invoke()` returns the parsed
 * object, not the message). Returns `null` when no usage is present.
 *
 * Primary source: the `ChatGeneration`'s `message` (usage_metadata +
 * response_metadata). Fallback: `llmOutput.tokenUsage|estimatedTokenUsage`.
 */
export function extractUsageFromLLMResult(
  output: LLMResult,
): UsageEnvelopeParams | null {
  const gen = output?.generations?.[0]?.[0] as ChatGeneration | undefined;
  const message = (gen as { message?: unknown } | undefined)?.message;

  if (message && isAIMessage(message as never)) {
    const aiMessage = message as {
      usage_metadata?: {
        input_tokens?: number;
        output_tokens?: number;
        input_token_details?: { cache_read?: number };
      };
      response_metadata?: Record<string, unknown>;
    };
    const usage = aiMessage.usage_metadata;
    if (usage) {
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

      const providerMetadata: Record<string, unknown> = {};
      if (generationId) providerMetadata.generationId = generationId;
      if (responseModel) providerMetadata.model = responseModel;

      return {
        model: responseModel ?? "unknown",
        inputTokens,
        outputTokens,
        cachedTokens,
        providerMetadata:
          Object.keys(providerMetadata).length > 0
            ? providerMetadata
            : undefined,
      };
    }
  }

  // Fallback: aggregate token usage on llmOutput.
  const llmOutput = output?.llmOutput as
    | {
        tokenUsage?: { promptTokens?: number; completionTokens?: number };
        estimatedTokenUsage?: {
          promptTokens?: number;
          completionTokens?: number;
        };
      }
    | undefined;
  const tokenUsage = llmOutput?.tokenUsage ?? llmOutput?.estimatedTokenUsage;
  if (tokenUsage) {
    const inputTokens =
      typeof tokenUsage.promptTokens === "number" ? tokenUsage.promptTokens : 0;
    const outputTokens =
      typeof tokenUsage.completionTokens === "number"
        ? tokenUsage.completionTokens
        : 0;
    if (inputTokens === 0 && outputTokens === 0) return null;
    return { model: "unknown", inputTokens, outputTokens };
  }

  return null;
}
