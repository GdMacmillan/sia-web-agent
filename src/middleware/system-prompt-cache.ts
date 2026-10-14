/**
 * System prompt cache breakpoint.
 *
 * Marks the system prompt as a prompt-cache breakpoint
 * (`cache_control: { type: "ephemeral" }` on its text block) when the model is
 * an Anthropic model reached through an OpenAI-compatible gateway such as
 * OpenRouter. Anthropic models only cache with an explicit breakpoint; the
 * gateway forwards content-block `cache_control` as-is. Everything up to and
 * including the breakpoint — tool definitions plus the system prompt — is
 * then read from cache on later calls, which only works because the system
 * prompt is byte-stable (see `utils/system-context.ts` and
 * `middleware/host-context.ts`).
 *
 * Other providers cache automatically by prefix (OpenAI, DeepSeek, Gemini
 * implicit caching) and get the request unchanged, as does a native
 * `ChatAnthropic` model, which LangChain's own prompt-caching middleware
 * handles.
 *
 * Keep this the innermost middleware that touches the system prompt: it
 * replaces the system message object while leaving `systemPrompt` intact, so
 * a later middleware changing `systemPrompt` would conflict with it.
 */

import { createMiddleware, type AgentMiddleware } from "langchain";
import { SystemMessage } from "@langchain/core/messages";

export const SYSTEM_PROMPT_CACHE_MIDDLEWARE_NAME =
  "systemPromptCacheMiddleware";

export interface SystemPromptCacheMiddlewareOptions {
  /**
   * Model id to use when it can't be read from the request's model object.
   */
  modelId?: string;
}

/**
 * Whether a model id names an Anthropic model: an `anthropic/` gateway prefix
 * or `claude` anywhere in the id, case-insensitive.
 */
export function isAnthropicModelId(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.startsWith("anthropic/") || id.includes("claude");
}

interface ModelIdentity {
  model?: unknown;
  modelName?: unknown;
  getName?: () => string;
}

function readModelId(model: unknown, fallback?: string): string | undefined {
  const candidate = model as ModelIdentity | undefined;
  if (typeof candidate?.model === "string") return candidate.model;
  if (typeof candidate?.modelName === "string") return candidate.modelName;
  return fallback;
}

function isNativeAnthropicModel(model: unknown): boolean {
  const candidate = model as ModelIdentity | undefined;
  try {
    return candidate?.getName?.() === "ChatAnthropic";
  } catch {
    return false;
  }
}

/** Create the system prompt cache breakpoint middleware. */
export function createSystemPromptCacheMiddleware(
  options: SystemPromptCacheMiddlewareOptions = {},
): AgentMiddleware {
  return createMiddleware({
    name: SYSTEM_PROMPT_CACHE_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      if (isNativeAnthropicModel(request.model)) return handler(request);
      if (!isAnthropicModelId(readModelId(request.model, options.modelId))) {
        return handler(request);
      }

      const text = request.systemPrompt ?? request.systemMessage?.text ?? "";
      if (!text) return handler(request);

      return handler({
        ...request,
        systemMessage: new SystemMessage({
          content: [
            { type: "text", text, cache_control: { type: "ephemeral" } },
          ],
        }),
      });
    },
  });
}
