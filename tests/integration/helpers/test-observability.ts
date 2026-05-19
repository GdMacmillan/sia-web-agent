/**
 * Test Observability Utilities
 *
 * Provides logging and tracing for integration tests to make agent
 * actions visible during test execution.
 */

import { EventEmitter } from "events";
import type { BaseMessage } from "@langchain/core/messages";

/**
 * Check if verbose test mode is enabled
 */
export function isVerboseMode(): boolean {
  return process.env.VERBOSE_TESTS === "true";
}

/**
 * Enable LangSmith tracing for integration tests
 */
export function enableTestTracing(testName: string): void {
  if (process.env.LANGSMITH_TRACING !== "false") {
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_PROJECT =
      process.env.LANGSMITH_PROJECT || `integration-tests-${testName}`;
  }
}

/**
 * Disable LangSmith tracing
 */
export function disableTestTracing(): void {
  delete process.env.LANGSMITH_TRACING;
  delete process.env.LANGSMITH_PROJECT;
}

/**
 * Agent action logger for verbose test output
 */
export class AgentActionLogger {
  private agentName: string;
  private verbose: boolean;

  constructor(agentName: string, verbose: boolean = isVerboseMode()) {
    this.agentName = agentName;
    this.verbose = verbose;
  }

  /**
   * Log a decision made by the agent
   */
  logDecision(decision: any): void {
    if (!this.verbose) return;

    console.log(`\n[${this.agentName}] 🤔 Decision Made:`);
    console.log(`  ↳ Action: ${decision.action || decision}`);
    if (decision.nextNode) {
      console.log(`  ↳ Next Node: ${decision.nextNode}`);
    }
    if (decision.reasoning) {
      console.log(`  ↳ Reasoning: ${decision.reasoning}`);
    }
  }

  /**
   * Log a tool call
   */
  logToolCall(toolName: string, args: any): void {
    if (!this.verbose) return;

    console.log(`\n[Tool] 🔧 ${toolName}`);
    console.log(
      `  ↳ Args:`,
      JSON.stringify(args, null, 2).split("\n").join("\n    "),
    );
  }

  /**
   * Log a tool result
   */
  logToolResult(toolName: string, result: any, duration?: number): void {
    if (!this.verbose) return;

    const resultStr =
      typeof result === "string"
        ? result.slice(0, 200) + (result.length > 200 ? "..." : "")
        : JSON.stringify(result).slice(0, 200);

    console.log(
      `[Tool] ✓ ${toolName} completed` +
        (duration ? ` (${duration.toFixed(2)}s)` : ""),
    );
    console.log(`  ↳ Result: ${resultStr}`);
  }

  /**
   * Log an LLM call
   */
  logLLMCall(
    prompt: string | BaseMessage[],
    model?: string,
    temperature?: number,
  ): void {
    if (!this.verbose) return;

    const promptStr = Array.isArray(prompt)
      ? `${prompt.length} messages`
      : prompt.slice(0, 100) + (prompt.length > 100 ? "..." : "");

    console.log(`\n[${this.agentName}] 💭 LLM Call:`);
    console.log(`  ↳ Prompt: ${promptStr}`);
    if (model) console.log(`  ↳ Model: ${model}`);
    if (temperature !== undefined)
      console.log(`  ↳ Temperature: ${temperature}`);
  }

  /**
   * Log an LLM response
   */
  logLLMResponse(
    response: string,
    tokens?: { input: number; output: number; total: number },
  ): void {
    if (!this.verbose) return;

    const responseStr =
      response.slice(0, 200) + (response.length > 200 ? "..." : "");

    console.log(`[${this.agentName}] ✓ LLM Response:`);
    console.log(`  ↳ Output: ${responseStr}`);
    if (tokens) {
      console.log(
        `  ↳ Tokens: ${tokens.input} input, ${tokens.output} output (${tokens.total} total)`,
      );
    }
  }

  /**
   * Log an error
   */
  logError(error: Error | string, context?: string): void {
    if (!this.verbose) return;

    const errorMsg = error instanceof Error ? error.message : error;
    console.error(
      `\n[${this.agentName}] ❌ Error` + (context ? ` (${context})` : "") + ":",
    );
    console.error(`  ↳ ${errorMsg}`);
  }

  /**
   * Log a general message
   */
  log(message: string, details?: any): void {
    if (!this.verbose) return;

    console.log(`\n[${this.agentName}] ${message}`);
    if (details) {
      console.log(`  ↳`, details);
    }
  }
}

/**
 * Test event emitter for programmatic observation of agent actions
 */
export class TestEventEmitter extends EventEmitter {
  /**
   * Emit an agent decision event
   */
  emitDecision(agent: string, decision: any): void {
    this.emit("agent:decision", { agent, decision, timestamp: Date.now() });
  }

  /**
   * Emit a tool call event
   */
  emitToolCall(toolName: string, args: any): void {
    this.emit("tool:call", { toolName, args, timestamp: Date.now() });
  }

  /**
   * Emit a tool result event
   */
  emitToolResult(toolName: string, result: any, duration?: number): void {
    this.emit("tool:result", {
      toolName,
      result,
      duration,
      timestamp: Date.now(),
    });
  }

  /**
   * Emit an LLM call event
   */
  emitLLMCall(agent: string, prompt: any, model?: string): void {
    this.emit("llm:call", { agent, prompt, model, timestamp: Date.now() });
  }

  /**
   * Emit an LLM response event
   */
  emitLLMResponse(agent: string, response: string, tokens?: any): void {
    this.emit("llm:response", {
      agent,
      response,
      tokens,
      timestamp: Date.now(),
    });
  }

  /**
   * Emit an error event
   */
  emitError(agent: string, error: Error | string, context?: string): void {
    this.emit("error", { agent, error, context, timestamp: Date.now() });
  }
}

/**
 * Global event emitter for integration tests
 */
export const testEvents = new TestEventEmitter();

/**
 * Create a logger for an agent
 */
export function createAgentLogger(agentName: string): AgentActionLogger {
  return new AgentActionLogger(agentName);
}

/**
 * Log a test section header
 */
export function logTestSection(title: string): void {
  if (!isVerboseMode()) return;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}\n`);
}

/**
 * Log test start
 */
export function logTestStart(testName: string): void {
  if (!isVerboseMode()) return;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`▶ Starting test: ${testName}`);
  console.log(`${"─".repeat(60)}`);
}

/**
 * Log test end
 */
export function logTestEnd(
  testName: string,
  passed: boolean,
  duration?: number,
): void {
  if (!isVerboseMode()) return;

  const status = passed ? "✅ PASSED" : "❌ FAILED";
  const timeStr = duration ? ` (${(duration / 1000).toFixed(2)}s)` : "";

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${status}: ${testName}${timeStr}`);
  console.log(`${"─".repeat(60)}\n`);
}
