/**
 * The tool-definition budget, enforced against the real assembled agent.
 *
 * Every tool definition is re-sent on every model call, so each one has a
 * size cap and the set advertised on a turn has a total cap. The agent is
 * built with `createDeepAgentWithDefaults` around a model that records what
 * it is handed and never calls a provider.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

// Sub-agent and summarization models are constructed from the provider
// config at assembly time; stub the client so no key is needed.
jest.mock("@langchain/openrouter", () => ({
  ChatOpenRouter: class {
    constructor(_options: unknown) {}
  },
}));

// Boot reconciliation asks the host about prepared versions; there is none.
jest.mock("../../../src/components/lineage-reconcile.js", () => ({
  getLineageReconciler: () => ({ onBoot: async () => undefined }),
}));

import {
  createDeepAgentWithDefaults,
  collectToolPool,
} from "../../../src/deep-agent-setup.js";
import {
  budgetFor,
  measureTools,
  serializeToolDefinition,
  TOTAL_TOOL_BUDGET,
} from "../../../src/tools/tool-budget.js";
import { DEFAULT_DEFERRED_TOOL_GROUPS } from "../../../src/middleware/deferred-tools.js";
import { resetConfig } from "../../../src/config/index.js";

type AnyTool = { name: string } & Record<string, unknown>;

const EXPECTED_TOOLS = [
  "announce_component_version",
  "bash",
  "check_item",
  "create_checklist",
  "create_component",
  "delete_checklist",
  "describe_component",
  "edit_file",
  "execute_code",
  "get_checklist",
  "get_ready_items",
  "glob",
  "grep",
  "list_entities",
  "load_skill",
  "ls",
  "prepare_component_version",
  "promote_entities",
  "read_file",
  "retrieve_entity",
  "run_component_contract",
  "search",
  "search_entities",
  "set_dependencies",
  "start_self_task",
  "store_entity",
  "task",
  "traverse_graph",
  "uncheck_item",
  "update_entity",
  "update_entity_status",
  "web_crawl",
  "web_extract",
  "web_map",
  "web_search",
  "write_file",
  "write_todos",
];

const DEFERRED = new Set(DEFAULT_DEFERRED_TOOL_GROUPS.flatMap((g) => g.tools));

const captured: AnyTool[][] = [];

class RecordingChatModel extends BaseChatModel {
  boundTools: AnyTool[] = [];
  _llmType(): string {
    return "recording";
  }
  bindTools(tools: AnyTool[]): this {
    const bound = Object.create(this) as this;
    bound.boundTools = tools;
    return bound;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    captured.push(this.boundTools);
    const message = new AIMessage("ok");
    return { generations: [{ message, text: "ok" }] };
  }
}

const ENV_KEYS = [
  "LLM_PROVIDER",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "TAVILY_API_KEY",
  "SIA_SERVERS_FILE",
  "SIA_COMPONENTS_DIR",
  "SIA_DAEMON_URL",
  "SIA_DAEMON_TOKEN",
] as const;

describe("tool-definition budget", () => {
  const saved: Record<string, string | undefined> = {};
  let pool: AnyTool[] = [];
  let advertised: AnyTool[] = [];

  beforeAll(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.LLM_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "tool-budget-test";
    process.env.OPENROUTER_MODEL = "anthropic/claude-sonnet-4-6";
    process.env.TAVILY_API_KEY = "tool-budget-test";
    delete process.env.SIA_SERVERS_FILE;
    delete process.env.SIA_COMPONENTS_DIR;
    delete process.env.SIA_DAEMON_URL;
    delete process.env.SIA_DAEMON_TOKEN;
    resetConfig();

    const agent = await createDeepAgentWithDefaults({
      model: new RecordingChatModel({}) as unknown as never,
    });
    pool = collectToolPool(agent) as unknown as AnyTool[];
    await agent.invoke(
      { messages: [new HumanMessage("hi")] },
      { configurable: { thread_id: "tool-budget-test" } },
    );
    advertised = captured[0] ?? [];
  }, 60_000);

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetConfig();
  });

  it("assembles the expected tool pool", () => {
    expect(pool.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("keeps every tool definition within its budget", () => {
    const over = measureTools(pool).tools.filter((row) => row.overBudget);
    expect(
      over.map((row) => `${row.name} ${row.chars} > ${row.budget}`),
    ).toEqual([]);
  });

  it("keeps the compact write_todos description in place", () => {
    const writeTodos = pool.find((t) => t.name === "write_todos");
    expect(writeTodos).toBeDefined();
    expect(serializeToolDefinition(writeTodos!).length).toBeLessThanOrEqual(
      budgetFor("write_todos"),
    );
  });

  it("advertises the pool minus the deferred groups on a fresh thread", () => {
    const names = advertised.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS.filter((n) => !DEFERRED.has(n)));
  });

  it("keeps the advertised set within the total budget", () => {
    expect(measureTools(advertised).totalChars).toBeLessThanOrEqual(
      TOTAL_TOOL_BUDGET,
    );
  });
});
