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

  test("rejects requests when no authenticated instance is configured", async () => {
    let requestCount = 0;
    const result = await runServerLogsCliCommand({
      envPrefix: "TEST_LOGS_OVERRIDE",
      environment: { TEST_LOGS_OVERRIDE_API_KEY: "admin-key" },
      fetchFn: (async (_input: string | URL | Request, _init?: RequestInit) => {
        requestCount += 1;
        return Response.json({ enabled: false, logs: [] });
      }) as typeof fetch,
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("No authenticated CLI instance is configured");
    expect(requestCount).toBe(0);
  });
});
