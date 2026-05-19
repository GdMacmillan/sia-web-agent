/**
 * Auto-Continue Middleware
 *
 * Retries failed LLM API calls on transient errors (429 rate limits,
 * 5xx server errors, network errors) using exponential backoff with jitter.
 * Placed first in the middleware stack so retries are invisible to
 * cost tracking and all downstream middleware.
 */

import { createMiddleware, type AgentMiddleware } from "langchain";
import { logger } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface AutoContinueConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
}

export interface AutoContinueMiddlewareOptions {
  config?: Partial<AutoContinueConfig>;
  /** Injectable delay function for testing (DIP) */
  delayFn?: (ms: number) => Promise<void>;
}

const DEFAULT_CONFIG: AutoContinueConfig = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 300_000,
  jitterFactor: 0.1,
};

// ─── Retryable HTTP status codes ─────────────────────────────

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// ─── Network error patterns ─────────────────────────────────

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
]);

const RETRYABLE_MESSAGE_PATTERNS = [
  "fetch failed",
  "socket hang up",
  "network error",
];

// ─── Pure Functions ──────────────────────────────────────────

/**
 * Determine whether an error is transient and worth retrying.
 */
export function isRetryableError(error: unknown): boolean {
  if (error == null || typeof error === "string") {
    return false;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  // Check HTTP status codes
  const status = (error as any).status;
  if (typeof status === "number" && RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  // Check error codes (ECONNRESET, ETIMEDOUT, etc.)
  const code = (error as any).code;
  if (typeof code === "string" && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  // Check message patterns
  const message = error.message?.toLowerCase() ?? "";
  if (RETRYABLE_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern))) {
    return true;
  }

  // Recursive check on cause
  if (error.cause) {
    return isRetryableError(error.cause);
  }

  return false;
}

/**
 * Extract Retry-After header value from an error, converting to milliseconds.
 * Returns null if no valid Retry-After header is found.
 */
export function extractRetryAfter(error: unknown): number | null {
  if (error == null || typeof error !== "object") {
    return null;
  }

  const headerSources = [
    (error as any).headers,
    (error as any).response?.headers,
  ];

  for (const headers of headerSources) {
    if (!headers) continue;

    let value: string | undefined;

    // Support Headers object with get() method
    if (typeof headers.get === "function") {
      value = headers.get("retry-after");
    } else {
      value = headers["retry-after"];
    }

    if (value != null) {
      const seconds = Number(value);
      if (!Number.isNaN(seconds)) {
        return seconds * 1000;
      }
    }
  }

  return null;
}

/**
 * Calculate backoff delay for a given attempt.
 * Uses exponential backoff: initialDelayMs * 2^attempt, capped at maxDelayMs.
 * If retryAfterMs is provided (from Retry-After header), uses that instead.
 * Applies jitter as ±jitterFactor percentage of the delay.
 */
export function calculateBackoff(
  attempt: number,
  config: AutoContinueConfig,
  retryAfterMs?: number | null,
): number {
  let delay: number;

  if (retryAfterMs != null) {
    delay = retryAfterMs;
  } else {
    delay = config.initialDelayMs * Math.pow(2, attempt);
  }

  // Cap at maxDelayMs
  delay = Math.min(delay, config.maxDelayMs);

  // Apply jitter
  if (config.jitterFactor > 0) {
    const jitterRange = delay * config.jitterFactor;
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    delay = Math.round(delay + jitter);
  }

  return delay;
}

// ─── Middleware Factory ──────────────────────────────────────

const defaultDelayFn = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Create auto-continue middleware that retries transient LLM API errors.
 *
 * Place first in the middleware stack so retries are invisible to
 * cost tracking and all downstream middleware.
 */
export function createAutoContinueMiddleware(
  options?: AutoContinueMiddlewareOptions,
): AgentMiddleware {
  const config: AutoContinueConfig = {
    ...DEFAULT_CONFIG,
    ...options?.config,
  };
  const delayFn = options?.delayFn ?? defaultDelayFn;

  return createMiddleware({
    name: "autoContinueMiddleware",

    wrapModelCall: async (request: any, handler: any) => {
      let lastError: unknown;

      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        try {
          return await handler(request);
        } catch (error) {
          lastError = error;

          // Don't retry non-transient errors
          if (!isRetryableError(error)) {
            throw error;
          }

          // Don't retry if we've exhausted all attempts
          if (attempt >= config.maxRetries) {
            break;
          }

          const retryAfterMs = extractRetryAfter(error);
          const delay = calculateBackoff(attempt, config, retryAfterMs);

          logger.warn(
            `[AutoContinue] Transient error (attempt ${attempt + 1}/${config.maxRetries}), retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`,
          );

          await delayFn(delay);
        }
      }

      throw lastError;
    },
  });
}
