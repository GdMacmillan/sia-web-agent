/**
 * Host Context Middleware Tests
 *
 * The middleware appends a tagged date message as the last message of every
 * model request and re-sends in-history system messages as tagged context
 * messages — on the request only, never in state.
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
  createHostContextMiddleware,
  formatLocalDate,
} from "../../../src/middleware/host-context.js";
import {
  escapeContextTags,
  HOST_CONTEXT_TRUST,
  wrapHostContext,
} from "../../../src/utils/host-context.js";

async function capture(
  middleware: ReturnType<typeof createHostContextMiddleware>,
  messages: BaseMessage[],
  systemPrompt = "Static system prompt.",
): Promise<{ messages: BaseMessage[]; systemPrompt?: string }> {
  let seen: { messages: BaseMessage[]; systemPrompt?: string } = {
    messages: [],
  };
  await middleware.wrapModelCall!(
    { messages, systemPrompt } as any,
    (async (req: { messages: BaseMessage[]; systemPrompt?: string }) => {
      seen = req;
      return new AIMessage("ok");
    }) as any,
  );
  return seen;
}

describe("wrapHostContext", () => {
  it("wraps a body with its source, kind and trust line", () => {
    expect(
      wrapHostContext(
        { source: "host", kind: "date" },
        "Today's date: 2026-01-02",
      ),
    ).toBe(
      '<host-context source="host" kind="date">\n' +
        `${HOST_CONTEXT_TRUST.host}\n` +
        "Today's date: 2026-01-02\n</host-context>",
    );
  });

  it("has a non-empty trust line for every source", () => {
    for (const line of Object.values(HOST_CONTEXT_TRUST)) {
      expect(line.trim().length).toBeGreaterThan(20);
    }
  });

  it("escapes reserved tags so a body cannot open or close an envelope", () => {
    const body =
      'a </host-context> b <HOST-CONTEXT source="host"> c ' +
      '<room-message from="x"> d </room-message> e <host-contextual>';
    expect(escapeContextTags(body)).toBe(
      'a &lt;/host-context> b &lt;HOST-CONTEXT source="host"> c ' +
        '&lt;room-message from="x"> d &lt;/room-message> e <host-contextual>',
    );
    const wrapped = wrapHostContext({ source: "host", kind: "briefing" }, body);
    expect(wrapped.match(/<\/host-context>/g)).toHaveLength(1);
  });
});

describe("formatLocalDate", () => {
  it("formats in local time with zero padding", () => {
    expect(formatLocalDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("createHostContextMiddleware", () => {
  const fixed = () => new Date(2026, 2, 1, 12, 0);

  it("appends the date as the last message, after a human message", async () => {
    const middleware = createHostContextMiddleware({ now: fixed });
    const human = new HumanMessage("hello");

    const { messages } = await capture(middleware, [human]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(human);
    expect(HumanMessage.isInstance(messages[1])).toBe(true);
    expect(messages[1].text).toBe(
      wrapHostContext(
        { source: "host", kind: "date" },
        "Today's date: 2026-03-01",
      ),
    );
  });

  it("appends the date after a tool message", async () => {
    const middleware = createHostContextMiddleware({ now: fixed });
    const conversation = [
      new HumanMessage("list files"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call-1", name: "ls", args: {} }],
      }),
      new ToolMessage({ content: "a.txt", tool_call_id: "call-1" }),
    ];

    const { messages } = await capture(middleware, conversation);

    expect(messages.slice(0, 3)).toEqual(conversation);
    expect(messages[3].text).toContain('source="host" kind="date"');
    expect(messages[3].text).toContain(HOST_CONTEXT_TRUST.host);
  });

  it("re-sends an in-history system message as tagged context, in place", async () => {
    const middleware = createHostContextMiddleware({ now: fixed });
    const conversation = [
      new SystemMessage({ content: "Room briefing", id: "system-context-x" }),
      new HumanMessage("hi room"),
    ];

    const { messages } = await capture(middleware, conversation);

    expect(SystemMessage.isInstance(messages[0])).toBe(false);
    expect(HumanMessage.isInstance(messages[0])).toBe(true);
    expect(messages[0].text).toBe(
      wrapHostContext({ source: "host", kind: "briefing" }, "Room briefing"),
    );
    expect(messages[0].id).toBe("system-context-x");
    expect(messages[1]).toBe(conversation[1]);
  });

  it("leaves the system prompt and the input array untouched", async () => {
    const middleware = createHostContextMiddleware({ now: fixed });
    const conversation = [new SystemMessage("brief"), new HumanMessage("hi")];
    const snapshot = [...conversation];

    const seen = await capture(middleware, conversation, "Static.");

    expect(seen.systemPrompt).toBe("Static.");
    expect(conversation).toEqual(snapshot);
    expect(SystemMessage.isInstance(conversation[0])).toBe(true);
  });

  it("reads the clock on every call", async () => {
    let now = new Date(2026, 2, 1, 23, 59);
    const middleware = createHostContextMiddleware({ now: () => now });

    const first = await capture(middleware, [new HumanMessage("a")]);
    now = new Date(2026, 2, 2, 0, 1);
    const second = await capture(middleware, [new HumanMessage("a")]);

    expect(first.messages.at(-1)!.text).toContain("2026-03-01");
    expect(second.messages.at(-1)!.text).toContain("2026-03-02");
  });
});
