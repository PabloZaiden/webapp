import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createWebAppServer, defineRoutes, sqliteWebAppStore } from "@pablozaiden/webapp/server";

const envNames = ["TEST_LIFECYCLE_LOGS_BASE_URL", "TEST_LIFECYCLE_LOGS_API_KEY"] as const;
const dataDirs: string[] = [];
const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
  previousEnv.clear();
  for (const name of envNames) {
    previousEnv.set(name, process.env[name]);
  }
});

afterEach(() => {
  for (const name of envNames) {
    const value = previousEnv.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("server lifecycle CLI", () => {
  test("exposes the logs command through runFromCli", async () => {
    const dataDir = `.cache/tests/server-lifecycle-logs-${crypto.randomUUID()}`;
    dataDirs.push(dataDir);
    process.env["TEST_LIFECYCLE_LOGS_BASE_URL"] = "https://logs.example.test";
    process.env["TEST_LIFECYCLE_LOGS_API_KEY"] = "admin-key";

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
        routes: defineRoutes({}),
      });

      await app.runFromCli(["logs"]);

      expect(requests).toEqual([{
        url: "https://logs.example.test/api/server/logs",
        authorization: "Bearer admin-key",
      }]);
      expect(JSON.parse(output[0]!)).toEqual({ enabled: false, logs: [] });
    } finally {
      globalThis.fetch = previousFetch;
      console.log = previousLog;
    }
  });
});
