/**
 * Unit tests for Configuration Validation
 *
 * Tests validateConfig() and logValidationResult() from the
 * centralized configuration validation system.
 */

import {
  validateConfig,
  logValidationResult,
} from "../../../src/config/validate.js";
import { loadConfig, resetConfig } from "../../../src/config/loader.js";
import type { AgentConfig } from "../../../src/config/schema.js";

// Save original env and restore after each test
const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  resetConfig();

  // Clear all relevant env vars
  delete process.env.LLM_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.OPENROUTER_SMALL_FAST_MODEL;
  delete process.env.OPENROUTER_MIDTIER_MODEL;
  delete process.env.OPENROUTER_HEAVY_THINKING_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
  delete process.env.TAVILY_API_KEY;
  delete process.env.KNOWLEDGE_FORMATION_MIN_CONFIDENCE;
  delete process.env.KNOWLEDGE_FORMATION_DEDUP_THRESHOLD;
  delete process.env.OUTCOME_TRACKING_SIMILARITY_WEIGHT;
  delete process.env.OUTCOME_TRACKING_SUCCESS_WEIGHT;
  delete process.env.OUTCOME_TRACKING_RECENCY_WEIGHT;
});

afterAll(() => {
  process.env = originalEnv;
});

/**
 * Helper to build a valid config for testing.
 * Sets required env vars and loads config.
 */
function buildValidConfig(): AgentConfig {
  process.env.OPENROUTER_API_KEY = "sk-or-test-key";
  process.env.TAVILY_API_KEY = "tvly-test-key";
  return loadConfig();
}

// ============================================================================
// validateConfig()
// ============================================================================

