/**
 * Backend Utils Tests
 *
 * Tests for utility functions in backends/utils.ts
 */

import { describe, it, expect } from "@jest/globals";
import {
  TOOL_RESULT_TOKEN_LIMIT,
  truncateIfTooLong,
  TRUNCATION_GUIDANCE,
} from "../../../src/backends/utils.js";

describe("Backend Utils", () => {
  describe("truncateIfTooLong", () => {
    const maxChars = TOOL_RESULT_TOKEN_LIMIT * 4;

    describe("with string input", () => {
      it("should return string unchanged if under limit", () => {
        const shortString = "Hello, world!";
        const result = truncateIfTooLong(shortString);
        expect(result).toBe(shortString);
      });

      it("should truncate string if over limit", () => {
        const longString = "x".repeat(maxChars + 1000);
        const result = truncateIfTooLong(longString);
        expect(typeof result).toBe("string");
        expect((result as string).length).toBeLessThan(longString.length);
        expect((result as string).endsWith(TRUNCATION_GUIDANCE)).toBe(true);
      });

      it("should truncate to exactly maxChars plus guidance", () => {
        const longString = "x".repeat(maxChars + 1000);
        const result = truncateIfTooLong(longString) as string;
        expect(result).toBe("x".repeat(maxChars) + "\n" + TRUNCATION_GUIDANCE);
      });
    });

    describe("with array input", () => {
      it("should return array unchanged if total chars under limit", () => {
        const shortArray = ["Hello", "World", "Test"];
        const result = truncateIfTooLong(shortArray);
        expect(result).toEqual(shortArray);
      });

      it("should truncate array if total chars over limit", () => {
        // Create array with many items that total well over the limit
        const itemSize = 10000;
        const numItems = Math.ceil((maxChars * 3) / itemSize); // 3x over limit
        const longArray = Array(numItems).fill("x".repeat(itemSize));
        const result = truncateIfTooLong(longArray);
        expect(Array.isArray(result)).toBe(true);
        expect((result as string[]).length).toBeLessThan(longArray.length);
        expect((result as string[])[(result as string[]).length - 1]).toBe(
          TRUNCATION_GUIDANCE,
        );
      });

      it("should preserve items proportionally when truncating", () => {
        // Create array where each item is 1000 chars
        const itemSize = 1000;
        const numItems = Math.ceil((maxChars * 2) / itemSize);
        const longArray = Array(numItems).fill("x".repeat(itemSize));
        const result = truncateIfTooLong(longArray) as string[];

        // Should keep roughly half the items (since total is 2x limit)
        expect(result.length).toBeLessThan(numItems);
        expect(result[result.length - 1]).toBe(TRUNCATION_GUIDANCE);
      });
    });
  });
});
