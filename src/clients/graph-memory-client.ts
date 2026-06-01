/**
 * Graph Memory API Client
 *
 * Centralized client for communicating with the Graph Memory service.
 * Encapsulates URL configuration, HTTP calls, and error handling.
 *
 * Follows Single Responsibility Principle: handles only API communication.
 * Dependency Inversion: consumers depend on this abstraction, not axios directly.
 *
 * DEPRECATED (AGI-227): this legacy direct-HTTP path is no longer wired
 * into any runtime caller. `knowledge-formation.ts` migrated to the
 * workspace-bound graph-memory adapter. The module is kept (valid +
 * still unit-tested) but MUST NOT be expanded — it has no workspace
 * scoping. Reach graph memory via `getMemoryAdapter()` instead.
 */

import axios from "axios";
import { getConfig } from "../config/index.js";

/**
 * Configuration for GraphMemoryClient
 */
export interface GraphMemoryClientConfig {
  /** Base URL for the Graph Memory API */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
}

/**
 * Resolves the Graph Memory API base URL from configuration or environment.
 *
 * Priority:
 * 1. Explicit baseUrl in config
 * 2. GRAPH_MEMORY_API environment variable (full URL)
 * 3. GRAPH_MEMORY_HOST + GRAPH_MEMORY_PORT (constructed URL)
 * 4. Default: http://localhost:8080
 */
function resolveBaseUrl(config?: GraphMemoryClientConfig): string {
  if (config?.baseUrl) {
    return config.baseUrl;
  }

  return getConfig().services.graphMemory.baseUrl;
}

/**
 * Client for the Graph Memory API.
 *
 * Provides a clean interface for HTTP communication with error handling.
 */
export class GraphMemoryClient {
  readonly baseUrl: string;
  private readonly timeout: number;

  constructor(config?: GraphMemoryClientConfig) {
    this.baseUrl = resolveBaseUrl(config);
    this.timeout = config?.timeout ?? 10000;
  }

  /**
   * Make an HTTP request to the Graph Memory API.
   *
   * @param method - HTTP method (GET, POST, PUT, DELETE)
   * @param endpoint - API endpoint path (e.g., "/entities")
   * @param data - Optional request body
   * @returns Response data
   * @throws Error with descriptive message on failure
   */
  async request<T = unknown>(
    method: string,
    endpoint: string,
    data?: unknown,
  ): Promise<T> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      const response = await axios({
        method,
        url,
        data,
        headers: { "Content-Type": "application/json" },
        timeout: this.timeout,
      });
      return response.data as T;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Graph Memory API error: ${errorMsg}`, { cause: error });
    }
  }

  /**
   * GET request convenience method.
   */
  async get<T = unknown>(endpoint: string): Promise<T> {
    return this.request<T>("GET", endpoint);
  }

  /**
   * POST request convenience method.
   */
  async post<T = unknown>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>("POST", endpoint, data);
  }

  /**
   * Execute a graph query.
   *
   * @param query - Query string in Graph Memory query language
   * @returns Query response
   */
  async query<T = unknown>(query: string): Promise<T> {
    return this.post<T>("/graph/query", { query });
  }

  /**
   * Check if the Graph Memory API is available.
   *
   * @returns true if the health endpoint responds, false otherwise
   */
  async isAvailable(): Promise<boolean> {
    try {
      await axios({
        method: "GET",
        url: `${this.baseUrl}/health`,
        timeout: 2000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Factory function to create a GraphMemoryClient.
 *
 * Preferred over direct instantiation for testability and future extension.
 */
export function createGraphMemoryClient(
  config?: GraphMemoryClientConfig,
): GraphMemoryClient {
  return new GraphMemoryClient(config);
}

/**
 * Default shared client instance.
 *
 * Use this for most cases to avoid creating multiple clients.
 * Lazily initialized on first access.
 */
let defaultClient: GraphMemoryClient | null = null;

export function getDefaultClient(): GraphMemoryClient {
  if (!defaultClient) {
    defaultClient = createGraphMemoryClient();
  }
  return defaultClient;
}

/**
 * Reset the default client (useful for testing).
 */
export function resetDefaultClient(): void {
  defaultClient = null;
}
