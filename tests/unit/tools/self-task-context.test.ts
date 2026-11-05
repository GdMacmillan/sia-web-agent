/**
 * The shared "component work happens in a self-task" sentence and the
 * self-task signal: the prompt and the skill quote the sentence, and a
 * thread's kind comes from its metadata, else its opening message.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  COMPONENT_WORK_IN_SELF_TASK,
  COMPONENT_WORK_IN_SELF_TASK_CLAUSE,
  isSelfTaskThread,
  opensAsSelfTask,
  readThreadMetadata,
} from "../../../src/tools/self-task-context.js";
import { buildSelfTaskMessage } from "../../../src/tools/self-task-tool.js";

const flatten = (text: string): string => text.replace(/\s+/g, " ");

describe("COMPONENT_WORK_IN_SELF_TASK", () => {
  it("names the tool and the skill to use", () => {
    expect(COMPONENT_WORK_IN_SELF_TASK.startsWith(COMPONENT_WORK_IN_SELF_TASK_CLAUSE)).toBe(true);
    expect(COMPONENT_WORK_IN_SELF_TASK).toContain("start_self_task");
    expect(COMPONENT_WORK_IN_SELF_TASK).toContain('"iterate-component"');
  });

  it.each([["prompts/manager.md"], ["skills/iterate-component/SKILL.md"]])(
    "%s says it in the same words",
    (file) => {
      const text = flatten(readFileSync(join(process.cwd(), file), "utf8"));
      expect(text).toContain(COMPONENT_WORK_IN_SELF_TASK_CLAUSE);
    },
  );
});

describe("readThreadMetadata", () => {
  const answer = (status: number, body: unknown) =>
    jest.fn(async (_url: unknown, _init?: unknown) => new Response(JSON.stringify(body), { status }));

  it("reads the thread from the agent's own server with the agent id", async () => {
    const fetchImpl = answer(200, { metadata: { self_task: true, channel: "dev" } });
    const metadata = await readThreadMetadata({
      threadId: "t/1",
      agentId: "agent-1",
      serverUrl: "http://127.0.0.1:2024/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(metadata).toEqual({ self_task: true, channel: "dev" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:2024/threads/t%2F1");
    expect((init.headers as Record<string, string>)["X-SIA-Agent-Id"]).toBe("agent-1");
  });

  it("is unknown with no thread id, a non-2xx answer, no metadata object, or a network error", async () => {
    const base = { agentId: "a", serverUrl: "http://x" };
    const never = jest.fn();
    expect(await readThreadMetadata({ ...base, threadId: undefined, fetchImpl: never as unknown as typeof fetch })).toBeUndefined();
    expect(never).not.toHaveBeenCalled();
    for (const fetchImpl of [
      answer(404, { metadata: { self_task: true } }),
      answer(200, { metadata: null }),
      answer(200, { metadata: ["x"] }),
      jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    ]) {
      expect(
        await readThreadMetadata({ ...base, threadId: "t", fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).toBeUndefined();
    }
  });
});

describe("isSelfTaskThread", () => {
  const opening = new HumanMessage(buildSelfTaskMessage("do it", "iterate-component"));

  it("takes the metadata as the authority when it is known", () => {
    expect(isSelfTaskThread({ self_task: true }, [])).toBe(true);
    expect(isSelfTaskThread({ self_task: "true" }, [opening])).toBe(false);
    expect(isSelfTaskThread({}, [opening])).toBe(false);
  });

  it("falls back to the preamble, else unknown", () => {
    expect(isSelfTaskThread(undefined, [new SystemMessage("briefing"), opening])).toBe(true);
    expect(isSelfTaskThread(undefined, [new HumanMessage("hi")])).toBeUndefined();
  });

  it("reads only the first person message, in string or block form", () => {
    expect(opensAsSelfTask([new HumanMessage("hi"), opening])).toBe(false);
    expect(opensAsSelfTask([new AIMessage("x"), new HumanMessage({ content: [{ type: "text", text: opening.text }] })])).toBe(true);
  });
});
