/**
 * Byte-stable system prompt, end to end through createDeepAgent.
 *
 * Drives the fully assembled main agent with a recording chat model across a
 * tool-call turn and a second invocation on the same thread a day later, and
 * checks that the system message the model receives never changes while the
 * changing context (date, skills list, an in-history system briefing) arrives
 * as ordinary tagged messages — on the request only, never in state.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";

// The summarization model is constructed from the provider config at
// assembly time; stub the client so no key is needed.
jest.mock("@langchain/openrouter", () => ({
  ChatOpenRouter: class {
    constructor(_options: unknown) {}
  },
}));

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "../../src/agent.js";
import { resetConfig } from "../../src/config/index.js";
import { getProjectRoot } from "../../src/utils/path-utils.js";

const DATE_TAG = '<host-context source="date">';
const SESSION_TAG = '<host-context source="session">';
const CONVERSATION_TAG = '<host-context source="conversation">';

/**
 * A chat model that records every request it receives and replays a script
 * of responses. `bindTools` returns the same instance so recording survives
 * the agent's tool binding.
 */
class RecordingChatModel extends BaseChatModel {
  calls: BaseMessage[][] = [];
  private turn = 0;

  constructor(private readonly script: Array<() => AIMessage>) {
    super({});
  }

  _llmType(): string {
    return "recording";
  }

  bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const next = this.script[Math.min(this.turn, this.script.length - 1)];
    this.turn++;
    const message = next();
    return { generations: [{ text: message.text, message }] };
  }
}

const ENV_KEYS = [
  "KNOWLEDGE_FORMATION_ENABLED",
  "OUTCOME_TRACKING_ENABLED",
  "MEMORY_AUGMENTATION_ENABLED",
  "SIA_MODEL_NAME",
  "SIA_MODEL_KNOWLEDGE_CUTOFF",
] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("system prompt stability across turns", () => {
  const model = new RecordingChatModel([
    () =>
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "write_todos",
            args: { todos: [{ content: "check", status: "pending" }] },
          },
        ],
      }),
    () => new AIMessage("first answer"),
    () => new AIMessage("second answer"),
  ]);
  let finalState: { messages: BaseMessage[] };

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.KNOWLEDGE_FORMATION_ENABLED = "false";
    process.env.OUTCOME_TRACKING_ENABLED = "false";
    process.env.MEMORY_AUGMENTATION_ENABLED = "false";
    delete process.env.SIA_MODEL_NAME;
    delete process.env.SIA_MODEL_KNOWLEDGE_CUTOFF;
    resetConfig();

    jest.useFakeTimers({
      now: new Date(2026, 2, 1, 23, 50),
      advanceTimers: true,
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });

    const agent = await createDeepAgent({
      model: model as any,
      tools: [],
      projectRoot: getProjectRoot(),
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "stable-prompt" } };

    await agent.invoke(
      { messages: [new HumanMessage("make a todo")] } as any,
      config,
    );

    jest.setSystemTime(new Date(2026, 2, 2, 0, 10));
    finalState = (await agent.invoke(
      {
        messages: [
          new SystemMessage({
            content: "You are in room #general with two peers.",
            id: "system-context-general",
          }),
          new HumanMessage("anything new?"),
        ],
      } as any,
      config,
    )) as unknown as { messages: BaseMessage[] };
  });

  afterAll(() => {
    jest.useRealTimers();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetConfig();
  });

  it("calls the model once per step: tool turn, answer, next-day answer", () => {
    expect(model.calls).toHaveLength(3);
  });

  it("sends byte-identical system message bytes on every call", () => {
    const systems = model.calls.map((messages) => {
      expect(SystemMessage.isInstance(messages[0])).toBe(true);
      return JSON.stringify(messages[0].content);
    });
    expect(new Set(systems).size).toBe(1);
  });

  it("keeps the date, the skills list and model guesses out of the system prompt", () => {
    const system = model.calls[0][0].text;
    expect(system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(system).not.toContain("Today's date");
    expect(system).not.toContain("**bash-usage**");
    expect(system).toContain("## Skills System");
    expect(system).not.toContain("Codex");
    expect(system).not.toContain("September 2024");
  });

  it("puts the skills list in a session message at the head", () => {
    for (const messages of model.calls) {
      expect(HumanMessage.isInstance(messages[1])).toBe(true);
      expect(messages[1].text.startsWith(SESSION_TAG)).toBe(true);
      expect(messages[1].text).toContain("**bash-usage**");
    }
    expect(model.calls[2][1].text).toBe(model.calls[0][1].text);
  });

  it("appends the date as the last message, after tool results too", () => {
    const [toolTurn, afterTool, nextDay] = model.calls;
    expect(toolTurn.at(-1)!.text).toBe(
      `${DATE_TAG}\nToday's date: 2026-03-01\n</host-context>`,
    );
    expect(afterTool.at(-2)!.getType()).toBe("tool");
    expect(afterTool.at(-1)!.text).toContain("2026-03-01");
    expect(nextDay.at(-1)!.text).toContain("Today's date: 2026-03-02");
  });

  it("re-sends an in-history system briefing as tagged context, in place", () => {
    const nextDay = model.calls[2];
    const systemsAfterHead = nextDay
      .slice(1)
      .filter((m) => SystemMessage.isInstance(m));
    expect(systemsAfterHead).toHaveLength(0);

    const briefing = nextDay.find((m) => m.text.startsWith(CONVERSATION_TAG));
    expect(briefing?.text).toContain("You are in room #general");
    const briefingIdx = nextDay.indexOf(briefing!);
    expect(nextDay[briefingIdx + 1].text).toBe("anything new?");
  });

  it("writes none of the request-only context into state", () => {
    const texts = finalState.messages.map((m) => m.text);
    expect(texts.some((t) => t.includes("<host-context"))).toBe(false);
    const briefing = finalState.messages.find(
      (m) => m.id === "system-context-general",
    );
    expect(briefing && SystemMessage.isInstance(briefing)).toBe(true);
  });
});
