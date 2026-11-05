/**
 * Deferred tool groups: hidden from the advertised list until the
 * conversation reveals them, never blocked from executing, and announced by
 * one system line that does not change when a group is revealed.
 */
import { describe, it, expect, jest } from "@jest/globals";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  createDeferredToolsMiddleware,
  DEFAULT_DEFERRED_TOOL_GROUPS,
  DEFERRED_TOOLS_MIDDLEWARE_NAME,
  isGroupRevealed,
  type DeferredToolsOptions,
} from "../../../src/middleware/deferred-tools.js";
import { COMPONENT_WORK_IN_SELF_TASK } from "../../../src/tools/self-task-context.js";
import { buildSelfTaskMessage } from "../../../src/tools/self-task-tool.js";

type Tool = { name: string };
type Request = {
  tools: Tool[];
  messages: BaseMessage[];
  systemMessage: SystemMessage;
  systemPrompt: string;
  runtime?: { configurable?: { thread_id?: string } };
};

type Middleware = {
  name: string;
  wrapModelCall: (
    request: Request,
    handler: (request: Request) => Promise<unknown>,
  ) => Promise<unknown>;
};

const CHECKLIST = DEFAULT_DEFERRED_TOOL_GROUPS.find(
  (g) => g.skill === "checklist",
)!;
const COMPONENTS = DEFAULT_DEFERRED_TOOL_GROUPS.find(
  (g) => g.skill === "iterate-component",
)!;

const PLAIN = ["read_file", "bash", "load_skill", "describe_component"];
const ALL_TOOLS: Tool[] = [
  ...PLAIN,
  ...CHECKLIST.tools,
  ...COMPONENTS.tools,
].map((name) => ({ name }));

/** Run the middleware's model-call hook and return what the handler saw. */
async function run(
  messages: BaseMessage[],
  tools: Tool[] = ALL_TOOLS,
  system = "base prompt",
  options: { middleware?: Middleware; threadId?: string } = {},
): Promise<{ tools: string[]; system: string }> {
  const middleware =
    options.middleware ?? (createDeferredToolsMiddleware() as unknown as Middleware);
  let seen: Request | undefined;
  await middleware.wrapModelCall(
    {
      tools,
      messages,
      systemMessage: new SystemMessage(system),
      systemPrompt: system,
      ...(options.threadId !== undefined
        ? { runtime: { configurable: { thread_id: options.threadId } } }
        : {}),
    },
    async (request) => {
      seen = request;
      return new AIMessage("ok");
    },
  );
  return {
    tools: seen!.tools.map((t) => t.name),
    system: seen!.systemMessage.text,
  };
}

function loadSkill(skill: string, id = "call_1"): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ id, name: "load_skill", args: { skill_name: skill } }],
  });
}

describe("createDeferredToolsMiddleware", () => {
  it("is named for the stack", () => {
    expect(createDeferredToolsMiddleware().name).toBe(
      DEFERRED_TOOLS_MIDDLEWARE_NAME,
    );
  });

  it("hides every deferred group on a fresh thread", async () => {
    const { tools } = await run([new HumanMessage("hi")]);
    expect(tools).toEqual(PLAIN);
  });

  it("reveals a group when its skill is loaded", async () => {
    const { tools } = await run([
      new HumanMessage("make a checklist"),
      loadSkill("checklist"),
      new ToolMessage({
        content: "skill text",
        tool_call_id: "call_1",
        name: "load_skill",
      }),
    ]);
    expect(tools).toEqual([...PLAIN, ...CHECKLIST.tools]);
  });

  it("leaves other groups hidden when one is revealed", async () => {
    const { tools } = await run([loadSkill("iterate-component")]);
    expect(tools).toEqual([...PLAIN, ...COMPONENTS.tools]);
    for (const name of CHECKLIST.tools) expect(tools).not.toContain(name);
  });

  it("does not reveal a group for a different skill", async () => {
    const { tools } = await run([loadSkill("web-search")]);
    expect(tools).toEqual(PLAIN);
  });

  it("reveals a group named by an earlier tool call", async () => {
    const { tools } = await run([
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "c", name: "get_checklist", args: { checklist_id: "x" } },
        ],
      }),
    ]);
    expect(tools).toEqual([...PLAIN, ...CHECKLIST.tools]);
  });

  it("reveals a group named by an earlier tool result", async () => {
    const { tools } = await run([
      new ToolMessage({
        content: "{}",
        tool_call_id: "c",
        name: "run_component_contract",
      }),
    ]);
    expect(tools).toEqual([...PLAIN, ...COMPONENTS.tools]);
  });

  it("keeps the system line byte-identical whether a group is hidden or revealed", async () => {
    const hidden = await run([new HumanMessage("hi")]);
    const revealed = await run([
      loadSkill("checklist", "a"),
      loadSkill("iterate-component", "b"),
    ]);
    expect(hidden.tools).not.toEqual(revealed.tools);
    expect(revealed.system).toBe(hidden.system);
    expect(hidden.system.startsWith("base prompt\n\n")).toBe(true);
    expect(hidden.system).toContain('"checklist"');
    expect(hidden.system).toContain('"iterate-component"');
  });

  it("leaves the request untouched when no deferred tool is registered", async () => {
    const tools = PLAIN.map((name) => ({ name }));
    const result = await run([new HumanMessage("hi")], tools);
    expect(result.tools).toEqual(PLAIN);
    expect(result.system).toBe("base prompt");
  });

  it("names only the groups that have a registered tool", async () => {
    const tools = [...PLAIN, ...CHECKLIST.tools].map((name) => ({ name }));
    const { system } = await run([new HumanMessage("hi")], tools);
    expect(system).toContain('"checklist"');
    expect(system).not.toContain('"iterate-component"');
  });

  it("never removes a tool outside the deferred groups", async () => {
    const { tools } = await run([new HumanMessage("hi")]);
    for (const name of PLAIN) expect(tools).toContain(name);
  });
});

