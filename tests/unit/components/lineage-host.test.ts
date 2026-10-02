/**
 * `readHostComponents`: the request it sends, independent of how its
 * caller resolves a token.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { readHostComponents } from "../../../src/components/lineage-host.js";

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
