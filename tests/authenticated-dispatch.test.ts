import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createManagedApiKey, createWebAppServer, findRouteCatalogEntry, jsonResponse, memoryWebAppStore,
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
  let middlewareWait: (() => Promise<void>) | undefined;
  let adminMutations = 0;
  const config: RuntimeConfig = {
    appName: "Dispatch", envPrefix: "DISPATCH_TEST", host: "127.0.0.1", port: 0,
    dataDir: ".cache/tests/dispatch", logLevel: "error", logLevelFromEnv: false,
    passkeyDisabled: false, sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
  };
  const app = createWebAppServer({
    appName: config.appName, envPrefix: config.envPrefix, runtimeConfig: config,
    version: "running-test-version",
    store, web: false, auth: { apiKeys: true },
    routeMiddleware: async (_request, _context, _operation, invoke) => {
      await middlewareWait?.();
      return await invoke();
    },
    routes: {
      "/api/admin/:id": {
        auth: "admin", sameOrigin: "always",
        POST: (_req, context) => {
          const actor = context.requireAdmin();
          adminMutations++;
          return jsonResponse({
            actor: actor.id, id: context.params["id"],
            approved: authority.getStore()?.approved, mode: context.auth.kind,
          });
        },
      },
      "/api/owner": { auth: "owner", GET: (_req, context) => jsonResponse({ actor: context.requireOwner().id }) },
      "/api/public": { auth: "public", GET: () => jsonResponse({ public: true }) },
      "/health": { auth: "public", GET: () => jsonResponse({ application: true }) },
    },
  });
  const request = (path = "/api/admin/a%20b", method = "POST") => new Request(`http://localhost${path}`, {
    method, headers: { authorization: "Bearer ignored-input", origin: "https://untrusted.invalid" },
  });
  const approve = { userId: admin.id, authorize: () => ({ approved: true }) };
  try {
    const server = await app.start();
    const health = await fetch(new URL("/api/health", server.url), {
      headers: { authorization: "Bearer expired-or-invalid-probe-token" },
    });
    expect(await health.json()).toMatchObject({ ok: true, version: "running-test-version" });
    expect(await (await fetch(new URL("/health", server.url))).json()).toEqual({ application: true });
    expect(findRouteCatalogEntry(app.routeCatalog, "health")?.entry.path).toBe("/health");
    expect(findRouteCatalogEntry(app.routeCatalog, "/api/health")?.entry.path).toBe("/api/health");
    expect(findRouteCatalogEntry(app.routeCatalog, "/api/health")?.entry.methods).toEqual(["GET"]);
    expect(findRouteCatalogEntry(app.routeCatalog, "/api/api-keys")).toBeUndefined();
    const diagnostic = request("/api/health", "GET");
    expect((await app.dispatchAuthenticated(diagnostic, approve))?.status).toBe(403);
    expect((await app.dispatchAuthenticated(diagnostic, { ...approve, allowPublic: true, authorize: () => false }))?.status).toBe(403);
    const admittedHealth = await app.dispatchAuthenticated(diagnostic, { ...approve, allowPublic: true });
    expect(await admittedHealth?.json()).toMatchObject({ ok: true, version: "running-test-version" });
    const admittedConfig = await app.dispatchAuthenticated(request("/api/config", "GET"), { ...approve, allowPublic: true });
    expect(await admittedConfig?.json()).toMatchObject({ currentUser: { id: admin.id }, version: "running-test-version" });
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
    for (const stage of ["authorize", "run", "middleware", "result"]) {
      store.setUserRole(admin.id, "admin", new Date().toISOString());
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const wait = async () => { entered.resolve(); await released.promise; };
      const before = adminMutations;
      middlewareWait = stage === "middleware" ? wait : undefined;
      try {
        const pending = app.dispatchAuthenticated(request(), {
          ...approve,
          authorize: async () => { if (stage === "authorize") await wait(); return {}; },
          run: async (_invocation, invoke) => {
            if (stage === "run") await wait();
            const response = await invoke();
            if (stage === "result") await wait();
            return response;
          },
        });
        await entered.promise;
        store.setUserRole(admin.id, "user", new Date().toISOString());
        released.resolve();
        expect((await pending)?.status).toBe(403);
        expect(adminMutations).toBe(before + (stage === "result" ? 1 : 0));
      } finally {
        released.resolve();
        middlewareWait = undefined;
      }
    }
    store.disableUser(member.id, new Date().toISOString());
    expect((await app.dispatchAuthenticated(request(), { ...approve, userId: member.id }))?.status).toBe(403);
  } finally {
    await app.stop(true);
  }
});
