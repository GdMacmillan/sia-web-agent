/**
 * HyDE (Hypothetical Document Embedding) Integration Tests
 *
 * Tests the HyDE functionality integrated with memory search tools:
 * - Auto-detection of when to apply HyDE based on query heuristics
 * - Explicit opt-in/opt-out via use_hyde parameter
 * - Caching of generated hypothetical documents
 * - Integration with searchEntitiesTool
 *
 * Note: These tests use mocked LLM calls to avoid making real API requests.
 * For true end-to-end integration testing with real LLM calls, use manual testing.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  jest,
} from "@jest/globals";
import axios from "axios";
import { searchEntitiesTool } from "../../src/tools/memory-tools.js";
import {
  clearHyDECache,
  getHyDECacheStats,
  resetHyDE,
} from "../../src/utils/hyde.js";

// Mock axios for memory API calls
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Shared mock invoke function that can be configured per-test
const mockInvoke = jest.fn();

// Mock the model creation with shared mockInvoke
jest.mock("../../src/config/model-config.js", () => ({
  createMemoryModel: jest.fn(async () => ({
    invoke: mockInvoke,
  })),
}));

// Skip if integration tests are not enabled
const shouldRunIntegration = process.env.RUN_INTEGRATION === "true";
const describeIntegration = shouldRunIntegration ? describe : describe.skip;

describeIntegration("HyDE Integration", () => {
  beforeAll(() => {
    // Reset HyDE state before tests
    resetHyDE();
    clearHyDECache();

    // Set up default mock: successful LLM response
    mockInvoke.mockImplementation(async (prompt: string) => ({
      content: `Hypothetical document for: ${prompt.substring(0, 50)}...`,
    }));
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock axios for memory API search calls
    mockedAxios.mockResolvedValue({
      data: {
        success: true,
        data: {
          nodes: [],
        },
      },
    } as any);
  });

  describe("Auto-detection", () => {
    it("should apply HyDE for question queries", async () => {
      const query =
        "how to implement authentication patterns in web applications";
      const result = await searchEntitiesTool.func({
        query,
        limit: 5,
      });

      const response = JSON.parse(result);

      expect(response.hyde).toBeDefined();
      expect(response.hyde.applied).toBe(true);
      expect(response.hyde.reason).toContain("Auto-detected");
      expect(response.query).toBe(query);
    });

    it("should skip HyDE for technical queries", async () => {
      const query = "error TypeError in module";
      const result = await searchEntitiesTool.func({
        query,
        limit: 5,
      });

      const response = JSON.parse(result);

      expect(response.hyde).toBeDefined();
      expect(response.hyde.applied).toBe(false);
      expect(response.hyde.reason).toContain("Auto-skipped");
    });

    it("should skip HyDE for short queries", async () => {
      const query = "auth error";
      const result = await searchEntitiesTool.func({
        query,
        limit: 5,
      });

      const response = JSON.parse(result);

      expect(response.hyde).toBeDefined();
      expect(response.hyde.applied).toBe(false);
      expect(response.hyde.reason).toContain("too short");
    });

    it("should apply HyDE for abstract concept queries", async () => {
      const query = "best practice for caching in web applications";
      const result = await searchEntitiesTool.func({
        query,
        limit: 5,
      });

      const response = JSON.parse(result);

      expect(response.hyde).toBeDefined();
      expect(response.hyde.applied).toBe(true);
      expect(response.hyde.reason).toContain("Auto-detected");
    });
  });

  describe("Explicit Control", () => {
    it("should apply HyDE when explicitly enabled via use_hyde=true", async () => {
      const query = "short"; // Would normally be skipped
      const result = await searchEntitiesTool.func({
        query,
        use_hyde: true,
        limit: 5,
      });

      const response = JSON.parse(result);

      expect(response.hyde).toBeDefined();
      expect(response.hyde.applied).toBe(true);
      expect(response.hyde.reason).toContain("Explicitly enabled");
    });

    it("should skip HyDE when explicitly disabled via use_hyde=false", async () => {
      const query = "how to implement authentication"; // Would normally trigger
      const result = await searchEntitiesTool.func({
        query,
        use_hyde: false,
        limit: 5,
      });

      const response = JSON.parse(result);

      expect(response.hyde).toBeDefined();
      expect(response.hyde.applied).toBe(false);
      expect(response.hyde.reason).toContain("Explicitly disabled");
    });
  });

  describe("Caching", () => {
    it("should cache hypothetical documents and reuse them", async () => {
      clearHyDECache();

      const query = "what is the best approach for testing React components";

      // First call - not cached
      const result1 = await searchEntitiesTool.func({
        query,
        use_hyde: true,
        limit: 5,
      });

      const response1 = JSON.parse(result1);
      expect(response1.hyde.applied).toBe(true);
      expect(response1.hyde.cached).toBe(false);

      // Second call - should be cached
      const result2 = await searchEntitiesTool.func({
        query,
        use_hyde: true,
        limit: 5,
      });

      const response2 = JSON.parse(result2);
      expect(response2.hyde.applied).toBe(true);
      expect(response2.hyde.cached).toBe(true);

      // Verify cache stats
      const stats = getHyDECacheStats();
      expect(stats).toBeDefined();
      expect(stats!.hits).toBeGreaterThanOrEqual(1);
      expect(stats!.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Response Format", () => {
    it("should include hyde metadata in response", async () => {
      const query = "why use dependency injection";
      const result = await searchEntitiesTool.func({
        query,
        limit: 5,
      });

      const response = JSON.parse(result);

      expect(response).toHaveProperty("query");
      expect(response).toHaveProperty("hyde");
      expect(response.hyde).toHaveProperty("applied");
      expect(response.hyde).toHaveProperty("reason");
      expect(response).toHaveProperty("count");
      expect(response).toHaveProperty("entities");
      expect(response).toHaveProperty("message");
    });
  });
});
