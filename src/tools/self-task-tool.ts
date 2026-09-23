/**
 * `start_self_task` — open a thread on the agent's own server and start a
 * run in it, so a piece of work can proceed in the background while the
 * conversation that raised it continues.
 *
 * The thread is created and driven over the server's own HTTP API (the
 * same routes any client uses). The run is started as a stream and read
 * to the end in the background: the server advances a run only while its
 * stream is being consumed, and persists the thread's state only once the
 * run finishes, so dropping the stream would freeze the run and leave an
 * empty thread. The tool returns as soon as the server has acknowledged
 * the run (its first stream event), never earlier.
 *
 * Guards, each reported as a result string with nothing sent:
 * - no agent id configured (`SIA_AGENT_ID`) — the thread would be
 *   unattributed and invisible to its owner;
 * - the current thread is itself a self-task — no nesting;
 * - a self-task started from this thread is still running — one at a time.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod/v4";
import { logger } from "../utils/logger.js";

/** Where the server listens when nothing says otherwise. */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:2024";
/** The graph the run is started against (falls back to the default graph). */
export const SELF_TASK_ASSISTANT_ID = "agent";
/** Longest a thread create / run start may take before it is reported as failed. */
export const DEFAULT_SELF_TASK_TIMEOUT_MS = 10_000;
/** How much of the task text is kept in the thread metadata. */
const METADATA_TASK_MAX = 500;
/** Header the server reads for thread attribution. */
const AGENT_ID_HEADER = "X-SIA-Agent-Id";

/** Error code the host answers (403) when it refuses to create a self-task. */
const SELF_TASK_NOT_PERMITTED = "self_task_not_permitted";

export interface ResolveOwnServerUrlInput {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
}

/**
 * The base URL of the server this agent runs inside: `SIA_SERVER_URL`,
 * else the `--port` the server was started with (`--port 2024`,
 * `--port=2024`, `-p 2024`), else the default.
 */
export function resolveOwnServerUrl(input: ResolveOwnServerUrlInput = {}): string {
  const env = input.env ?? process.env;
  const explicit = env.SIA_SERVER_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const argv = input.argv ?? process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === "--port" || arg === "-p") {
      value = argv[i + 1];
    } else if (arg.startsWith("--port=")) {
      value = arg.slice("--port=".length);
    }
    if (value !== undefined && /^\d{1,5}$/.test(value)) {
      return `http://127.0.0.1:${value}`;
    }
  }
  return DEFAULT_SERVER_URL;
}

export interface SelfTaskToolOptions {
  fetchImpl?: typeof fetch;
  /** Overrides the resolved own-server URL. */
  baseUrl?: string;
  /** Overrides `SIA_AGENT_ID`. */
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  timeoutMs?: number;
}

/**
 * Self-tasks in flight, keyed by the thread that started them. Set before
 * the first await so parallel calls in one turn collapse to one child.
 */
const activeChildren = new Map<string, string>();
const PENDING = "(starting)";

/** Test hook: forget every in-flight self-task. */
export function _resetSelfTaskStateForTests(): void {
  activeChildren.clear();
}

/** Test hook: the in-flight self-tasks, parent → child thread id. */
export function _activeSelfTasksForTests(): ReadonlyMap<string, string> {
  return activeChildren;
}

function threadIdFrom(config?: RunnableConfig): string | undefined {
  const threadId = config?.configurable?.thread_id;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (_error) {
    return {};
  }
}

interface SseEvent {
  event: string;
  data: string;
}

function parseSseBlock(block: string): SseEvent {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return { event, data: data.join("\n") };
}

/**
 * Read the stream until the first complete event, return it, and hand the
 * reader back positioned after it. Null when the stream ends first.
 */
async function readFirstEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<SseEvent | null> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value !== undefined) {
      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.search(/\r?\n\r?\n/);
      if (boundary !== -1) {
        return parseSseBlock(buffer.slice(0, boundary));
      }
    }
    if (done) {
      const rest = buffer.trim();
      return rest === "" ? null : parseSseBlock(rest);
    }
  }
}

/** Consume the rest of the stream to its end. Never throws. */
async function drainToEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  threadId: string,
): Promise<void> {
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
    logger.info({ threadId }, "self-task run finished");
  } catch (error: unknown) {
    logger.warn(
      { threadId, error: errorMessage(error) },
      "self-task stream ended early",
    );
  } finally {
    try {
      reader.releaseLock();
    } catch (_error) {
      // Nothing left to release.
    }
  }
}

function runIdFrom(event: SseEvent | null): string | undefined {
  if (event === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(event.data);
    const runId = (parsed as { run_id?: unknown } | null)?.run_id;
    return typeof runId === "string" ? runId : undefined;
  } catch (_error) {
    return undefined;
  }
}

/** The first message of the self-task thread. */
export function buildSelfTaskMessage(task: string, skill?: string): string {
  const trimmedSkill = skill?.trim();
  if (trimmedSkill) {
    return `Load the skill "${trimmedSkill}" with load_skill before anything else. Then: ${task}`;
  }
  return task;
}

