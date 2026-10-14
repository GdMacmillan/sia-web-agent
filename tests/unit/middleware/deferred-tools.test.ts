/**
 * Deferred tool groups: hidden from the advertised list until the
 * conversation reveals them, never blocked from executing, and announced by
 * one system line that does not change when a group is revealed.
 */
import { describe, it, expect } from "@jest/globals";
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
} from "../../../src/middleware/deferred-tools.js";

type Tool = { name: string };
type Request = {
  tools: Tool[];
  messages: BaseMessage[];
  systemMessage: SystemMessage;
  systemPrompt: string;
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
): Promise<{ tools: string[]; system: string }> {
  const middleware = createDeferredToolsMiddleware() as unknown as {
    name: string;
    wrapModelCall: (
      request: Request,
      handler: (request: Request) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  let seen: Request | undefined;
  await middleware.wrapModelCall(
    {
      tools,
      messages,
      systemMessage: new SystemMessage(system),
      systemPrompt: system,
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
