import { Transformer, ValidationResult } from "./types.js";

/**
 * CSV transformer - converts arrays of objects to/from CSV
 */
export const csvTransformer: Transformer<Record<string, unknown>[], string> = {
  from(csv: string): Record<string, unknown>[] {
    const lines = csv.trim().split("\n");
    if (lines.length === 0) return [];

    const headers = lines[0].split(",").map((h) => h.trim());
    const result = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(",").map((v) => v.trim());
      const row: Record<string, unknown> = {};

      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = values[j];
      }

      result.push(row);
    }

    return result;
  },

  to(data: Record<string, unknown>[]): string {
    if (data.length === 0) return "";

    const headers = Object.keys(data[0]);
    const lines = [headers.join(",")];

    for (const row of data) {
      const values = headers.map((h) => String(row[h] || ""));
      lines.push(values.join(","));
    }

    return lines.join("\n");
  },

  validate(data: unknown): ValidationResult {
    if (!Array.isArray(data)) {
      return {
        valid: false,
        errors: ["Data must be an array of objects"],
      };
    }

    for (const item of data) {
      if (typeof item !== "object" || item === null) {
        return {
          valid: false,
          errors: ["Each item must be an object"],
        };
      }
    }

    return {
      valid: true,
      errors: [],
    };
  },
};
