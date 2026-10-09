/**
 * Remote tools: tools served by remote Model Context Protocol servers over
 * HTTP, listed in a servers file (`docs/COMPONENTS.md` §7).
 *
 * Three parts:
 *
 * 1. The servers file — a JSON record keyed by server name. Each entry is
 *    parsed on its own; a bad entry is dropped with a warning and never takes
 *    its siblings down. Header values may reference `${VAR}`, expanded from
 *    the process env at read time. That is not a credential channel: a host
 *    that holds an upstream's credential points the entry at its own egress
 *    route and references only the agent's own host token; the real
 *    credential never enters this process's env.
 * 2. The client — one `MultiServerMCPClient` per distinct resolved config
 *    (its fingerprint). The file is re-read on every model call; an unchanged
 *    fingerprint reuses the client, a changed one closes it and builds the
 *    next, serialised so parallel calls never double-connect.
 * 3. The middleware — `wrapModelCall` advertises the active servers' tools
 *    after the built-ins; `wrapToolCall` routes a call to the remote tool.
 *
 * Nothing here ever throws out of the middleware: a missing file, a dead
 * server or a failing call degrades to "no remote tools" or to an error
 * `ToolMessage`, and a built-in tool's call and result are never touched.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMiddleware, ToolMessage, type AgentMiddleware } from "langchain";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { getConfig } from "../config/index.js";
import type { RuntimeConfig } from "../config/schema.js";
import { isSafePath } from "../utils/skills-loader.js";
import { logger } from "../utils/logger.js";
import { isToolExcluded } from "./tool_exclusion.js";

/** The name this middleware registers under. */
export const REMOTE_TOOLS_MIDDLEWARE_NAME = "remoteToolsMiddleware";

/** Prefix every remote tool name carries: `mcp__<server>__<tool>`. */
const REMOTE_PREFIX = "mcp__";

/** Per-call timeout for a remote tool. */
const REMOTE_TOOL_TIMEOUT_MS = 60_000;

const SERVER_NAME = /^[a-z][a-z0-9-]*$/;
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// ============================================================================
// 1. The servers file
// ============================================================================

const ServerEntrySchema = z.object({
  transport: z.literal("http"),
  url: z.string().refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "url must be an absolute http(s) URL"),
  headers: z.record(z.string(), z.string()).optional(),
  scope: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .optional(),
});

/** One server entry, after `${VAR}` expansion and scope normalisation. */
export interface ResolvedServer {
  url: string;
  headers: Record<string, string>;
  /** Undefined means always active. */
  scope: string[] | undefined;
}

export interface ServersFileContents {
  servers: Record<string, ResolvedServer>;
  /** sha256 over the canonical resolved config. */
  fingerprint: string;
}

/**
 * Where the servers file lives, or `null` for "no remote tools".
 *
 * An explicit `serversFile` wins; otherwise `<componentsDir>/servers.json`.
 * When a component root is set the path must resolve inside it — the same
 * containment rule as manifests. With no component root an explicit path is
 * used as given (a standalone run).
 */
export function resolveServersFilePath(
  cfg: Pick<RuntimeConfig, "serversFile" | "componentsDir">,
): string | null {
  const candidate =
    cfg.serversFile ??
    (cfg.componentsDir ? join(cfg.componentsDir, "servers.json") : undefined);
  if (!candidate) return null;
  if (!cfg.componentsDir) return candidate;
  // isSafePath resolves links, so it needs the file to exist; a missing file
  // is simply "no servers" and needs no containment verdict.
  if (!existsSync(candidate)) return candidate;
  if (isSafePath(candidate, cfg.componentsDir)) return candidate;
  logger.warn(
    { path: candidate },
    "remote tools: servers file is outside the component root; ignored",
  );
  return null;
}

function fingerprintOf(servers: Record<string, ResolvedServer>): string {
  const canonical = Object.keys(servers)
    .sort()
    .map((name) => {
      const { url, headers, scope } = servers[name];
      const sortedHeaders = Object.keys(headers)
        .sort()
        .map((key) => [key, headers[key]]);
      return [name, url, sortedHeaders, scope ?? null];
    });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Expand `${VAR}` references; `null` when any reference is unresolved. */
function expandEnv(value: string): string | null {
  let unresolved = false;
  const expanded = value.replace(ENV_REF, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined || resolved === "") {
      unresolved = true;
      return "";
    }
    return resolved;
  });
  return unresolved ? null : expanded;
}

