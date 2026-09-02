import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { CurrentUser } from "../src/contracts";
import { createApiKey } from "../src/server/auth/api-keys";
import {
  createWebAppServer,
  defineRoutes,
  jsonResponse,
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
  auth?: WebAppServerConfig["auth"];
  routes?: RouteTable;
  publicRoutes?: WebAppServerConfig["publicRoutes"];
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
    inMemoryLogsEnabled: false,
    passkeyDisabled: input.passkeyDisabled ?? false,
    sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" },
    development: false,
  };
  const store = sqliteWebAppStore({ dataDir: input.dataDir });
  const app = createWebAppServer({
    appName: runtimeConfig.appName,
    envPrefix: input.envPrefix,
    runtimeConfig,
    web: testWeb,
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

test("enforces API-key authentication, scopes, ownership, and CRUD over HTTP", async () => {
  const dataDir = testDataDir("api-keys");
  const store = sqliteWebAppStore({ dataDir });
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
      GET: (_request, context) => jsonResponse(context.filterOwned(records)),
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

    const forbiddenAdmin = await fetch(`${running.baseUrl}/api/admin`, {
      headers: { authorization: bearer(aliceKey.token) },
    });
    expect(forbiddenAdmin.status).toBe(403);

    const missingScope = await fetch(`${running.baseUrl}/api/write`, {
      method: "POST",
      headers: jsonHeaders(running.baseUrl, aliceKey.token),
    });
    expect(missingScope.status).toBe(403);

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

test("completes device authorization and invalidates replayed refresh tokens over HTTP", async () => {
  const dataDir = testDataDir("device-auth");
  const store = sqliteWebAppStore({ dataDir });
  store.initialize();
  createUser(store, "owner");
  const routes = defineRoutes({
    "/api/protected": {
      auth: "user",
      scopes: ["write"],
      POST: () => jsonResponse({ ok: true }),
    },
  });
  const running = await startServer({
    envPrefix: "TEST_E2E_DEVICE_AUTH",
    dataDir,
    auth: { passkeys: true, deviceAuth: true },
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
