import { describe, expect, test } from "bun:test";
import { runDeviceAuthCommand, type StoredDeviceCredentials } from "@pablozaiden/webapp/cli";
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
    const writes: StoredDeviceCredentials[] = [];
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/auth/device")) {
        return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "http://example.test/device", verification_uri_complete: "http://example.test/device?code=ABCD-EFGH", interval: 0 });
      }
      return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 60, scope: "*" });
    };

    const result = await runDeviceAuthCommand({
      baseUrl: "http://example.test",
      clientId: "cli",
      store: memoryStore(writes),
      fetchFn: fetchFn as typeof fetch,
      sleep: async () => undefined,
      now: () => new Date("2026-01-01T00:00:05Z"),
      out: () => undefined,
    });

    expect(result).toBe(0);
    expect(writes[0]).toMatchObject({
      createdAt: "2026-01-01T00:00:05.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
    });
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
