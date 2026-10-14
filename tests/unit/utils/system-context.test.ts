/**
 * buildSystemContext Unit Tests
 *
 * The environment block is part of the system prompt, which must be
 * byte-stable across turns and must not state facts the host didn't supply.
 */

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { buildSystemContext } from "../../../src/utils/system-context.js";

const WORKDIR = "/tmp/agent-root";

describe("buildSystemContext", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("contains only process-lifetime facts when no model facts are given", () => {
    const context = buildSystemContext({ workingDirectory: WORKDIR });

    expect(context).toMatch(
      /^## System Environment\nHere is useful information about the environment you are running in:\n<env>\nWorking directory: \/tmp\/agent-root\nIs directory a git repo: (Yes|No)\nPlatform: .+\nOS Version: .+\n<\/env>$/,
    );
  });

  it("has no date line and does not change with the clock", () => {
    jest.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const first = buildSystemContext({ workingDirectory: WORKDIR });
    jest.setSystemTime(new Date("2027-06-15T12:00:00Z"));
    const second = buildSystemContext({ workingDirectory: WORKDIR });

    expect(second).toBe(first);
    expect(first).not.toMatch(/date/i);
  });

  it("renders every supplied model fact", () => {
    const context = buildSystemContext({
      workingDirectory: WORKDIR,
      modelName: "Claude Sonnet 4.5",
      modelId: "anthropic/claude-sonnet-4.5",
      knowledgeCutoff: "January 2025",
    });

    expect(
      context.endsWith(
        "</env>\n\nYou are powered by the model named Claude Sonnet 4.5. The exact model ID is anthropic/claude-sonnet-4.5.\n\nAssistant knowledge cutoff is January 2025.",
      ),
    ).toBe(true);
  });

  it("omits each missing model fact individually", () => {
    const idOnly = buildSystemContext({
      workingDirectory: WORKDIR,
      modelId: "openai/gpt-4o-mini",
    });
    expect(
      idOnly.endsWith("</env>\n\nThe exact model ID is openai/gpt-4o-mini."),
    ).toBe(true);
    expect(idOnly).not.toContain("powered by");
    expect(idOnly).not.toContain("cutoff");

    const nameOnly = buildSystemContext({
      workingDirectory: WORKDIR,
      modelName: "GPT-4o mini",
      knowledgeCutoff: "  ",
    });
    expect(
      nameOnly.endsWith(
        "</env>\n\nYou are powered by the model named GPT-4o mini.",
      ),
    ).toBe(true);
    expect(nameOnly).not.toContain("cutoff");
  });

  it("renders the host's account of the process inside the env block", () => {
    const context = buildSystemContext({
      workingDirectory: WORKDIR,
      nodeId: "node-3f2c",
      sandboxStatus: "partial",
      sandboxMechanism: "landlock+seccomp",
      agentSourceVersion: "0.13.0",
      provider: "openrouter",
    });

    expect(context).toMatch(
      /\nOS Version: .+\nNode: node-3f2c\nSandbox: partial \(landlock\+seccomp\)\nAgent source version: 0\.13\.0 \(as staged by the host\)\nModel provider: openrouter\n<\/env>$/,
    );
  });

  it("omits each missing host fact individually", () => {
    const context = buildSystemContext({
      workingDirectory: WORKDIR,
      sandboxStatus: "disabled_by_operator",
      sandboxMechanism: "none",
      nodeId: " ",
    });

    expect(context).toContain("\nSandbox: disabled by operator\n</env>");
    expect(context).not.toContain("Node:");
    expect(context).not.toContain("Agent source version:");
    expect(context).not.toContain("Model provider:");

    const mechanismAlone = buildSystemContext({
      workingDirectory: WORKDIR,
      sandboxMechanism: "seatbelt",
    });
    expect(mechanismAlone).not.toContain("Sandbox:");
  });

  it("host facts are as byte-stable as the rest of the block", () => {
    const options = {
      workingDirectory: WORKDIR,
      nodeId: "n",
      sandboxStatus: "enforced",
      sandboxMechanism: "seatbelt",
      agentSourceVersion: "1.0.0",
      provider: "openai",
    };
    jest.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const first = buildSystemContext(options);
    jest.setSystemTime(new Date("2027-06-15T12:00:00Z"));
    expect(buildSystemContext(options)).toBe(first);
  });
});
