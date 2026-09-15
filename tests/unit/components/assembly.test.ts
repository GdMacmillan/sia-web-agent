/**
 * Full-stack assembly: component middleware reaches both the main and the
 * sub-agent stack as a replacement (never an addition), main-only entries
 * stay out of the sub-agent stack, a replacement whose target is absent is
 * dropped, and profile overlays reach the tool-exclusion boundary.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { createMiddleware, type AgentMiddleware } from "langchain";

// The summarization model is constructed from the provider config at
// assembly time; stub the client so no key is needed.
jest.mock("@langchain/openrouter", () => ({
  ChatOpenRouter: class {
    constructor(_options: unknown) {}
  },
}));

import * as subagentsModule from "../../../src/middleware/subagents.js";
import { createDeepAgent, KNOWN_MIDDLEWARE_NAMES } from "../../../src/agent.js";
import { createComponentsMiddleware } from "../../../src/components/registry.js";
import { tagReplaces } from "../../../src/components/replaces-tag.js";
import { createHarnessProfile } from "../../../src/profiles/harness.js";
import { getProjectRoot } from "../../../src/utils/path-utils.js";
import { logger } from "../../../src/utils/logger.js";

type AgentOptions = {
  tools?: Array<{ name: string }>;
  middleware?: AgentMiddleware[];
};

const MAIN_BASELINE = [
  "autoContinueMiddleware",
  "capExhaustionMiddleware",
  "usageEventsMiddleware",
  "todoListMiddleware",
  "FilesystemMiddleware",
  "memoryAugmentationMiddleware",
  "skillsMiddleware",
  "CodeExecutionMiddleware",
  "subAgentMiddleware",
  "SummarizationMiddleware",
  "patchToolCallsMiddleware",
  "PromptCachingMiddleware",
  "knowledgeFormationMiddleware",
];

const SUBAGENT_BASELINE = [
  "autoContinueMiddleware",
  "capExhaustionMiddleware",
  "usageEventsMiddleware",
  "todoListMiddleware",
  "FilesystemMiddleware",
  "memoryAugmentationMiddleware",
  "skillsMiddleware",
  "CodeExecutionMiddleware",
  "SummarizationMiddleware",
  "patchToolCallsMiddleware",
  "PromptCachingMiddleware",
];

const names = (list: readonly AgentMiddleware[] | undefined) =>
  (list ?? []).map((m) => m.name);

const toolNames = (list: readonly AgentMiddleware[] | undefined) =>
  (list ?? []).flatMap((m) =>
    ((m as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name),
  );

function stub(name: string, replaces?: string): AgentMiddleware {
  const mw = createMiddleware({ name, tools: [] });
  return replaces ? tagReplaces(mw, replaces) : mw;
}

describe("createDeepAgent with component middleware", () => {
  const model = {
    invoke: jest.fn(),
    stream: jest.fn(),
    modelName: "test-model",
  } as any;
  let spy: ReturnType<typeof jest.spyOn>;
  let warn: ReturnType<typeof jest.spyOn>;
  const projectRoot = getProjectRoot();

  beforeEach(() => {
    spy = jest.spyOn(subagentsModule, "createSubAgentMiddleware");
    warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    spy.mockRestore();
    warn.mockRestore();
  });

  function subagentDefaults(): AgentMiddleware[] {
    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0][0] as {
      defaultMiddleware?: AgentMiddleware[];
    };
    return options.defaultMiddleware ?? [];
  }

  async function assemble(
    middleware: AgentMiddleware[] = [],
    extra: Record<string, unknown> = {},
  ): Promise<AgentOptions> {
    const agent = await createDeepAgent({
      model,
      tools: [],
      projectRoot,
      middleware,
      ...extra,
    });
    return (agent as unknown as { options: AgentOptions }).options;
  }

  it("assembles the baseline stacks when nothing is customised", async () => {
    const options = await assemble();
    expect(names(options.middleware)).toEqual(MAIN_BASELINE);
    expect(names(subagentDefaults())).toEqual(SUBAGENT_BASELINE);
    expect(toolNames(options.middleware)).toContain("execute_code");
  });

  it("declares every assembled middleware name in KNOWN_MIDDLEWARE_NAMES", async () => {
    const options = await assemble();
    for (const name of [...names(options.middleware), ...names(subagentDefaults())]) {
      expect(KNOWN_MIDDLEWARE_NAMES.has(name)).toBe(true);
    }
  });

  it("swaps a CodeExecutionMiddleware replacement into both stacks in place", async () => {
    const replacement = stub("CodeExecutionMiddleware", "CodeExecutionMiddleware");
    const options = await assemble([replacement]);

    const main = options.middleware ?? [];
    expect(names(main)).toEqual(MAIN_BASELINE);
    expect(main[MAIN_BASELINE.indexOf("CodeExecutionMiddleware")]).toBe(
      replacement,
    );
    expect(toolNames(main)).not.toContain("execute_code");

    const sub = subagentDefaults();
    expect(names(sub)).toEqual(SUBAGENT_BASELINE);
    expect(sub[SUBAGENT_BASELINE.indexOf("CodeExecutionMiddleware")]).toBe(
      replacement,
    );
    expect(toolNames(sub)).not.toContain("execute_code");
  });

  it("keeps a main-only replacement and the manifest refresher out of the sub-agent stack", async () => {
    const knowledge = stub("knowledgeFormationMiddleware", "knowledgeFormationMiddleware");
    const refresher = createComponentsMiddleware();
    const options = await assemble([knowledge, refresher]);

    const main = options.middleware ?? [];
    expect(main).toContain(knowledge);
    expect(main).toContain(refresher);
    // Novel entries insert between the core and tail segments.
    expect(names(main).indexOf("componentsMiddleware")).toBe(
      MAIN_BASELINE.indexOf("PromptCachingMiddleware"),
    );

    const sub = subagentDefaults();
    expect(names(sub)).toEqual(SUBAGENT_BASELINE);
    expect(sub).not.toContain(knowledge);
    expect(sub).not.toContain(refresher);
  });

  it("drops a replacement whose target is not in the assembled stack", async () => {
    const interpreter = stub("CodeInterpreterMiddleware", "CodeInterpreterMiddleware");
    const options = await assemble([interpreter]);
    expect(names(options.middleware)).toEqual(MAIN_BASELINE);
    expect(names(subagentDefaults())).toEqual(SUBAGENT_BASELINE);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ replaces: "CodeInterpreterMiddleware" }),
      expect.stringMatching(/dropped/),
    );
  });

  it("adds a novel component middleware to both stacks", async () => {
    const novel = stub("novelMiddleware");
    const options = await assemble([novel]);
    expect(options.middleware).toContain(novel);
    expect(subagentDefaults()).toContain(novel);
  });

  it("applies a profile overlay's excluded tools at the model boundary", async () => {
    const overlay = createHarnessProfile({ excludedTools: ["execute_code"] });
    const options = await assemble([], { profileOverlays: [overlay] });
    const exclusion = (options.middleware ?? []).find(
      (m) => m.name === "_ToolExclusionMiddleware",
    ) as (AgentMiddleware & {
      wrapModelCall?: (request: any, handler: (r: any) => any) => any;
    }) | undefined;
    expect(exclusion).toBeDefined();

    let seen: Array<{ name: string }> | undefined;
    await exclusion?.wrapModelCall?.(
      { tools: [{ name: "execute_code" }, { name: "bash" }] },
      async (request) => {
        seen = request.tools;
        return {};
      },
    );
    expect(seen?.map((t) => t.name)).toEqual(["bash"]);
  });
});