function resolveEntry(name: string, raw: unknown): ResolvedServer | null {
  if (!SERVER_NAME.test(name)) {
    logger.warn(
      { server: name },
      "remote tools: invalid server name; entry dropped",
    );
    return null;
  }
  if (
    raw !== null &&
    typeof raw === "object" &&
    (raw as { transport?: unknown }).transport === "stdio"
  ) {
    logger.warn(
      { server: name },
      "remote tools: stdio servers are not supported; entry skipped",
    );
    return null;
  }
  const parsed = ServerEntrySchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { server: name, issues: parsed.error.issues.map((i) => i.message) },
      "remote tools: invalid server entry; entry dropped",
    );
    return null;
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.data.headers ?? {})) {
    const expanded = expandEnv(value);
    if (expanded === null) {
      // Never send the literal reference: drop the whole entry instead.
      logger.warn(
        { server: name, header: key },
        "remote tools: header references an unset environment variable; entry dropped",
      );
      return null;
    }
    headers[key] = expanded;
  }
  const { scope } = parsed.data;
  return {
    url: parsed.data.url,
    headers,
    scope:
      scope === undefined
        ? undefined
        : typeof scope === "string"
          ? [scope]
          : scope,
  };
}

/**
 * Read and resolve the servers file. Never throws: a missing file is silently
 * empty, an unreadable or malformed one is empty with a warning.
 */
export function readServersFile(path: string | null): ServersFileContents {
  const servers: Record<string, ResolvedServer> = {};
  if (path && existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      logger.warn(
        { path, error: String(error) },
        "remote tools: servers file is not valid JSON; ignored",
      );
      raw = {};
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      logger.warn(
        { path },
        "remote tools: servers file must be a JSON object; ignored",
      );
    } else {
      for (const [name, entry] of Object.entries(raw)) {
        const resolved = resolveEntry(name, entry);
        if (resolved) servers[name] = resolved;
      }
    }
  }
  return { servers, fingerprint: fingerprintOf(servers) };
}

// ============================================================================
// 2. Client lifecycle
// ============================================================================

interface RemoteTool {
  tool: StructuredToolInterface;
  server: string;
}

interface ToolSet {
  /** Closes the underlying client, if any. */
  close: () => Promise<void>;
  /** Stable order: servers by name, tools in the order the server listed them. */
  tools: RemoteTool[];
  scopes: Map<string, string[] | undefined>;
}

const EMPTY_TOOL_SET: ToolSet = {
  close: async () => undefined,
  tools: [],
  scopes: new Map(),
};

/** `mcp__<server>__<tool>` → `<server>`; server names never contain `__`. */
function serverOf(toolName: string): string | undefined {
  if (!toolName.startsWith(REMOTE_PREFIX)) return undefined;
  const sep = toolName.indexOf("__", REMOTE_PREFIX.length);
  return sep > REMOTE_PREFIX.length
    ? toolName.slice(REMOTE_PREFIX.length, sep)
    : undefined;
}

async function buildToolSet(contents: ServersFileContents): Promise<ToolSet> {
  const names = Object.keys(contents.servers).sort();
  if (names.length === 0) return EMPTY_TOOL_SET;
  try {
    // Loaded lazily: with no servers file the agent never loads the client.
    const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
    const client = new MultiServerMCPClient({
      mcpServers: Object.fromEntries(
        names.map((name) => {
          const { url, headers } = contents.servers[name];
          return [
            name,
            {
              transport: "http" as const,
              url,
              headers,
              automaticSSEFallback: false,
            },
          ];
        }),
      ),
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: "mcp",
      throwOnLoadError: false,
      onConnectionError: "ignore",
      defaultToolTimeout: REMOTE_TOOL_TIMEOUT_MS,
      useStandardContentBlocks: true,
    });
    const close = async () => {
      try {
        await client.close();
      } catch (error) {
        logger.warn(
          { error: String(error) },
          "remote tools: closing the client failed",
        );
      }
    };
    let loaded: StructuredToolInterface[] = [];
    try {
      loaded = await client.getTools();
    } catch (error) {
      logger.warn(
        { error: String(error) },
        "remote tools: listing tools failed",
      );
    }
    const byServer = new Map<string, StructuredToolInterface[]>();
    for (const tool of loaded) {
      const server = serverOf(tool.name);
      if (!server || !(server in contents.servers)) continue;
      byServer.set(server, [...(byServer.get(server) ?? []), tool]);
    }
    const tools = names.flatMap((server) =>
      (byServer.get(server) ?? []).map((tool) => ({ tool, server })),
    );
    logger.info(
      { servers: names, tools: tools.length },
      "remote tools: servers connected",
    );
    return {
      close,
      tools,
      scopes: new Map(
        names.map((name) => [name, contents.servers[name].scope]),
      ),
    };
  } catch (error) {
    logger.warn({ error: String(error) }, "remote tools: client setup failed");
    return EMPTY_TOOL_SET;
  }
}

