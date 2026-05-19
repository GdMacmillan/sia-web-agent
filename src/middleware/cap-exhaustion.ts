/**
 * Cap-exhaustion middleware (AGI-235).
 *
 * Detects OpenRouter's "key spend limit reached" 429 and surfaces it as a
 * `cap_exhausted` custom event so the web UI can show the global banner
 * without inventing a private side channel. The model error is re-thrown
 * unchanged after the event dispatches — the agent's normal retry / abort
 * paths still run.
 *
 * OR signals cap exhaustion with HTTP 429 + an error body that includes a
 * `metadata.reason` of `key_limit` (sometimes `daily_limit` / `monthly_limit`
 * for resetting caps). We match on any `*_limit` reason and on the literal
 * "spend limit" substring as a belt-and-braces fallback for routers that
 * change the field name without notice.
 */

import { createMiddleware, type AgentMiddleware } from "langchain";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { z } from "zod";

export const CapExhaustedDataSchema = z.object({
  reason: z.string(),
  message: z.string().optional(),
  model: z.string().optional(),
  timestamp: z.number(),
});

export type CapExhaustedData = z.infer<typeof CapExhaustedDataSchema>;

export interface CapExhaustedEvent {
  type: "cap_exhausted";
  data: CapExhaustedData;
}

// One-liner so `format-template-literals.js` doesn't collapse a multi-line
// ternary inside a template literal interpolation.
const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export interface CapExhaustionMiddlewareOptions {
  logger?: { warn: (m: string) => void };
}

interface ErrLike {
  status?: number;
  statusCode?: number;
  message?: string;
  body?: unknown;
  cause?: unknown;
}

function isLimitReason(reason: unknown): boolean {
  if (typeof reason !== "string") return false;
  const r = reason.toLowerCase();
  return r.endsWith("_limit") || r === "rate_limit_exceeded";
}

function extractReason(err: ErrLike): string | null {
  // OR error body: { error: { code, message, metadata: { reason: "key_limit" } } }
  const tryParse = (raw: unknown): unknown => {
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const body =
    typeof err.body === "string" ? tryParse(err.body) : (err.body ?? null);
  const reason =
    (body as { error?: { metadata?: { reason?: string } } } | null)?.error
      ?.metadata?.reason ?? null;
  if (isLimitReason(reason)) return reason as string;
  if (typeof err.message === "string" && /spend limit/i.test(err.message)) {
    return "key_limit";
  }
  return null;
}

export function createCapExhaustionMiddleware(
  options: CapExhaustionMiddlewareOptions = {},
): AgentMiddleware {
  const log = options.logger ?? { warn: (m: string) => console.warn(m) };

  return createMiddleware({
    name: "capExhaustionMiddleware",

    wrapModelCall: async (request: any, handler: any) => {
      // See cost-tracking-middleware for the rationale: `runtime.writer` is
      // the only path that reaches `streamMode: "custom"` consumers.
      const runtimeWriter = (
        request as { runtime?: { writer?: (chunk: unknown) => void } }
      )?.runtime?.writer;
      try {
        return await handler(request);
      } catch (err) {
        const e = err as ErrLike;
        const status = e.status ?? e.statusCode ?? 0;
        const reason = extractReason(e);
        if (status === 429 && reason) {
          const event: CapExhaustedEvent = {
            type: "cap_exhausted",
            data: {
              reason,
              message: e.message,
              model: (request?.model as { modelName?: string; model?: string })
                ?.modelName,
              timestamp: Date.now(),
            },
          };
          if (typeof runtimeWriter === "function") {
            try {
              runtimeWriter(event);
            } catch (writerErr) {
              log.warn(
                "[CapExhaustion] runtime.writer threw: " + errMsg(writerErr),
              );
            }
          }
          try {
            await dispatchCustomEvent("cap_exhausted", event.data);
          } catch (dispatchErr) {
            log.warn(
              "[CapExhaustion] dispatchCustomEvent failed: " +
                errMsg(dispatchErr),
            );
          }
        }
        throw err;
      }
    },
  });
}
