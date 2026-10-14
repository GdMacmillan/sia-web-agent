/**
 * Read-only sub-agents.
 *
 * A sub-agent whose description says "Read-only" must have no write tool
 * reach its model, and a call to one must change nothing. The shared
 * sub-agent stack injects write-capable tools of its own (filesystem
 * writes, `execute_code`, `eval`), so the base tool filter alone was not
 * enough.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { ToolMessage } from "langchain";

jest.mock("../../../src/config/model-config.js", () => ({
  createPlanModel: jest.fn(async () => ({ name: "plan-model" })),
  createResearchModel: jest.fn(async () => ({ name: "research-model" })),
  createAnswerModel: jest.fn(async () => ({ name: "answer-model" })),
}));

import {
  createReadOnlyMiddleware,
  READ_ONLY_EXCLUDED_TOOLS,
  READ_ONLY_MIDDLEWARE_NAME,
} from "../../../src/middleware/read-only.js";
import { FILESYSTEM_TOOL_NAMES } from "../../../src/middleware/fs.js";
import {
  getPlanSubAgent,
  getResearchSubAgent,
  getAnswerSubAgent,
} from "../../../src/sub-agents.js";

/** Every tool that can write a file, write memory, or run code. */
const WRITE_TOOLS = [
  "write_file",
  "edit_file",
  "store_entity",
  "update_entity",
  "update_entity_status",
  "promote_entities",
  "execute_code",
  "eval",
];

const READ_TOOLS = [
  "ls",
  "read_file",
  "glob",
  "grep",
  "search",
  "retrieve_entity",
  "search_entities",
  "list_entities",
  "traverse_graph",
  "web_search",
];

/** What the shared sub-agent stack can put in front of a model. */
const STACK_TOOLS = [
  ...new Set([
    ...FILESYSTEM_TOOL_NAMES,
    ...READ_TOOLS,
    ...WRITE_TOOLS,
    "write_todos",
  ]),
];

async function toolsSeenByModel(names: string[]): Promise<string[]> {
  const mw = createReadOnlyMiddleware();
  let seen: Array<{ name: string }> = [];
  await mw.wrapModelCall!(
    { tools: names.map((name) => ({ name })) } as any,
    (async (req: { tools: Array<{ name: string }> }) => {
      seen = req.tools;
      return { content: "" };
    }) as any,
  );
  return seen.map((t) => t.name);
}

describe("createReadOnlyMiddleware", () => {
  it("excludes exactly the write and code-execution tools", () => {
    expect([...READ_ONLY_EXCLUDED_TOOLS].sort()).toEqual(
      [...WRITE_TOOLS].sort(),
    );
  });

  it("lets no write tool reach the model, and keeps every read tool", async () => {
    const seen = await toolsSeenByModel(STACK_TOOLS);
    for (const name of WRITE_TOOLS) expect(seen).not.toContain(name);
    for (const name of READ_TOOLS) expect(seen).toContain(name);
  });

  it("refuses a write tool the model calls anyway, without running it", async () => {
    const mw = createReadOnlyMiddleware();
    const handler = jest.fn(async () => "ran");
    const result = await mw.wrapToolCall!(
      {
        toolCall: {
          id: "call-1",
          name: "write_file",
          args: { file_path: "/x", content: "y" },
        },
      } as any,
      handler as any,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(ToolMessage);
    const message = result as ToolMessage;
    expect(message.status).toBe("error");
    expect(message.tool_call_id).toBe("call-1");
    expect(String(message.content)).toContain("read-only");
  });

  it("passes a read tool call through untouched", async () => {
    const mw = createReadOnlyMiddleware();
    const handler = jest.fn(async () => "file contents");
    const result = await mw.wrapToolCall!(
      { toolCall: { id: "call-2", name: "read_file", args: {} } } as any,
      handler as any,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toBe("file contents");
  });
});

describe("sub-agent definitions", () => {
  const readOnlyNames = (agent: { middleware?: Array<{ name: string }> }) =>
    (agent.middleware ?? []).map((m) => m.name);

  it("every sub-agent described as read-only carries the read-only middleware", async () => {
    const agents = [
      await getPlanSubAgent(),
      await getResearchSubAgent(),
      await getAnswerSubAgent(),
    ];
    for (const agent of agents) {
      const described = /read-only/i.test(agent.description);
      expect(readOnlyNames(agent as any).includes(READ_ONLY_MIDDLEWARE_NAME)).toBe(
        described,
      );
    }
    // Plan and research are the read-only ones; answer may store what it learns.
    expect(agents.filter((a) => /read-only/i.test(a.description))).toHaveLength(
      2,
    );
  });
});
