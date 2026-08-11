import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { StoredDeviceCredentials } from "@pablozaiden/webapp/cli";
import { createWebAppServer, defineRoutes, sqliteWebAppStore } from "@pablozaiden/webapp/server";

const dataDirs: string[] = [];

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("server lifecycle CLI", () => {
  test("exposes the logs command through runFromCli", async () => {
    const dataDir = `.cache/tests/server-lifecycle-logs-${crypto.randomUUID()}`;
    dataDirs.push(dataDir);
    const storedCredentials = {
      baseUrl: "https://logs.example.test",
      clientId: "cli",
      accessToken: "admin-access",
      refreshToken: "admin-refresh",
      tokenType: "Bearer",
      scope: "*",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies StoredDeviceCredentials;

    const requests: Array<{ url: string; authorization: string | null }> = [];
    const previousFetch = globalThis.fetch;
    const previousLog = console.log;
    const output: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ enabled: false, logs: [] });
    }) as typeof fetch;
    console.log = ((message?: unknown) => {
      output.push(String(message));
    }) as typeof console.log;

    try {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_LIFECYCLE_LOGS",
        store: sqliteWebAppStore({ dataDir }),
        auth: { passkeys: false },
        cli: {
          credentials: {
            read: async () => storedCredentials,
            write: async () => undefined,
          },
        },
        routes: defineRoutes({}),
      });

      await app.runFromCli(["logs"]);

      expect(requests).toEqual([{
        url: "https://logs.example.test/api/server/logs",
        authorization: "Bearer admin-access",
      }]);
      expect(JSON.parse(output[0]!)).toEqual({ enabled: false, logs: [] });
    } finally {
      globalThis.fetch = previousFetch;
      console.log = previousLog;
    }
  });
});
