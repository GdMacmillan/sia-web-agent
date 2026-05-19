/**
 * Unit tests for LLM Provider Resolution
 *
 * Tests the provider preset system that resolves LLM_PROVIDER env var
 * to the correct baseUrl, apiKey, and model for each provider.
 */

import {
  getActiveProvider,
  resolveProviderConfig,
} from "../../../src/config/llm-providers.js";

// Save original env and restore after each test
const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  // Clear all LLM-related env vars for clean test state
  delete process.env.LLM_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.VLLM_API_KEY;
  delete process.env.VLLM_MODEL;
  delete process.env.VLLM_BASE_URL;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.LMSTUDIO_API_KEY;
  delete process.env.LMSTUDIO_MODEL;
  delete process.env.LMSTUDIO_BASE_URL;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
  // Per-agent overrides
  delete process.env.OPENROUTER_PLANNER_MODEL;
  delete process.env.OPENROUTER_PLANNER_API_KEY;
  delete process.env.OPENAI_PLANNER_MODEL;
  delete process.env.OPENAI_PLANNER_API_KEY;
});

afterAll(() => {
  process.env = originalEnv;
});

describe("getActiveProvider", () => {
  it("defaults to openrouter when LLM_PROVIDER is not set", () => {
    expect(getActiveProvider()).toBe("openrouter");
  });

  it("returns the provider from LLM_PROVIDER env var", () => {
    process.env.LLM_PROVIDER = "openai";
    expect(getActiveProvider()).toBe("openai");
  });

  it("normalizes provider name to lowercase", () => {
    process.env.LLM_PROVIDER = "OpenAI";
    expect(getActiveProvider()).toBe("openai");
  });

  it("throws for unknown provider", () => {
    process.env.LLM_PROVIDER = "unknown-provider";
    expect(() => getActiveProvider()).toThrow(/unknown-provider/);
    expect(() => getActiveProvider()).toThrow(/Supported providers/);
  });
});