describe("component-building tools and the thread's kind", () => {
  const THREAD = "44444444-4444-4444-8444-444444444444";

  /** A middleware whose thread read answers `metadata` (or `status`). */
  function withHost(answer: { metadata?: Record<string, unknown>; status?: number }) {
    const fetchImpl = jest.fn(async (_url: unknown, _init?: unknown): Promise<Response> =>
      new Response(JSON.stringify({ thread_id: THREAD, metadata: answer.metadata ?? {} }), {
        status: answer.status ?? 200,
      }),
    );
    const options: DeferredToolsOptions = {
      agentId: "agent-1",
      serverUrl: "http://127.0.0.1:2024",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    const middleware = createDeferredToolsMiddleware(
      DEFAULT_DEFERRED_TOOL_GROUPS,
      options,
    ) as unknown as Middleware;
    const go = (messages: BaseMessage[]) =>
      run(messages, ALL_TOOLS, "base prompt", { middleware, threadId: THREAD });
    return { go, fetchImpl };
  }

  it("never reveals them in a thread known not to be a self-task, and says where the work happens", async () => {
    const { go, fetchImpl } = withHost({ metadata: { channel: "dev" } });
    const { tools, system } = await go([
      new HumanMessage("build yourself a skill for this"),
      loadSkill("iterate-component"),
    ]);
    expect(tools).toEqual(PLAIN);
    expect(system).toContain(COMPONENT_WORK_IN_SELF_TASK);
    expect(system).toContain(
      "The component-building tools (create_component, prepare_component_version, run_component_contract, announce_component_version) are not available in this conversation.",
    );
    expect(system).not.toContain('with "iterate-component"');
    expect(system).toContain('the checklist tools with "checklist"');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:2024/threads/${THREAD}`);
    expect((init.headers as Record<string, string>)["X-SIA-Agent-Id"]).toBe("agent-1");
  });

  it("still withholds them after an earlier call names one of them", async () => {
    const { go } = withHost({ metadata: { self_task: false } });
    const { tools } = await go([
      new ToolMessage({ content: "{}", tool_call_id: "c", name: "create_component" }),
    ]);
    for (const name of COMPONENTS.tools) expect(tools).not.toContain(name);
  });

  it("reveals them on load_skill in a self-task opened by the preamble, without reading the thread", async () => {
    const { go, fetchImpl } = withHost({ metadata: {} });
    const opening = new HumanMessage(buildSelfTaskMessage("build a skill", "iterate-component"));
    const before = await go([opening]);
    const after = await go([opening, loadSkill("iterate-component")]);
    expect(before.tools).toEqual(PLAIN);
    expect(after.tools).toEqual([...PLAIN, ...COMPONENTS.tools]);
    expect(after.system).toBe(before.system);
    expect(after.system).toContain('with "iterate-component"');
    expect(after.system).not.toContain(COMPONENT_WORK_IN_SELF_TASK);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the thread once and remembers a self-task whose preamble was summarised away", async () => {
    const { go, fetchImpl } = withHost({ metadata: { self_task: true } });
    await go([new HumanMessage("summary of earlier work")]);
    const later = await go([new HumanMessage("summary"), loadSkill("iterate-component")]);
    expect(later.tools).toEqual([...PLAIN, ...COMPONENTS.tools]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the line fixed for the life of a non-self-task thread", async () => {
    const { go, fetchImpl } = withHost({ metadata: {} });
    const first = await go([new HumanMessage("hi")]);
    const second = await go([new HumanMessage("hi"), loadSkill("checklist")]);
    expect(second.system).toBe(first.system);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the reveal-on-load behaviour when the thread cannot be read", async () => {
    const { go } = withHost({ status: 404 });
    const { tools, system } = await go([loadSkill("iterate-component")]);
    expect(tools).toEqual([...PLAIN, ...COMPONENTS.tools]);
    expect(system).toContain('with "iterate-component"');
  });

  it("reads nothing when no component-building tool is registered", async () => {
    const { fetchImpl } = withHost({ metadata: {} });
    const middleware = createDeferredToolsMiddleware(DEFAULT_DEFERRED_TOOL_GROUPS, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      agentId: "a",
      serverUrl: "http://x",
    }) as unknown as Middleware;
    const tools = [...PLAIN, ...CHECKLIST.tools].map((name) => ({ name }));
    await run([new HumanMessage("hi")], tools, "base prompt", { middleware, threadId: THREAD });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("isGroupRevealed", () => {
  it("is false for an empty conversation", () => {
    expect(isGroupRevealed(CHECKLIST, [])).toBe(false);
  });

  it("ignores a load_skill call without a matching skill_name", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [{ id: "x", name: "load_skill", args: {} }],
    });
    expect(isGroupRevealed(CHECKLIST, [message])).toBe(false);
  });
});
