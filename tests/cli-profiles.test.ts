import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  createCliProfileStore,
  createWebAppCli,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function credentials(baseUrl: string): StoredDeviceCredentials {
  const now = new Date().toISOString();
  return {
    baseUrl,
    clientId: "test-cli",
    accessToken: "access",
    refreshToken: "refresh",
    tokenType: "Bearer",
    scope: "*",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

function expiredCredentials(baseUrl: string): StoredDeviceCredentials {
  return {
    ...credentials(baseUrl),
    accessTokenExpiresAt: new Date(0).toISOString(),
  };
}

function emptyInput() {
  return {
    async *[Symbol.asyncIterator]() {
      return;
    },
  };
}

describe("CLI credential profiles", () => {
  test("lists, selects, and removes profile-specific device credentials", async () => {
    const root = `.cache/tests/cli-profiles-${crypto.randomUUID()}`;
    roots.push(root);
    const profiles = createCliProfileStore({
      appDirectoryName: "state",
      home: root,
    });

    await profiles.credentials("work").write(credentials("https://work.example.test"));
    await profiles.credentials("personal").write(credentials("https://personal.example.test"));
    const cli = createWebAppCli({
      appName: "Test App",
      commandName: "test-app",
      envPrefix: "TEST_PROFILE_COMMANDS",
      version: "1.0.0",
      profileStore: profiles,
      stdin: emptyInput(),
    });

    const listed = await cli.execute(["profile", "list"]);
    expect(listed.output).toContain("personal\thttps://personal.example.test");
    expect(listed.output).toContain("work\thttps://work.example.test");
    expect((await cli.execute(["profile", "use", "work"])).exitCode).toBe(0);
    expect(await profiles.selectedName()).toBe("work");
    expect(await profiles.list()).toEqual([
      {
        name: "personal",
        current: false,
        baseUrl: "https://personal.example.test",
      },
      {
        name: "work",
        current: true,
        baseUrl: "https://work.example.test",
      },
    ]);
    expect((await cli.execute(["profile", "remove", "work"])).exitCode).toBe(0);
    expect(await profiles.selectedName()).toBe("default");
    expect(await profiles.credentials("work").read()).toBeUndefined();
  });

  test("authenticates and validates the globally selected profile", async () => {
    const root = `.cache/tests/cli-profile-auth-${crypto.randomUUID()}`;
    roots.push(root);
    const profiles = createCliProfileStore({
      appDirectoryName: "state",
      home: root,
    });
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const output: string[] = [];
    const fetchFn = (async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.endsWith("/api/auth/device")) {
        return Response.json({
          device_code: "device",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.example.test/device",
          interval: 0,
        });
      }
      if (url.endsWith("/api/auth/token")) {
        return Response.json({
          access_token: "profile-access",
          refresh_token: "profile-refresh",
          token_type: "Bearer",
          expires_in: 600,
          scope: "*",
        });
      }
      return Response.json({
        authenticated: true,
        authKind: "bearer",
        subject: "user-1",
        clientId: "test-app-cli",
        scope: "*",
      });
    }) as typeof fetch;
    const cli = createWebAppCli({
      appName: "Test App",
      commandName: "test-app",
      envPrefix: "TEST_PROFILE_AUTH",
      version: "1.0.0",
      profileStore: profiles,
      stdin: emptyInput(),
      stdout: { write: (chunk) => output.push(chunk) },
      fetchFn,
    });

    expect((await cli.execute([
      "--profile",
      "work",
      "auth",
      "--base-url",
      "https://app.example.test",
    ])).exitCode).toBe(0);
    const status = await cli.execute(["status", "--profile=work"]);

    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.output!)).toMatchObject({
      authenticated: true,
      authKind: "bearer",
    });
    expect((await profiles.credentials("work").read())?.accessToken).toBe("profile-access");
    expect(requests.at(-1)?.url).toBe("https://app.example.test/api/auth/status");
    expect(requests.at(-1)?.authorization?.startsWith("Bearer ")).toBe(true);
    expect(output.join("")).toContain("Authenticated with https://app.example.test");
  });

  test("refreshes a device token once when status receives a 401", async () => {
    const root = `.cache/tests/cli-status-refresh-${crypto.randomUUID()}`;
    roots.push(root);
    const profiles = createCliProfileStore({
      appDirectoryName: "state",
      home: root,
    });
    await profiles.credentials("work").write(credentials("https://app.example.test"));
    const requests: Array<{ url: string; authorization: string | null }> = [];
    let statusRequests = 0;
    let refreshRequests = 0;
    const cli = createWebAppCli({
      appName: "Test App",
      commandName: "test-app",
      envPrefix: "TEST_STATUS_REFRESH",
      version: "1.0.0",
      profileStore: profiles,
      stdin: emptyInput(),
      fetchFn: (async (request: string | URL | Request, init?: RequestInit) => {
        const url = String(request);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url.endsWith("/api/auth/token")) {
          refreshRequests++;
          return Response.json({
            access_token: "refreshed",
            refresh_token: "next-refresh",
            token_type: "Bearer",
            expires_in: 600,
            scope: "*",
          });
        }
        statusRequests++;
        if (statusRequests === 1) {
          return Response.json({ error: "rejected" }, { status: 401 });
        }
        return Response.json({
          authenticated: true,
          authKind: "bearer",
          subject: "user-1",
          clientId: "test-app-cli",
          scope: "*",
        });
      }) as typeof fetch,
    });

    const status = await cli.execute(["status", "--profile=work"]);

    expect(status.exitCode).toBe(0);
    expect(statusRequests).toBe(2);
    expect(refreshRequests).toBe(1);
    const statusAuthorizations = requests
      .filter((request) => request.url.endsWith("/api/auth/status"))
      .map((request) => request.authorization);
    expect(statusAuthorizations).toHaveLength(2);
    expect(statusAuthorizations[0]).not.toBe(statusAuthorizations[1]);
    expect((await profiles.credentials("work").read())?.accessToken).toBe("refreshed");
  });

  test("validates environment API-key credentials when no profile is stored", async () => {
    const authorizations: Array<string | null> = [];
    const root = `.cache/tests/cli-env-status-${crypto.randomUUID()}`;
    roots.push(root);
    const cli = createWebAppCli({
      appName: "Test App",
      commandName: "test-app",
      envPrefix: "TEST_ENV_STATUS",
      version: "1.0.0",
      profileStore: createCliProfileStore({
        appDirectoryName: "unused",
        home: root,
      }),
      environment: {
        TEST_ENV_STATUS_BASE_URL: "https://env.example.test",
        TEST_ENV_STATUS_API_KEY: "env-key",
      },
      stdin: emptyInput(),
      fetchFn: (async (_request: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return Response.json({
          authenticated: true,
          authKind: "api-key",
        });
      }) as typeof fetch,
    });

    const status = await cli.execute(["status"]);

    expect(status.exitCode).toBe(0);
    expect(authorizations[0]?.startsWith("Bearer ")).toBe(true);
  });

  test("falls back to environment credentials when a stored token cannot refresh", async () => {
    const root = `.cache/tests/cli-refresh-fallback-${crypto.randomUUID()}`;
    roots.push(root);
    const profiles = createCliProfileStore({
      appDirectoryName: "state",
      home: root,
    });
    await profiles.credentials("work").write(expiredCredentials("https://stored.example.test"));
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const cli = createWebAppCli({
      appName: "Test App",
      commandName: "test-app",
      envPrefix: "TEST_REFRESH_FALLBACK",
      version: "1.0.0",
      profileStore: profiles,
      environment: {
        TEST_REFRESH_FALLBACK_BASE_URL: "https://env.example.test",
        TEST_REFRESH_FALLBACK_API_KEY: "env-key",
      },
      stdin: emptyInput(),
      fetchFn: (async (request: string | URL | Request, init?: RequestInit) => {
        const url = String(request);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url.endsWith("/api/auth/token")) {
          return Response.json({ error: "invalid_grant" }, { status: 401 });
        }
        return Response.json({
          authenticated: true,
          authKind: "api-key",
        });
      }) as typeof fetch,
    });

    const status = await cli.execute(["--profile", "work", "status"]);

    expect(status.exitCode).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      "https://stored.example.test/api/auth/token",
      "https://env.example.test/api/auth/status",
    ]);
    expect(requests.at(-1)?.authorization?.startsWith("Bearer ")).toBe(true);
  });
});
