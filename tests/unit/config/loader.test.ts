/**
 * Unit tests for Centralized Config Loader
 *
 * Tests loadConfig(), getConfig(), resetConfig(), and resolveModelEndpoint()
 * from the new centralized configuration system.
 */

import {
  loadConfig,
  getConfig,
  resetConfig,
  resolveModelEndpoint,
} from "../../../src/config/loader.js";
import { AGENT_TIER_DEFAULTS } from "../../../src/config/schema.js";

// Save original env and restore after each test
const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  resetConfig();

  // Clear all LLM-related env vars for clean test state
  delete process.env.LLM_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.OPENROUTER_SMALL_FAST_MODEL;
  delete process.env.OPENROUTER_MIDTIER_MODEL;
  delete process.env.OPENROUTER_HEAVY_THINKING_MODEL;
  delete process.env.OPENROUTER_PLANNER_MODEL;
  delete process.env.OPENROUTER_PLANNER_API_KEY;
  delete process.env.OPENROUTER_ORCHESTRATOR_MODEL;
  delete process.env.OPENROUTER_RESEARCHER_MODEL;
  delete process.env.OPENROUTER_MEMORY_MODEL;
  delete process.env.OPENROUTER_ANSWER_MODEL;
  delete process.env.OPENROUTER_TOOL_USE_MODEL;
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

  // Clear feature env vars
  delete process.env.KNOWLEDGE_FORMATION_ENABLED;
  delete process.env.KNOWLEDGE_FORMATION_SENSITIVITY;
  delete process.env.KNOWLEDGE_FORMATION_MIN_CONFIDENCE;
  delete process.env.KNOWLEDGE_FORMATION_MAX_LEARNINGS;
  delete process.env.KNOWLEDGE_FORMATION_DEDUP_THRESHOLD;
  delete process.env.KNOWLEDGE_FORMATION_EXCLUDE_AGENTS;
  delete process.env.KNOWLEDGE_FORMATION_DEBUG;
  delete process.env.OUTCOME_TRACKING_ENABLED;
  delete process.env.OUTCOME_TRACKING_CRITIC_ENABLED;
  delete process.env.OUTCOME_TRACKING_SIMILARITY_WEIGHT;
  delete process.env.OUTCOME_TRACKING_SUCCESS_WEIGHT;
  delete process.env.OUTCOME_TRACKING_RECENCY_WEIGHT;
  delete process.env.OUTCOME_TRACKING_MAX_HISTORY;
  delete process.env.OUTCOME_TRACKING_MIN_APPLICATIONS;

  // Clear middleware env vars
  delete process.env.SUMMARIZATION_TRIGGER_TOKENS;
  delete process.env.SUMMARIZATION_KEEP_MESSAGES;
  delete process.env.COST_TRACKING_CACHE_TTL_MS;

  // Clear services env vars
  delete process.env.TAVILY_API_KEY;
  delete process.env.GRAPH_MEMORY_API;
  delete process.env.GRAPH_MEMORY_HOST;
  delete process.env.GRAPH_MEMORY_PORT;

  // Clear runtime env vars
  delete process.env.LOG_LEVEL;
  delete process.env.NODE_ENV;
  delete process.env.SIA_PROJECT_ROOT;
  delete process.env.SIA_CLI_SOCKET_PATH;
});

afterAll(() => {
  process.env = originalEnv;
});

// ============================================================================
// loadConfig() - Default Config
// ============================================================================

