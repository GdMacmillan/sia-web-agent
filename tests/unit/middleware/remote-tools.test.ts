/**
 * Remote tools: the servers file reader, the client lifecycle, and the
 * middleware that advertises and routes `mcp__<server>__<tool>` tools.
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
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolMessage } from "langchain";

// ---------------------------------------------------------------------------
// A fake MultiServerMCPClient: records every construction and close, and
// serves the tools listed in `serverTools` for the servers it was given.
// ---------------------------------------------------------------------------

interface FakeClient {
  config: { mcpServers: Record<string, Record<string, unknown>> } & Record<
    string,
    unknown
  >;
  closed: boolean;
}

const fake: {
  clients: FakeClient[];
  serverTools: Record<string, string[]>;
  getToolsError: Error | null;
} = { clients: [], serverTools: {}, getToolsError: null };

function remoteTool(name: string) {
  return {
    name,
    description: `remote ${name}`,
    invoke: jest.fn(async () => `${name} result`),
  };
}

jest.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: class {
    private readonly record: FakeClient;
    constructor(config: FakeClient["config"]) {
      this.record = { config, closed: false };
      fake.clients.push(this.record);
    }
    async getTools() {
      if (fake.getToolsError) throw fake.getToolsError;
      return Object.keys(this.record.config.mcpServers).flatMap((server) =>
        (fake.serverTools[server] ?? []).map((tool) =>
          remoteTool(`mcp__${server}__${tool}`),
        ),
      );
    }
    async close() {
      this.record.closed = true;
    }
  },
}));

import {
  createRemoteToolsMiddleware,
  readServersFile,
  resolveServersFilePath,
  REMOTE_TOOLS_MIDDLEWARE_NAME,
} from "../../../src/middleware/remote-tools.js";
import { logger } from "../../../src/utils/logger.js";

type Mw = ReturnType<typeof createRemoteToolsMiddleware> & {
  wrapModelCall: (request: any, handler: (r: any) => any) => Promise<any>;
  wrapToolCall: (request: any, handler: (r: any) => any) => Promise<any>;
};

let dir: string;
let file: string;
let warn: ReturnType<typeof jest.spyOn>;

function writeServers(contents: unknown) {
  writeFileSync(file, JSON.stringify(contents));
}

function middleware(excluded: string[] = []): Mw {
  return createRemoteToolsMiddleware({
    excludedTools: new Set(excluded),
    resolvePath: () => file,
  }) as Mw;
}

async function advertised(
  mw: Mw,
  opts: { scopes?: unknown; tools?: unknown[] } = {},
) {
  let seen: Array<{ name: string }> = [];
  await mw.wrapModelCall(
    {
      tools: opts.tools ?? [{ name: "read_file" }],
      runtime: {
        configurable: opts.scopes === undefined ? {} : { scopes: opts.scopes },
      },
    },
    async (request) => {
      seen = request.tools;
      return {};
    },
  );
  return seen.map((t) => t.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remote-tools-"));
  file = join(dir, "servers.json");
  fake.clients = [];
  fake.serverTools = {};
  fake.getToolsError = null;
  warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.REMOTE_TOOLS_TEST_TOKEN;
});

// ---------------------------------------------------------------------------
// The servers file
// ---------------------------------------------------------------------------

describe("readServersFile", () => {
  it("treats a missing file as no servers, silently", () => {
    expect(readServersFile(file).servers).toEqual({});
    expect(readServersFile(null).servers).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats invalid JSON as no servers, with a warning", () => {
    writeFileSync(file, "{ not json");
    expect(readServersFile(file).servers).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it("skips a stdio entry with a warning and keeps its siblings", () => {
    writeServers({
      local: { transport: "stdio", command: "node", args: ["server.js"] },
      docs: { transport: "http", url: "https://docs.example/mcp" },
    });
    expect(Object.keys(readServersFile(file).servers)).toEqual(["docs"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ server: "local" }),
      expect.stringMatching(/stdio/),
    );
  });

  it("drops a bad entry and keeps a good sibling", () => {
    writeServers({
      docs: { transport: "http", url: "https://docs.example/mcp" },
      nourl: { transport: "http" },
      ftp: { transport: "http", url: "ftp://files.example/" },
      Bad_Name: { transport: "http", url: "https://x.example/" },
      emptyscope: { transport: "http", url: "https://x.example/", scope: [] },
    });
    expect(Object.keys(readServersFile(file).servers)).toEqual(["docs"]);
  });

  it("normalises a string scope to a list", () => {
    writeServers({
      a: { transport: "http", url: "https://a.example/", scope: "tag-a" },
      b: { transport: "http", url: "https://b.example/", scope: ["x", "y"] },
      c: { transport: "http", url: "https://c.example/" },
    });
    const { servers } = readServersFile(file);
    expect(servers.a.scope).toEqual(["tag-a"]);
    expect(servers.b.scope).toEqual(["x", "y"]);
    expect(servers.c.scope).toBeUndefined();
  });

  it("expands ${VAR} in header values from the process env", () => {
    process.env.REMOTE_TOOLS_TEST_TOKEN = "s3cret";
    writeServers({
      docs: {
        transport: "http",
        url: "https://docs.example/mcp",
        headers: { Authorization: "Bearer ${REMOTE_TOOLS_TEST_TOKEN}" },
      },
    });
    expect(readServersFile(file).servers.docs.headers).toEqual({
      Authorization: "Bearer s3cret",
    });
  });

  it("drops an entry whose header references an unset variable", () => {
    writeServers({
      docs: {
        transport: "http",
        url: "https://docs.example/mcp",
        headers: { Authorization: "Bearer ${REMOTE_TOOLS_TEST_TOKEN}" },
      },
      open: { transport: "http", url: "https://open.example/mcp" },
    });
    const { servers } = readServersFile(file);
    expect(Object.keys(servers)).toEqual(["open"]);
    expect(JSON.stringify(servers)).not.toContain("${");
  });

  it("fingerprints the resolved config, not the file text", () => {
    process.env.REMOTE_TOOLS_TEST_TOKEN = "one";
    const entry = {
      docs: {
        transport: "http",
        url: "https://docs.example/mcp",
        headers: { Authorization: "Bearer ${REMOTE_TOOLS_TEST_TOKEN}" },
      },
    };
    writeServers(entry);
    const first = readServersFile(file).fingerprint;
    writeFileSync(file, JSON.stringify(entry, null, 2));
    expect(readServersFile(file).fingerprint).toBe(first);
    process.env.REMOTE_TOOLS_TEST_TOKEN = "two";
    expect(readServersFile(file).fingerprint).not.toBe(first);
  });
});

describe("resolveServersFilePath", () => {
  it("is null with neither a servers file nor a component root", () => {
    expect(
      resolveServersFilePath({
        serversFile: undefined,
        componentsDir: undefined,
      }),
    ).toBeNull();
  });

  it("defaults to servers.json in the component root", () => {
    expect(
      resolveServersFilePath({ serversFile: undefined, componentsDir: dir }),
    ).toBe(file);
  });

  it("honours an explicit path when there is no component root", () => {
    const elsewhere = join(dir, "elsewhere.json");
    expect(
      resolveServersFilePath({
        serversFile: elsewhere,
        componentsDir: undefined,
      }),
    ).toBe(elsewhere);
  });

  it("refuses an explicit path outside the component root", () => {
    const root = join(dir, "root");
    mkdirSync(root);
    writeServers({});
    expect(
      resolveServersFilePath({ serversFile: file, componentsDir: root }),
    ).toBeNull();
  });

  it("refuses a link inside the root that points outside it", () => {
    const root = join(dir, "root");
    mkdirSync(root);
    writeServers({});
    const link = join(root, "servers.json");
    symlinkSync(file, link);
    expect(
      resolveServersFilePath({ serversFile: undefined, componentsDir: root }),
    ).toBeNull();
  });

  it("accepts an explicit path inside the component root", () => {
    writeServers({});
    expect(
      resolveServersFilePath({ serversFile: file, componentsDir: dir }),
    ).toBe(file);
  });
});

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

describe("createRemoteToolsMiddleware", () => {
  it("is named remoteToolsMiddleware", () => {
    expect(middleware().name).toBe(REMOTE_TOOLS_MIDDLEWARE_NAME);
    expect(REMOTE_TOOLS_MIDDLEWARE_NAME).toBe("remoteToolsMiddleware");
  });

  it("leaves the request untouched when there is no servers file", async () => {
    const mw = middleware();
    const request = { tools: [{ name: "read_file" }], runtime: {} };
    let seen: unknown;
    await mw.wrapModelCall(request, async (r) => {
      seen = r;
      return {};
    });
    expect(seen).toBe(request);
    expect(fake.clients).toHaveLength(0);
  });

  it("builds the client with prefixed names and the http transport", async () => {
    writeServers({
      docs: { transport: "http", url: "https://docs.example/mcp" },
    });
    fake.serverTools = { docs: ["search"] };
    await advertised(middleware());
    expect(fake.clients).toHaveLength(1);
    expect(fake.clients[0].config).toMatchObject({
      mcpServers: {
        docs: {
          transport: "http",
          url: "https://docs.example/mcp",
          automaticSSEFallback: false,
        },
      },
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: "mcp",
      throwOnLoadError: false,
      onConnectionError: "ignore",
    });
  });

  it("appends remote tools after the built-ins", async () => {
    writeServers({
      docs: { transport: "http", url: "https://docs.example/mcp" },
    });
    fake.serverTools = { docs: ["search", "fetch"] };
    expect(await advertised(middleware())).toEqual([
      "read_file",
      "mcp__docs__search",
      "mcp__docs__fetch",
    ]);
  });

  it("keeps the built-in on a name collision", async () => {
    writeServers({
      docs: { transport: "http", url: "https://docs.example/mcp" },
    });
    fake.serverTools = { docs: ["search"] };
    const builtin = { name: "mcp__docs__search", builtin: true };
    let seen: any[] = [];
    await middleware().wrapModelCall(
      { tools: [builtin], runtime: {} },
      async (r) => {
        seen = r.tools;
        return {};
      },
    );
    expect(seen).toEqual([builtin]);
  });

  it("advertises scoped servers only when a scope matches", async () => {
    writeServers({
      open: { transport: "http", url: "https://open.example/mcp" },
      room: {
        transport: "http",
        url: "https://room.example/mcp",
        scope: ["tag-a"],
      },
    });
    fake.serverTools = { open: ["a"], room: ["b"] };
    const mw = middleware();
    expect(await advertised(mw)).toEqual(["read_file", "mcp__open__a"]);
    expect(await advertised(mw, { scopes: ["other"] })).toEqual([
      "read_file",
      "mcp__open__a",
    ]);
    expect(await advertised(mw, { scopes: ["tag-a"] })).toEqual([
      "read_file",
      "mcp__open__a",
      "mcp__room__b",
    ]);
    // A malformed scopes value is treated as no scopes.
    expect(await advertised(mw, { scopes: "tag-a" })).toEqual([
      "read_file",
      "mcp__open__a",
    ]);
  });

  it("keeps one client while the fingerprint is unchanged", async () => {
    writeServers({
      docs: { transport: "http", url: "https://docs.example/mcp" },
    });
    fake.serverTools = { docs: ["search"] };
    const mw = middleware();
    await Promise.all([advertised(mw), advertised(mw), advertised(mw)]);
    await advertised(mw);
    expect(fake.clients).toHaveLength(1);
    expect(fake.clients[0].closed).toBe(false);
  });

  it("closes the old client and builds a new one when the file changes", async () => {
    writeServers({
      docs: { transport: "http", url: "https://docs.example/mcp" },
    });
    fake.serverTools = { docs: ["search"], wiki: ["read"] };
    const mw = middleware();
    await advertised(mw);
    writeServers({
      wiki: { transport: "http", url: "https://wiki.example/mcp" },
    });
    expect(await advertised(mw)).toEqual(["read_file", "mcp__wiki__read"]);
    expect(fake.clients).toHaveLength(2);
    expect(fake.clients[0].closed).toBe(true);
    expect(fake.clients[1].closed).toBe(false);
  });

  it("closes the client and advertises nothing once the file is emptied", async () => {
    writeServers({
      docs: { transport: "http", url: "https://docs.example/mcp" },
    });
    fake.serverTools = { docs: ["search"] };
    const mw = middleware();
    await advertised(mw);
    rmSync(file);
    expect(await advertised(mw)).toEqual(["read_file"]);
    expect(fake.clients[0].closed).toBe(true);
    expect(fake.clients).toHaveLength(1);
  });

  it("advertises nothing when listing tools fails", async () => {
    writeServers({
      docs: { transport: "http", url: "https://docs.example/mcp" },
    });
    fake.getToolsError = new Error("connection refused");
    expect(await advertised(middleware())).toEqual(["read_file"]);
  });

  describe("wrapToolCall", () => {
    function call(name: string, scopes?: string[]) {
      return {
        toolCall: { id: "call-1", name, args: {} },
        runtime: { configurable: scopes ? { scopes } : {} },
      };
    }

    beforeEach(() => {
      writeServers({
        docs: { transport: "http", url: "https://docs.example/mcp" },
        room: {
          transport: "http",
          url: "https://room.example/mcp",
          scope: "tag-a",
        },
      });
      fake.serverTools = { docs: ["search"], room: ["agents"] };
    });

    it("passes a built-in call through untouched, without reading the file", async () => {
      const mw = middleware();
      const request = call("read_file");
      const result = { built: "in" };
      const handler = jest.fn(async () => result);
      expect(await mw.wrapToolCall(request, handler)).toBe(result);
      expect(handler).toHaveBeenCalledWith(request);
      expect(fake.clients).toHaveLength(0);
    });

    it("routes a remote call through the handler with the remote tool", async () => {
      const mw = middleware();
      const handler = jest.fn(async (r: any) => r.tool?.name);
      expect(await mw.wrapToolCall(call("mcp__docs__search"), handler)).toBe(
        "mcp__docs__search",
      );
    });

    it("passes an unknown remote name through for the tool node to answer", async () => {
      const mw = middleware();
      const handler = jest.fn(async (r: any) => r);
      const request = call("mcp__docs__nope");
      expect(await mw.wrapToolCall(request, handler)).toBe(request);
    });

    it("passes an out-of-scope remote call through without the tool", async () => {
      const mw = middleware();
      const handler = jest.fn(async (r: any) => r.tool);
      expect(
        await mw.wrapToolCall(call("mcp__room__agents"), handler),
      ).toBeUndefined();
      expect(
        (await mw.wrapToolCall(call("mcp__room__agents", ["tag-a"]), handler))
          ?.name,
      ).toBe("mcp__room__agents");
    });

    it("turns a thrown error into an error ToolMessage", async () => {
      const mw = middleware();
      const result = await mw.wrapToolCall(
        call("mcp__docs__search"),
        async () => {
          throw new Error("upstream 502");
        },
      );
      expect(result).toBeInstanceOf(ToolMessage);
      expect(result.status).toBe("error");
      expect(result.tool_call_id).toBe("call-1");
      expect(result.content).toContain("upstream 502");
    });

    it("refuses an excluded remote tool without calling the handler", async () => {
      const handler = jest.fn(async () => "ran");
      for (const entry of ["mcp__docs", "mcp__docs__*", "mcp__docs__search"]) {
        const result = await middleware([entry]).wrapToolCall(
          call("mcp__docs__search"),
          handler,
        );
        expect(result).toBeInstanceOf(ToolMessage);
        expect(result.status).toBe("error");
      }
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
