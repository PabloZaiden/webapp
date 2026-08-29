import { describe, expect, test } from "bun:test";
import {
  getAuthorizedHeaders,
  runApiCliCommand,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";
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
        withLock: async <T>(callback: () => Promise<T>) => callback(),
      },
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.exitCode).toBe(0);
    expect(requestedUrls).toEqual(["http://example.test/api/items/123", "http://example.test/api/items/123"]);
    expect(requestedAuth).toEqual(["Bearer old", "Bearer new"]);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(result.output!)).toMatchObject({ response: { id: "123" } });
  });

  test("performs one refresh across concurrent device 401 recoveries", async () => {
    const initial: StoredDeviceCredentials = {
      baseUrl: "http://example.test",
      clientId: "cli",
      accessToken: "old",
      refreshToken: "refresh",
      tokenType: "Bearer",
      scope: "*",
      accessTokenExpiresAt: "2026-01-01T00:10:00.000Z",
      createdAt: "2025-12-31T00:00:00.000Z",
      updatedAt: "2025-12-31T00:00:00.000Z",
    };
    let stored = initial;
    let lockTail = Promise.resolve();
    const store = {
      read: async () => stored,
      write: async (value: StoredDeviceCredentials) => {
        stored = value;
      },
      withLock: async <T>(callback: () => Promise<T>) => {
        const previous = lockTail;
        let release!: () => void;
        lockTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    };
    const rotated: StoredDeviceCredentials = {
      ...initial,
      accessToken: "new",
      refreshToken: "next",
      accessTokenExpiresAt: "2026-01-01T00:10:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const rotatedAuthorization = getAuthorizedHeaders(rotated).get("authorization");
    const requestedAuth: string[] = [];
    let applicationRequests = 0;
    let refreshRequests = 0;
    let releaseInitialRequests!: () => void;
    const initialRequests = new Promise<void>((resolve) => {
      releaseInitialRequests = resolve;
    });
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/token")) {
        refreshRequests++;
        return Response.json({
          access_token: rotated.accessToken,
          refresh_token: rotated.refreshToken,
          token_type: "Bearer",
          expires_in: 600,
          scope: "*",
        });
      }
      applicationRequests++;
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      requestedAuth.push(authorization);
      if (applicationRequests === 2) releaseInitialRequests();
      if (applicationRequests <= 2) await initialRequests;
      return authorization === rotatedAuthorization
        ? Response.json({ id: "123" })
        : Response.json({ error: "rejected" }, { status: 401 });
    };
    const command = () => runApiCliCommand({
      catalog,
      args: ["item/123"],
      fetchFn: fetchFn as typeof fetch,
      credentials: store,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const [first, second] = await Promise.all([command(), command()]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(refreshRequests).toBe(1);
    expect(applicationRequests).toBe(4);
    expect(rotatedAuthorization).toBeDefined();
    expect(requestedAuth.filter((authorization) => authorization === rotatedAuthorization)).toHaveLength(2);
    expect(new Set(requestedAuth).size).toBe(2);
    expect(stored).toMatchObject({
      accessToken: "new",
      refreshToken: "next",
    });
  });

  test("preserves the final 401 after one refresh and retry", async () => {
    let stored: StoredDeviceCredentials = {
      baseUrl: "http://example.test",
      clientId: "cli",
      accessToken: "old",
      refreshToken: "refresh",
      tokenType: "Bearer",
      scope: "*",
      accessTokenExpiresAt: "2026-01-01T00:10:00.000Z",
      createdAt: "2025-12-31T00:00:00.000Z",
      updatedAt: "2025-12-31T00:00:00.000Z",
    };
    let applicationRequests = 0;
    let refreshRequests = 0;
    const result = await runApiCliCommand({
      catalog,
      args: ["item/123"],
      fetchFn: (async (input: string | URL | Request) => {
        if (String(input).endsWith("/api/auth/token")) {
          refreshRequests++;
          return Response.json({
            access_token: "new",
            refresh_token: "next",
            token_type: "Bearer",
            expires_in: 600,
            scope: "*",
          });
        }
        applicationRequests++;
        return Response.json({ error: "still-rejected" }, { status: 401 });
      }) as typeof fetch,
      credentials: {
        read: async () => stored,
        write: async (value) => {
          stored = value;
        },
        withLock: async <T>(callback: () => Promise<T>) => callback(),
      },
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.exitCode).toBe(1);
    expect(applicationRequests).toBe(2);
    expect(refreshRequests).toBe(1);
    expect(JSON.parse(result.output!)).toMatchObject({
      status: { code: 401 },
      response: { error: "still-rejected" },
    });
  });

  test("uses the complete environment pair without device credentials", async () => {
    const requested: Array<{ url: string; authorization: string | null }> = [];
    const result = await runApiCliCommand({
      catalog,
      args: ["item/123"],
      envPrefix: "TEST_CLI_ENV",
      environment: {
        TEST_CLI_ENV_BASE_URL: " https://env.example.test/// ",
        TEST_CLI_ENV_API_KEY: " env-key ",
      },
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        requested.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ id: "123" });
      }) as typeof fetch,
    });

    expect(result.exitCode).toBe(0);
    expect(requested).toEqual([{
      url: "https://env.example.test/api/items/123",
      authorization: "Bearer env-key",
    }]);
  });

  test("uses an explicit base URL with the environment API key", async () => {
    const requested: Array<{ url: string; authorization: string | null }> = [];
    const result = await runApiCliCommand({
      catalog,
      args: ["item/123"],
      baseUrl: "https://explicit.example.test///",
      envPrefix: "TEST_CLI_EXPLICIT",
      environment: {
        TEST_CLI_EXPLICIT_BASE_URL: "https://ignored.example.test",
        TEST_CLI_EXPLICIT_API_KEY: "explicit-key",
      },
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        requested.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ id: "123" });
      }) as typeof fetch,
    });

    expect(result.exitCode).toBe(0);
    expect(requested).toEqual([{
      url: "https://explicit.example.test/api/items/123",
      authorization: "Bearer explicit-key",
    }]);
  });

  test("preserves anonymous requests for missing or partial environment pairs", async () => {
    for (const environment of [
      { TEST_CLI_PARTIAL_API_KEY: "key-only" },
      { TEST_CLI_PARTIAL_BASE_URL: "https://base-only.example.test" },
    ]) {
      const requested: Array<{ url: string; authorization: string | null }> = [];
      const result = await runApiCliCommand({
        catalog,
        args: ["item/123"],
        envPrefix: "TEST_CLI_PARTIAL",
        environment,
        fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
          requested.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return Response.json({ id: "123" });
        }) as typeof fetch,
      });

      expect(result.exitCode).toBe(0);
      expect(requested).toEqual([{
        url: "http://localhost:3000/api/items/123",
        authorization: null,
      }]);
    }
  });

  test("does not refresh or retry an environment API-key 401", async () => {
    const requestedUrls: string[] = [];
    const requestedAuth: string[] = [];
    const result = await runApiCliCommand({
      catalog,
      args: ["item/123"],
      envPrefix: "TEST_CLI_401",
      environment: {
        TEST_CLI_401_BASE_URL: "https://env.example.test",
        TEST_CLI_401_API_KEY: "invalid-key",
      },
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrls.push(String(input));
        requestedAuth.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({ error: "invalid_token" }, { status: 401 });
      }) as typeof fetch,
    });

    expect(result.exitCode).toBe(1);
    expect(requestedUrls).toEqual(["https://env.example.test/api/items/123"]);
    expect(requestedAuth).toEqual(["Bearer invalid-key"]);
  });

  test("uses the stored device base URL by default", async () => {
    const requested: Array<{ url: string; authorization: string | null }> = [];
    const stored: StoredDeviceCredentials = {
      baseUrl: "https://stored.example.test",
      clientId: "cli",
      accessToken: "stored-token",
      refreshToken: "stored-refresh",
      tokenType: "Bearer",
      scope: "*",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const commandInput = {
      catalog,
      args: ["item/123"],
      envPrefix: "TEST_CLI_STORED",
      environment: {
        TEST_CLI_STORED_BASE_URL: "https://env.example.test",
        TEST_CLI_STORED_API_KEY: "env-key",
      },
      credentials: { read: async () => stored, write: async () => undefined },
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        requested.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ id: "123" });
      }) as typeof fetch,
    };
    const result = await runApiCliCommand(commandInput);

    expect(result.exitCode).toBe(0);
    expect(requested).toEqual([{
      url: "https://stored.example.test/api/items/123",
      authorization: "Bearer stored-token",
    }]);
  });
  test("preserves non-JSON response bodies in body format", async () => {
    const body = "plain text\nwith \"quoted\" content";
    const result = await runApiCliCommand({
      catalog,
      args: ["item/123"],
      responseFormat: "body",
      fetchFn: (async (_input: string | URL | Request, _init?: RequestInit) => new Response(body, { status: 200 })) as typeof fetch,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(body);
  });
});

describe("generic API CLI base URL overrides", () => {
  test("uses an explicit base URL with stored device credentials", async () => {
    const stored: StoredDeviceCredentials = {
      baseUrl: "https://stored.example.test",
      clientId: "cli",
      accessToken: "stored-token",
      refreshToken: "stored-refresh",
      tokenType: "Bearer",
      scope: "*",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let requestedUrl = "";
    let hasAuthorization = false;

    const result = await runApiCliCommand({
      catalog,
      args: ["item/123"],
      baseUrl: "https://explicit.example.test///",
      credentials: {
        read: async () => stored,
        write: async () => undefined,
      },
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(input);
        hasAuthorization = new Headers(init?.headers).has("authorization");
        return Response.json({ id: "123" });
      }) as typeof fetch,
    });

    expect(result.exitCode).toBe(0);
    expect(requestedUrl).toBe("https://explicit.example.test/api/items/123");
    expect(hasAuthorization).toBe(true);
  });
});
