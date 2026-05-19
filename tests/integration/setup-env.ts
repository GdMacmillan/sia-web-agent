/**
 * Setup file to load environment variables for integration tests
 *
 * Priority order:
 * 1. packages/agent/.env (agent-specific config)
 * 2. root .env (shared fallback)
 */
import dotenv from "dotenv";
import * as path from "path";

// Load agent-specific config first
const agentEnvPath = path.resolve(process.cwd(), ".env");
dotenv.config({ path: agentEnvPath });

// Then load root config as fallback (existing vars not overridden)
const rootEnvPath = path.resolve(process.cwd(), "../../../.env");
dotenv.config({ path: rootEnvPath });

// Log loaded variables (without exposing secrets)
console.log("[Integration Tests] Environment loaded:");
console.log("- OPENROUTER_MODEL:", process.env.OPENROUTER_MODEL);
console.log(
  "- OPENROUTER_API_KEY:",
  process.env.OPENROUTER_API_KEY ? "✓ Set" : "✗ Missing",
);
console.log("- RUN_INTEGRATION:", process.env.RUN_INTEGRATION);
