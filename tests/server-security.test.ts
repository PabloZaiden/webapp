import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { CurrentUser } from "../src/contracts";
import { createApiKey } from "../src/server/auth/api-keys";
import { createLogger } from "../src/server/logger";
import {
  createWebAppServer,
  defineRoutes,
  jsonResponse,
  memoryWebAppStore,
  sqliteWebAppStore,
  type RouteTable,
  type RuntimeConfig,
  type UserRecord,
  type WebAppServerConfig,
  type WebAppStore,
} from "@pablozaiden/webapp/server";

const testWeb = { entry: new URL("./fixtures/web/main.tsx", import.meta.url) };

function testDataDir(label: string): string {
  return resolve(".cache/tests", `server-${label}-${crypto.randomUUID()}`);
}

interface TestStoreProvider {
  name: string;
  shareWithServer: boolean;
  create(dataDir: string): WebAppStore;
}

const testStoreProviders: TestStoreProvider[] = [
  {
    name: "SQLite",
    shareWithServer: false,
    create: (dataDir) => sqliteWebAppStore({ dataDir }),
  },
  {
    name: "memory",
    shareWithServer: true,
    create: (_dataDir) => memoryWebAppStore(),
  },
];

function createUser(store: WebAppStore, username: string, role: UserRecord["role"] = "owner"): UserRecord {
  const timestamp = new Date().toISOString();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username,
    role,
    authVersion: 1,
    passkeyConfigured: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.createUser(user);
  return user;
}

function currentUser(user: UserRecord): CurrentUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isOwner: user.role === "owner",
    isAdmin: user.role === "owner" || user.role === "admin",
  };
}

function bearer(token: string): string {
  return ["Bearer", token].join(" ");
}

function jsonHeaders(baseUrl: string, token?: string): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    origin: baseUrl,
  });
  if (token) {
    headers.set("authorization", bearer(token));
  }
  return headers;
}

async function responseJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function startServer(input: {
  envPrefix: string;
  dataDir: string;
  store?: WebAppStore;
  auth?: WebAppServerConfig["auth"];
  routes?: RouteTable;
  publicRoutes?: WebAppServerConfig["publicRoutes"];
  web?: WebAppServerConfig["web"];
  requestFilter?: WebAppServerConfig["requestFilter"];
  passkeyDisabled?: boolean;
}): Promise<{
  app: ReturnType<typeof createWebAppServer>;
  store: WebAppStore;
  server: Awaited<ReturnType<ReturnType<typeof createWebAppServer>["start"]>>;
  baseUrl: string;
}> {
  const runtimeConfig: RuntimeConfig = {
    appName: "E2E Server",
    envPrefix: input.envPrefix,
    host: "127.0.0.1",
    port: 0,
    dataDir: input.dataDir,
    logLevel: "info",
    logLevelFromEnv: false,
    passkeyDisabled: input.passkeyDisabled ?? false,
    sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" },
    development: false,
  };
  const store = input.store ?? sqliteWebAppStore({ dataDir: input.dataDir });
  const app = createWebAppServer({
    appName: runtimeConfig.appName,
    envPrefix: input.envPrefix,
    runtimeConfig,
    web: input.web ?? testWeb,
    requestFilter: input.requestFilter,
    store,
    auth: input.auth,
    publicRoutes: input.publicRoutes,
    routes: input.routes ?? defineRoutes({}),
  });
  const server = await app.start();
  return {
    app,
    store,
    server,
    baseUrl: server.url.toString().replace(/\/$/, ""),
  };
}

