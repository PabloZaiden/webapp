import { describe, expect, test } from "bun:test";
import { RealtimeBus, createWebAppServer, defineRoutes, jsonResponse, sqliteWebAppStore, type ResourceRealtimeEvent } from "@pablozaiden/webapp/server";
import { createApiKey } from "../src/server/auth/api-keys";
import { readRuntimeConfig } from "../src/server/runtime-config";
import type { UserRecord, WebAppStore } from "../src/server/auth/store";

function testStore(name: string) {
  return sqliteWebAppStore({ dataDir: `.cache/tests/${name}-${crypto.randomUUID()}` });
}

function configuredUser(store: WebAppStore, username = "owner", role: UserRecord["role"] = "owner"): UserRecord {
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    username,
    role,
    authVersion: 1,
    passkeyConfigured: false,
    createdAt: now,
    updatedAt: now,
  };
  store.createUser(user);
  return user;
}

function configuredPasskey(userId: string) {
  return {
    id: crypto.randomUUID(),
    userId,
    name: "Test passkey",
    credentialId: crypto.randomUUID(),
    publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    transports: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function currentUser(user: UserRecord) {
  return { id: user.id, username: user.username, role: user.role, isOwner: user.role === "owner", isAdmin: user.role === "owner" || user.role === "admin" };
}

async function responseJson<T>(response: Response | undefined): Promise<T> {
  expect(response).toBeDefined();
  return await response!.json() as T;
}

describe("server security defaults", () => {
  test("realtime bus publishes standard resource events with target filters", () => {
    const bus = new RealtimeBus<ResourceRealtimeEvent>();
    const projectMessages: string[] = [];
    const todoMessages: string[] = [];
    bus.add({ data: { filters: { resource: "projects" } }, send: (payload: string) => projectMessages.push(payload) } as never);
    bus.add({ data: { filters: { resource: "todos" } }, send: (payload: string) => todoMessages.push(payload) } as never);

    bus.publishEntityChanged("projects", "alpha");

    expect(projectMessages).toHaveLength(1);
    expect(todoMessages).toHaveLength(0);
    expect(JSON.parse(projectMessages[0]!)).toMatchObject({
      type: "event",
      event: { type: "projects.changed", resource: "projects", action: "changed", id: "alpha" },
    });
  });

  test("realtime user targets only deliver to the authenticated user socket", () => {
    const bus = new RealtimeBus<ResourceRealtimeEvent>();
    const ownerMessages: string[] = [];
    const aliceMessages: string[] = [];
    bus.add({ data: { userId: "owner" }, send: (payload: string) => ownerMessages.push(payload) } as never);
    bus.add({ data: { userId: "alice" }, send: (payload: string) => aliceMessages.push(payload) } as never);

    bus.publishEntityChanged("projects", "alpha", { target: { userId: "alice" } });

    expect(ownerMessages).toHaveLength(0);
    expect(aliceMessages).toHaveLength(1);
  });

  test("config exposes passkey bootstrap and disabled states", async () => {
    const enabledApp = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST",
      index: "<html></html>",
      store: testStore("passkey-enabled-config"),
      auth: { passkeys: true },
      routes: defineRoutes({}),
    });
    const enabledConfig = await responseJson<{ passkeyAuth: { enabled: boolean; passkeyConfigured: boolean; passkeyRequired: boolean } }>(await enabledApp.handleRequest(new Request("http://localhost/api/config")));
    expect(enabledConfig.passkeyAuth).toMatchObject({ enabled: true, passkeyConfigured: false, passkeyRequired: false });

    const disabledApp = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST",
      index: "<html></html>",
      store: testStore("passkey-disabled-config"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    });
    const disabledConfig = await responseJson<{ passkeyAuth: { enabled: boolean; authenticated: boolean } }>(await disabledApp.handleRequest(new Request("http://localhost/api/config")));
    expect(disabledConfig.passkeyAuth).toMatchObject({ enabled: false, authenticated: true });
  });

  test("emergency bypass still requires owner bootstrap when no owner exists", async () => {
    const previous = process.env["TEST_EMPTY_BYPASS_DISABLE_PASSKEY"];
    process.env["TEST_EMPTY_BYPASS_DISABLE_PASSKEY"] = "true";
    try {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_EMPTY_BYPASS",
        index: "<html></html>",
        store: testStore("empty-bypass-config"),
        auth: { passkeys: true },
        routes: defineRoutes({}),
      });
      const config = await responseJson<{ passkeyAuth: { bootstrapRequired: boolean; authenticated: boolean; passkeyDisabled: boolean } }>(await app.handleRequest(new Request("http://localhost/api/config")));
      expect(config.passkeyAuth).toMatchObject({ bootstrapRequired: true, authenticated: false, passkeyDisabled: true });
    } finally {
      if (previous === undefined) {
        delete process.env["TEST_EMPTY_BYPASS_DISABLE_PASSKEY"];
      } else {
        process.env["TEST_EMPTY_BYPASS_DISABLE_PASSKEY"] = previous;
      }
    }
  });

  test("runtime config names invalid prefixed log level variables", () => {
    const previous = process.env["TEST_LOG_LEVEL"];
    process.env["TEST_LOG_LEVEL"] = "verbose";
    try {
      expect(() => readRuntimeConfig({ appName: "Test", envPrefix: "TEST" })).toThrow("TEST_LOG_LEVEL");
    } finally {
      if (previous === undefined) {
        delete process.env["TEST_LOG_LEVEL"];
      } else {
        process.env["TEST_LOG_LEVEL"] = previous;
      }
    }
  });

  test("started server keeps device page disabled when device auth is disabled", async () => {
    const portPrevious = process.env["TEST_DEVICE_ROUTE_PORT"];
    const hostPrevious = process.env["TEST_DEVICE_ROUTE_HOST"];
    process.env["TEST_DEVICE_ROUTE_PORT"] = "0";
    process.env["TEST_DEVICE_ROUTE_HOST"] = "127.0.0.1";
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_DEVICE_ROUTE",
      index: "<html></html>",
      store: testStore("device-route-disabled"),
      auth: { deviceAuth: false },
      routes: defineRoutes({}),
    });
    const server = app.start();
    try {
      const response = await fetch(new URL("/device", server.url));
      expect(response.status).toBe(404);
    } finally {
      server.stop(true);
      if (portPrevious === undefined) {
        delete process.env["TEST_DEVICE_ROUTE_PORT"];
      } else {
        process.env["TEST_DEVICE_ROUTE_PORT"] = portPrevious;
      }
      if (hostPrevious === undefined) {
        delete process.env["TEST_DEVICE_ROUTE_HOST"];
      } else {
        process.env["TEST_DEVICE_ROUTE_HOST"] = hostPrevious;
      }
    }
  });

  test("protected routes reject anonymous requests after passkey bootstrap", async () => {
    const store = testStore("reject-anon");
    store.initialize();
    const user = configuredUser(store);
    store.savePasskey(configuredPasskey(user.id));
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST",
      index: "<html></html>",
      store,
      routes: defineRoutes({
        "/api/protected": {
          GET: () => jsonResponse({ ok: true }),
        },
      }),
    });

    const response = await app.handleRequest(new Request("http://localhost/api/protected"));
    expect(response?.status).toBe(401);
  });

  test("route auth helpers return auth errors instead of server errors", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST",
      index: "<html></html>",
      store: testStore("route-helper-auth-error"),
      routes: defineRoutes({
        "/api/current-user": {
          GET: (_req, ctx) => jsonResponse({ username: ctx.requireUser().username }),
        },
      }),
    });

    const response = await app.handleRequest(new Request("http://localhost/api/current-user"));
    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({ error: "authentication_required" });
  });

  test("declarative route auth enforces admin and owner roles", async () => {
    const store = testStore("declarative-route-auth");
    store.initialize();
    const owner = configuredUser(store);
    const alice = configuredUser(store, "alice", "user");
    const aliceKey = createApiKey(store, currentUser(alice), { name: "alice key", scopes: ["*"] });
    const ownerKey = createApiKey(store, currentUser(owner), { name: "owner key", scopes: ["*"] });
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_ROUTE_AUTH",
      index: "<html></html>",
      store,
      auth: { apiKeys: true },
      routes: defineRoutes({
        "/api/admin-only": {
          auth: "admin",
          GET: () => jsonResponse({ ok: true }),
        },
        "/api/owner-only": {
          auth: "owner",
          GET: () => jsonResponse({ ok: true }),
        },
      }),
    });

    const userAdmin = await app.handleRequest(new Request("http://localhost/api/admin-only", {
      headers: { authorization: `Bearer ${aliceKey.token}` },
    }));
    expect(userAdmin?.status).toBe(403);

    const ownerAdmin = await app.handleRequest(new Request("http://localhost/api/admin-only", {
      headers: { authorization: `Bearer ${ownerKey.token}` },
    }));
    expect(ownerAdmin?.status).toBe(200);

    const userOwner = await app.handleRequest(new Request("http://localhost/api/owner-only", {
      headers: { authorization: `Bearer ${aliceKey.token}` },
    }));
    expect(userOwner?.status).toBe(403);
  });

  test("owned resource helpers keep user data self-only", async () => {
    const store = testStore("owned-resource-helpers");
    store.initialize();
    const owner = configuredUser(store);
    const alice = configuredUser(store, "alice", "user");
    const aliceKey = createApiKey(store, currentUser(alice), { name: "alice key", scopes: ["*"] });
    const records = [
      { id: "owner-record", userId: owner.id, value: "owner" },
      { id: "alice-record", userId: alice.id, value: "alice" },
    ];
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_OWNED",
      index: "<html></html>",
      store,
      auth: { apiKeys: true },
      routes: defineRoutes({
        "/api/records": {
          auth: "user",
          GET: (_req, ctx) => jsonResponse(ctx.filterOwned(records)),
        },
        "/api/records/:id": {
          auth: "user",
          GET: (_req, ctx) => jsonResponse(ctx.requireOwned(records.find((record) => record.id === ctx.params.id))),
        },
      }),
    });

    const listed = await responseJson<Array<{ id: string }>>(await app.handleRequest(new Request("http://localhost/api/records", {
      headers: { authorization: `Bearer ${aliceKey.token}` },
    })));
    expect(listed.map((record) => record.id)).toEqual(["alice-record"]);

    const otherUserRecord = await app.handleRequest(new Request("http://localhost/api/records/owner-record", {
      headers: { authorization: `Bearer ${aliceKey.token}` },
    }));
    expect(otherUserRecord?.status).toBe(404);
  });

  test("API key POST works without Origin or Referer", async () => {
    const store = testStore("api-key-no-origin");
    store.initialize();
    const user = configuredUser(store);
    store.savePasskey(configuredPasskey(user.id));
    const { token } = createApiKey(store, currentUser(user), { name: "test", scopes: ["write"] });
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST",
      index: "<html></html>",
      store,
      auth: { apiKeys: true },
      routes: defineRoutes({
        "/api/protected": {
          scopes: ["write"],
          POST: () => jsonResponse({ ok: true }),
        },
      }),
    });

    const response = await app.handleRequest(new Request("http://localhost/api/protected", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(response?.status).toBe(200);
  });

  test("API key missing scope is rejected", async () => {
    const store = testStore("api-key-scope");
    store.initialize();
    const user = configuredUser(store);
    store.savePasskey(configuredPasskey(user.id));
    const { token } = createApiKey(store, currentUser(user), { name: "test", scopes: ["read"] });
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST",
      index: "<html></html>",
      store,
      auth: { apiKeys: true },
      routes: defineRoutes({
        "/api/protected": {
          scopes: ["write"],
          POST: () => jsonResponse({ ok: true }),
        },
      }),
    });

    const response = await app.handleRequest(new Request("http://localhost/api/protected", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(response?.status).toBe(403);
  });

  test("API keys can be created, listed and deleted through built-in routes", async () => {
    const previous = process.env["TEST_API_KEY_CRUD_DISABLE_PASSKEY"];
    process.env["TEST_API_KEY_CRUD_DISABLE_PASSKEY"] = "true";
    const store = testStore("api-key-crud");
    store.initialize();
    configuredUser(store);
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_API_KEY_CRUD",
      index: "<html></html>",
      store,
      auth: { apiKeys: true },
      routes: defineRoutes({}),
    });

    try {
      const created = await responseJson<{ key: { id: string } }>(await app.handleRequest(new Request("http://localhost/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ name: "Browser key", scopes: ["*"] }),
      })));
      expect(created.key.id).toBeTruthy();

      const listed = await responseJson<Array<{ id: string }>>(await app.handleRequest(new Request("http://localhost/api/api-keys")));
      expect(listed.map((key) => key.id)).toContain(created.key.id);

      const deleted = await app.handleRequest(new Request(`http://localhost/api/api-keys/${created.key.id}`, {
        method: "DELETE",
        headers: { origin: "http://localhost" },
      }));
      expect(deleted?.status).toBe(200);

      const deletedAgain = await app.handleRequest(new Request(`http://localhost/api/api-keys/${created.key.id}`, {
        method: "DELETE",
        headers: { origin: "http://localhost" },
      }));
      expect(deletedAgain?.status).toBe(200);

      const afterDelete = await responseJson<Array<{ id: string }>>(await app.handleRequest(new Request("http://localhost/api/api-keys")));
      expect(afterDelete.map((key) => key.id)).not.toContain(created.key.id);
    } finally {
      if (previous === undefined) {
        delete process.env["TEST_API_KEY_CRUD_DISABLE_PASSKEY"];
      } else {
        process.env["TEST_API_KEY_CRUD_DISABLE_PASSKEY"] = previous;
      }
    }
  });

  test("admins can create, reset, promote and delete users but not delete owner", async () => {
    const previous = process.env["TEST_USERS_DISABLE_PASSKEY"];
    process.env["TEST_USERS_DISABLE_PASSKEY"] = "true";
    const store = testStore("users-admin");
    store.initialize();
    const owner = configuredUser(store);
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_USERS",
      index: "<html></html>",
      store,
      routes: defineRoutes({}),
    });

    try {
      const created = await responseJson<{ user: { id: string; username: string; role: string }; setupLink: { url: string } }>(await app.handleRequest(new Request("http://localhost/api/users", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ username: "Alice", role: "user" }),
      })));
      expect(created.user).toMatchObject({ username: "alice", role: "user" });
      expect(created.setupLink.url).toContain("/setup?token=");

      const promoted = await responseJson<{ role: string }>(await app.handleRequest(new Request(`http://localhost/api/users/${created.user.id}/role`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ role: "admin" }),
      })));
      expect(promoted.role).toBe("admin");

      const reset = await responseJson<{ setupLink: { url: string } }>(await app.handleRequest(new Request(`http://localhost/api/users/${created.user.id}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: "{}",
      })));
      expect(reset.setupLink.url).toContain("/setup?token=");

      const resetOwner = await app.handleRequest(new Request(`http://localhost/api/users/${owner.id}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: "{}",
      }));
      expect(resetOwner?.status).toBe(409);

      const deleteOwner = await app.handleRequest(new Request(`http://localhost/api/users/${owner.id}`, {
        method: "DELETE",
        headers: { origin: "http://localhost" },
      }));
      expect(deleteOwner?.status).toBe(409);

      const deleted = await app.handleRequest(new Request(`http://localhost/api/users/${created.user.id}`, {
        method: "DELETE",
        headers: { origin: "http://localhost" },
      }));
      expect(deleted?.status).toBe(200);
    } finally {
      if (previous === undefined) {
        delete process.env["TEST_USERS_DISABLE_PASSKEY"];
      } else {
        process.env["TEST_USERS_DISABLE_PASSKEY"] = previous;
      }
    }
  });

  test("API keys are scoped to the authenticated user", async () => {
    const store = testStore("api-key-self-only");
    store.initialize();
    const owner = configuredUser(store);
    const alice = configuredUser(store, "alice", "user");
    const ownerKey = createApiKey(store, currentUser(owner), { name: "owner key", scopes: ["*"] });
    const aliceKey = createApiKey(store, currentUser(alice), { name: "alice key", scopes: ["*"] });
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_API_KEY_SELF",
      index: "<html></html>",
      store,
      auth: { apiKeys: true },
      routes: defineRoutes({}),
    });

    const listed = await responseJson<Array<{ id: string }>>(await app.handleRequest(new Request("http://localhost/api/api-keys", {
      headers: { authorization: `Bearer ${aliceKey.token}` },
    })));
    expect(listed.map((key) => key.id)).toEqual([aliceKey.key.id]);

    const deleteOwnerAsAlice = await app.handleRequest(new Request(`http://localhost/api/api-keys/${ownerKey.key.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${aliceKey.token}`, origin: "http://localhost" },
    }));
    expect(deleteOwnerAsAlice?.status).toBe(200);
    expect(store.listApiKeys(owner.id).map((key) => key.id)).toContain(ownerKey.key.id);
  });

  test("public routes remain public even after passkey bootstrap", async () => {
    const store = testStore("public");
    store.initialize();
    const user = configuredUser(store);
    store.savePasskey(configuredPasskey(user.id));
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST",
      index: "<html></html>",
      store,
      routes: defineRoutes({
        "/api/public": {
          auth: "public",
          sameOrigin: "never",
          POST: () => jsonResponse({ ok: true }),
        },
      }),
    });

    const response = await app.handleRequest(new Request("http://localhost/api/public", { method: "POST" }));
    expect(response?.status).toBe(200);
  });

  test("device flow issues one-use code, bearer access and rotated refresh tokens", async () => {
    const previous = process.env["TEST_DEVICE_FLOW_DISABLE_PASSKEY"];
    process.env["TEST_DEVICE_FLOW_DISABLE_PASSKEY"] = "true";
    const store = testStore("device-flow");
    store.initialize();
    configuredUser(store);
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_DEVICE_FLOW",
      index: "<html></html>",
      store,
      auth: { deviceAuth: true },
      routes: defineRoutes({
        "/api/protected": {
          scopes: ["write"],
          POST: (_req, ctx) => jsonResponse({ ok: true, auth: ctx.auth.kind }),
        },
      }),
    });

    try {
      const device = await responseJson<{ device_code: string; user_code: string }>(await app.handleRequest(new Request("http://localhost/api/auth/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "test-cli", scope: "write" }),
    })));

    const pending = await app.handleRequest(new Request("http://localhost/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: "test-cli" }),
    }));
    expect(pending?.status).toBe(400);
    expect(await pending?.json()).toMatchObject({ error: "authorization_pending" });

    const approved = await app.handleRequest(new Request("http://localhost/api/auth/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ user_code: device.user_code }),
    }));
    expect(approved?.status).toBe(200);

    const token = await responseJson<{ access_token: string; refresh_token: string }>(await app.handleRequest(new Request("http://localhost/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: "test-cli" }),
    })));
    expect(token.access_token).toBeTruthy();
    expect(token.refresh_token).toBeTruthy();

    const reused = await app.handleRequest(new Request("http://localhost/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: "test-cli" }),
    }));
    expect(reused?.status).toBe(400);
    expect(await reused?.json()).toMatchObject({ error: "invalid_grant" });

    const protectedResponse = await app.handleRequest(new Request("http://localhost/api/protected", {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}` },
    }));
    expect(protectedResponse?.status).toBe(200);
    expect(await protectedResponse?.json()).toMatchObject({ auth: "bearer" });

    const refreshed = await responseJson<{ access_token: string; refresh_token: string }>(await app.handleRequest(new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: token.refresh_token, client_id: "test-cli" }),
    })));
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(token.refresh_token);

    const staleRefresh = await app.handleRequest(new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: token.refresh_token, client_id: "test-cli" }),
    }));
    expect(staleRefresh?.status).toBe(400);
    expect(await staleRefresh?.json()).toMatchObject({ error: "invalid_grant" });
    } finally {
      if (previous === undefined) {
        delete process.env["TEST_DEVICE_FLOW_DISABLE_PASSKEY"];
      } else {
        process.env["TEST_DEVICE_FLOW_DISABLE_PASSKEY"] = previous;
      }
    }
  });
});