describe("resolveProviderConfig", () => {
  describe("openrouter provider (default)", () => {
    it("resolves with openrouter defaults", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test-key";
      process.env.OPENROUTER_MODEL = "openai/gpt-4o-mini";

      const config = resolveProviderConfig();

      expect(config.apiKey).toBe("sk-or-test-key");
      expect(config.model).toBe("openai/gpt-4o-mini");
      expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
    });

    it("uses default model when OPENROUTER_MODEL is not set", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test-key";

      const config = resolveProviderConfig();

      expect(config.model).toBe("openai/gpt-4o-mini");
    });

    it("allows base URL override via OPENROUTER_BASE_URL", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test-key";
      process.env.OPENROUTER_BASE_URL = "https://custom.openrouter.ai/v1";

      const config = resolveProviderConfig();

      expect(config.baseUrl).toBe("https://custom.openrouter.ai/v1");
    });

    it("throws when API key is missing for openrouter", () => {
      expect(() => resolveProviderConfig()).toThrow(/API key required/);
      expect(() => resolveProviderConfig()).toThrow(/OPENROUTER_API_KEY/);
    });
  });

  describe("openai provider", () => {
    beforeEach(() => {
      process.env.LLM_PROVIDER = "openai";
    });

    it("resolves with openai defaults", () => {
      process.env.OPENAI_API_KEY = "sk-openai-key";
      process.env.OPENAI_MODEL = "gpt-4o";

      const config = resolveProviderConfig();

      expect(config.apiKey).toBe("sk-openai-key");
      expect(config.model).toBe("gpt-4o");
      expect(config.baseUrl).toBe("https://api.openai.com/v1");
    });

    it("throws when API key is missing for openai", () => {
      expect(() => resolveProviderConfig()).toThrow(/API key required/);
      expect(() => resolveProviderConfig()).toThrow(/OPENAI_API_KEY/);
    });
  });

  describe("local providers (vllm, ollama, lmstudio)", () => {
    it("resolves vllm with localhost defaults and no key required", () => {
      process.env.LLM_PROVIDER = "vllm";

      const config = resolveProviderConfig();

      expect(config.apiKey).toBe("");
      expect(config.baseUrl).toBe("http://localhost:8000/v1");
    });

    it("resolves ollama with localhost defaults and no key required", () => {
      process.env.LLM_PROVIDER = "ollama";

      const config = resolveProviderConfig();

      expect(config.apiKey).toBe("");
      expect(config.baseUrl).toBe("http://localhost:11434/v1");
    });

    it("resolves lmstudio with localhost defaults and no key required", () => {
      process.env.LLM_PROVIDER = "lmstudio";

      const config = resolveProviderConfig();

      expect(config.apiKey).toBe("");
      expect(config.baseUrl).toBe("http://localhost:1234/v1");
    });

    it("allows model override for local providers", () => {
      process.env.LLM_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "llama3.2";

      const config = resolveProviderConfig();

      expect(config.model).toBe("llama3.2");
    });

    it("allows optional API key for local providers", () => {
      process.env.LLM_PROVIDER = "vllm";
      process.env.VLLM_API_KEY = "optional-key";

      const config = resolveProviderConfig();

      expect(config.apiKey).toBe("optional-key");
    });

    it("allows base URL override for local providers", () => {
      process.env.LLM_PROVIDER = "ollama";
      process.env.OLLAMA_BASE_URL = "http://remote-server:11434/v1";

      const config = resolveProviderConfig();

      expect(config.baseUrl).toBe("http://remote-server:11434/v1");
    });
  });

  describe("custom provider", () => {
    beforeEach(() => {
      process.env.LLM_PROVIDER = "custom";
    });

    it("reads from LLM_* env vars", () => {
      process.env.LLM_API_KEY = "custom-key";
      process.env.LLM_BASE_URL = "https://my-llm.example.com/v1";
      process.env.LLM_MODEL = "my-model";

      const config = resolveProviderConfig();

      expect(config.apiKey).toBe("custom-key");
      expect(config.baseUrl).toBe("https://my-llm.example.com/v1");
      expect(config.model).toBe("my-model");
    });

    it("throws when base URL is missing for custom provider", () => {
      process.env.LLM_API_KEY = "custom-key";

      expect(() => resolveProviderConfig()).toThrow(/LLM_BASE_URL/);
    });
  });

  describe("per-agent overrides", () => {
    it("uses agent-specific model when available", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-key";
      process.env.OPENROUTER_MODEL = "openai/gpt-4o-mini";
      process.env.OPENROUTER_PLANNER_MODEL = "openai/gpt-4o";

      const config = resolveProviderConfig("PLANNER");

      expect(config.model).toBe("openai/gpt-4o");
      expect(config.apiKey).toBe("sk-or-key");
    });

    it("uses agent-specific API key when available", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-default";
      process.env.OPENROUTER_PLANNER_API_KEY = "sk-or-planner";

      const config = resolveProviderConfig("PLANNER");

      expect(config.apiKey).toBe("sk-or-planner");
    });

    it("falls back to provider defaults when agent overrides not set", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-key";
      process.env.OPENROUTER_MODEL = "openai/gpt-4o-mini";

      const config = resolveProviderConfig("PLANNER");

      expect(config.model).toBe("openai/gpt-4o-mini");
      expect(config.apiKey).toBe("sk-or-key");
    });

    it("works with non-openrouter providers", () => {
      process.env.LLM_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-openai-key";
      process.env.OPENAI_MODEL = "gpt-4o-mini";
      process.env.OPENAI_PLANNER_MODEL = "gpt-4o";

      const config = resolveProviderConfig("PLANNER");

      expect(config.model).toBe("gpt-4o");
      expect(config.apiKey).toBe("sk-openai-key");
    });
  });

  describe("backward compatibility", () => {
    it("works with existing OPENROUTER_* vars when LLM_PROVIDER is unset", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-existing-key";
      process.env.OPENROUTER_MODEL = "openai/gpt-oss-120b";

      const config = resolveProviderConfig();

      expect(config.apiKey).toBe("sk-or-existing-key");
      expect(config.model).toBe("openai/gpt-oss-120b");
      expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
    });

    it("preserves per-agent overrides with existing OPENROUTER_* pattern", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-key";
      process.env.OPENROUTER_MODEL = "openai/gpt-4o-mini";
      process.env.OPENROUTER_PLANNER_MODEL = "openai/gpt-oss-120b";
      process.env.OPENROUTER_PLANNER_API_KEY = "sk-or-planner-key";

      const config = resolveProviderConfig("PLANNER");

      expect(config.model).toBe("openai/gpt-oss-120b");
      expect(config.apiKey).toBe("sk-or-planner-key");
      expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
    });
  });
});
