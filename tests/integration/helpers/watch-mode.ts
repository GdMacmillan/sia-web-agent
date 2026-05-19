/**
 * Watch Mode for Integration Tests
 *
 * Enables real-time streaming of agent actions and decisions
 * for development and debugging purposes.
 */

import type { BaseMessage } from "@langchain/core/messages";

/**
 * ANSI color codes for terminal output
 */
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",

  // Foreground colors
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Background colors
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
};

/**
 * Check if watch mode is enabled
 */
export function isWatchModeEnabled(): boolean {
  return process.env.WATCH_AGENTS === "true";
}

/**
 * Pretty formatter for watch mode output
 */
export class PrettyFormatter {
  /**
   * Format agent name with color
   */
  static formatAgent(agent: string): string {
    const agentColors: Record<string, string> = {
      manager: colors.blue,
      planner: colors.magenta,
      programmer: colors.cyan,
      default: colors.green,
    };

    const color = agentColors[agent.toLowerCase()] || agentColors.default;
    return `${color}${colors.bright}[${agent}]${colors.reset}`;
  }

  /**
   * Format tool name with icon
   */
  static formatTool(toolName: string): string {
    const toolIcons: Record<string, string> = {
      execute_bash: "🔧",
      grep_code: "🔍",
      file_read: "📖",
      file_create: "📝",
      file_edit: "✏️",
      file_delete: "🗑️",
      default: "🛠️",
    };

    const icon = toolIcons[toolName] || toolIcons.default;
    return `${colors.yellow}${icon} ${toolName}${colors.reset}`;
  }

  /**
   * Format cost with color based on magnitude
   */
  static formatCost(cost: number, tokens?: number): string {
    const costStr = cost === 0 ? "FREE" : `$${cost.toFixed(4)}`;
    const color =
      cost === 0 ? colors.green : cost < 0.01 ? colors.yellow : colors.red;

    let output = `${color}${costStr}${colors.reset}`;
    if (tokens) {
      output += ` ${colors.gray}(${tokens.toLocaleString()} tokens)${colors.reset}`;
    }

    return output;
  }

  /**
   * Format decision with color
   */
  static formatDecision(decision: any): string {
    const action = decision.action || decision;
    const actionColors: Record<string, string> = {
      proceed: colors.green,
      clarify: colors.yellow,
      error: colors.red,
    };

    const color =
      actionColors[action as keyof typeof actionColors] || colors.cyan;
    return `${color}${action}${colors.reset}`;
  }

