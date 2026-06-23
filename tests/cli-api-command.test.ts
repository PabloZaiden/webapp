import { describe, expect, test } from "bun:test";
import { runApiCliCommand, type StoredDeviceCredentials } from "@pablozaiden/webapp/cli";
import { createRouteCatalog, defineRoutes, jsonResponse } from "@pablozaiden/webapp/server";

const catalog = createRouteCatalog(defineRoutes({
  "/api/items/:id": {
    auth: "user",
    scopes: ["items:read"],
    cliPath: "item/:id",
    description: "Read item.",
    GET: () => jsonResponse({ ok: true }),
  },
}));

describe("generic API CLI command", () => {
  test("lists endpoints and prints schema metadata", async () => {
    const list = await runApiCliCommand({ catalog, args: [] });
    const schema = await runApiCliCommand({ catalog, mode: "schema", args: ["item/123"] });

    expect(list.output).toContain("GET item/:id - Read item.");
    expect(JSON.parse(schema.output!)).toMatchObject({
      path: "/api/items/:id",
      scopes: ["items:read"],
    });
  });

  test("calls an endpoint and refreshes once after 401", async () => {
    const writes: StoredDeviceCredentials[] = [];
    let credentials: StoredDeviceCredentials | undefined = {
      baseUrl: "http://example.test",
      clientId: "cli",
      accessToken: "old",
      refreshToken: "refresh",
      tokenType: "Bearer",
      scope: "*",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const requestedAuth: string[] = [];
    const requestedUrls: string[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/token")) {
        return Response.json({ access_token: "new", refresh_token: "next", token_type: "Bearer", expires_in: 600, scope: "*" });
      }
      requestedUrls.push(url);
      requestedAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return requestedAuth.length === 1
        ? Response.json({ error: "expired" }, { status: 401 })
        : Response.json({ id: "123" });
    };

    const result = await runApiCliCommand({
      catalog,
      args: ["item/123"],
      baseUrl: "http://example.test",
      fetchFn: fetchFn as typeof fetch,
      credentials: {
        read: async () => credentials,
        write: async (value) => {
          writes.push(value);
          credentials = value;
        },
      },
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.exitCode).toBe(0);
    expect(requestedUrls).toEqual(["http://example.test/api/items/123", "http://example.test/api/items/123"]);
    expect(requestedAuth).toEqual(["Bearer old", "Bearer new"]);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(result.output!)).toMatchObject({ response: { id: "123" } });
  });
});
