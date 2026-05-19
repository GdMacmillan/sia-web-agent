/**
 * Tests for GraphMemoryClient
 *
 * Following TDD: These tests define the expected behavior before implementation.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import axios from "axios";
import { createGraphMemoryClient } from "../../../src/clients/graph-memory-client.js";
import { resetConfig } from "../../../src/config/index.js";

jest.mock("axios");
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe("GraphMemoryClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear environment variables and reset cached config singleton
    // so env var changes take effect (getConfig() caches on first call)
    delete process.env.GRAPH_MEMORY_API;
    delete process.env.GRAPH_MEMORY_HOST;
    delete process.env.GRAPH_MEMORY_PORT;
    resetConfig();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("URL configuration", () => {
    it("uses GRAPH_MEMORY_API when provided", () => {
      process.env.GRAPH_MEMORY_API = "https://custom-api.example.com";

      const client = createGraphMemoryClient();

      expect(client.baseUrl).toBe("https://custom-api.example.com");
    });

    it("constructs URL from GRAPH_MEMORY_HOST and GRAPH_MEMORY_PORT", () => {
      process.env.GRAPH_MEMORY_HOST = "memory.local";
      process.env.GRAPH_MEMORY_PORT = "9090";

      const client = createGraphMemoryClient();

      expect(client.baseUrl).toBe("http://memory.local:9090");
    });

    it("defaults to localhost:8080 when no env vars set", () => {
      const client = createGraphMemoryClient();

      expect(client.baseUrl).toBe("http://localhost:8080");
    });

    it("accepts explicit config over environment variables", () => {
      process.env.GRAPH_MEMORY_API = "https://env-api.example.com";

      const client = createGraphMemoryClient({
        baseUrl: "https://explicit-api.example.com",
      });

      expect(client.baseUrl).toBe("https://explicit-api.example.com");
    });
  });

  describe("request method", () => {
    it("makes GET request with correct URL", async () => {
      mockedAxios.mockResolvedValueOnce({ data: { success: true } });

      const client = createGraphMemoryClient({
        baseUrl: "http://test-api:8080",
      });

      const result = await client.request("GET", "/entities");

      expect(mockedAxios).toHaveBeenCalledWith({
        method: "GET",
        url: "http://test-api:8080/entities",
        data: undefined,
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      });
      expect(result).toEqual({ success: true });
    });

    it("makes POST request with data", async () => {
      mockedAxios.mockResolvedValueOnce({ data: { id: "123" } });

      const client = createGraphMemoryClient({
        baseUrl: "http://test-api:8080",
      });

      const result = await client.request("POST", "/entities", {
        title: "Test",
      });

      expect(mockedAxios).toHaveBeenCalledWith({
        method: "POST",
        url: "http://test-api:8080/entities",
        data: { title: "Test" },
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      });
      expect(result).toEqual({ id: "123" });
    });

    it("uses custom timeout when configured", async () => {
      mockedAxios.mockResolvedValueOnce({ data: {} });

      const client = createGraphMemoryClient({
        baseUrl: "http://test-api:8080",
        timeout: 5000,
      });

      await client.request("GET", "/health");

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it("wraps axios errors with descriptive message", async () => {
      mockedAxios.mockRejectedValueOnce(new Error("Connection refused"));

      const client = createGraphMemoryClient({
        baseUrl: "http://test-api:8080",
      });

      await expect(client.request("GET", "/entities")).rejects.toThrow(
        "Graph Memory API error: Connection refused",
      );
    });

    it("handles non-Error exceptions", async () => {
      mockedAxios.mockRejectedValueOnce("Network failure");

      const client = createGraphMemoryClient({
        baseUrl: "http://test-api:8080",
      });

      await expect(client.request("GET", "/entities")).rejects.toThrow(
        "Graph Memory API error: Network failure",
      );
    });
  });

  describe("convenience methods", () => {
    it("get() delegates to request with GET method", async () => {
      mockedAxios.mockResolvedValueOnce({ data: { entities: [] } });

      const client = createGraphMemoryClient({
        baseUrl: "http://test-api:8080",
      });

      const result = await client.get("/entities");

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          url: "http://test-api:8080/entities",
        }),
      );
      expect(result).toEqual({ entities: [] });
    });

    it("post() delegates to request with POST method", async () => {
      mockedAxios.mockResolvedValueOnce({ data: { created: true } });

      const client = createGraphMemoryClient({
        baseUrl: "http://test-api:8080",
      });

      const result = await client.post("/entities", { title: "New Entity" });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          url: "http://test-api:8080/entities",
          data: { title: "New Entity" },
        }),
      );
      expect(result).toEqual({ created: true });
    });

    it("query() posts to /graph/query endpoint", async () => {
      mockedAxios.mockResolvedValueOnce({
        data: { success: true, data: { nodes: [] } },
      });

      const client = createGraphMemoryClient({
        baseUrl: "http://test-api:8080",
      });

      const result = await client.query("MATCH (n) RETURN n LIMIT 10");

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          url: "http://test-api:8080/graph/query",
          data: { query: "MATCH (n) RETURN n LIMIT 10" },
        }),
      );
      expect(result).toEqual({ success: true, data: { nodes: [] } });
    });
  });

  describe("isAvailable", () => {
    it("returns true when health endpoint responds", async () => {
      mockedAxios.mockResolvedValueOnce({ data: { status: "ok" } });

      const client = createGraphMemoryClient({
        baseUrl: "http://test-api:8080",
      });

      const available = await client.isAvailable();

      expect(available).toBe(true);
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          url: "http://test-api:8080/health",
          timeout: 2000,
        }),
      );
    });

    it("returns false when health endpoint fails", async () => {
      mockedAxios.mockRejectedValueOnce(new Error("Connection refused"));

      const client = createGraphMemoryClient({
        baseUrl: "http://test-api:8080",
      });

      const available = await client.isAvailable();

      expect(available).toBe(false);
    });
  });
});
