/**
 * The first version of a brand-new component: the scaffolded stub is a
 * runnable tool with a contract that calls it, so `planNewComponent`
 * followed by `runComponentContract` passes before the author changes a
 * line — the no-host end-to-end for creating a component.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import { planNewComponent } from "../../../src/components/authoring.js";
import { runComponentContract } from "../../../src/components/contract.js";
import { parseComponentManifest } from "../../../src/components/manifest.js";
import {
  _resetComponentsForTests,
  setActiveComponents,
} from "../../../src/components/registry.js";
import {
  NEW_COMPONENT_VERSION,
  TOOL_NAME_PATTERN,
  defaultToolName,
  newComponentManifest,
  stubContractSource,
  stubEntrySource,
} from "../../../src/components/scaffold.js";
import { SDK_VERSION } from "../../../src/components/sdk.js";
import { resetConfig } from "../../../src/config/loader.js";
import { clearAllowedPathRoots } from "../../../src/utils/path-utils.js";
import { makeRoot, plainImport, removeRoot } from "./fixtures.js";

const CONFIG = { agentId: "agent-1", agentName: "Agent One", projectRoot: "/tmp/project" };

describe("scaffold sources", () => {
  it("derives the tool name from the component name", () => {
    expect(defaultToolName("parse-time-expression")).toBe("parse_time_expression");
    expect(defaultToolName("echo")).toBe("echo");
    expect(TOOL_NAME_PATTERN.test("parse_time_expression")).toBe(true);
    expect(TOOL_NAME_PATTERN.test("Parse-Time")).toBe(false);
    expect(TOOL_NAME_PATTERN.test("")).toBe(false);
  });

  it("names the tool in the entry and the contract, and escapes the description", () => {
    const entry = stubEntrySource("when_is", 'Resolve "soon" to a time.');
    expect(entry).toContain('name: "when_is"');
    expect(entry).toContain(JSON.stringify('Resolve "soon" to a time.'));
    expect(entry).not.toMatch(/^\s*import /m);
    const contract = stubContractSource("when_is");
    expect(contract).toContain('deps.invoke("when_is"');
    expect(contract).not.toMatch(/^\s*import /m);
  });

  it("types deps.host in the entry and the contract and says the credential stays with the host", () => {
    const entry = stubEntrySource("when_is", "x");
    expect(entry).toMatch(/host: \{\n\s+fetch: \(upstream: string, path: string, init\?: RequestInit\) => Promise<Response>;/);
    expect(entry).toContain("upstreams: () => Promise<Array<{ name: string; host: string }> | undefined>;");
    expect(entry).toContain("Call an authenticated API through the host by upstream name; the\n   * credential never enters this process.");
    const contract = stubContractSource("when_is");
    expect(contract).toContain("fetch: (upstream: string, path: string, init?: RequestInit) => Promise<Response>;");
  });

  it("builds a strict, parentless manifest for 0.1.0", () => {
    const raw = newComponentManifest({
      name: "parse-time-expression",
      intent: "Turn phrases into timestamps.",
      need: "what is 4 days from now",
      producedBy: "agent-1",
    });
    const parsed = parseComponentManifest(raw, {
      dirName: "parse-time-expression",
      versionDirName: NEW_COMPONENT_VERSION,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest).toMatchObject({
      name: "parse-time-expression",
      version: "0.1.0",
      kind: "tools",
      depth: 0,
      lineage: { need: "what is 4 days from now", producedBy: "agent-1" },
    });
    expect(parsed.manifest.lineage.parent).toBeUndefined();
    expect(semver.satisfies(SDK_VERSION, parsed.manifest.sdk)).toBe(true);
  });

  it("honors an explicit version and still writes no parent — re-creating over a removed component starts fresh", () => {
    const raw = newComponentManifest({
      name: "waiting",
      intent: "Turn phrases into timestamps.",
      need: "what is 4 days from now",
      producedBy: "agent-1",
      version: "0.2.0",
    });
    const parsed = parseComponentManifest(raw, {
      dirName: "waiting",
      versionDirName: "0.2.0",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.version).toBe("0.2.0");
    expect(parsed.manifest.lineage.parent).toBeUndefined();
  });
});

describe("a new component's stub passes its own contract", () => {
  let host: string;

  beforeEach(() => {
    host = makeRoot("host-");
  });

  afterEach(() => {
    _resetComponentsForTests();
    clearAllowedPathRoots();
    resetConfig();
    removeRoot(host);
  });

  it("round-trips planNewComponent → runComponentContract on 0.1.0 with no current", async () => {
    const planned = planNewComponent({
      name: "parse-time-expression",
      roots: [host],
      authoringRoot: host,
      intent: "Turn phrases like '4 days from now' into ISO 8601 timestamps.",
      need: "what is 4 days from now",
      producedBy: "agent-1",
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.version).toBe("0.1.0");
    expect(existsSync(path.join(host, "parse-time-expression", "current"))).toBe(false);

    setActiveComponents({ components: [], roots: [host] });
    const result = await runComponentContract("parse-time-expression", {
      version: "0.1.0",
      importModule: plainImport,
      config: CONFIG,
    });
    expect(result).toMatchObject({ ok: true, version: "0.1.0" });
    expect(result.loaded?.entry.file).toBe("entry.ts");
    expect(result.loaded?.contract.file).toBe("contract.ts");
  });

  it("fails the contract once the stub stops echoing — the contract proves the tool", async () => {
    const planned = planNewComponent({
      name: "parse-time-expression",
      roots: [host],
      authoringRoot: host,
      intent: "Turn phrases into timestamps.",
      need: "what is 4 days from now",
      producedBy: "agent-1",
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const entry = readFileSync(planned.plan.entryPath, "utf-8");
    expect(entry).toContain("echo");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      planned.plan.entryPath,
      entry.replace(/return JSON\.stringify\(\{[^}]*\}\);/, 'return "nothing";'),
    );

    setActiveComponents({ components: [], roots: [host] });
    const result = await runComponentContract("parse-time-expression", {
      version: "0.1.0",
      importModule: plainImport,
      config: CONFIG,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/parse_time_expression did not echo/);
  });
});
