/**
 * Usage-envelope callback handler (AGI-312).
 *
 * Some LLM calls run outside the middleware stack — notably bare
 * `model.invoke()` sites and `.withStructuredOutput()` calls (where
 * `.invoke()` returns the parsed object, not the message). A callback handler
 * sees the raw `LLMResult` in `handleLLMEnd` regardless of return shape, so it
 * can POST the same raw usage envelope to the local events endpoint that the
 * usage-events middleware sends for the main turn.
 *
 * `handleLLMEnd` fires only on a successful completion, so one invoke yields at
 * most one POST. Best-effort: never throws, never blocks.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import {
  emitUsageEnvelope,
  extractUsageFromLLMResult,
  type UsageEmitOptions,
} from "./usage-emit.js";

export interface UsageEnvelopeCallbackHandlerOptions extends UsageEmitOptions {
  /** Optional thread attribution; stateless sites omit it. */
  threadId?: string;
}

export class UsageEnvelopeCallbackHandler extends BaseCallbackHandler {
  name = "usageEnvelopeCallbackHandler";

  private readonly options: UsageEnvelopeCallbackHandlerOptions;

  constructor(options: UsageEnvelopeCallbackHandlerOptions = {}) {
    super();
    this.options = options;
  }

  async handleLLMEnd(output: LLMResult): Promise<void> {
    const params = extractUsageFromLLMResult(output);
    if (!params) return;
    if (this.options.threadId) params.threadId = this.options.threadId;
    await emitUsageEnvelope(params, this.options);
  }
}

export function createUsageEnvelopeCallbackHandler(
  options: UsageEnvelopeCallbackHandlerOptions = {},
): UsageEnvelopeCallbackHandler {
  return new UsageEnvelopeCallbackHandler(options);
}
