/**
 * Usage-events middleware (AGI-268, Phase 1 of AGI-261).
 *
 * Replaces agent-side cost math (cost-tracking-middleware) with a thin
 * POST of raw token usage to siad's loopback events endpoint. siad
 * enriches with userId/nodeId and republishes on
 * `w.{wsId}.usage.agent.events`; the web consumer (AGI-265) computes
 * cost host-side via the OR pricing cache and writes `usage_events`.
 *
 * No-op gates: SIAD_EVENTS_URL/SIAD_LOCAL_TOKEN unset (standalone OSS
 * mode), SIA_AGENT_ID/SIA_WORKSPACE_ID unset, or aiMessage missing
 * usage_metadata.
 *
 * Best-effort: every error is caught and dropped. Never throws, never
 * blocks the model call.
 */
import { createMiddleware, type AgentMiddleware } from "langchain";
import { AIMessage, isAIMessage } from "@langchain/core/messages";
import axios from "axios";
import { getConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";

const POST_TIMEOUT_MS = 2000;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type HttpPost = (
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<void>;

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

function generateRunId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

const defaultPost: HttpPost = async (url, body, headers, timeoutMs) => {
  await axios({
    method: "POST",
    url,
    data: body,
    headers: { "Content-Type": "application/json", ...headers },
    timeout: timeoutMs,
  });
};

export function createUsageEventsMiddleware(
  options: UsageEventsMiddlewareOptions = {},
): AgentMiddleware {
  const httpPost = options.httpPost ?? defaultPost;

  return createMiddleware({
    name: "usageEventsMiddleware",
    wrapModelCall: async (request: any, handler: any) => {
      const response = await handler(request);

      try {
        const eventsUrl = options.eventsUrl ?? process.env.SIAD_EVENTS_URL;
        const localToken = options.localToken ?? process.env.SIAD_LOCAL_TOKEN;
        const agentId = options.agentId ?? process.env.SIA_AGENT_ID;
        const workspaceId = options.workspaceId ?? process.env.SIA_WORKSPACE_ID;
        const provider = options.provider ?? getConfig().llm.provider;

        if (!eventsUrl || !localToken) return response;
        if (!agentId || !workspaceId) return response;

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

        const body: Record<string, unknown> = {
          agentId,
          workspaceId,
          timestamp: new Date().toISOString(),
          provider,
          model,
          inputTokens,
          outputTokens,
          runId: generateRunId(),
        };
        if (threadId) body.threadId = threadId;
        if (cachedTokens !== undefined) body.cachedTokens = cachedTokens;
        if (Object.keys(providerMetadata).length > 0) {
          body.providerMetadata = providerMetadata;
        }

        await httpPost(
          eventsUrl,
          body,
          { Authorization: `Bearer ${localToken}` },
          POST_TIMEOUT_MS,
        );
        logger.debug(
          `[UsageEvents] posted model=${model} in=${inputTokens} out=${outputTokens}`,
        );
      } catch (err) {
        logger.debug("[UsageEvents] dropped: " + errMsg(err));
      }

      return response;
    },
  });
}
