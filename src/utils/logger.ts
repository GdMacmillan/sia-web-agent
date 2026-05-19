/**
 * Centralized Pino-based logging utility for the self-improving agent system.
 * Provides high-performance structured logging with minimal overhead.
 */

import pino from "pino";
import { getConfig } from "../config/index.js";

/**
 * Create and configure Pino logger instance.
 *
 * Configuration:
 * - LOG_LEVEL: debug, info, warn, error, silent (default: info)
 * - NODE_ENV: development uses pretty printing, production uses JSON
 */
const runtimeConfig = getConfig().runtime;

const logger = pino({
  level: runtimeConfig.logLevel,

  // Use pino-pretty for development, raw JSON for production
  transport:
    runtimeConfig.nodeEnv !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
            singleLine: false,
          },
        }
      : undefined,

  // Base configuration
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },

  // Production timestamp format
  timestamp: () => `,"time":"${new Date().toISOString()}"`,

  // Enable for integration tests, disable for unit tests
  enabled:
    process.env.RUN_INTEGRATION === "true" || process.env.NODE_ENV !== "test",
});

/**
 * Create a child logger for a specific agent.
 *
 * @param agent - Agent name (Manager, Planner, Programmer, etc.)
 * @returns Child logger with agent context
 */
export function createAgentLogger(agent: string) {
  return logger.child({ agent });
}

/**
 * Main logger export for non-agent logging
 */
export { logger };

/**
 * Log level utilities
 */
export const setLogLevel = (level: string) => {
  logger.level = level;
};

export const getLogLevel = () => {
  return logger.level;
};
