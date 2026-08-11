import { describe, expect, test } from "bun:test";
import { runServerLogsCliCommand } from "@pablozaiden/webapp/cli";

describe("server logs CLI command", () => {
  test("requests the server log endpoint with environment API-key authentication", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const result = await runServerLogsCliCommand({
      envPrefix: "TEST_LOGS",
      environment: {
        TEST_LOGS_BASE_URL: " https://logs.example.test/// ",
        TEST_LOGS_API_KEY: " admin-key ",
      },
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ enabled: true, logs: [{ message: "captured" }] });
      }) as typeof fetch,
    });

    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([{
      url: "https://logs.example.test/api/server/logs",
      authorization: "Bearer admin-key",
    }]);
    expect(JSON.parse(result.output!)).toEqual({
      enabled: true,
      logs: [{ message: "captured" }],
    });
  });

  test("supports an explicit base URL and preserves failed response bodies", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const result = await runServerLogsCliCommand({
      envPrefix: "TEST_LOGS_OVERRIDE",
      args: ["--base-url", "https://override.example.test///"],
      environment: { TEST_LOGS_OVERRIDE_API_KEY: "admin-key" },
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ error: "admin_required", message: "Admin permissions are required" }, { status: 403 });
      }) as typeof fetch,
    });

    expect(result.exitCode).toBe(1);
    expect(requests).toEqual([{
      url: "https://override.example.test/api/server/logs",
      authorization: "Bearer admin-key",
    }]);
    expect(JSON.parse(result.output!)).toEqual({
      error: "admin_required",
      message: "Admin permissions are required",
    });
  });
});
