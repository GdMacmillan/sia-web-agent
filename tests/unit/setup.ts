/**
 * Test setup for agent integration tests
 */

// Set test environment variables
process.env.NODE_ENV = "test";

// Suppress console output during tests unless debugging
if (!process.env.DEBUG_TESTS) {
  console.log = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();
}

// Global test timeout
jest.setTimeout(30000);

export {};
