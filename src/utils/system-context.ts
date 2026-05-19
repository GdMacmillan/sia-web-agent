/**
 * System Context Builder - Generates dynamic environment context
 *
 * Builds the <env> section for system prompts with current environment
 * information including working directory, platform, and date.
 * Uses getProjectRoot() which respects SIA_PROJECT_ROOT in self-improve mode.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getProjectRoot } from "./path-utils.js";

/**
 * Options for building system context
 */
export interface SystemContextOptions {
  /** Override the working directory (defaults to getProjectRoot()) */
  workingDirectory?: string;
  /** Model display name (e.g., "GPT Codex 5.1 Mini") */
  modelName?: string;
  /** Model ID (e.g., "openai/gpt-5.1-codex-mini") */
  modelId?: string;
  /** Knowledge cutoff date (e.g., "September 2024") */
  knowledgeCutoff?: string;
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
 * @param options - Optional overrides for context values
 * @returns Formatted system context string with <env> section
 */
export function buildSystemContext(options: SystemContextOptions = {}): string {
  // Uses getProjectRoot() which respects SIA_PROJECT_ROOT in self-improve mode
  const workingDir = options.workingDirectory ?? getProjectRoot();
  const modelName = options.modelName ?? "GPT Codex 5.1 Mini";
  const modelId = options.modelId ?? "openai/gpt-5.1-codex-mini";
  const cutoff = options.knowledgeCutoff ?? "September 2024";
  const { platform, version } = getPlatformInfo();
  const today = new Date().toISOString().split("T")[0];

  return `## System Environment
Here is useful information about the environment you are running in:
<env>
Working directory: ${workingDir}
Is directory a git repo: ${isGitRepo(workingDir) ? "Yes" : "No"}
Platform: ${platform}
OS Version: ${version}
Today's date: ${today}
</env>

You are powered by the model named ${modelName}. The exact model ID is ${modelId}.

Assistant knowledge cutoff is ${cutoff}.`;
}
