import { Transformer, ValidationResult } from "./types.js";

/**
 * JSON transformer - converts objects to/from JSON
 */
export const jsonTransformer: Transformer<Record<string, unknown>, string> = {
  from(json: string): Record<string, unknown> {
    return JSON.parse(json) as Record<string, unknown>;
  },

  to(data: Record<string, unknown>): string {
    return JSON.stringify(data, null, 2);
  },

  validate(data: unknown): ValidationResult {
    if (typeof data !== "object" || data === null) {
      return {
        valid: false,
        errors: ["Data must be an object"],
      };
    }

    if (Array.isArray(data)) {
      return {
        valid: false,
        errors: ["Data must be an object, not an array"],
      };
    }

    return {
      valid: true,
      errors: [],
    };
  },
};