/** Holds the current tool set and rebuilds it when the servers file changes. */
class RemoteToolsRegistry {
  private fingerprint: string | null = null;
  private current: Promise<ToolSet> | null = null;

  constructor(private readonly resolvePath: () => string | null) {}

  /** Re-read the file; reuse, or close and rebuild, the tool set. */
  refresh(): Promise<ToolSet> {
    let contents: ServersFileContents;
    try {
      contents = readServersFile(this.resolvePath());
    } catch (error) {
      logger.warn(
        { error: String(error) },
        "remote tools: reading servers failed",
      );
      return this.current ?? Promise.resolve(EMPTY_TOOL_SET);
    }
    if (this.current && contents.fingerprint === this.fingerprint) {
      return this.current;
    }
    const previous = this.current;
    this.fingerprint = contents.fingerprint;
    // Chained on the previous build: one in-flight build at a time, and the
    // old client is closed before the next one connects.
    this.current = (async () => {
      if (previous) await (await previous).close();
      return buildToolSet(contents);
    })();
    return this.current;
  }
}

// ============================================================================
// 3. The middleware
// ============================================================================

function scopesOf(configurable: unknown): string[] {
  const scopes = (configurable as { scopes?: unknown } | undefined)?.scopes;
  return Array.isArray(scopes)
    ? scopes.filter((s): s is string => typeof s === "string")
    : [];
}

function activeTools(set: ToolSet, scopes: readonly string[]): RemoteTool[] {
  return set.tools.filter(({ server }) => {
    const scope = set.scopes.get(server);
    return scope === undefined || scope.some((s) => scopes.includes(s));
  });
}

function toolNameOf(tool: unknown): string | undefined {
  return tool !== null &&
    typeof tool === "object" &&
    typeof (tool as { name?: unknown }).name === "string"
    ? (tool as { name: string }).name
    : undefined;
}

export interface RemoteToolsMiddlewareOptions {
  /** The profile's `excludedTools`; an excluded remote tool is never routed. */
  excludedTools?: ReadonlySet<string>;
  /** Where to read the servers file. Defaults to the runtime config. */
  resolvePath?: () => string | null;
}

/**
 * Advertise and route the servers file's tools.
 *
 * A server with no `scope` is always active; a scoped one is active only when
 * a scope of its appears in `config.configurable.scopes`. Built-in tools come
 * first and win a name collision.
 */
export function createRemoteToolsMiddleware(
  options: RemoteToolsMiddlewareOptions = {},
): AgentMiddleware {
  const excluded = options.excludedTools ?? new Set<string>();
  const registry = new RemoteToolsRegistry(
    options.resolvePath ?? (() => resolveServersFilePath(getConfig().runtime)),
  );

  return createMiddleware({
    name: REMOTE_TOOLS_MIDDLEWARE_NAME,

    wrapModelCall: async (request, handler) => {
      let extra: StructuredToolInterface[] = [];
      try {
        const set = await registry.refresh();
        const have = new Set(
          (request.tools ?? []).map(toolNameOf).filter((n) => n !== undefined),
        );
        extra = activeTools(set, scopesOf(request.runtime?.configurable))
          .map(({ tool }) => tool)
          .filter((tool) => !have.has(tool.name));
      } catch (error) {
        logger.warn(
          { error: String(error) },
          "remote tools: advertising failed",
        );
      }
      if (extra.length === 0) return handler(request);
      return handler({
        ...request,
        tools: [...(request.tools ?? []), ...extra],
      });
    },

    wrapToolCall: async (request, handler) => {
      const { toolCall } = request;
      if (!toolCall.name.startsWith(REMOTE_PREFIX)) return handler(request);

      if (isToolExcluded(toolCall.name, excluded)) {
        return new ToolMessage({
          status: "error",
          tool_call_id: toolCall.id ?? "",
          name: toolCall.name,
          content: `Error: tool ${toolCall.name} is not available to this agent.`,
        });
      }

      let entry: RemoteTool | undefined;
      try {
        const set = await registry.refresh();
        entry = activeTools(set, scopesOf(request.runtime?.configurable)).find(
          ({ tool }) => tool.name === toolCall.name,
        );
      } catch (error) {
        logger.warn({ error: String(error) }, "remote tools: routing failed");
      }
      // Unknown or out of scope: the tool node answers with its own
      // "not a valid tool" message.
      if (!entry) return handler(request);

      try {
        return await handler({ ...request, tool: entry.tool });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new ToolMessage({
          status: "error",
          tool_call_id: toolCall.id ?? "",
          name: toolCall.name,
          content: `Error: remote tool ${toolCall.name} failed: ${message}`,
        });
      }
    },
  });
}
