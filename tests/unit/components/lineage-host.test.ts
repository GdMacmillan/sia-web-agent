/**
 * `readHostComponents`: the request it sends, independent of how its
 * caller resolves a token.
 */
import { describe, it, expect, jest } from "@jest/globals";
import {
  parseHostComponent,
  parseHostStatusView,
  readHostComponents,
  readHostStatus,
} from "../../../src/components/lineage-host.js";

function respondingWith(body: unknown) {
  const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return fetchImpl as unknown as typeof fetch;
}

describe("readHostComponents", () => {
  it("sends a bearer authorization header when a token is supplied", async () => {
    const fetchImpl = respondingWith({ node: { components: { components: [] } } });

    await readHostComponents(fetchImpl, "http://127.0.0.1:7700", "secret-token");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      accept: "application/json",
      authorization: "Bearer secret-token",
    });
  });

  it("sends no authorization header when no token is available", async () => {
    const fetchImpl = respondingWith({ node: { components: { components: [] } } });

    await readHostComponents(fetchImpl, "http://127.0.0.1:7700", undefined);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ accept: "application/json" });
  });

  it("sends no authorization header for an empty-string token", async () => {
    const fetchImpl = respondingWith({ node: { components: { components: [] } } });

    await readHostComponents(fetchImpl, "http://127.0.0.1:7700", "");

    const [, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ accept: "application/json" });
  });
});

describe("parseHostComponent — the keeper's reasons", () => {
  it("reads the declined list and the last outcome's reason", () => {
    expect(
      parseHostComponent({
        name: "execute-code",
        versions: ["0.2.3"],
        lastOutcome: { version: "0.2.2", result: "activated", decisionReason: "clean" },
        rejected: {
          "0.2.3": { at: "2026-10-11T09:00:00Z", agentId: "a", decisionReason: "no dep" },
          "0.2.4": { at: "2026-10-12T09:00:00Z" },
          "0.2.5": "not an object",
        },
      }),
    ).toEqual({
      name: "execute-code",
      versions: ["0.2.3"],
      lastOutcome: { version: "0.2.2", result: "activated", decisionReason: "clean" },
      rejected: {
        "0.2.3": { at: "2026-10-11T09:00:00Z", decisionReason: "no dep" },
        "0.2.4": { at: "2026-10-12T09:00:00Z" },
      },
    });
  });

  it("drops a malformed declined list without dropping the component", () => {
    expect(parseHostComponent({ name: "x", versions: [], rejected: ["0.1.0"] })).toEqual({
      name: "x",
      versions: [],
    });
  });
});

describe("parseHostStatusView", () => {
  it("reads the agent-source drift beside the component store", () => {
    expect(
      parseHostStatusView({
        node: {
          components: { components: [] },
          agentSource: {
            version: "0.13.0",
            checkedAt: "2026-10-14T10:00:00Z",
            baseline: "ok",
            modified: ["src/a.ts", 7],
            added: ["b.md"],
            truncated: 2,
            setAside: { dir: "/elsewhere" },
          },
        },
      }),
    ).toEqual({
      components: [],
      agentSource: {
        version: "0.13.0",
        checkedAt: "2026-10-14T10:00:00Z",
        baseline: "ok",
        modified: ["src/a.ts"],
        added: ["b.md"],
        removed: [],
        truncated: 2,
      },
    });
  });

  it("reports each half as null when absent or malformed, independently", () => {
    expect(parseHostStatusView({ node: { agentSource: { modified: [] } } })).toEqual({
      components: null,
      agentSource: null,
    });
    expect(parseHostStatusView({ node: { components: { components: [] } } })).toEqual({
      components: [],
      agentSource: null,
    });
    expect(parseHostStatusView("nope")).toEqual({ components: null, agentSource: null });
  });
});

describe("readHostStatus", () => {
  it("reads nothing reported on a failed request, a non-2xx or a non-JSON body", async () => {
    const nothing = { components: null, agentSource: null };
    const throwing = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const status500 = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    const notJson = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(readHostStatus(throwing, "http://h")).resolves.toEqual(nothing);
    await expect(readHostStatus(status500, "http://h")).resolves.toEqual(nothing);
    await expect(readHostStatus(notJson, "http://h")).resolves.toEqual(nothing);
  });
});
