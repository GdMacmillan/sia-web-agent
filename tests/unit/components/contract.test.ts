/**
 * Contract runner: pass/fail/timeout, target resolution, the `version`
 * option, `invoke` routing, and the never-throw guarantee. Entries and
 * contracts are real on-disk `.ts` modules loaded through the plain importer.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { tool } from "langchain";
import { z } from "zod/v4";
import { runComponentContract } from "../../../src/components/contract.js";
import {
  _resetComponentsForTests,
  setActiveComponents,
  setActiveToolPool,
} from "../../../src/components/registry.js";
import { SDK_VERSION } from "../../../src/components/sdk.js";
import { resetConfig } from "../../../src/config/loader.js";
import { clearAllowedPathRoots } from "../../../src/utils/path-utils.js";
import {
  FAILING_CONTRACT,
  HANGING_CONTRACT,
  PASSING_CONTRACT,
  SERVICE_ENTRY,
  TOOLS_ENTRY,
  makeRoot,
  plainImport,
  removeRoot,
  writeComponent,
} from "./fixtures.js";

const CONFIG = { agentId: "a", agentName: "A", projectRoot: "/tmp/project" };

describe("runComponentContract", () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
    setActiveComponents({ components: [], roots: [root] });
  });

  afterEach(() => {
    _resetComponentsForTests();
    clearAllowedPathRoots();
    removeRoot(root);
  });

  const run = (name: string, opts: Record<string, unknown> = {}) =>
    runComponentContract(name, {
      importModule: plainImport,
      config: CONFIG,
      ...opts,
    });

  it("passes a contract that returns", async () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
    });
    const result = await run("hello");
    expect(result).toMatchObject({
      ok: true,
      version: "0.1.0",
      sdkVersion: SDK_VERSION,
    });
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fails a contract that throws, with its message", async () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: FAILING_CONTRACT,
    });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    expect(result.version).toBe("0.1.0");
    expect(result.error).toMatch(/deliberately failed/);
  });

  it("fails a contract that exceeds the timeout", async () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: HANGING_CONTRACT,
    });
    const result = await run("hello", { timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out after 20 ms/);
  });

  it("fails when there is no contract file", async () => {
    writeComponent(root, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no contract file/);
  });

  it("fails on a contract with no default export", async () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: "export const nothing = 1;",
    });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/contract has no default export/);
  });

  it("fails on an entry with no default export", async () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: "export const nothing = 1;",
      contract: PASSING_CONTRACT,
    });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/entry has no default export/);
  });

  it("fails for an unknown component name", async () => {
    const result = await run("nope");
    expect(result).toMatchObject({ ok: false, version: null });
    expect(result.error).toMatch(/unknown component "nope"/);
  });

  it("fails for an invalid component name", async () => {
    const result = await run("Not Valid");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid component name/);
  });

  it("fails when the component has no current pointer", async () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      current: false,
    });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no "current" pointer/);
  });

  it("fails when current is dangling", async () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      currentTarget: ".versions/9.9.9",
    });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dangling/);
  });

  it("fails on an SDK range mismatch", async () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      manifest: { sdk: "^2.0.0" },
    });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    expect(result.version).toBe("0.1.0");
    expect(result.error).toContain(SDK_VERSION);
  });

  it("fails when no component roots are present", async () => {
    _resetComponentsForTests();
    const result = await runComponentContract("hello", {
      importModule: plainImport,
      config: CONFIG,
    });
    expect(result.ok).toBe(false);
  });

  describe("version option", () => {
    it("targets a version that is not current", async () => {
      writeComponent(root, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        contract: PASSING_CONTRACT,
      });
      writeComponent(root, "hello", "0.2.0", {
        entry: SERVICE_ENTRY,
        contract: FAILING_CONTRACT,
        current: false,
      });
      const current = await run("hello");
      expect(current).toMatchObject({ ok: true, version: "0.1.0" });
      const candidate = await run("hello", { version: "0.2.0" });
      expect(candidate).toMatchObject({ ok: false, version: "0.2.0" });
      expect(candidate.error).toMatch(/deliberately failed/);
    });

    it("fails for a version that does not exist", async () => {
      writeComponent(root, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        contract: PASSING_CONTRACT,
      });
      const result = await run("hello", { version: "3.0.0" });
      expect(result).toMatchObject({ ok: false, version: null });
      expect(result.error).toMatch(/version "3.0.0" of "hello" not found/);
    });

    it("fails for an invalid version string", async () => {
      writeComponent(root, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        contract: PASSING_CONTRACT,
      });
      const result = await run("hello", { version: "../../etc" });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/invalid version/);
    });

    it("works without a current pointer at all", async () => {
      writeComponent(root, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        contract: PASSING_CONTRACT,
        current: false,
      });
      const result = await run("hello", { version: "0.1.0" });
      expect(result).toMatchObject({ ok: true, version: "0.1.0" });
    });
  });

  describe("roots", () => {
    it("searches a host-managed root that appeared after assembly", async () => {
      // The active set recorded only `root`; a host root configured later
      // (and created after assembly) carries the candidate version.
      writeComponent(root, "hello", "0.1.0", {
        entry: SERVICE_ENTRY,
        contract: PASSING_CONTRACT,
      });
      const host = makeRoot("host-");
      const previous = process.env.SIA_COMPONENTS_DIR;
      process.env.SIA_COMPONENTS_DIR = host;
      resetConfig();
      try {
        writeComponent(host, "hello", "0.1.0", {
          entry: SERVICE_ENTRY,
          contract: PASSING_CONTRACT,
          currentFile: true,
        });
        writeComponent(host, "hello", "0.1.1", {
          entry: SERVICE_ENTRY,
          contract: FAILING_CONTRACT,
          current: false,
        });
        const candidate = await run("hello", { version: "0.1.1" });
        expect(candidate).toMatchObject({ ok: false, version: "0.1.1" });
        expect(candidate.error).toMatch(/deliberately failed/);
      } finally {
        if (previous === undefined) delete process.env.SIA_COMPONENTS_DIR;
        else process.env.SIA_COMPONENTS_DIR = previous;
        resetConfig();
        removeRoot(host);
      }
    });
  });

  describe("invoke", () => {
    const INVOKE_CONTRACT = `
export default async function (deps: any) {
  const scratch = await deps.invoke("component_echo", { text: "hi" });
  if (!/^echo:hi:contract-hello-[0-9a-f-]{36}$/.test(scratch)) {
    throw new Error("unexpected scratch-thread result: " + scratch);
  }
  const pinned = await deps.invoke("component_echo", { text: "yo" }, { threadId: "t1" });
  if (pinned !== "echo:yo:t1") throw new Error("unexpected pinned result: " + pinned);
  const pooled = await deps.invoke("pool_tool", {});
  if (pooled !== "flat") throw new Error("unexpected pool result: " + pooled);
}
`;

    it("routes to the component's own tools and the active pool, flattening results", async () => {
      const poolTool = tool(async () => ({ content: "flat" }) as unknown as string, {
        name: "pool_tool",
        description: "Returns a message-shaped object.",
        schema: z.object({}),
      });
      setActiveToolPool([poolTool]);
      writeComponent(root, "hello", "0.1.0", {
        entry: TOOLS_ENTRY,
        contract: INVOKE_CONTRACT,
        manifest: { kind: "tools" },
      });
      const result = await run("hello");
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
    });

    it("reports an unknown tool with the available names", async () => {
      writeComponent(root, "hello", "0.1.0", {
        entry: TOOLS_ENTRY,
        contract: `export default async (deps: any) => { await deps.invoke("nope", {}); }`,
        manifest: { kind: "tools" },
      });
      const result = await run("hello");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/unknown tool "nope"; available: component_echo/);
    });

    it("exposes a middleware component's tools to invoke", async () => {
      const MW_ENTRY = `
export default function (deps: any) {
  const t = deps.tool(async () => "from-middleware", {
    name: "mw_tool",
    description: "x",
    schema: deps.z.object({}),
  });
  return deps.createMiddleware({ name: "novelMiddleware", tools: [t] });
}
`;
      writeComponent(root, "hello", "0.1.0", {
        entry: MW_ENTRY,
        contract: `export default async (deps: any) => {
  const r = await deps.invoke("mw_tool", {});
  if (r !== "from-middleware") throw new Error("got " + r);
}`,
        manifest: { kind: "middleware" },
      });
      const result = await run("hello");
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
    });
  });

  it("hands the contract the component value and the dependency bundle", async () => {
    writeComponent(root, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: `export default async (deps: any) => {
  if (deps.component.name !== "hello") throw new Error("component missing");
  if (deps.sdkVersion !== "${SDK_VERSION}") throw new Error("sdk missing");
  if (deps.manifest.version !== "0.1.0") throw new Error("manifest missing");
  if (deps.config.agentId !== "a") throw new Error("config missing");
  if (typeof deps.invoke !== "function") throw new Error("invoke missing");
}`,
    });
    const result = await run("hello");
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
