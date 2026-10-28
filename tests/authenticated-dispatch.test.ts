import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createManagedApiKey, createWebAppServer, jsonResponse, memoryWebAppStore,
  type RuntimeConfig,
} from "@pablozaiden/webapp/server";
import { createUserRecord, toCurrentUser } from "../src/server/auth/users";

test("server-authenticated dispatch grants canonical application operations without issuing credentials", async () => {
  const store = memoryWebAppStore();
  store.initialize();
  const owner = createUserRecord({ username: "owner", role: "owner" });
  const admin = createUserRecord({ username: "admin", role: "admin" });
  const member = createUserRecord({ username: "member", role: "user" });
  for (const user of [owner, admin, member]) store.createUser(user);
  const authority = new AsyncLocalStorage<{ approved: boolean }>();
  const config: RuntimeConfig = {
    appName: "Dispatch", envPrefix: "DISPATCH_TEST", host: "127.0.0.1", port: 0,
    dataDir: ".cache/tests/dispatch", logLevel: "error", logLevelFromEnv: false,
    passkeyDisabled: false, sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
  };
  const app = createWebAppServer({
    appName: config.appName, envPrefix: config.envPrefix, runtimeConfig: config,
    store, web: false, auth: { apiKeys: true },
    routes: {
      "/api/admin/:id": {
        auth: "admin", sameOrigin: "always",
        POST: (_req, context) => jsonResponse({
          actor: context.requireAdmin().id, id: context.params["id"],
          approved: authority.getStore()?.approved, mode: context.auth.kind,
        }),
      },
      "/api/owner": { auth: "owner", GET: (_req, context) => jsonResponse({ actor: context.requireOwner().id }) },
      "/api/public": { auth: "public", GET: () => jsonResponse({ public: true }) },
    },
  });
  const request = (path = "/api/admin/a%20b", method = "POST") => new Request(`http://localhost${path}`, {
    method, headers: { authorization: "Bearer ignored-input", origin: "https://untrusted.invalid" },
  });
  const approve = { userId: admin.id, authorize: () => ({ approved: true }) };
  try {
    const response = await app.dispatchAuthenticated(request(), {
      ...approve,
      authorize(operation) {
        expect(operation.path).toBe("/api/admin/:id");
        expect(operation.params["id"]).toBe("a b");
        expect(operation.method).toBe("POST");
        return { approved: true };
      },
      run: (invocation, invoke) => authority.run(invocation.authorization, invoke),
    });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ actor: admin.id, id: "a b", approved: true, mode: "server" });
    expect(response?.headers.has("set-cookie")).toBe(false);
    expect((await app.dispatchAuthenticated(request(), { ...approve, authorize: () => false }))?.status).toBe(403);
    expect((await app.dispatchAuthenticated(request(), { ...approve, userId: member.id }))?.status).toBe(403);
    expect((await app.dispatchAuthenticated(request("/api/owner", "GET"), approve))?.status).toBe(403);
    expect((await app.dispatchAuthenticated(request("/api/owner", "GET"), { ...approve, userId: owner.id }))?.status).toBe(200);
    expect((await app.dispatchAuthenticated(request("/api/public", "GET"), approve))?.status).toBe(403);
    expect((await app.dispatchAuthenticated(request("/api/api-keys", "GET"), approve))?.status).toBe(404);
    expect((await app.dispatchAuthenticated(request(), { ...approve, userId: "missing" }))?.status).toBe(403);
    const delegatedAdmin = await app.dispatchDelegated(request(), { actor: { ...admin, isAdmin: true, isOwner: false }, authorize: () => ({}) });
    expect(delegatedAdmin?.status).toBe(403);

    // The remote control credential is only a front-door credential, not owner authority.
    const managed = createManagedApiKey(store, toCurrentUser(admin), { name: "Control", scopes: ["control"], managedBy: "test" });
    expect((await app.handleRequest(new Request("http://localhost/api/admin/a", {
      method: "POST", headers: { authorization: `Bearer ${managed.token}` },
    })))?.status).toBe(403);
    expect((await app.handleRequest(new Request("http://localhost/api/passkey-auth/api-key", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ apiKey: managed.token }),
    })))?.status).toBe(401);
    expect((await app.dispatchAuthenticated(request(), {
      ...approve,
      authorize() {
        store.setUserRole(admin.id, "user", new Date().toISOString());
        return {};
      },
    }))?.status).toBe(403);
    store.disableUser(member.id, new Date().toISOString());
    expect((await app.dispatchAuthenticated(request(), { ...approve, userId: member.id }))?.status).toBe(403);
  } finally {
    await app.stop(true);
  }
});
