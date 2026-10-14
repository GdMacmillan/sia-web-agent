/**
 * Tripwire: the agent can prepare, test and announce a version of its own
 * components, skills and prompts, but never decide one. Accepting,
 * rejecting, retiring and swapping are the keeper's, made on the host;
 * nothing the agent runs may reach them or move a `current` pointer.
 *
 * If one of these fails, a change gave the agent a way to approve its own
 * edit. Take the capability out rather than adjusting the test.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import path from "node:path";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { createComponentTools } from "../../../src/tools/component-tools.js";
import { createSelfTaskTool } from "../../../src/tools/self-task-tool.js";
import { _resetComponentsForTests } from "../../../src/components/registry.js";
import { _resetContentWarningsForTests } from "../../../src/components/content.js";
import { resetConfig } from "../../../src/config/loader.js";
import { clearAllowedPathRoots } from "../../../src/utils/path-utils.js";
import { GRAPH_MEMORY_VERB_SCHEMA_HASHES } from "../../../src/vendor/svc-rpc/graph-memory/schema-hash.js";
import * as knowledgeVerbs from "../../../src/vendor/svc-rpc/db/knowledge-hashes.js";
import {
  PASSING_CONTRACT,
  SERVICE_ENTRY,
  makeRoot,
  plainImport,
  removeRoot,
  writeComponent,
} from "./fixtures.js";
import { writeSeedPrompt, writeSeedSkill } from "./content-fixtures.js";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DECIDING_VERBS = [
  "accept",
  "approve",
  "swap",
  "activate",
  "retire",
  "reject",
  "decide",
];
const DECIDING = new RegExp(`(${DECIDING_VERBS.join("|")})`, "i");
/** Host routes that carry a keeper's decision or move a version. */
const DECISION_ROUTE =
  /\/components\/(swap|reject|retire)\b|\/decision\b|\/admin\//;

const THREAD = "55555555-5555-4555-8555-555555555555";
const config = { configurable: { thread_id: THREAD } };

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function recordingHost() {
  const urls: string[] = [];
  const fetchImpl = jest.fn(async (url: unknown): Promise<Response> => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/threads/")) {
      return new Response(
        JSON.stringify({ metadata: { channel: "dev", self_task: true } }),
        {
          status: 200,
        },
      );
    }
    return new Response("{}", {
      status: u.endsWith("/chat/component-version") ? 202 : 200,
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
}

describe("the agent cannot decide its own versions", () => {
  let project: string;
  let host: string;

  beforeEach(() => {
    _resetContentWarningsForTests();
    project = makeRoot("project-");
    const seed = path.join(project, "components");
    mkdirSync(seed);
    host = path.join(makeRoot("host-"), "components");
    mkdirSync(host);
    writeComponent(seed, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      currentFile: true,
      manifest: { intent: "Say hello.", lineage: { producedBy: "seed" } },
    });
    writeSeedSkill(project, "probe");
    writeSeedPrompt(project, "answer", "Answer the question asked.\n");
  });

  afterEach(() => {
    _resetComponentsForTests();
    clearAllowedPathRoots();
    resetConfig();
    removeRoot(project);
    removeRoot(path.dirname(host));
  });

  const allTools = (fetchImpl?: typeof fetch) => [
    ...createComponentTools({
      projectRoot: project,
      componentsDir: host,
      agentId: "agent-1",
      env: {},
      contract: { importModule: plainImport },
      daemonUrl: "http://127.0.0.1:7700",
      daemonToken: "daemon-token",
      serverUrl: "http://127.0.0.1:2024",
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    createSelfTaskTool({
      serverUrl: "http://127.0.0.1:2024",
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  ];

  it("offers no tool whose name decides a version", () => {
    for (const tool of allTools()) {
      expect(tool.name).not.toMatch(DECIDING);
    }
  });

  it("never tells the agent to decide a version itself", () => {
    const verbAtStart = new RegExp(`^(${DECIDING_VERBS.join("|")})`, "i");
    const youDecide = new RegExp(
      `\\byou (can |may |should |must )?(${DECIDING_VERBS.join("|")})`,
      "i",
    );
    for (const tool of allTools()) {
      for (const sentence of sentencesOf(tool.description)) {
        expect(sentence).not.toMatch(verbAtStart);
        expect(sentence).not.toMatch(youDecide);
      }
    }
  });

  it("takes no decision as a tool argument", () => {
    for (const tool of allTools()) {
      const schema = toJsonSchema(tool.schema as never) as {
        properties?: Record<string, unknown>;
      };
      for (const prop of Object.keys(schema.properties ?? {})) {
        expect(prop).not.toMatch(/decision|verdict|accept|approve|activate/i);
      }
    }
  });

  it("reaches no decision route and moves no current pointer across a full loop", async () => {
    const recorder = recordingHost();
    const tools = allTools(recorder.fetchImpl);
    const call = (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((t) => t.name === name);
      if (tool === undefined) throw new Error(`no tool ${name}`);
      return tool.invoke(args, config);
    };
    await call("describe_component", {});
    for (const name of ["skill-probe", "prompt-answer", "hello"]) {
      const prepared = String(
        await call("prepare_component_version", { name, need: "do better" }),
      );
      const version = /@(\d+\.\d+\.\d+) from/.exec(prepared)?.[1];
      expect(version).toBeDefined();
      if (name === "skill-probe") {
        appendFileSync(
          path.join(host, name, ".versions", String(version), "SKILL.md"),
          "A rule.\n",
        );
      }
      await call("run_component_contract", { name, version });
      await call("announce_component_version", {
        name,
        version,
        summary: "Better.",
      });
    }
    await call("create_component", {
      name: "skill-new",
      kind: "skill",
      intent: "Do a new thing.",
      need: "a new thing",
    });

    expect(
      recorder.urls.some((u) => u.endsWith("/chat/component-version")),
    ).toBe(true);
    for (const url of recorder.urls) {
      expect(url).not.toMatch(DECISION_ROUTE);
    }
    for (const name of ["skill-probe", "prompt-answer", "skill-new"]) {
      expect(existsSync(path.join(host, name, "current"))).toBe(false);
    }
    // A code component copied under the host root keeps the seed's
    // pointer at the seed version; the new version is never linked.
    const helloCurrent = path.join(host, "hello", "current");
    if (existsSync(helloCurrent)) {
      const target = lstatSync(helloCurrent).isSymbolicLink()
        ? readlinkSync(helloCurrent)
        : readFileSync(helloCurrent, "utf-8").trim();
      expect(target).not.toContain("0.1.1");
    }
  });

  it("has no source that names a decision route or the decision writer", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|js|mjs)$/.test(entry.name)) {
          const text = readFileSync(full, "utf-8");
          if (
            DECISION_ROUTE.test(text) ||
            /decideComponentVersion|decide_component_version|setComponentDecision/.test(
              text,
            )
          ) {
            offenders.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    expect(offenders).toEqual([]);
  });

  it("calls no host verb that records a decision", () => {
    const verbs = [
      ...Object.keys(GRAPH_MEMORY_VERB_SCHEMA_HASHES),
      ...Object.entries(knowledgeVerbs)
        .filter(
          ([key, value]) => key.endsWith("_VERB") && typeof value === "string",
        )
        .map(([, value]) => value as string),
    ];
    expect(verbs.length).toBeGreaterThan(0);
    for (const verb of verbs) {
      expect(verb).not.toMatch(/decision|decide|accept|approve|retire|swap/i);
    }
  });
});