/** Create the `start_self_task` tool. Every option is injectable for tests. */
export function createSelfTaskTool(
  opts: SelfTaskToolOptions = {},
): DynamicStructuredTool {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SELF_TASK_TIMEOUT_MS;

  return new DynamicStructuredTool({
    name: "start_self_task",
    description:
      "Start a piece of work in a new thread of your own, in the background, " +
      "and return immediately with the thread id. Use it for work that " +
      "should not happen inline in the current conversation (for example " +
      "iterating one of your components). The new thread starts from the " +
      "task text; pass `skill` to have it load that skill first. One " +
      "self-task per conversation at a time; a self-task cannot start another. " +
      "The host decides who may ask for one: by default only your owner, so " +
      "a request that came from someone else (or from no person at all) is " +
      "refused, and the result says why.",
    schema: z.object({
      task: z
        .string()
        .describe("What the new thread should do, in full — it starts with nothing else."),
      skill: z
        .string()
        .optional()
        .describe('A skill the new thread must load first (e.g. "iterate-component").'),
    }),
    func: async (
      { task, skill }: { task: string; skill?: string },
      _runManager?: unknown,
      config?: RunnableConfig,
    ): Promise<string> => {
      const agentId = (opts.agentId ?? env.SIA_AGENT_ID ?? "").trim();
      if (!agentId) {
        return "Cannot start a self-task: no agent id is configured (SIA_AGENT_ID), so the thread would have no owner.";
      }
      const trimmedTask = typeof task === "string" ? task.trim() : "";
      if (!trimmedTask) {
        return "Cannot start a self-task: the task is empty.";
      }

      const parentThreadId = threadIdFrom(config);
      const parentKey = parentThreadId ?? "(no thread)";
      const inFlight = activeChildren.get(parentKey);
      if (inFlight !== undefined) {
        return inFlight === PENDING
          ? "A self-task is already being started from this conversation; wait for it."
          : `A self-task started from this conversation is still running (thread ${inFlight}); wait for it to finish before starting another.`;
      }
      // Claimed synchronously: parallel calls in one turn see it immediately.
      activeChildren.set(parentKey, PENDING);

      const fetchImpl = opts.fetchImpl ?? fetch;
      const baseUrl = (
        opts.baseUrl ?? resolveOwnServerUrl({ env, argv: opts.argv })
      ).replace(/\/+$/, "");
      const headers = {
        "Content-Type": "application/json",
        [AGENT_ID_HEADER]: agentId,
      };

      try {
        let channel: string | undefined;
        if (parentThreadId !== undefined) {
          const res = await fetchImpl(
            `${baseUrl}/threads/${encodeURIComponent(parentThreadId)}`,
            { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) },
          );
          if (res.ok) {
            const parent = await readJson(res);
            const metadata =
              parent.metadata !== null && typeof parent.metadata === "object"
                ? (parent.metadata as Record<string, unknown>)
                : {};
            if (metadata.self_task === true) {
              return "This conversation is already a self-task; do the work here instead of starting a nested one.";
            }
            if (typeof metadata.channel === "string" && metadata.channel) {
              channel = metadata.channel;
            }
          } else if (res.status !== 404) {
            return `Cannot start a self-task: reading the current thread failed (${res.status}).`;
          }
        }

        const metadata: Record<string, unknown> = {
          self_task: true,
          type: "self_task",
          agent_id: agentId,
          sia_agent_id: agentId,
          task: trimmedTask.slice(0, METADATA_TASK_MAX),
        };
        if (parentThreadId !== undefined) metadata.parent_thread_id = parentThreadId;
        if (channel !== undefined) metadata.channel = channel;
        const trimmedSkill = skill?.trim();
        if (trimmedSkill) metadata.skill = trimmedSkill;

        const created = await fetchImpl(`${baseUrl}/threads`, {
          method: "POST",
          headers,
          body: JSON.stringify({ metadata }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (created.status === 403) {
          const refusal = await readJson(created);
          if (refusal.error === SELF_TASK_NOT_PERMITTED) {
            const reason =
              typeof refusal.reason === "string" && refusal.reason.trim()
                ? refusal.reason.trim()
                : "the person who asked is not allowed to";
            return (
              `Not started: the host refused this self-task (${reason}). ` +
              "Nothing was created. You can tell whoever asked, and pass the idea " +
              "along to someone who can start it."
            );
          }
        }
        if (!created.ok) {
          return `Cannot start a self-task: creating the thread failed (${created.status}).`;
        }
        const thread = await readJson(created);
        const threadId = thread.thread_id;
        if (typeof threadId !== "string" || !threadId) {
          return "Cannot start a self-task: the server returned no thread id.";
        }

        // The timer bounds only the start of the run (headers plus the
        // first event); it is cleared before the background read begins,
        // which must never be cut short.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        let started: Response;
        try {
          started = await fetchImpl(
            `${baseUrl}/threads/${encodeURIComponent(threadId)}/runs/stream`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                assistant_id: SELF_TASK_ASSISTANT_ID,
                input: {
                  messages: [
                    { role: "user", content: buildSelfTaskMessage(trimmedTask, skill) },
                  ],
                },
                config: { configurable: { thread_id: threadId } },
                stream_mode: ["updates"],
              }),
              signal: controller.signal,
            },
          );
          if (!started.ok) {
            return `Started thread ${threadId} but the run failed to start (${started.status}).`;
          }
          if (started.body === null) {
            return `Started thread ${threadId} but the server sent no run stream.`;
          }
          const reader = started.body.getReader();
          const first = await readFirstEvent(reader);
          if (first === null) {
            return `Started thread ${threadId} but the run stream ended before the run was acknowledged.`;
          }
          clearTimeout(timer);
          activeChildren.set(parentKey, threadId);
          void drainToEnd(reader, threadId).finally(() => {
            if (activeChildren.get(parentKey) === threadId) {
              activeChildren.delete(parentKey);
            }
          });
          const runId = runIdFrom(first);
          return (
            `Started self-task thread ${threadId}` +
            (runId ? ` (run ${runId}).` : ".") +
            " It runs in the background; the thread is visible on the thread list."
          );
        } finally {
          clearTimeout(timer);
        }
      } catch (error: unknown) {
        return `Cannot start a self-task: ${errorMessage(error)}`;
      } finally {
        if (activeChildren.get(parentKey) === PENDING) {
          activeChildren.delete(parentKey);
        }
      }
    },
  });
}
