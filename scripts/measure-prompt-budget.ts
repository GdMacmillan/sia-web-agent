/**
 * Measure the per-turn prompt: every tool definition and the system message
 * exactly as the first model call of a fresh thread receives them.
 *
 * Builds the real agent (`createDeepAgentWithDefaults`) around a recording
 * chat model that never calls a provider, sends one message, and reports what
 * that model was handed. No network, no API key, no cost.
 *
 * Usage:
 *   yarn measure:prompt              # table
 *   yarn measure:prompt --json       # machine-readable
 *   yarn measure:prompt --check      # exit 1 when anything is over budget
 *   yarn measure:prompt --no-web     # measure without the web tools
 *   yarn measure:prompt --keep-env   # use the real environment as-is
 *   yarn measure:prompt --model <id> # orchestrator model (selects the profile)
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (!flag("--keep-env")) {
  // Hermetic: fake credentials so every key-gated tool registers, and no
  // host endpoints so nothing is fetched or contacted.
  process.env.LLM_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "measure-prompt-budget";
  process.env.OPENROUTER_MODEL =
    option("--model") ?? "anthropic/claude-sonnet-4-6";
  if (flag("--no-web")) {
    delete process.env.TAVILY_API_KEY;
  } else {
    process.env.TAVILY_API_KEY = "measure-prompt-budget";
  }
  for (const name of [
    "SIA_SERVERS_FILE",
    "SIA_COMPONENTS_DIR",
    "SIA_DAEMON_URL",
    "SIA_DAEMON_TOKEN",
  ]) {
    delete process.env[name];
  }
}
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";

const { BaseChatModel } =
  await import("@langchain/core/language_models/chat_models");
const { AIMessage, HumanMessage, SystemMessage } =
  await import("@langchain/core/messages");
const { createDeepAgentWithDefaults, collectToolPool } =
  await import("../src/deep-agent-setup.js");
const { measureTools, approxTokens, TOTAL_TOOL_BUDGET } =
  await import("../src/tools/tool-budget.js");
const { getProjectRoot } = await import("../src/backend-config.js");
const { getSystemPrompt } = await import("../src/system-prompts.js");
const { resolveHarnessProfile } = await import("../src/profiles/index.js");
const { getConfig, resolveModelEndpoint } =
  await import("../src/config/index.js");

type AnyTool = { name: string } & Record<string, unknown>;
interface Capture {
  tools: AnyTool[];
  system: string;
}

/** Flatten a message's content (string or content blocks) to its text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "string"
          ? block
          : typeof (block as { text?: unknown })?.text === "string"
            ? (block as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}

const captures: Capture[] = [];

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
  async _generate(
    messages: Array<{ content: unknown; _getType?: () => string }>,
  ) {
    const system = messages.find(
      (message) => message._getType?.() === "system",
    );
    captures.push({
      tools: this.boundTools,
      system: system ? textOf(system.content) : "",
    });
    const message = new AIMessage("ok");
    return { generations: [{ message, text: "ok" }] };
  }
}

const model = new RecordingChatModel({});
const agent = await createDeepAgentWithDefaults({
  model: model as unknown as never,
});
await agent.invoke(
  { messages: [new HumanMessage("hi")] },
  { configurable: { thread_id: "measure-prompt-budget" } },
);

const first = captures[0];
if (!first) {
  console.error("measure-prompt-budget: the model was never called");
  process.exit(2);
}

// --- tools -----------------------------------------------------------------
const advertised = measureTools(first.tools);
const pool = collectToolPool(agent);
const poolMeasured = measureTools(pool as unknown as AnyTool[]);
const advertisedNames = new Set(advertised.tools.map((row) => row.name));
const deferred = poolMeasured.tools.filter(
  (row) => !advertisedNames.has(row.name),
);
const poolNames = new Set(poolMeasured.tools.map((row) => row.name));
const unknown = advertised.tools.filter((row) => !poolNames.has(row.name));
const poolOver = poolMeasured.over;

// Which middleware contributes each tool (plain tools have none).
const middlewareOf = new Map<string, string>();
const options = (agent as unknown as { options?: { middleware?: unknown[] } })
  .options;
for (const entry of options?.middleware ?? []) {
  const mw = entry as { name?: string; tools?: Array<{ name?: string }> };
  for (const tool of mw.tools ?? []) {
    if (tool?.name && mw.name) middlewareOf.set(tool.name, mw.name);
  }
}

// --- system prompt -----------------------------------------------------------
const projectRoot = getProjectRoot();
const system = first.system;
const managerRaw = readFileSync(
  path.join(projectRoot, "prompts", "manager.md"),
  "utf8",
);
const sharedRaw = readFileSync(
  path.join(projectRoot, "prompts", "shared.md"),
  "utf8",
);
const basePrompt = await getSystemPrompt("manager");
const orchestrator = resolveModelEndpoint(
  getConfig().llm,
  "orchestrator",
).model;
const profile = resolveHarnessProfile(
  orchestrator,
  getConfig().runtime.harnessProfile,
);
const suffix = profile.systemPromptSuffix ?? "";

interface SystemPart {
  part: string;
  chars: number;
}
const parts: SystemPart[] = [];
let attributed = 0;
const add = (part: string, chars: number): void => {
  parts.push({ part, chars });
  attributed += chars;
};
if (system.includes(basePrompt)) {
  add("prompts/manager.md", managerRaw.length);
  add("prompts/shared.md", sharedRaw.length);
  add(
    "environment block",
    basePrompt.length - managerRaw.length - sharedRaw.length,
  );
}
if (suffix && system.includes(suffix)) {
  add(`profile suffix (${orchestrator})`, suffix.length);
}

// Probe each middleware's model-call hook against an empty system message to
// see what it adds. Hooks that need live state just fail the probe.
for (const entry of options?.middleware ?? []) {
  const mw = entry as {
    name?: string;
    wrapModelCall?: (request: unknown, handler: unknown) => unknown;
  };
  if (typeof mw.wrapModelCall !== "function") continue;
  let seen = "";
  try {
    await mw.wrapModelCall(
      {
        model,
        messages: [new HumanMessage("hi")],
        systemMessage: new SystemMessage(""),
        systemPrompt: "",
        // The full pool, so a hook whose text depends on which tools are
        // registered (the deferred-groups line) shows what it adds.
        tools: pool,
        state: { messages: [new HumanMessage("hi")] },
        runtime: { context: {}, configurable: {} },
      },
      async (request: {
        systemMessage?: { content: unknown };
        systemPrompt?: string;
      }) => {
        const fromMessage = textOf(request.systemMessage?.content);
        seen =
          (request.systemPrompt ?? "").length > fromMessage.length
            ? (request.systemPrompt ?? "")
            : fromMessage;
        return new AIMessage("ok");
      },
    );
  } catch {
    continue;
  }
  if (seen.trim().length > 0 && system.includes(seen.trim())) {
    add(`middleware ${mw.name}`, seen.length);
  }
}
add("(unattributed)", system.length - attributed);

// --- report ------------------------------------------------------------------
const promptTotal = system.length + advertised.totalChars;
const share = promptTotal > 0 ? advertised.totalChars / promptTotal : 0;
const overall = {
  tools: {
    count: advertised.tools.length,
    chars: advertised.totalChars,
    tokens: advertised.totalTokens,
    budget: TOTAL_TOOL_BUDGET,
    overBudget: advertised.totalChars > TOTAL_TOOL_BUDGET,
  },
  deferredTools: {
    count: deferred.length,
    chars: deferred.reduce((sum, row) => sum + row.chars, 0),
    names: deferred.map((row) => row.name),
  },
  fullPool: {
    count: poolMeasured.tools.length,
    chars: poolMeasured.totalChars,
    tokens: poolMeasured.totalTokens,
  },
  system: { chars: system.length, tokens: approxTokens(system.length) },
  toolsShareOfPrompt: Number((share * 100).toFixed(1)),
};

const failures: string[] = [];
if (overall.tools.overBudget) {
  failures.push(
    `advertised tools total ${advertised.totalChars} > ${TOTAL_TOOL_BUDGET}`,
  );
}
for (const row of poolOver) {
  failures.push(`${row.name} ${row.chars} > ${row.budget}`);
}
if (unknown.length > 0) {
  failures.push(
    `advertised but not in the tool pool: ${unknown.map((r) => r.name).join(", ")}`,
  );
}

if (flag("--json")) {
  console.log(
    JSON.stringify(
      {
        ...overall,
        perTool: poolMeasured.tools.map((row) => ({
          ...row,
          advertised: advertisedNames.has(row.name),
          source: middlewareOf.get(row.name) ?? "tools",
        })),
        systemParts: parts,
        failures,
      },
      null,
      2,
    ),
  );
} else {
  const pad = (value: string | number, width: number, left = false): string =>
    left ? String(value).padEnd(width) : String(value).padStart(width);
  console.log(
    `${pad("tool", 28, true)} ${pad("chars", 6)} ${pad("~tok", 5)} ${pad("budget", 6)}  ${pad("status", 8, true)} source`,
  );
  for (const row of poolMeasured.tools) {
    const status = row.overBudget
      ? "OVER"
      : advertisedNames.has(row.name)
        ? "ok"
        : "deferred";
    console.log(
      `${pad(row.name, 28, true)} ${pad(row.chars, 6)} ${pad(row.tokens, 5)} ${pad(row.budget, 6)}  ${pad(status, 8, true)} ${middlewareOf.get(row.name) ?? "tools"}`,
    );
  }
  console.log("");
  console.log(
    `advertised tools: ${overall.tools.count}  ${overall.tools.chars} chars  ~${overall.tools.tokens} tokens  (budget ${TOTAL_TOOL_BUDGET})`,
  );
  console.log(
    `deferred tools:   ${overall.deferredTools.count}  ${overall.deferredTools.chars} chars`,
  );
  console.log(
    `full tool pool:   ${overall.fullPool.count}  ${overall.fullPool.chars} chars  ~${overall.fullPool.tokens} tokens`,
  );
  console.log("");
  console.log(
    `system message:   ${system.length} chars  ~${overall.system.tokens} tokens`,
  );
  for (const part of parts) {
    console.log(`  ${pad(part.part, 44, true)} ${pad(part.chars, 6)}`);
  }
  console.log("");
  console.log(`tools share of per-turn prompt: ${overall.toolsShareOfPrompt}%`);
  if (failures.length > 0) {
    console.log("");
    console.log("over budget:");
    for (const failure of failures) console.log(`  ${failure}`);
  }
}

process.exit(flag("--check") && failures.length > 0 ? 1 : 0);