describe("validateConfig", () => {
  describe("valid config", () => {
    it("returns valid with no errors when everything configured correctly", () => {
      const config = buildValidConfig();
      const result = validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("may still have warnings on a valid config", () => {
      const config = buildValidConfig();
      const result = validateConfig(config);

      // Valid means no errors, warnings are allowed
      expect(result.valid).toBe(true);
    });
  });

  describe("missing API key", () => {
    it("errors when openrouter provider has no API key", () => {
      // Don't set OPENROUTER_API_KEY
      const config = loadConfig();
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("OPENROUTER_API_KEY");
      expect(result.errors[0]).toContain("required");
    });

    it("errors when openai provider has no API key", () => {
      process.env.LLM_PROVIDER = "openai";
      // Don't set OPENAI_API_KEY

      const config = loadConfig();
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("OPENAI_API_KEY");
    });

    it("does not error for local providers without API key", () => {
      process.env.LLM_PROVIDER = "ollama";

      const config = loadConfig();
      const result = validateConfig(config);

      // No API key error for local providers
      const apiKeyErrors = result.errors.filter((e) =>
        e.includes("API_KEY is required"),
      );
      expect(apiKeyErrors).toHaveLength(0);
    });
  });

  describe("missing base URL for custom provider", () => {
    it("errors when custom provider has no base URL", () => {
      process.env.LLM_PROVIDER = "custom";
      // Don't set LLM_BASE_URL

      const config = loadConfig();
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("LLM_BASE_URL")]),
      );
    });

    it("no error when custom provider has base URL", () => {
      process.env.LLM_PROVIDER = "custom";
      process.env.LLM_BASE_URL = "https://my-llm.example.com/v1";

      const config = loadConfig();
      const result = validateConfig(config);

      const baseUrlErrors = result.errors.filter((e) =>
        e.includes("LLM_BASE_URL"),
      );
      expect(baseUrlErrors).toHaveLength(0);
    });
  });

  describe("invalid confidence values", () => {
    it("errors when min confidence is greater than 1", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.KNOWLEDGE_FORMATION_MIN_CONFIDENCE = "1.5";

      const config = loadConfig();
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("KNOWLEDGE_FORMATION_MIN_CONFIDENCE"),
        ]),
      );
    });

    it("errors when min confidence is less than 0", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.KNOWLEDGE_FORMATION_MIN_CONFIDENCE = "-0.1";

      const config = loadConfig();
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("KNOWLEDGE_FORMATION_MIN_CONFIDENCE"),
        ]),
      );
    });

    it("errors when deduplication threshold is out of range", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.KNOWLEDGE_FORMATION_DEDUP_THRESHOLD = "2.0";

      const config = loadConfig();
      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("KNOWLEDGE_FORMATION_DEDUP_THRESHOLD"),
        ]),
      );
    });

    it("accepts valid confidence values at boundaries", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.TAVILY_API_KEY = "tvly-key";
      process.env.KNOWLEDGE_FORMATION_MIN_CONFIDENCE = "0";
      process.env.KNOWLEDGE_FORMATION_DEDUP_THRESHOLD = "1";

      const config = loadConfig();
      const result = validateConfig(config);

      // No confidence-related errors
      const confidenceErrors = result.errors.filter(
        (e) => e.includes("MIN_CONFIDENCE") || e.includes("DEDUP_THRESHOLD"),
      );
      expect(confidenceErrors).toHaveLength(0);
    });
  });

  describe("re-ranking weight sum warning", () => {
    it("warns when re-ranking weights do not sum to 1.0", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.OUTCOME_TRACKING_SIMILARITY_WEIGHT = "0.5";
      process.env.OUTCOME_TRACKING_SUCCESS_WEIGHT = "0.5";
      process.env.OUTCOME_TRACKING_RECENCY_WEIGHT = "0.5";

      const config = loadConfig();
      const result = validateConfig(config);

      // This should be a warning, not an error
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("re-ranking weights sum"),
        ]),
      );
    });

    it("does not warn when weights sum to approximately 1.0", () => {
      const config = buildValidConfig();
      const result = validateConfig(config);

      const weightWarnings = result.warnings.filter((w) =>
        w.includes("re-ranking weights"),
      );
      expect(weightWarnings).toHaveLength(0);
    });
  });

  describe("missing Tavily key warning", () => {
    it("warns when TAVILY_API_KEY is not set", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      // Don't set TAVILY_API_KEY

      const config = loadConfig();
      const result = validateConfig(config);

      // Should be a warning, NOT an error
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("TAVILY_API_KEY")]),
      );
    });

    it("does not warn when TAVILY_API_KEY is set", () => {
      const config = buildValidConfig();
      const result = validateConfig(config);

      const tavilyWarnings = result.warnings.filter((w) =>
        w.includes("TAVILY_API_KEY"),
      );
      expect(tavilyWarnings).toHaveLength(0);
    });
  });

  describe("model tier warnings", () => {
    it("warns about empty model tiers for remote providers", () => {
      // Construct a config manually with empty tiers to test the validation logic
      const config = buildValidConfig();
      // Override tiers with empty strings to simulate missing tier models
      config.llm.tiers = { smallFast: "", midtier: "", heavyThinking: "" };
      // Set provider to one that requires a key so the tier check runs
      config.llm.provider = "openrouter";

      const result = validateConfig(config);

      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("Model tier")]),
      );
    });
  });
});

// ============================================================================
// logValidationResult()
// ============================================================================

describe("logValidationResult", () => {
  it("logs errors when present", () => {
    const mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    };

    const result = {
      valid: false,
      errors: ["Missing API key", "Invalid base URL"],
      warnings: [],
    };

    logValidationResult(result, mockLogger);

    expect(mockLogger.error).toHaveBeenCalledWith(
      "[Config] Configuration errors:",
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Missing API key"),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid base URL"),
    );
  });

  it("logs warnings when present", () => {
    const mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    };

    const result = {
      valid: true,
      errors: [],
      warnings: ["Tavily key not set"],
    };

    logValidationResult(result, mockLogger);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[Config] Configuration warnings:",
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Tavily key not set"),
    );
  });

  it("logs success when valid with no warnings", () => {
    const mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    };

    const result = {
      valid: true,
      errors: [],
      warnings: [],
    };

    logValidationResult(result, mockLogger);

    expect(mockLogger.info).toHaveBeenCalledWith(
      "[Config] Configuration validated successfully.",
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("uses Pino logger as default logger when none provided", () => {
    // When no logger is passed, logValidationResult uses the Pino defaultLogger.
    // Verify it doesn't throw and completes without error.
    const result = {
      valid: true,
      errors: [],
      warnings: [],
    };

    expect(() => logValidationResult(result)).not.toThrow();
  });

  it("logs both errors and warnings when present", () => {
    const mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    };

    const result = {
      valid: false,
      errors: ["Missing API key"],
      warnings: ["Tavily key not set"],
    };

    logValidationResult(result, mockLogger);

    expect(mockLogger.error).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});
