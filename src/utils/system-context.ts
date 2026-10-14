/**
 * System Context Builder - Generates dynamic environment context
 *
 * Builds the <env> section for system prompts with environment information
 * that is fixed for the life of the process: working directory, git status,
 * platform and OS version, plus the model facts the host supplied.
 *
 * The output must be byte-stable across turns so the system prompt can be
 * served from a provider's prompt cache. Anything that changes during the
 * process's lifetime (today's date, for one) does NOT belong here — it is
 * delivered per request as a context message instead (see
 * `middleware/host-context.ts`).
 *
 * Model facts are never guessed: a line whose value the host didn't supply is
 * omitted rather than filled with a default that may be false. The same holds
 * for the host's account of this process — the node it runs on, the sandbox
 * it runs under, the source version it was launched from and how it reaches
 * its model: each is a line only when the host said so.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { release } from "node:os";
import { getProjectRoot } from "./path-utils.js";

/**
 * Options for building system context
 */
export interface SystemContextOptions {
  /** Override the working directory (defaults to getProjectRoot()) */
  workingDirectory?: string;
  /** Model display name (e.g., "Claude Sonnet 4.5"). Line omitted when absent. */
  modelName?: string;
  /** Model ID (e.g., "anthropic/claude-sonnet-4.5"). Omitted when absent. */
  modelId?: string;
  /** Knowledge cutoff (e.g., "January 2025"). Line omitted when absent. */
  knowledgeCutoff?: string;
  /** How the agent reaches its model (e.g., "openrouter"). Omitted when absent. */
  provider?: string;
  /** The machine the host runs this agent on. Omitted when absent. */
  nodeId?: string;
  /** The sandbox the host applied (e.g., "enforced"). Omitted when absent. */
  sandboxStatus?: string;
  /** How that sandbox is enforced (e.g., "seatbelt"). Optional detail. */
  sandboxMechanism?: string;
  /** Source version the host staged this process from. Omitted when absent. */
  agentSourceVersion?: string;
}

/**
 * Check if a directory is a git repository
 *
 * @param dir - Directory path to check
 * @returns true if directory contains a .git folder
 */
function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * Get platform information including OS name and version
 *
 * @returns Object with platform name and version string
 */
function getPlatformInfo(): { platform: string; version: string } {
  const platform =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform === "linux"
          ? "Linux"
          : process.platform;

  let version = "Unknown";
  try {
    if (process.platform === "darwin") {
      const productName = execSync("sw_vers -productName", {
        encoding: "utf-8",
      }).trim();
      const productVersion = execSync("sw_vers -productVersion", {
        encoding: "utf-8",
      }).trim();
      version = `${productName} Version ${productVersion}`;
    } else if (process.platform === "win32") {
      // `uname` isn't available on Windows; use the kernel release directly.
      version = `Windows ${release()}`;
    } else {
      version = execSync("uname -r", { encoding: "utf-8" }).trim();
    }
  } catch {
    /* use default */
  }

  return { platform, version };
}

/**
 * Build the system context string for injection into prompts.
 *
 * Uses getProjectRoot() which respects SIA_PROJECT_ROOT env var,
 * ensuring the correct working directory is shown in self-improve mode.
 *
 * Deterministic for a given set of options within one process: it contains
 * no clock reading, so two calls produce identical bytes.
 *
 * @param options - Optional overrides for context values
 * @returns Formatted system context string with <env> section
 */
export function buildSystemContext(options: SystemContextOptions = {}): string {
  // Uses getProjectRoot() which respects SIA_PROJECT_ROOT in self-improve mode
  const workingDir = options.workingDirectory ?? getProjectRoot();
  const { platform, version } = getPlatformInfo();

  const envLines = [
    `Working directory: ${workingDir}`,
    `Is directory a git repo: ${isGitRepo(workingDir) ? "Yes" : "No"}`,
    `Platform: ${platform}`,
    `OS Version: ${version}`,
    ...hostEnvLines(options),
  ];

  const sections = [
    `## System Environment
Here is useful information about the environment you are running in:
<env>
${envLines.join("\n")}
</env>`,
  ];

  const modelName = nonEmpty(options.modelName);
  const modelId = nonEmpty(options.modelId);
  const modelLine = [
    modelName ? `You are powered by the model named ${modelName}.` : null,
    modelId ? `The exact model ID is ${modelId}.` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  if (modelLine) sections.push(modelLine);

  const cutoff = nonEmpty(options.knowledgeCutoff);
  if (cutoff) sections.push(`Assistant knowledge cutoff is ${cutoff}.`);

  return sections.join("\n\n");
}

/**
 * The host's account of this process, one line per fact it supplied. All of
 * these are fixed for the process's life (the host stamps them at launch), so
 * they keep the block byte-stable.
 */
function hostEnvLines(options: SystemContextOptions): string[] {
  const lines: string[] = [];
  const nodeId = nonEmpty(options.nodeId);
  if (nodeId) lines.push(`Node: ${nodeId}`);

  const sandbox = nonEmpty(options.sandboxStatus);
  if (sandbox) {
    const mechanism = nonEmpty(options.sandboxMechanism);
    const detail = mechanism && mechanism !== "none" ? ` (${mechanism})` : "";
    lines.push(`Sandbox: ${sandbox.replace(/_/g, " ")}${detail}`);
  }

  const sourceVersion = nonEmpty(options.agentSourceVersion);
  if (sourceVersion) {
    lines.push(`Agent source version: ${sourceVersion} (as staged by the host)`);
  }

  const provider = nonEmpty(options.provider);
  if (provider) lines.push(`Model provider: ${provider}`);
  return lines;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
