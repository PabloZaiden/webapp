import { describe, expect, test } from "bun:test";
import {
  createWebAppCli,
  type CliProfileStore,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";
import {
  createRouteCatalog,
  defineRoutes,
  jsonResponse,
} from "@pablozaiden/webapp/server";

const catalog = createRouteCatalog(defineRoutes({
  "/api/items/:id": {
    auth: "user",
    cliPath: "item/:id",
    description: "Read an item.",
    GET: () => jsonResponse({ ok: true }),
  },
}));

function storedCredentials(): StoredDeviceCredentials {
  const now = new Date().toISOString();
  return {
    baseUrl: "https://app.example.test",
    clientId: "cli",
    accessToken: "access",
    refreshToken: "refresh",
    tokenType: "Bearer",
    scope: "*",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

function profiles(): CliProfileStore {
  return {
    selectedName: async () => "work",
    list: async () => [],
    use: async () => undefined,
    remove: async () => false,
    credentials: () => ({
      path: () => "memory",
      read: async () => storedCredentials(),
      write: async () => undefined,
      clear: async () => undefined,
    }),
  };
}

describe("composed API, schema, and logs commands", () => {
  test("reuses route catalog and authenticated request helpers", async () => {
    const requests: string[] = [];
    const cli = createWebAppCli({
      appName: "Test",
      commandName: "test-app",
      envPrefix: "TEST_APP",
      version: "1.0.0",
      routeCatalog: catalog,
      profileStore: profiles(),
      stdin: {
        async *[Symbol.asyncIterator]() {
          return;
        },
      },
      fetchFn: (async (request: string | URL | Request) => {
        const url = String(request);
        requests.push(url);
        return url.endsWith("/api/server/logs")
          ? Response.json({ enabled: true, logs: [] })
          : Response.json({ id: "123" });
      }) as typeof fetch,
    });

    const api = await cli.execute(["api", "item/123"]);
    const schema = await cli.execute(["schema", "item/123"]);
    const logs = await cli.execute(["logs"]);

    expect(api.exitCode).toBe(0);
    expect(JSON.parse(api.output!)).toMatchObject({ response: { id: "123" } });
    expect(JSON.parse(schema.output!)).toMatchObject({
      path: "/api/items/:id",
      cliPath: "item/:id",
    });
    expect(JSON.parse(logs.output!)).toEqual({ enabled: true, logs: [] });
    expect(requests).toEqual([
      "https://app.example.test/api/items/123",
      "https://app.example.test/api/server/logs",
    ]);
  });
});