describe("loadConfig", () => {
  describe("default config", () => {
    it("returns valid config with all defaults when no env vars set", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test-key";

      const config = loadConfig();

      expect(config).toHaveProperty("llm");
      expect(config).toHaveProperty("features");
      expect(config).toHaveProperty("middleware");
      expect(config).toHaveProperty("services");
      expect(config).toHaveProperty("runtime");
    });

    it("defaults to openrouter provider", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test-key";

      const config = loadConfig();

      expect(config.llm.provider).toBe("openrouter");
      expect(config.llm.envPrefix).toBe("OPENROUTER");
      expect(config.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(config.llm.model).toBe("openai/gpt-4o-mini");
    });

    it("reads API key from provider-prefixed env var", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test-key";

      const config = loadConfig();

      expect(config.llm.apiKey).toBe("sk-or-test-key");
    });
  });

  // ============================================================================
  // LLM Provider Resolution
  // ============================================================================

  describe("LLM provider resolution", () => {
    it("resolves openrouter provider", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-key";

      const config = loadConfig();

      expect(config.llm.provider).toBe("openrouter");
      expect(config.llm.envPrefix).toBe("OPENROUTER");
      expect(config.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(config.llm.model).toBe("openai/gpt-4o-mini");
    });

    it("resolves openai provider", () => {
      process.env.LLM_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-openai-key";

      const config = loadConfig();

      expect(config.llm.provider).toBe("openai");
      expect(config.llm.envPrefix).toBe("OPENAI");
      expect(config.llm.baseUrl).toBe("https://api.openai.com/v1");
      expect(config.llm.model).toBe("gpt-4o-mini");
      expect(config.llm.apiKey).toBe("sk-openai-key");
    });

    it("resolves vllm provider", () => {
      process.env.LLM_PROVIDER = "vllm";

      const config = loadConfig();

      expect(config.llm.provider).toBe("vllm");
      expect(config.llm.envPrefix).toBe("VLLM");
      expect(config.llm.baseUrl).toBe("http://localhost:8000/v1");
      expect(config.llm.apiKey).toBe("");
    });

    it("resolves ollama provider", () => {
      process.env.LLM_PROVIDER = "ollama";

      const config = loadConfig();

      expect(config.llm.provider).toBe("ollama");
      expect(config.llm.envPrefix).toBe("OLLAMA");
      expect(config.llm.baseUrl).toBe("http://localhost:11434/v1");
    });

    it("resolves lmstudio provider", () => {
      process.env.LLM_PROVIDER = "lmstudio";

      const config = loadConfig();

      expect(config.llm.provider).toBe("lmstudio");
      expect(config.llm.envPrefix).toBe("LMSTUDIO");
      expect(config.llm.baseUrl).toBe("http://localhost:1234/v1");
    });

    it("resolves custom provider", () => {
      process.env.LLM_PROVIDER = "custom";
      process.env.LLM_BASE_URL = "https://my-llm.example.com/v1";
      process.env.LLM_MODEL = "my-model";
      process.env.LLM_API_KEY = "custom-key";

      const config = loadConfig();

      expect(config.llm.provider).toBe("custom");
      expect(config.llm.envPrefix).toBe("LLM");
      expect(config.llm.baseUrl).toBe("https://my-llm.example.com/v1");
      expect(config.llm.model).toBe("my-model");
      expect(config.llm.apiKey).toBe("custom-key");
    });

    it("normalizes provider name to lowercase", () => {
      process.env.LLM_PROVIDER = "OpenAI";
      process.env.OPENAI_API_KEY = "sk-key";

      const config = loadConfig();

      expect(config.llm.provider).toBe("openai");
    });

    it("throws for unknown provider", () => {
      process.env.LLM_PROVIDER = "unknown-provider";

      expect(() => loadConfig()).toThrow(/Unknown LLM provider/);
      expect(() => loadConfig()).toThrow(/unknown-provider/);
    });

    it("allows base URL override for any provider", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.OPENROUTER_BASE_URL = "https://custom.openrouter.ai/v1";

      const config = loadConfig();

      expect(config.llm.baseUrl).toBe("https://custom.openrouter.ai/v1");
    });
  });

  // ============================================================================
  // Model Tiers
  // ============================================================================

  describe("model tiers", () => {
    it("sets tier-specific models from env vars", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.OPENROUTER_SMALL_FAST_MODEL = "openai/gpt-4o-mini";
      process.env.OPENROUTER_MIDTIER_MODEL = "openai/gpt-4o";
      process.env.OPENROUTER_HEAVY_THINKING_MODEL = "openai/o1";

      const config = loadConfig();

      expect(config.llm.tiers.smallFast).toBe("openai/gpt-4o-mini");
      expect(config.llm.tiers.midtier).toBe("openai/gpt-4o");
      expect(config.llm.tiers.heavyThinking).toBe("openai/o1");
    });

    it("falls back to default model when tier env vars not set", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.OPENROUTER_MODEL = "openai/gpt-4o-mini";

      const config = loadConfig();

      expect(config.llm.tiers.smallFast).toBe("openai/gpt-4o-mini");
      expect(config.llm.tiers.midtier).toBe("openai/gpt-4o-mini");
      expect(config.llm.tiers.heavyThinking).toBe("openai/gpt-4o-mini");
    });

    it("falls back to provider default model when no model env vars set", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";

      const config = loadConfig();

      // openrouter default model is "openai/gpt-4o-mini"
      expect(config.llm.tiers.smallFast).toBe("openai/gpt-4o-mini");
      expect(config.llm.tiers.midtier).toBe("openai/gpt-4o-mini");
      expect(config.llm.tiers.heavyThinking).toBe("openai/gpt-4o-mini");
    });

    it("allows mixing tier-specific and fallback models", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.OPENROUTER_MODEL = "openai/gpt-4o-mini";
      process.env.OPENROUTER_HEAVY_THINKING_MODEL = "openai/o1";

      const config = loadConfig();

      expect(config.llm.tiers.smallFast).toBe("openai/gpt-4o-mini");
      expect(config.llm.tiers.midtier).toBe("openai/gpt-4o-mini");
      expect(config.llm.tiers.heavyThinking).toBe("openai/o1");
    });
  });

  // ============================================================================
  // Per-Agent Overrides
  // ============================================================================

  describe("per-agent overrides", () => {
    it("loads agent-specific model overrides", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.OPENROUTER_PLANNER_MODEL = "openai/o1";

      const config = loadConfig();

      expect(config.llm.agentOverrides.planner?.model).toBe("openai/o1");
    });

    it("loads agent-specific API key overrides", () => {
      process.env.OPENROUTER_API_KEY = "sk-default";
      process.env.OPENROUTER_PLANNER_API_KEY = "sk-planner";

      const config = loadConfig();

      expect(config.llm.agentOverrides.planner?.apiKey).toBe("sk-planner");
    });

    it("does not create overrides for roles without env vars", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";

      const config = loadConfig();

      expect(config.llm.agentOverrides.planner).toBeUndefined();
      expect(config.llm.agentOverrides.researcher).toBeUndefined();
    });

    it("supports all agent roles", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.OPENROUTER_ORCHESTRATOR_MODEL = "model-orch";
      process.env.OPENROUTER_PLANNER_MODEL = "model-plan";
      process.env.OPENROUTER_RESEARCHER_MODEL = "model-res";
      process.env.OPENROUTER_MEMORY_MODEL = "model-mem";
      process.env.OPENROUTER_ANSWER_MODEL = "model-ans";
      process.env.OPENROUTER_TOOL_USE_MODEL = "model-tool";

      const config = loadConfig();

      expect(config.llm.agentOverrides.orchestrator?.model).toBe("model-orch");
      expect(config.llm.agentOverrides.planner?.model).toBe("model-plan");
      expect(config.llm.agentOverrides.researcher?.model).toBe("model-res");
      expect(config.llm.agentOverrides.memory?.model).toBe("model-mem");
      expect(config.llm.agentOverrides.answer?.model).toBe("model-ans");
      expect(config.llm.agentOverrides.toolUse?.model).toBe("model-tool");
    });
  });

  // ============================================================================
  // Features Config
  // ============================================================================

  describe("features config", () => {
    describe("knowledge formation", () => {
      it("uses balanced defaults when no env vars set", () => {
        process.env.OPENROUTER_API_KEY = "sk-key";

        const config = loadConfig();

        expect(config.features.knowledgeFormation.enabled).toBe(true);
        expect(config.features.knowledgeFormation.sensitivity).toBe("balanced");
        expect(config.features.knowledgeFormation.minConfidence).toBe(0.7);
        expect(config.features.knowledgeFormation.maxLearningsPerTask).toBe(3);
        expect(config.features.knowledgeFormation.deduplicationThreshold).toBe(
          0.9,
        );
        expect(config.features.knowledgeFormation.excludeAgentTypes).toEqual(
          [],
        );
        expect(config.features.knowledgeFormation.debugLogging).toBe(false);
      });

      it("applies aggressive sensitivity preset", () => {
        process.env.OPENROUTER_API_KEY = "sk-key";
        process.env.KNOWLEDGE_FORMATION_SENSITIVITY = "aggressive";

        const config = loadConfig();

        expect(config.features.knowledgeFormation.sensitivity).toBe(
          "aggressive",
        );
        expect(config.features.knowledgeFormation.minConfidence).toBe(0.5);
        expect(config.features.knowledgeFormation.maxLearningsPerTask).toBe(5);
        expect(config.features.knowledgeFormation.deduplicationThreshold).toBe(
          0.85,
        );
      });

      it("applies conservative sensitivity preset", () => {
        process.env.OPENROUTER_API_KEY = "sk-key";
        process.env.KNOWLEDGE_FORMATION_SENSITIVITY = "conservative";

        const config = loadConfig();

        expect(config.features.knowledgeFormation.sensitivity).toBe(
          "conservative",
        );
        expect(config.features.knowledgeFormation.minConfidence).toBe(0.85);
        expect(config.features.knowledgeFormation.maxLearningsPerTask).toBe(2);
        expect(config.features.knowledgeFormation.deduplicationThreshold).toBe(
          0.95,
        );
      });

      it("allows custom values to override preset defaults", () => {
        process.env.OPENROUTER_API_KEY = "sk-key";
        process.env.KNOWLEDGE_FORMATION_SENSITIVITY = "aggressive";
        process.env.KNOWLEDGE_FORMATION_MIN_CONFIDENCE = "0.6";

        const config = loadConfig();

        expect(config.features.knowledgeFormation.minConfidence).toBe(0.6);
      });

      it("disables knowledge formation when set to false", () => {
        process.env.OPENROUTER_API_KEY = "sk-key";
        process.env.KNOWLEDGE_FORMATION_ENABLED = "false";

        const config = loadConfig();

        expect(config.features.knowledgeFormation.enabled).toBe(false);
      });

      it("parses exclude agent types from comma-separated list", () => {
        process.env.OPENROUTER_API_KEY = "sk-key";
        process.env.KNOWLEDGE_FORMATION_EXCLUDE_AGENTS = "planner,memory";

        const config = loadConfig();

        expect(config.features.knowledgeFormation.excludeAgentTypes).toEqual([
          "planner",
          "memory",
        ]);
      });

      it("enables debug logging when set to true", () => {
        process.env.OPENROUTER_API_KEY = "sk-key";
        process.env.KNOWLEDGE_FORMATION_DEBUG = "true";

        const config = loadConfig();

        expect(config.features.knowledgeFormation.debugLogging).toBe(true);
      });
    });

    describe("outcome tracking", () => {
      it("uses defaults when no env vars set", () => {
        process.env.OPENROUTER_API_KEY = "sk-key";

        const config = loadConfig();

        expect(config.features.outcomeTracking.enabled).toBe(true);
        expect(config.features.outcomeTracking.criticEnabled).toBe(true);
        expect(
          config.features.outcomeTracking.rerankingWeights.similarity,
        ).toBe(0.5);
        expect(
          config.features.outcomeTracking.rerankingWeights.successRate,
        ).toBe(0.3);
        expect(config.features.outcomeTracking.rerankingWeights.recency).toBe(
          0.2,
        );
        expect(config.features.outcomeTracking.maxApplicationHistory).toBe(10);
        expect(config.features.outcomeTracking.minApplicationsForRanking).toBe(
          3,
        );
      });

      it("allows custom re-ranking weights", () => {
        process.env.OPENROUTER_API_KEY = "sk-key";
        process.env.OUTCOME_TRACKING_SIMILARITY_WEIGHT = "0.4";
        process.env.OUTCOME_TRACKING_SUCCESS_WEIGHT = "0.4";
        process.env.OUTCOME_TRACKING_RECENCY_WEIGHT = "0.2";

        const config = loadConfig();

        expect(
          config.features.outcomeTracking.rerankingWeights.similarity,
        ).toBe(0.4);
        expect(
          config.features.outcomeTracking.rerankingWeights.successRate,
        ).toBe(0.4);
      });
    });
  });

  // ============================================================================
  // Middleware Config
  // ============================================================================

  describe("middleware config", () => {
    it("uses default summarization settings", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";

      const config = loadConfig();

      expect(config.middleware.summarization.triggerTokens).toBe(170000);
      expect(config.middleware.summarization.keepMessages).toBe(20);
    });

    it("allows custom summarization trigger tokens", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.SUMMARIZATION_TRIGGER_TOKENS = "100000";

      const config = loadConfig();

      expect(config.middleware.summarization.triggerTokens).toBe(100000);
    });

    it("allows custom keep messages count", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.SUMMARIZATION_KEEP_MESSAGES = "10";

      const config = loadConfig();

      expect(config.middleware.summarization.keepMessages).toBe(10);
    });

    it("reads cost tracking cache TTL", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.COST_TRACKING_CACHE_TTL_MS = "60000";

      const config = loadConfig();

      expect(config.middleware.costTracking.cacheTtlMs).toBe(60000);
    });

    it("defaults cost tracking cache TTL to undefined", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";

      const config = loadConfig();

      expect(config.middleware.costTracking.cacheTtlMs).toBeUndefined();
    });
  });

  // ============================================================================
  // Services Config
  // ============================================================================

  describe("services config", () => {
    it("reads Tavily API key", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.TAVILY_API_KEY = "tvly-test-key";

      const config = loadConfig();

      expect(config.services.tavily.apiKey).toBe("tvly-test-key");
    });

    it("defaults Tavily API key to empty string", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";

      const config = loadConfig();

      expect(config.services.tavily.apiKey).toBe("");
    });

    it("builds graph memory URL from host and port defaults", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";

      const config = loadConfig();

      expect(config.services.graphMemory.host).toBe("localhost");
      expect(config.services.graphMemory.port).toBe("8080");
      expect(config.services.graphMemory.baseUrl).toBe("http://localhost:8080");
    });

    it("uses GRAPH_MEMORY_API when set (overrides host/port)", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.GRAPH_MEMORY_API = "https://memory.example.com";

      const config = loadConfig();

      expect(config.services.graphMemory.apiUrl).toBe(
        "https://memory.example.com",
      );
      expect(config.services.graphMemory.baseUrl).toBe(
        "https://memory.example.com",
      );
    });

    it("allows custom host and port", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.GRAPH_MEMORY_HOST = "memory-server";
      process.env.GRAPH_MEMORY_PORT = "9090";

      const config = loadConfig();

      expect(config.services.graphMemory.host).toBe("memory-server");
      expect(config.services.graphMemory.port).toBe("9090");
      expect(config.services.graphMemory.baseUrl).toBe(
        "http://memory-server:9090",
      );
    });
  });

  // ============================================================================
  // Runtime Config
  // ============================================================================

  describe("runtime config", () => {
    it("defaults log level to info", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";

      const config = loadConfig();

      expect(config.runtime.logLevel).toBe("info");
    });

    it("reads LOG_LEVEL env var", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.LOG_LEVEL = "debug";

      const config = loadConfig();

      expect(config.runtime.logLevel).toBe("debug");
    });

    it("defaults NODE_ENV to development", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      delete process.env.NODE_ENV;

      const config = loadConfig();

      expect(config.runtime.nodeEnv).toBe("development");
    });

    it("reads NODE_ENV when set", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.NODE_ENV = "production";

      const config = loadConfig();

      expect(config.runtime.nodeEnv).toBe("production");
    });

    it("reads SIA_PROJECT_ROOT when set", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";
      process.env.SIA_PROJECT_ROOT = "/tmp/experiment";

      const config = loadConfig();

      expect(config.runtime.siaProjectRoot).toBe("/tmp/experiment");
    });

    it("defaults SIA_PROJECT_ROOT to undefined", () => {
      process.env.OPENROUTER_API_KEY = "sk-key";

      const config = loadConfig();

      expect(config.runtime.siaProjectRoot).toBeUndefined();
    });
  });
});

