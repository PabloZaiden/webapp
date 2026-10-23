import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import {
  createRouteCatalog, createWebAppServer, defineRoutes, jsonResponse, memoryWebAppStore,
  type DelegatedDispatchOptions, type RouteTable, type RuntimeConfig,
} from "@pablozaiden/webapp/server";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";

// Public contract: a verified transport invokes the same declared operation,
// without replacing the actor with the application's storage authority.
test("trusted delegated HTTP operations preserve guest identity and canonical route policy", async () => {
  const directory = resolve(".cache/tests", `delegation-${crypto.randomUUID()}`);
  const authority = new AsyncLocalStorage<{ ownerId: string; documentId: string }>();
  const actor: CurrentUser = { id: "guest", username: "Guest", role: "user", isAdmin: false, isOwner: false };
  let document = { id: "a b", text: "original", author: "controller-owner" };
  let relayBase = "";
  const metadata = {
    resource: "document", action: "read",
    bindings: [{ source: "param" as const, name: "id", resource: "document" }],
  };
  const routes: RouteTable = defineRoutes({
    "/api/documents/:id": {
      auth: "user", sameOrigin: "mutations", delegation: metadata,
      operations: { POST: { delegation: { ...metadata, action: "write" } }, DELETE: { delegation: false } },
      GET(_req, ctx) {
        return jsonResponse({
          ...document, id: ctx.params["id"], actor: ctx.requireUser().id,
          owner: authority.getStore()?.ownerId,
          delegated: ctx.auth.kind === "delegated",
        });
      },
      async POST(req, ctx) {
        const input = await req.json() as { text: string };
        if (typeof input.text !== "string") return jsonResponse({ error: "invalid_text" }, { status: 400 });
        document = { id: ctx.params["id"]!, text: input.text, author: ctx.requireUser().id };
        return jsonResponse(document, { status: 201 });
      },
      DELETE: () => jsonResponse({ deleted: true }),
    },
    "/api/owned": {
      auth: "user", sameOrigin: "mutations", delegation: metadata,
      GET: (_req, ctx) => jsonResponse(ctx.requireOwned({ userId: "controller-owner" })),
    },
    "/api/elevate": {
      auth: "user", sameOrigin: "mutations", delegation: metadata,
      GET: (_req, ctx) => jsonResponse(ctx.requireAdmin()),
    },
    "/api/admin": {
      auth: "admin", sameOrigin: "mutations", delegation: metadata,
      GET: () => jsonResponse({ secret: true }),
    },
    "/api/owner": {
      auth: "owner", sameOrigin: "mutations", delegation: metadata,
      GET: () => jsonResponse({ secret: true }),
    },
    "/api/undeclared": {
      auth: "user", sameOrigin: "mutations",
      GET: () => jsonResponse({ secret: true }),
    },
    "/api/catalog": {
      auth: "user", sameOrigin: "mutations",
      GET: () => jsonResponse(createRouteCatalog(routes)),
    },
  });
  const config: RuntimeConfig = {
    appName: "Delegation", envPrefix: "TEST_DELEGATION", host: "127.0.0.1", port: 0,
    dataDir: directory, logLevel: "error", logLevelFromEnv: false,
    passkeyDisabled: true, sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
  };
  const app = createWebAppServer({
    appName: config.appName, envPrefix: config.envPrefix, runtimeConfig: config,
    store: memoryWebAppStore(), web: false, routes,
    async routeMiddleware(req, ctx, operation, invoke) {
      if (!ctx.delegation && operation.params["id"]?.startsWith("source:")) {
        const remoteId = operation.params["id"].slice("source:".length);
        const response = await fetch(`${relayBase}/api/documents/${encodeURIComponent(remoteId)}`, {
          method: req.method, headers: { authorization: "Bearer admitted-relay" },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return response;
        const value = await response.json() as { id: string };
        return jsonResponse({ ...value, id: `source:${value.id}` }, { status: response.status });
      }
      return await invoke();
    },
  });
  const server = await app.start();
  const grant: DelegatedDispatchOptions<{ ownerId: string; documentId: string }> = {
    actor,
    authorize(operation) {
      if (operation.delegation.resource !== "document") return false;
      if (!["read", "write"].includes(operation.delegation.action)) return false;
      if (operation.path === "/api/documents/:id" && operation.params["id"] !== "a b") return false;
      return { ownerId: "controller-owner", documentId: operation.params["id"] ?? "" };
    },
    run: (invocation, invoke) => authority.run(invocation.authorization, invoke),
  };
  const relay = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer admitted-relay") return new Response(null, { status: 401 });
      return await app.dispatchDelegated(req, grant) ?? new Response(null, { status: 204 });
    },
  });
  relayBase = relay.url.origin;
  const request = (base: string, path: string, init?: RequestInit) => fetch(`${base}${path}`, {
    ...init, signal: AbortSignal.timeout(5_000),
  });
  const delegated = (path: string, init?: RequestInit) => request(relayBase, path, {
    ...init, headers: { authorization: "Bearer admitted-relay", ...init?.headers },
  });
  try {
    expect((await request(relayBase, "/api/documents/a%20b")).status).toBe(401);
    const accepted = await delegated("/api/documents/a%20b");
    expect(await accepted.json()).toMatchObject({
      id: "a b", text: "original", actor: "guest", owner: "controller-owner", delegated: true,
    });
    const written = await delegated("/api/documents/a%20b", {
      method: "POST", headers: { origin: "https://transport.invalid", "content-type": "application/json" },
      body: JSON.stringify({ text: "shared work" }),
    });
    expect(written.status).toBe(201);
    expect(await written.json()).toMatchObject({ text: "shared work", author: "guest" });
    expect((await delegated("/api/documents/not-granted")).status).toBe(403);
    expect((await delegated("/api/documents/a%20b", { method: "DELETE" })).status).toBe(403);
    for (const path of ["/api/admin", "/api/owner", "/api/elevate", "/api/undeclared", "/api/keys"]) {
      expect((await delegated(path)).status, path).toBeOneOf([403, 404]);
    }
    expect((await delegated("/api/owned")).status).toBe(404);
    const spoofed = await request(server.url.origin, "/api/documents/a%20b", {
      headers: { "x-webapp-delegated-user": "guest", "x-webapp-delegation": "document:read" },
    });
    expect(await spoofed.json()).toMatchObject({ delegated: false });
    expect((await request(server.url.origin, "/api/documents/a%20b", {
      method: "POST", headers: { "content-type": "application/json", "x-webapp-delegated-user": "guest" },
      body: JSON.stringify({ text: "spoofed" }),
    })).status).toBe(403);
    const unified = await request(server.url.origin, "/api/documents/source%3Aa%20b");
    expect(await unified.json()).toMatchObject({
      id: "source:a b", text: "shared work", actor: "guest", owner: "controller-owner",
    });
    const catalog = await (await request(server.url.origin, "/api/catalog")).json() as {
      path: string; delegation?: unknown; operations?: { DELETE?: { delegation?: unknown } };
    }[];
    expect(catalog.find(entry => entry.path === "/api/documents/:id")).toMatchObject({
      delegation: metadata, operations: { DELETE: { delegation: false } },
    });
  } finally {
    await relay.stop(true);
    await app.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