  /**
   * Format duration
   */
  static formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${colors.gray}${ms.toFixed(0)}ms${colors.reset}`;
    }
    return `${colors.gray}${(ms / 1000).toFixed(2)}s${colors.reset}`;
  }

  /**
   * Format success/failure
   */
  static formatStatus(success: boolean): string {
    return success
      ? `${colors.green}✓ Success${colors.reset}`
      : `${colors.red}✗ Failed${colors.reset}`;
  }
}

/**
 * Progress spinner for long operations
 */
export class ProgressIndicator {
  private spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private spinnerIndex = 0;
  private interval: NodeJS.Timeout | null = null;
  private message: string = "";

  /**
   * Start the spinner
   */
  start(message: string): void {
    if (!isWatchModeEnabled()) return;

    this.message = message;
    this.spinnerIndex = 0;

    // Clear any existing spinner
    if (this.interval) {
      clearInterval(this.interval);
    }

    // Start new spinner
    this.interval = setInterval(() => {
      const frame = this.spinner[this.spinnerIndex];
      process.stdout.write(
        `\r${colors.cyan}${frame}${colors.reset} ${this.message}`,
      );
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinner.length;
    }, 80);
  }

  /**
   * Update spinner message
   */
  update(message: string): void {
    this.message = message;
  }

  /**
   * Stop the spinner
   */
  stop(success: boolean = true, finalMessage?: string): void {
    if (!isWatchModeEnabled()) return;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Clear the line and write final message
    process.stdout.write("\r\x1b[K"); // Clear line

    if (finalMessage) {
      const icon = success ? "✓" : "✗";
      const color = success ? colors.green : colors.red;
      console.log(`${color}${icon}${colors.reset} ${finalMessage}`);
    }
  }
}

/**
 * Agent watcher for real-time streaming
 */
export class AgentWatcher {
  private agentName: string;
  private indent: string;

  constructor(agentName: string, indent: number = 0) {
    this.agentName = agentName;
    this.indent = "  ".repeat(indent);
  }

  /**
   * Stream LLM call start
   */
  streamLLMCall(
    prompt: string | BaseMessage[],
    model?: string,
    temperature?: number,
  ): void {
    if (!isWatchModeEnabled()) return;

    const promptStr = Array.isArray(prompt)
      ? `${prompt.length} messages`
      : prompt.slice(0, 80) + (prompt.length > 80 ? "..." : "");

    console.log(
      `\n${this.indent}${PrettyFormatter.formatAgent(this.agentName)} 💭 Thinking...`,
    );
    console.log(
      `${this.indent}  ↳ Prompt: ${colors.gray}${promptStr}${colors.reset}`,
    );
    if (model) {
      console.log(
        `${this.indent}  ↳ Model: ${colors.gray}${model}${colors.reset}`,
      );
    }
    if (temperature !== undefined) {
      console.log(
        `${this.indent}  ↳ Temperature: ${colors.gray}${temperature}${colors.reset}`,
      );
    }
  }

  /**
   * Stream LLM response
   */
  streamLLMResponse(
    response: string,
    tokens?: { input: number; output: number; total: number },
    cost?: number,
  ): void {
    if (!isWatchModeEnabled()) return;

    const responseStr =
      response.slice(0, 150) + (response.length > 150 ? "..." : "");

    console.log(
      `${this.indent}${PrettyFormatter.formatAgent(this.agentName)} ✓ Response:`,
    );
    console.log(
      `${this.indent}  ↳ ${colors.gray}${responseStr}${colors.reset}`,
    );

    if (tokens) {
      console.log(
        `${this.indent}  ↳ Tokens: ${colors.gray}${tokens.input} in, ${tokens.output} out (${tokens.total} total)${colors.reset}`,
      );
    }

    if (cost !== undefined) {
      console.log(
        `${this.indent}  ↳ Cost: ${PrettyFormatter.formatCost(cost, tokens?.total)}`,
      );
    }
  }

  /**
   * Stream tool call
   */
  streamToolCall(
    toolName: string,
    args: any,
    startTime: number = Date.now(),
  ): number {
    if (!isWatchModeEnabled()) return startTime;

    console.log(`\n${this.indent}${PrettyFormatter.formatTool(toolName)}`);

    // Format args nicely
    const argsStr = JSON.stringify(args, null, 2)
      .split("\n")
      .map((line, i) => (i === 0 ? line : `${this.indent}    ${line}`))
      .join("\n");

    console.log(
      `${this.indent}  ↳ Args: ${colors.dim}${argsStr}${colors.reset}`,
    );

    return startTime;
  }

  /**
   * Stream tool result
   */
  streamToolResult(toolName: string, result: any, startTime: number): void {
    if (!isWatchModeEnabled()) return;

    const duration = Date.now() - startTime;
    const resultStr =
      typeof result === "string"
        ? result.slice(0, 200) + (result.length > 200 ? "..." : "")
        : JSON.stringify(result).slice(0, 200);

    console.log(
      `${this.indent}${PrettyFormatter.formatStatus(true)} ${colors.yellow}${toolName}${colors.reset} ${PrettyFormatter.formatDuration(duration)}`,
    );
    console.log(`${this.indent}  ↳ ${colors.dim}${resultStr}${colors.reset}`);
  }

  /**
   * Stream decision
   */
  streamDecision(decision: any): void {
    if (!isWatchModeEnabled()) return;

    console.log(
      `\n${this.indent}${PrettyFormatter.formatAgent(this.agentName)} 🤔 Decision:`,
    );
    console.log(
      `${this.indent}  ↳ Action: ${PrettyFormatter.formatDecision(decision)}`,
    );

    if (decision.nextNode) {
      console.log(
        `${this.indent}  ↳ Next: ${colors.cyan}${decision.nextNode}${colors.reset}`,
      );
    }

    if (decision.reasoning) {
      const reasoning =
        decision.reasoning.slice(0, 150) +
        (decision.reasoning.length > 150 ? "..." : "");
      console.log(
        `${this.indent}  ↳ Reasoning: ${colors.dim}${reasoning}${colors.reset}`,
      );
    }
  }

  /**
   * Stream error
   */
  streamError(error: Error | string, context?: string): void {
    if (!isWatchModeEnabled()) return;

    const errorMsg = error instanceof Error ? error.message : error;

    console.log(
      `\n${this.indent}${PrettyFormatter.formatAgent(this.agentName)} ❌ Error` +
        (context ? ` (${context})` : ""),
    );
    console.log(`${this.indent}  ↳ ${colors.red}${errorMsg}${colors.reset}`);
  }

  /**
   * Stream section header
   */
  streamSection(title: string): void {
    if (!isWatchModeEnabled()) return;

    console.log(
      `\n${this.indent}${colors.bright}${"─".repeat(50)}${colors.reset}`,
    );
    console.log(`${this.indent}${colors.bright}  ${title}${colors.reset}`);
    console.log(
      `${this.indent}${colors.bright}${"─".repeat(50)}${colors.reset}`,
    );
  }
}

/**
 * Create a watcher for an agent
 */
export function createAgentWatcher(
  agentName: string,
  indent: number = 0,
): AgentWatcher {
  return new AgentWatcher(agentName, indent);
}

/**
 * Create a progress indicator
 */
export function createProgressIndicator(): ProgressIndicator {
  return new ProgressIndicator();
}
