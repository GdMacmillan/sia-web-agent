/**
 * Auto-Continue Middleware Tests
 *
 * Tests retry logic for transient LLM API failures:
 * - Pure function unit tests (isRetryableError, extractRetryAfter, calculateBackoff)
 * - Integration tests for createAutoContinueMiddleware wrapModelCall behavior
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  isRetryableError,
  extractRetryAfter,
  calculateBackoff,
  createAutoContinueMiddleware,
  type AutoContinueConfig,
} from "../../../src/middleware/auto-continue.js";

describe("Auto-Continue Middleware", () => {
  // ─── isRetryableError ───────────────────────────────────────

  describe("isRetryableError", () => {
    it("returns true for status 429 (rate limit)", () => {
      const error = Object.assign(new Error("Too Many Requests"), {
        status: 429,
      });
      expect(isRetryableError(error)).toBe(true);
    });

    it("returns true for status 500", () => {
      const error = Object.assign(new Error("Internal Server Error"), {
        status: 500,
      });
      expect(isRetryableError(error)).toBe(true);
    });

    it("returns true for status 502", () => {
      const error = Object.assign(new Error("Bad Gateway"), { status: 502 });
      expect(isRetryableError(error)).toBe(true);
    });

    it("returns true for status 503", () => {
      const error = Object.assign(new Error("Service Unavailable"), {
        status: 503,
      });
      expect(isRetryableError(error)).toBe(true);
    });

    it("returns true for status 504", () => {
      const error = Object.assign(new Error("Gateway Timeout"), {
        status: 504,
      });
      expect(isRetryableError(error)).toBe(true);
    });

    it("returns true for ECONNRESET", () => {
      const error = Object.assign(new Error("Connection reset"), {
        code: "ECONNRESET",
      });
      expect(isRetryableError(error)).toBe(true);
    });

    it("returns true for ETIMEDOUT", () => {
      const error = Object.assign(new Error("Timed out"), {
        code: "ETIMEDOUT",
      });
      expect(isRetryableError(error)).toBe(true);
    });

    it("returns true for ECONNABORTED", () => {
      const error = Object.assign(new Error("Connection aborted"), {
        code: "ECONNABORTED",
      });
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for "fetch failed" in message', () => {
      const error = new Error("fetch failed");
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for "socket hang up" in message', () => {
      const error = new Error("socket hang up");
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for "network error" in message', () => {
      const error = new Error("network error");
      expect(isRetryableError(error)).toBe(true);
    });

    it("returns true for nested cause with retryable error", () => {
      const cause = Object.assign(new Error("Internal Server Error"), {
        status: 500,
      });
      const error = new Error("Request failed", { cause });
      expect(isRetryableError(error)).toBe(true);
    });

    it("returns false for status 400", () => {
      const error = Object.assign(new Error("Bad Request"), { status: 400 });
      expect(isRetryableError(error)).toBe(false);
    });

    it("returns false for status 401", () => {
      const error = Object.assign(new Error("Unauthorized"), { status: 401 });
      expect(isRetryableError(error)).toBe(false);
    });

    it("returns false for status 404", () => {
      const error = Object.assign(new Error("Not Found"), { status: 404 });
      expect(isRetryableError(error)).toBe(false);
    });

    it("returns false for TypeError", () => {
      const error = new TypeError("Cannot read property of null");
      expect(isRetryableError(error)).toBe(false);
    });

    it("returns false for null", () => {
      expect(isRetryableError(null)).toBe(false);
    });

    it("returns false for plain strings", () => {
      expect(isRetryableError("some error")).toBe(false);
    });

    it("returns false for non-retryable error without status/code", () => {
      const error = new Error("Something went wrong");
      expect(isRetryableError(error)).toBe(false);
    });
  });

  // ─── extractRetryAfter ─────────────────────────────────────

  describe("extractRetryAfter", () => {
    it("extracts numeric seconds from error.headers['retry-after']", () => {
      const error = Object.assign(new Error("Rate limited"), {
        headers: { "retry-after": "30" },
      });
      expect(extractRetryAfter(error)).toBe(30_000);
    });

    it("extracts from error.response.headers['retry-after']", () => {
      const error = Object.assign(new Error("Rate limited"), {
        response: { headers: { "retry-after": "5" } },
      });
      expect(extractRetryAfter(error)).toBe(5_000);
    });

    it("returns null for missing headers", () => {
      const error = new Error("Some error");
      expect(extractRetryAfter(error)).toBeNull();
    });

    it("returns null for invalid (non-numeric) retry-after value", () => {
      const error = Object.assign(new Error("Rate limited"), {
        headers: { "retry-after": "not-a-number" },
      });
      expect(extractRetryAfter(error)).toBeNull();
    });

    it("returns null for null input", () => {
      expect(extractRetryAfter(null)).toBeNull();
    });

    it("handles retry-after of zero", () => {
      const error = Object.assign(new Error("Rate limited"), {
        headers: { "retry-after": "0" },
      });
      expect(extractRetryAfter(error)).toBe(0);
    });

    it("handles Headers object with get method", () => {
      const headers = new Map([["retry-after", "10"]]);
      const error = Object.assign(new Error("Rate limited"), {
        headers: { get: (key: string) => headers.get(key) },
      });
      expect(extractRetryAfter(error)).toBe(10_000);
    });
  });

  // ─── calculateBackoff ──────────────────────────────────────

  describe("calculateBackoff", () => {
    const baseConfig: AutoContinueConfig = {
      maxRetries: 5,
      initialDelayMs: 1000,
      maxDelayMs: 300_000,
      jitterFactor: 0,
    };

    it("returns initialDelayMs for attempt 0 (no jitter)", () => {
      expect(calculateBackoff(0, baseConfig)).toBe(1000);
    });

    it("doubles delay for attempt 1", () => {
      expect(calculateBackoff(1, baseConfig)).toBe(2000);
    });

    it("quadruples delay for attempt 2", () => {
      expect(calculateBackoff(2, baseConfig)).toBe(4000);
    });

    it("caps at maxDelayMs", () => {
      const config: AutoContinueConfig = {
        ...baseConfig,
        maxDelayMs: 5000,
      };
      // attempt 3 would be 8000, capped at 5000
      expect(calculateBackoff(3, config)).toBe(5000);
    });

    it("uses retryAfterMs when provided", () => {
      expect(calculateBackoff(0, baseConfig, 15_000)).toBe(15_000);
    });

    it("caps retryAfterMs at maxDelayMs", () => {
      const config: AutoContinueConfig = {
        ...baseConfig,
        maxDelayMs: 10_000,
      };
      expect(calculateBackoff(0, config, 60_000)).toBe(10_000);
    });

    it("applies jitter when jitterFactor > 0", () => {
      const config: AutoContinueConfig = {
        ...baseConfig,
        jitterFactor: 0.1,
      };
      // With 0.1 jitter on 1000ms base, result should be between 900 and 1100
      const results = new Set<number>();
      for (let i = 0; i < 50; i++) {
        const delay = calculateBackoff(0, config);
        expect(delay).toBeGreaterThanOrEqual(900);
        expect(delay).toBeLessThanOrEqual(1100);
        results.add(delay);
      }
      // Jitter should produce some variation (not all the same value)
      expect(results.size).toBeGreaterThan(1);
    });
  });

  // ─── createAutoContinueMiddleware (wrapModelCall integration) ──

  describe("createAutoContinueMiddleware", () => {
    const delayFn = jest.fn(async () => {});
    const mockResponse = { message: "success", id: "msg-123" };

    beforeEach(() => {
      delayFn.mockClear();
    });

    it("creates middleware with correct name", () => {
      const middleware = createAutoContinueMiddleware({ delayFn });
      expect(middleware).toBeDefined();
      expect(middleware.name).toBe("autoContinueMiddleware");
    });

    it("succeeds on first try without delay", async () => {
      const middleware = createAutoContinueMiddleware({ delayFn });
      const handler = jest.fn(async () => mockResponse);

      const wrapModelCall = middleware.wrapModelCall!;
      const result = await wrapModelCall({} as any, handler as any);

      expect(result).toBe(mockResponse);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(delayFn).not.toHaveBeenCalled();
    });

    it("retries on 429 then succeeds", async () => {
      const middleware = createAutoContinueMiddleware({
        delayFn,
        config: { jitterFactor: 0 },
      });
      const rateLimitError = Object.assign(new Error("Too Many Requests"), {
        status: 429,
      });
      const handler = jest
        .fn<() => Promise<any>>()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(mockResponse);

      const wrapModelCall = middleware.wrapModelCall!;
      const result = await wrapModelCall({} as any, handler as any);

      expect(result).toBe(mockResponse);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(delayFn).toHaveBeenCalledTimes(1);
    });

    it("retries on 503 then succeeds", async () => {
      const middleware = createAutoContinueMiddleware({
        delayFn,
        config: { jitterFactor: 0 },
      });
      const serverError = Object.assign(new Error("Service Unavailable"), {
        status: 503,
      });
      const handler = jest
        .fn<() => Promise<any>>()
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(mockResponse);

      const wrapModelCall = middleware.wrapModelCall!;
      const result = await wrapModelCall({} as any, handler as any);

      expect(result).toBe(mockResponse);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(delayFn).toHaveBeenCalledTimes(1);
    });

    it("retries on network error then succeeds", async () => {
      const middleware = createAutoContinueMiddleware({
        delayFn,
        config: { jitterFactor: 0 },
      });
      const networkError = new Error("fetch failed");
      const handler = jest
        .fn<() => Promise<any>>()
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce(mockResponse);

      const wrapModelCall = middleware.wrapModelCall!;
      const result = await wrapModelCall({} as any, handler as any);

      expect(result).toBe(mockResponse);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on 400 - throws immediately", async () => {
      const middleware = createAutoContinueMiddleware({ delayFn });
      const clientError = Object.assign(new Error("Bad Request"), {
        status: 400,
      });
      const handler = jest
        .fn<() => Promise<any>>()
        .mockRejectedValueOnce(clientError);

      const wrapModelCall = middleware.wrapModelCall!;
      await expect(wrapModelCall({} as any, handler as any)).rejects.toThrow(
        "Bad Request",
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(delayFn).not.toHaveBeenCalled();
    });

    it("does NOT retry on TypeError - throws immediately", async () => {
      const middleware = createAutoContinueMiddleware({ delayFn });
      const typeError = new TypeError("Cannot read property of null");
      const handler = jest
        .fn<() => Promise<any>>()
        .mockRejectedValueOnce(typeError);

      const wrapModelCall = middleware.wrapModelCall!;
      await expect(wrapModelCall({} as any, handler as any)).rejects.toThrow(
        TypeError,
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(delayFn).not.toHaveBeenCalled();
    });

    it("exhausts maxRetries then throws the last error", async () => {
      const middleware = createAutoContinueMiddleware({
        delayFn,
        config: { maxRetries: 2, jitterFactor: 0 },
      });
      const serverError = Object.assign(new Error("Internal Server Error"), {
        status: 500,
      });
      const handler = jest
        .fn<() => Promise<any>>()
        .mockRejectedValue(serverError);

      const wrapModelCall = middleware.wrapModelCall!;
      await expect(wrapModelCall({} as any, handler as any)).rejects.toThrow(
        "Internal Server Error",
      );

      // 1 initial + 2 retries = 3 total calls
      expect(handler).toHaveBeenCalledTimes(3);
      expect(delayFn).toHaveBeenCalledTimes(2);
    });

    it("respects Retry-After header value", async () => {
      const middleware = createAutoContinueMiddleware({
        delayFn,
        config: { jitterFactor: 0 },
      });
      const rateLimitError = Object.assign(new Error("Too Many Requests"), {
        status: 429,
        headers: { "retry-after": "30" },
      });
      const handler = jest
        .fn<() => Promise<any>>()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(mockResponse);

      const wrapModelCall = middleware.wrapModelCall!;
      await wrapModelCall({} as any, handler as any);

      // Should use 30 seconds from Retry-After header
      expect(delayFn).toHaveBeenCalledWith(30_000);
    });

    it("backoff increases exponentially across retries", async () => {
      const middleware = createAutoContinueMiddleware({
        delayFn,
        config: { maxRetries: 3, initialDelayMs: 1000, jitterFactor: 0 },
      });
      const serverError = Object.assign(new Error("Bad Gateway"), {
        status: 502,
      });
      const handler = jest
        .fn<() => Promise<any>>()
        .mockRejectedValueOnce(serverError)
        .mockRejectedValueOnce(serverError)
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(mockResponse);

      const wrapModelCall = middleware.wrapModelCall!;
      await wrapModelCall({} as any, handler as any);

      expect(delayFn).toHaveBeenCalledTimes(3);
      expect(delayFn).toHaveBeenNthCalledWith(1, 1000); // 1000 * 2^0
      expect(delayFn).toHaveBeenNthCalledWith(2, 2000); // 1000 * 2^1
      expect(delayFn).toHaveBeenNthCalledWith(3, 4000); // 1000 * 2^2
    });

    it("returns exact response object from handler on success", async () => {
      const middleware = createAutoContinueMiddleware({ delayFn });
      const specificResponse = {
        id: "unique-id",
        content: "Hello",
        metadata: { tokens: 42 },
      };
      const handler = jest.fn(async () => specificResponse);

      const wrapModelCall = middleware.wrapModelCall!;
      const result = await wrapModelCall({} as any, handler as any);

      expect(result).toBe(specificResponse); // referential equality
    });

    it("passes request through to handler unchanged", async () => {
      const middleware = createAutoContinueMiddleware({ delayFn });
      const request = { systemPrompt: "test", model: "gpt-4" };
      const handler = jest.fn(async () => mockResponse);

      const wrapModelCall = middleware.wrapModelCall!;
      await wrapModelCall(request as any, handler as any);

      expect(handler).toHaveBeenCalledWith(request);
    });
  });
});
