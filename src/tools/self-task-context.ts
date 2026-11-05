/**
 * What every surface says about where component work happens, and how a
 * thread is told apart as a self-task.
 *
 * Building or changing one of the agent's own components is done in a
 * self-task, never in the conversation where the need was raised. The
 * manager prompt, the iterate-component skill, the deferred-tools line and
 * the component tools' refusals all say so, in the words of
 * {@link COMPONENT_WORK_IN_SELF_TASK}, so the agent hears one rule wherever
 * it looks, and a refusal repeats what it was already told rather than
 * steering on its own.
 *
 * A thread is a self-task when its metadata says `self_task: true` (set by
 * `start_self_task` when it creates the thread). When the metadata cannot
 * be read, the first person message opening with {@link SELF_TASK_PREAMBLE}
 * is the fallback.
 */
import type { BaseMessage } from "@langchain/core/messages";
import { resolveOwnServerUrl, SELF_TASK_PREAMBLE } from "./self-task-tool.js";

/**
 * The one sentence every surface uses for where component work happens.
 * `prompts/manager.md` and `skills/iterate-component/SKILL.md` quote
 * {@link COMPONENT_WORK_IN_SELF_TASK_CLAUSE} verbatim (a test pins it).
 */
export const COMPONENT_WORK_IN_SELF_TASK_CLAUSE =
  "Building or changing one of your own components (a tool, skill or prompt) " +
  "happens in a self-task, never in the conversation where the need was raised";

export const COMPONENT_WORK_IN_SELF_TASK =
  `${COMPONENT_WORK_IN_SELF_TASK_CLAUSE}: confirm the need once (an ` +
  "instruction is its own confirmation), then call start_self_task with skill " +
  '"iterate-component" and the need in the person\'s words.';

/** Longest a thread-metadata read may take before it counts as unknown. */
export const DEFAULT_THREAD_METADATA_TIMEOUT_MS = 5_000;

export interface ReadThreadMetadataInput {
  threadId: string | undefined;
  /** Sent as `X-SIA-Agent-Id`, which the server uses to attribute threads. */
  agentId: string;
  /** The agent's own server (default: {@link resolveOwnServerUrl}). */
  serverUrl?: string;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The current thread's metadata, read from the agent's own server, or
 * `undefined` when it is unknown: no thread id, a non-2xx answer, a body
 * without an object `metadata`, a timeout or a network error. Never throws.
 */
export async function readThreadMetadata(
  input: ReadThreadMetadataInput,
): Promise<Record<string, unknown> | undefined> {
  const { threadId } = input;
  if (threadId === undefined || threadId.length === 0) return undefined;
  const serverUrl = (
    input.serverUrl ?? resolveOwnServerUrl({ env: input.env, argv: input.argv })
  ).replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${serverUrl}/threads/${encodeURIComponent(threadId)}`, {
      method: "GET",
      headers: { "X-SIA-Agent-Id": input.agentId },
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_THREAD_METADATA_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const thread = (await res.json()) as { metadata?: unknown } | null;
    const metadata = thread?.metadata;
    return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

function messageType(message: BaseMessage): string | undefined {
  const m = message as { getType?: () => string; type?: unknown };
  if (typeof m.getType === "function") return m.getType();
  return typeof m.type === "string" ? m.type : undefined;
}

function textOf(message: BaseMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") return block;
      if (block !== null && typeof block === "object" && "text" in block) {
        const text = (block as { text: unknown }).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return "";
}

/** Whether the first person message in `messages` opens a self-task. */
export function opensAsSelfTask(messages: readonly BaseMessage[]): boolean {
  const first = messages.find((m) => messageType(m) === "human");
  return first !== undefined && textOf(first).trimStart().startsWith(SELF_TASK_PREAMBLE);
}

/**
 * Whether the thread is a self-task: `true` / `false` from its metadata
 * when that is known, else `true` when it opens with the self-task
 * preamble, else `undefined` (unknown).
 */
export function isSelfTaskThread(
  metadata: Record<string, unknown> | undefined,
  messages: readonly BaseMessage[] = [],
): boolean | undefined {
  if (metadata !== undefined) return metadata.self_task === true;
  return opensAsSelfTask(messages) ? true : undefined;
}