// ============================================================================
// getConfig() / resetConfig() - Singleton Behavior
// ============================================================================

describe("getConfig singleton", () => {
  it("returns the same instance on subsequent calls", () => {
    process.env.OPENROUTER_API_KEY = "sk-key";

    const config1 = getConfig();
    const config2 = getConfig();

    expect(config1).toBe(config2);
  });

  it("returns a fresh instance after resetConfig()", () => {
    process.env.OPENROUTER_API_KEY = "sk-key";

    const config1 = getConfig();
    resetConfig();
    const config2 = getConfig();

    expect(config1).not.toBe(config2);
    // But values should be equal since env hasn't changed
    expect(config1).toEqual(config2);
  });

  it("picks up env changes after resetConfig()", () => {
    process.env.OPENROUTER_API_KEY = "sk-key";
    process.env.LOG_LEVEL = "debug";

    const config1 = getConfig();
    expect(config1.runtime.logLevel).toBe("debug");

    resetConfig();
    process.env.LOG_LEVEL = "warn";

    const config2 = getConfig();
    expect(config2.runtime.logLevel).toBe("warn");
  });
});

// ============================================================================
// resolveModelEndpoint()
// ============================================================================

describe("resolveModelEndpoint", () => {
  it("returns provider defaults when no agent role specified", () => {
    process.env.OPENROUTER_API_KEY = "sk-key";

    const config = loadConfig();
    const endpoint = resolveModelEndpoint(config.llm);

    expect(endpoint.model).toBe("openai/gpt-4o-mini");
    expect(endpoint.apiKey).toBe("sk-key");
    expect(endpoint.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("resolves tier-based model for agent role", () => {
    process.env.OPENROUTER_API_KEY = "sk-key";
    process.env.OPENROUTER_SMALL_FAST_MODEL = "openai/gpt-4o-mini";
    process.env.OPENROUTER_MIDTIER_MODEL = "openai/gpt-4o";
    process.env.OPENROUTER_HEAVY_THINKING_MODEL = "openai/o1";

    const config = loadConfig();

    // planner maps to heavyThinking tier
    const plannerEndpoint = resolveModelEndpoint(config.llm, "planner");
    expect(plannerEndpoint.model).toBe("openai/o1");

    // orchestrator maps to midtier
    const orchEndpoint = resolveModelEndpoint(config.llm, "orchestrator");
    expect(orchEndpoint.model).toBe("openai/gpt-4o");

    // researcher maps to midtier
    const researchEndpoint = resolveModelEndpoint(config.llm, "researcher");
    expect(researchEndpoint.model).toBe("openai/gpt-4o");
  });

  it("per-agent override takes precedence over tier", () => {
    process.env.OPENROUTER_API_KEY = "sk-key";
    process.env.OPENROUTER_HEAVY_THINKING_MODEL = "openai/o1";
    process.env.OPENROUTER_PLANNER_MODEL = "openai/o1-pro";

    const config = loadConfig();
    const endpoint = resolveModelEndpoint(config.llm, "planner");

    expect(endpoint.model).toBe("openai/o1-pro");
  });

  it("per-agent API key override takes precedence", () => {
    process.env.OPENROUTER_API_KEY = "sk-default";
    process.env.OPENROUTER_PLANNER_API_KEY = "sk-planner-key";

    const config = loadConfig();
    const endpoint = resolveModelEndpoint(config.llm, "planner");

    expect(endpoint.apiKey).toBe("sk-planner-key");
  });

  it("falls back to provider default when no tier mapping exists for role", () => {
    process.env.OPENROUTER_API_KEY = "sk-key";
    process.env.OPENROUTER_MODEL = "openai/gpt-4o-mini";

    const config = loadConfig();
    // "unknown-role" has no entry in AGENT_TIER_DEFAULTS
    const endpoint = resolveModelEndpoint(config.llm, "unknown-role");

    expect(endpoint.model).toBe("openai/gpt-4o-mini");
  });

  it("uses baseUrl from provider config (not per-agent)", () => {
    process.env.OPENROUTER_API_KEY = "sk-key";
    process.env.OPENROUTER_BASE_URL = "https://custom.example.com/v1";

    const config = loadConfig();
    const endpoint = resolveModelEndpoint(config.llm, "planner");

    expect(endpoint.baseUrl).toBe("https://custom.example.com/v1");
  });
});

// ============================================================================
// AGENT_TIER_DEFAULTS
// ============================================================================

describe("AGENT_TIER_DEFAULTS", () => {
  it("maps all expected agent roles to tiers", () => {
    expect(AGENT_TIER_DEFAULTS).toEqual({
      orchestrator: "midtier",
      planner: "heavyThinking",
      researcher: "midtier",
      memory: "smallFast",
      answer: "midtier",
      toolUse: "midtier",
    });
  });
});