test("captures more than 1,000 server log entries through the admin endpoint", async () => {
  const dataDir = testDataDir("server-log-capture");
  const store = memoryWebAppStore();
  store.initialize();
  const owner = createUser(store, "log-owner");
  const ownerKey = createApiKey(store, currentUser(owner), { name: "server log test key", scopes: ["*"] });
  const running = await startServer({
    envPrefix: "TEST_E2E_SERVER_LOG_CAPTURE",
    dataDir,
    store,
    auth: { passkeys: false, apiKeys: true },
    web: false,
  });

  try {
    const initialConfigResponse = await fetch(`${running.baseUrl}/api/config`);
    const initialConfig = await responseJson<{ inMemoryLogs: { enabled: boolean } }>(initialConfigResponse);
    expect(initialConfig.inMemoryLogs.enabled).toBe(false);
    const initialLogsResponse = await fetch(`${running.baseUrl}/api/server/logs`, {
      headers: { authorization: bearer(ownerKey.token) },
    });
    expect(await responseJson<{ enabled: boolean; logs: unknown[] }>(initialLogsResponse)).toEqual({
      enabled: false,
      logs: [],
    });

    const enabled = await fetch(`${running.baseUrl}/api/server/logs/settings`, {
      method: "PUT",
      headers: jsonHeaders(running.baseUrl, ownerKey.token),
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);

    const captureLogger = createLogger("server-log-capture-test");
    const consoleOutput = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (let index = 0; index < 1_001; index += 1) {
        captureLogger.info(`capture-entry:${index}`);
      }
      captureLogger.info(`capture-large:${"x".repeat(512 * 1024)}`);
    } finally {
      consoleOutput.mockRestore();
    }

    const response = await fetch(`${running.baseUrl}/api/server/logs`, {
      headers: { authorization: bearer(ownerKey.token) },
    });
    expect(response.status).toBe(200);
    const body = await responseJson<{ enabled: boolean; logs: Array<{ message: string }> }>(response);
    expect(body.enabled).toBe(true);
    const regularEntries = body.logs.filter((entry) => entry.message.startsWith("capture-entry:"));
    expect(regularEntries).toHaveLength(1_001);
    expect(regularEntries[0]?.message).toBe("capture-entry:0");
    expect(regularEntries.at(-1)?.message).toBe("capture-entry:1000");
    const largeEntry = body.logs.find((entry) => entry.message.startsWith("capture-large:"));
    expect(largeEntry?.message.length).toBeGreaterThan(512 * 1024);

    const disabled = await fetch(`${running.baseUrl}/api/server/logs/settings`, {
      method: "PUT",
      headers: jsonHeaders(running.baseUrl, ownerKey.token),
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    const afterDisable = await fetch(`${running.baseUrl}/api/server/logs`, {
      headers: { authorization: bearer(ownerKey.token) },
    });
    expect(await responseJson<{ enabled: boolean; logs: unknown[] }>(afterDisable)).toEqual({
      enabled: false,
      logs: [],
    });

    const reenabled = await fetch(`${running.baseUrl}/api/server/logs/settings`, {
      method: "PUT",
      headers: jsonHeaders(running.baseUrl, ownerKey.token),
      body: JSON.stringify({ enabled: true }),
    });
    expect(reenabled.status).toBe(200);

    const restartConsoleOutput = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      captureLogger.info("capture-before-clean-shutdown");
      await running.app.stop(true);
      const restartedServer = await running.app.start();
      captureLogger.info("capture-after-clean-shutdown");
      const restartedBaseUrl = restartedServer.url.toString().replace(/\/$/, "");
      const afterRestart = await fetch(`${restartedBaseUrl}/api/server/logs`, {
        headers: { authorization: bearer(ownerKey.token) },
      });
      const restartedLogs = await responseJson<{ enabled: boolean; logs: Array<{ message: string }> }>(afterRestart);
      const restartedConfig = await fetch(`${restartedBaseUrl}/api/config`);
      expect((await responseJson<{ inMemoryLogs: { enabled: boolean } }>(restartedConfig)).inMemoryLogs.enabled).toBe(true);
      expect(restartedLogs.enabled).toBe(true);
      expect(restartedLogs.logs.some((entry) => entry.message === "capture-before-clean-shutdown")).toBe(false);
      expect(restartedLogs.logs.some((entry) => entry.message === "capture-after-clean-shutdown")).toBe(true);
    } finally {
      restartConsoleOutput.mockRestore();
    }
  } finally {
    await running.app.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("persists server log capture preference across server instances", async () => {
  const dataDir = testDataDir("server-log-preference");
  let first: Awaited<ReturnType<typeof startServer>> | undefined;
  let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
  const envPrefix = "TEST_E2E_SERVER_LOG_PREFERENCE";

  try {
    first = await startServer({
      envPrefix,
      dataDir,
      auth: { passkeys: false, apiKeys: true },
      web: false,
    });
    const owner = createUser(first.store, "log-preference-owner");
    const ownerKey = createApiKey(first.store, currentUser(owner), {
      name: "server log preference test key",
      scopes: ["*"],
    });

    const initialConfig = await fetch(`${first.baseUrl}/api/config`);
    expect((await responseJson<{ inMemoryLogs: { enabled: boolean } }>(initialConfig)).inMemoryLogs.enabled).toBe(false);

    const enabled = await fetch(`${first.baseUrl}/api/server/logs/settings`, {
      method: "PUT",
      headers: jsonHeaders(first.baseUrl, ownerKey.token),
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);

    const captureLogger = createLogger("server-log-preference-test");
    const consoleOutput = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      captureLogger.info("before-server-instance-restart");
    } finally {
      consoleOutput.mockRestore();
    }
    await first.app.stop(true);

    restarted = await startServer({
      envPrefix,
      dataDir,
      auth: { passkeys: false, apiKeys: true },
      web: false,
    });

    const configAfterRestart = await fetch(`${restarted.baseUrl}/api/config`);
    expect((await responseJson<{ inMemoryLogs: { enabled: boolean } }>(configAfterRestart)).inMemoryLogs.enabled).toBe(true);

    const logsAfterRestart = await fetch(`${restarted.baseUrl}/api/server/logs`, {
      headers: { authorization: bearer(ownerKey.token) },
    });
    const restartedBody = await responseJson<{ enabled: boolean; logs: Array<{ message: string }> }>(logsAfterRestart);
    expect(restartedBody.enabled).toBe(true);
    expect(restartedBody.logs.some((entry) => entry.message === "before-server-instance-restart")).toBe(false);

    const restartConsoleOutput = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      captureLogger.info("after-server-instance-restart");
    } finally {
      restartConsoleOutput.mockRestore();
    }
    const logsAfterNewEntry = await fetch(`${restarted.baseUrl}/api/server/logs`, {
      headers: { authorization: bearer(ownerKey.token) },
    });
    const newBody = await responseJson<{ logs: Array<{ message: string }> }>(logsAfterNewEntry);
    expect(newBody.logs.some((entry) => entry.message === "after-server-instance-restart")).toBe(true);
  } finally {
    await restarted?.app.stop(true);
    await first?.app.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("starts without capture when restoring temporary server logs fails", async () => {
  const dataDir = testDataDir("server-log-storage-unavailable");
  const store = sqliteWebAppStore({ dataDir });
  store.initialize();
  store.setServerLogsEnabledPreference(true);
  const owner = createUser(store, "log-storage-unavailable-owner");
  const ownerKey = createApiKey(store, currentUser(owner), {
    name: "server log storage unavailable test key",
    scopes: ["*"],
  });
  const envPrefix = "TEST_E2E_SERVER_LOG_STORAGE_UNAVAILABLE";
  const runtimeConfig: RuntimeConfig = {
    appName: "E2E Server",
    envPrefix,
    host: "127.0.0.1",
    port: 0,
    dataDir,
    logLevel: "info",
    logLevelFromEnv: false,
    passkeyDisabled: false,
    sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" },
    development: false,
  };
  const previousTmpdir = process.env["TMPDIR"];
  const errorOutput = spyOn(console, "error").mockImplementation(() => undefined);
  process.env["TMPDIR"] = resolve(dataDir, "missing-temporary-directory");
  let stopApp: (() => Promise<void>) | undefined;

  try {
    const app = createWebAppServer({
      appName: runtimeConfig.appName,
      envPrefix,
      runtimeConfig,
      web: false,
      store,
      auth: { passkeys: false, apiKeys: true },
      routes: defineRoutes({}),
    });
    stopApp = () => app.stop(true);
    const server = await app.start();
    const baseUrl = server.url.toString().replace(/\/$/, "");
    const configResponse = await fetch(`${baseUrl}/api/config`);
    expect((await responseJson<{ inMemoryLogs: { enabled: boolean } }>(configResponse)).inMemoryLogs.enabled).toBe(false);

    const logsResponse = await fetch(`${baseUrl}/api/server/logs`, {
      headers: { authorization: bearer(ownerKey.token) },
    });
    expect(await responseJson<{ enabled: boolean; logs: unknown[] }>(logsResponse)).toEqual({
      enabled: false,
      logs: [],
    });
    expect(errorOutput).toHaveBeenCalled();
  } finally {
    if (previousTmpdir === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = previousTmpdir;
    }
    errorOutput.mockRestore();
    await stopApp?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("supports a headless server with a deny-by-default request surface", async () => {
  const dataDir = testDataDir("headless-request-filter");
  const running = await startServer({
    envPrefix: "TEST_E2E_HEADLESS_REQUEST_FILTER",
    dataDir,
    store: memoryWebAppStore(),
    auth: { passkeys: false },
    web: false,
    publicRoutes: {
      "/diagnostics.json": JSON.stringify({ exposed: true }),
    },
    routes: defineRoutes({
      "/api/worker": {
        auth: "public",
        sameOrigin: "never",
        GET: () => jsonResponse({ ok: true }),
      },
      "/api/blocked": {
        auth: "public",
        sameOrigin: "never",
        GET: () => jsonResponse({ exposed: true }),
      },
    }),
    requestFilter: (request) => {
      const path = new URL(request.url).pathname;
      return path === "/api/health" || path === "/api/worker";
    },
  });

  try {
    const health = await fetch(`${running.baseUrl}/api/health`);
    expect(health.status).toBe(200);

    const worker = await fetch(`${running.baseUrl}/api/worker`);
    expect(worker.status).toBe(200);
    expect(await worker.json()).toEqual({ ok: true });
    expect(await Bun.file(resolve(dataDir, "webapp.sqlite")).exists()).toBe(false);

    for (const path of ["/", "/projects", "/api/config", "/api/blocked", "/diagnostics.json"]) {
      const denied = await fetch(`${running.baseUrl}${path}`);
      expect(denied.status).toBe(404);
    }
  } finally {
    await running.server.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("requires headless mode when configuring a request filter", () => {
  expect(() => createWebAppServer({
    appName: "Filtered Server",
    envPrefix: "TEST_FILTERED_SERVER",
    web: testWeb,
    requestFilter: () => true,
  })).toThrow("requestFilter requires web: false");
});

test("serves framework and application public routes over HTTP", async () => {
  const dataDir = testDataDir("public-routes");
  const running = await startServer({
    envPrefix: "TEST_E2E_PUBLIC_ROUTES",
    dataDir,
    auth: { passkeys: false },
    publicRoutes: {
      "/diagnostics.json": {
        headers: { "content-type": "application/json" },
        GET: JSON.stringify({ app: "e2e", publicRoute: true }),
      },
    },
  });

  try {
    const health = await fetch(`${running.baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const document = await fetch(`${running.baseUrl}/projects`);
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toContain("text/html");

    const diagnostics = await fetch(`${running.baseUrl}/diagnostics.json`);
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toEqual({ app: "e2e", publicRoute: true });

    const missingMutation = await fetch(`${running.baseUrl}/api/missing`, { method: "POST" });
    expect(missingMutation.status).toBe(404);
    expect(await responseJson<{ error: string }>(missingMutation)).toMatchObject({ error: "not_found" });
  } finally {
    await running.server.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const provider of testStoreProviders) {
  test(`enforces API-key authentication, scopes, ownership, and CRUD over HTTP (${provider.name})`, async () => {
    const dataDir = testDataDir(`api-keys-${provider.name.toLowerCase()}`);
    const store = provider.create(dataDir);
    store.initialize();
    const owner = createUser(store, "owner");
    const alice = createUser(store, "alice", "user");
    const ownerKey = createApiKey(store, currentUser(owner), { name: "owner key", scopes: ["*"] });
    const aliceKey = createApiKey(store, currentUser(alice), { name: "alice key", scopes: ["read"] });
    const records = [
      { id: "owner-record", userId: owner.id },
      { id: "alice-record", userId: alice.id },
    ];
    const routes = defineRoutes({
      "/api/records": {
        auth: "user",
        scopes: ["read"],
        GET: (_request, context) => jsonResponse(context.filterOwned(records)),
      },
      "/api/private": {
        auth: "user",
        GET: () => jsonResponse({ ok: true }),
      },
      "/api/admin": {
        auth: "admin",
        GET: () => jsonResponse({ ok: true }),
      },
      "/api/write": {
        auth: "user",
        scopes: ["write"],
        POST: () => jsonResponse({ ok: true }),
      },
    });
    const running = await startServer({
      envPrefix: "TEST_E2E_API_KEYS",
      dataDir,
      store: provider.shareWithServer ? store : undefined,
      auth: { passkeys: false, apiKeys: true },
      routes,
    });

    try {
      const anonymous = await fetch(`${running.baseUrl}/api/records`);
      expect(anonymous.status).toBe(401);

      const ownRecords = await fetch(`${running.baseUrl}/api/records`, {
        headers: { authorization: bearer(aliceKey.token) },
      });
      expect(ownRecords.status).toBe(200);
      const ownRecordIds = (await responseJson<Array<{ id: string }>>(ownRecords)).map(({ id }) => id);
      expect(ownRecordIds).toEqual(["alice-record"]);

      const forbiddenPrivate = await fetch(`${running.baseUrl}/api/private`, {
        headers: { authorization: bearer(aliceKey.token) },
      });
      expect(forbiddenPrivate.status).toBe(403);
      expect(await forbiddenPrivate.json()).toMatchObject({ error: "insufficient_scope" });

      const unrestrictedPrivate = await fetch(`${running.baseUrl}/api/private`, {
        headers: { authorization: bearer(ownerKey.token) },
      });
      expect(unrestrictedPrivate.status).toBe(200);
      expect(await unrestrictedPrivate.json()).toEqual({ ok: true });

      const forbiddenAdmin = await fetch(`${running.baseUrl}/api/admin`, {
        headers: { authorization: bearer(aliceKey.token) },
      });
      expect(forbiddenAdmin.status).toBe(403);

      const missingScope = await fetch(`${running.baseUrl}/api/write`, {
        method: "POST",
        headers: jsonHeaders(running.baseUrl, aliceKey.token),
      });
      expect(missingScope.status).toBe(403);

      const forbiddenKeyCreation = await fetch(`${running.baseUrl}/api/api-keys`, {
        method: "POST",
        headers: jsonHeaders(running.baseUrl, aliceKey.token),
        body: JSON.stringify({ name: "Unrestricted key", scopes: ["*"] }),
      });
      expect(forbiddenKeyCreation.status).toBe(403);
      expect(await forbiddenKeyCreation.json()).toMatchObject({ error: "insufficient_scope" });

      const invalidToken = "wapp_invalid-token";
      const invalid = await fetch(`${running.baseUrl}/api/records`, {
        headers: { authorization: bearer(invalidToken) },
      });
      expect(invalid.status).toBe(401);
      const invalidBody = await invalid.text();
      expect(invalidBody).not.toContain(invalidToken);

      const listed = await fetch(`${running.baseUrl}/api/api-keys`, {
        headers: { authorization: bearer(ownerKey.token) },
      });
      expect(listed.status).toBe(200);
      const initialKeys = await responseJson<Array<{ id: string }>>(listed);
      expect(initialKeys.map(({ id }) => id)).toContain(ownerKey.key.id);

      const created = await fetch(`${running.baseUrl}/api/api-keys`, {
        method: "POST",
        headers: jsonHeaders(running.baseUrl, ownerKey.token),
        body: JSON.stringify({ name: "Created over HTTP", scopes: ["read"] }),
      });
      expect(created.status).toBe(200);
      const createdBody = await responseJson<{ key: { id: string } }>(created);

      const deleted = await fetch(`${running.baseUrl}/api/api-keys/${encodeURIComponent(createdBody.key.id)}`, {
        method: "DELETE",
        headers: jsonHeaders(running.baseUrl, ownerKey.token),
      });
      expect(deleted.status).toBe(200);

      const afterDelete = await fetch(`${running.baseUrl}/api/api-keys`, {
        headers: { authorization: bearer(ownerKey.token) },
      });
      const remainingKeys = await responseJson<Array<{ id: string }>>(afterDelete);
      expect(remainingKeys.map(({ id }) => id)).not.toContain(createdBody.key.id);
    } finally {
      await running.server.stop(true);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test(`completes device authorization and invalidates replayed refresh tokens over HTTP (${provider.name})`, async () => {
    const dataDir = testDataDir(`device-auth-${provider.name.toLowerCase()}`);
    const store = provider.create(dataDir);
    store.initialize();
    createUser(store, "owner");
    const routes = defineRoutes({
      "/api/private": {
        auth: "user",
        GET: () => jsonResponse({ ok: true }),
      },
      "/api/protected": {
        auth: "user",
        scopes: ["write"],
        POST: () => jsonResponse({ ok: true }),
      },
    });
    const running = await startServer({
      envPrefix: "TEST_E2E_DEVICE_AUTH",
      dataDir,
      store: provider.shareWithServer ? store : undefined,
      auth: { passkeys: true, deviceAuth: true, apiKeys: true },
      passkeyDisabled: true,
      routes,
    });

    try {
      const deviceResponse = await fetch(`${running.baseUrl}/api/auth/device`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: "e2e-cli", scope: "write" }),
      });
      expect(deviceResponse.status).toBe(200);
      const device = await responseJson<{ device_code: string; user_code: string }>(deviceResponse);

      const pending = await fetch(`${running.baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: "e2e-cli",
        }),
      });
      expect(pending.status).toBe(400);
      expect(await responseJson<{ error: string }>(pending)).toMatchObject({ error: "authorization_pending" });

      const approved = await fetch(`${running.baseUrl}/api/auth/device/approve`, {
        method: "POST",
        headers: jsonHeaders(running.baseUrl),
        body: JSON.stringify({ user_code: device.user_code }),
      });
      expect(approved.status).toBe(200);

      const tokenResponse = await fetch(`${running.baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: "e2e-cli",
        }),
      });
      expect(tokenResponse.status).toBe(200);
      const token = await responseJson<{ access_token: string; refresh_token: string }>(tokenResponse);

      const protectedResponse = await fetch(`${running.baseUrl}/api/protected`, {
        method: "POST",
        headers: jsonHeaders(running.baseUrl, token.access_token),
        body: JSON.stringify({}),
      });
      expect(protectedResponse.status).toBe(200);
      expect(await protectedResponse.json()).toEqual({ ok: true });

      const forbiddenPrivate = await fetch(`${running.baseUrl}/api/private`, {
        headers: { authorization: bearer(token.access_token) },
      });
      expect(forbiddenPrivate.status).toBe(403);
      expect(await forbiddenPrivate.json()).toMatchObject({ error: "insufficient_scope" });

      const forbiddenKeyCreation = await fetch(`${running.baseUrl}/api/api-keys`, {
        method: "POST",
        headers: jsonHeaders(running.baseUrl, token.access_token),
        body: JSON.stringify({ name: "Unrestricted key", scopes: ["*"] }),
      });
      expect(forbiddenKeyCreation.status).toBe(403);
      expect(await forbiddenKeyCreation.json()).toMatchObject({ error: "insufficient_scope" });

      const reusedDeviceCode = await fetch(`${running.baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: "e2e-cli",
        }),
      });
      expect(reusedDeviceCode.status).toBe(400);
      expect(await responseJson<{ error: string }>(reusedDeviceCode)).toMatchObject({ error: "invalid_grant" });

      const refreshed = await fetch(`${running.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: token.refresh_token, client_id: "e2e-cli" }),
      });
      expect(refreshed.status).toBe(200);
      const rotated = await responseJson<{ refresh_token: string }>(refreshed);
      expect(rotated.refresh_token).not.toBe(token.refresh_token);

      const replay = await fetch(`${running.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: token.refresh_token, client_id: "e2e-cli" }),
      });
      expect(replay.status).toBe(400);
      expect(await responseJson<{ error: string }>(replay)).toMatchObject({ error: "invalid_grant" });

      const familyRefresh = await fetch(`${running.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: rotated.refresh_token, client_id: "e2e-cli" }),
      });
      expect(familyRefresh.status).toBe(400);
    } finally {
      await running.server.stop(true);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
