import { describe, expect, test } from "bun:test";
import {
  createDeviceCredentialsStore,
  createWebAppCli,
  runDeviceAuthCommand,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";
import { createRouteCatalog, defineRoutes, jsonResponse } from "@pablozaiden/webapp/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonFileStore } from "../src/cli/credentials";

function memoryStore(writes: StoredDeviceCredentials[]): JsonFileStore<StoredDeviceCredentials> {
  return {
    path: () => "memory",
    read: async () => undefined,
    write: async (value) => {
      writes.push(value);
    },
    clear: async () => undefined,
  };
}

describe("device auth CLI helpers", () => {
  test("stores completion-time credentials after device auth succeeds", async () => {
    const home = mkdtempSync(join(tmpdir(), "webapp-cli-device-auth-"));
    const store = createDeviceCredentialsStore({
      appDirectoryName: ".device-auth-test",
      home,
    });
    const requests: Array<{
      url: string;
      method: string;
      body: unknown;
      authorization: string | null;
    }> = [];
    const sleepCalls: number[] = [];
    let tokenRequests = 0;
    const now = new Date("2026-01-01T00:00:05Z");
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      requests.push({
        url,
        method: init?.method ?? "GET",
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.endsWith("/api/auth/device")) {
        return Response.json({
          device_code: "device",
          user_code: "ABCD-EFGH",
          verification_uri: "https://example.test/device",
          verification_uri_complete: "https://example.test/device?code=ABCD-EFGH",
          interval: 1,
        });
      }
      tokenRequests += 1;
      if (tokenRequests === 1) {
        return Response.json({ error: "authorization_pending" }, { status: 400 });
      }
      if (tokenRequests === 2) {
        return Response.json({ error: "slow_down" }, { status: 400 });
      }
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 315_360_000,
        scope: "items:read",
      });
    };

    try {
      const output: string[] = [];
      const result = await runDeviceAuthCommand({
        baseUrl: " https://example.test/// ",
        clientId: "cli",
        scope: "items:read",
        store,
        fetchFn: fetchFn as typeof fetch,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        now: () => now,
        out: (message) => {
          output.push(message);
        },
      });

      expect(result).toBe(0);
      expect(output).toEqual([
        "Open: https://example.test/device?code=ABCD-EFGH",
        "Code: ABCD-EFGH",
        "Authenticated with https://example.test",
      ]);
      expect(sleepCalls).toEqual([1000, 1000, 1000]);
      expect(requests).toEqual([
        {
          url: "https://example.test/api/auth/device",
          method: "POST",
          body: { clientId: "cli", scope: "items:read" },
          authorization: null,
        },
        {
          url: "https://example.test/api/auth/token",
          method: "POST",
          body: {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: "device",
            client_id: "cli",
          },
          authorization: null,
        },
        {
          url: "https://example.test/api/auth/token",
          method: "POST",
          body: {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: "device",
            client_id: "cli",
          },
          authorization: null,
        },
        {
          url: "https://example.test/api/auth/token",
          method: "POST",
          body: {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: "device",
            client_id: "cli",
          },
          authorization: null,
        },
      ]);

      const stored = await store.read();
      expect(stored).toEqual({
        baseUrl: "https://example.test",
        clientId: "cli",
        accessToken: "access",
        refreshToken: "refresh",
        tokenType: "Bearer",
        scope: "items:read",
        accessTokenExpiresAt: new Date(now.getTime() + 315_360_000 * 1000).toISOString(),
        createdAt: "2026-01-01T00:00:05.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
      });

      const catalog = createRouteCatalog(defineRoutes({
        "/api/device-info": {
          auth: "user",
          cliPath: "device-info",
          GET: () => jsonResponse({ authenticated: true, source: "device" }),
        },
      }));
      const apiRequests: Array<{
        url: string;
        method: string;
        authorization: string | null;
      }> = [];
      const profileStore = {
        selectedName: async (name?: string) => name ?? "default",
        list: async () => [],
        use: async () => undefined,
        remove: async () => false,
        credentials: () => store,
      };
      const cli = createWebAppCli({
        appName: "Device Auth Test",
        commandName: "device-auth-test",
        envPrefix: "TEST_DEVICE_AUTH",
        version: "test",
        profileStore,
        routeCatalog: catalog,
        fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
          apiRequests.push({
            url: String(input),
            method: init?.method ?? "GET",
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return Response.json({ authenticated: true, source: "device" });
        }) as typeof fetch,
      });
      const nextCommand = await cli.execute(["api", "device-info"]);

      expect(nextCommand.exitCode).toBe(0);
      expect(apiRequests).toEqual([{
        url: "https://example.test/api/device-info",
        method: "GET",
        authorization: "Bearer access",
      }]);
      expect(JSON.parse(nextCommand.output!)).toMatchObject({
        response: { authenticated: true, source: "device" },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("handles non-JSON token errors without crashing JSON parsing", async () => {
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/auth/device")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "http://example.test/device", verification_uri_complete: "http://example.test/device?code=ABCD-EFGH", interval: 0 });
      }
      return new Response("<html>proxy error</html>", { status: 502, headers: { "content-type": "text/html" } });
    };

    await expect(runDeviceAuthCommand({
      baseUrl: "http://example.test",
      clientId: "cli",
      store: memoryStore([]),
      fetchFn: fetchFn as typeof fetch,
      sleep: async () => undefined,
      out: () => undefined,
    })).rejects.toThrow("Request failed with status 502");
  });
});
