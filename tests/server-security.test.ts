import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { RealtimeBus, createWebAppServer, defineRoutes, jsonResponse, sqliteWebAppStore, type ResourceRealtimeEvent } from "@pablozaiden/webapp/server";
import { createApiKey } from "../src/server/auth/api-keys";
import { sha256 } from "../src/server/auth/crypto";
import { readRuntimeConfig } from "../src/server/runtime-config";
import type { UserRecord, WebAppStore } from "../src/server/auth/store";
import staticIndex from "./fixtures/static-index.html";

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

function isoOffset(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
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

  test("config extensions cannot override framework-owned fields", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_CONFIG_EXTENSION",
      index: "<html></html>",
      store: testStore("config-extension"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
      configResponse: () => ({
        appName: "Overridden",
        passkeyAuth: { enabled: true, authenticated: false },
        publicBasePath: "/proxy",
      }),
    });

    const config = await responseJson<{ appName: string; passkeyAuth: { enabled: boolean; authenticated: boolean }; publicBasePath: string }>(
      await app.handleRequest(new Request("http://localhost/api/config")),
    );

    expect(config.appName).toBe("Test");
    expect(config.passkeyAuth).toMatchObject({ enabled: false, authenticated: true });
    expect(config.publicBasePath).toBe("/proxy");
  });

  test("auth status reports anonymous requests as unauthenticated", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_AUTH_STATUS",
      index: "<html></html>",
      store: testStore("auth-status-anonymous"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    });

    const status = await responseJson<{ authenticated: boolean; authKind: string; subject: string | null; clientId: string | null; scope: string | null }>(
      await app.handleRequest(new Request("http://localhost/api/auth/status")),
    );

    expect(status).toEqual({
      authenticated: false,
      authKind: "anonymous",
      subject: null,
      clientId: null,
      scope: null,
    });
  });

  test("emergency bypass skips bootstrap and authenticates as local owner", async () => {
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
      const config = await responseJson<{ currentUser?: { username: string; isOwner: boolean }; passkeyAuth: { bootstrapRequired: boolean; authenticated: boolean; passkeyDisabled: boolean } }>(await app.handleRequest(new Request("http://localhost/api/config")));
      expect(config.passkeyAuth).toMatchObject({ bootstrapRequired: false, authenticated: true, passkeyDisabled: true });
      expect(config.currentUser).toMatchObject({ username: "admin", isOwner: true });
    } finally {
      if (previous === undefined) {
        delete process.env["TEST_EMPTY_BYPASS_DISABLE_PASSKEY"];
      } else {
        process.env["TEST_EMPTY_BYPASS_DISABLE_PASSKEY"] = previous;
      }
    }
  });

  test("passkey setup rejects IP hosts with a clear auth error", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_IP_PASSKEY",
      index: "<html></html>",
      store: testStore("ip-passkey"),
      auth: { passkeys: true },
      routes: defineRoutes({}),
    });

    const response = await app.handleRequest(new Request("http://127.0.0.1/api/passkey-auth/bootstrap/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner" }),
    }));
    const body = await responseJson<{ error: string; message: string }>(response);

    expect(response?.status).toBe(400);
    expect(body.error).toBe("invalid_passkey_host");
    expect(body.message).toContain("hostname");
  });

  test("public static routes are explicit and keep API 404 behavior", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_PUBLIC_ROUTES",
      index: "<html>index</html>",
      store: testStore("public-routes"),
      auth: { passkeys: false },
      publicRoutes: {
        "/manifest.webmanifest": {
          headers: { "content-type": "application/manifest+json" },
          GET: JSON.stringify({ name: "Test" }),
        },
        "/missing-public": () => undefined,
      },
      routes: defineRoutes({}),
    });

    const manifest = await app.handleRequest(new Request("http://localhost/manifest.webmanifest"));
    const manifestPost = await app.handleRequest(new Request("http://localhost/manifest.webmanifest", { method: "POST" }));
    const missingPublic = await app.handleRequest(new Request("http://localhost/missing-public"));
    const missingApi = await app.handleRequest(new Request("http://localhost/api/missing"));
    const spa = await app.handleRequest(new Request("http://localhost/projects"));

    expect(manifest?.headers.get("content-type")).toContain("application/manifest+json");
    expect(await manifest?.json()).toEqual({ name: "Test" });
    expect(manifestPost?.status).toBe(405);
    expect(manifestPost?.headers.get("x-frame-options")).toBe("DENY");
    expect(missingPublic?.status).toBe(404);
    expect(missingPublic?.headers.get("x-frame-options")).toBe("DENY");
    expect(missingApi?.status).toBe(404);
    const spaHtml = await spa?.text();
    expect(spaHtml).toContain("<html>index</html>");
    expect(spaHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  test("serves generated PWA manifest with defaults and method handling", async () => {
    const app = createWebAppServer({
      appName: "Test App",
      envPrefix: "TEST_PWA_DEFAULTS",
      index: "<html><head></head><body>index</body></html>",
      store: testStore("pwa-defaults"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    });

    const manifest = await app.handleRequest(new Request("http://localhost/manifest.webmanifest"));
    const manifestHead = await app.handleRequest(new Request("http://localhost/manifest.webmanifest", { method: "HEAD" }));
    const manifestPost = await app.handleRequest(new Request("http://localhost/manifest.webmanifest", { method: "POST" }));

    expect(manifest?.headers.get("content-type")).toContain("application/manifest+json");
    expect(await manifest?.json()).toEqual({
      name: "Test App",
      short_name: "Test App",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#111827",
      icons: [
        { src: "/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "/web-app-manifest-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    });
    expect(manifestHead?.status).toBe(200);
    expect(await manifestHead?.text()).toBe("");
    expect(manifestPost?.status).toBe(405);
    expect(manifestPost?.headers.get("x-frame-options")).toBe("DENY");
  });

  test("serves custom PWA metadata and injects head tags", async () => {
    const app = createWebAppServer({
      appName: "Test App",
      envPrefix: "TEST_PWA_CUSTOM",
      index: "<!doctype html><html><head><title>Test</title></head><body>index</body></html>",
      store: testStore("pwa-custom"),
      auth: { passkeys: false },
      pwa: {
        manifestPath: "/site.webmanifest",
        shortName: "Test",
        themeColor: "#242424",
        backgroundColor: "#f3f4f6",
        display: "minimal-ui",
        startUrl: "/app",
        scope: "/app/",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
        appleTouchIcon: { href: "/apple-touch-icon-180x180.png", sizes: "180x180" },
      },
      routes: defineRoutes({}),
    });

    const manifest = await app.handleRequest(new Request("http://localhost/site.webmanifest"));
    const htmlResponse = await app.handleRequest(new Request("http://localhost/app", { headers: { accept: "text/html" } }));
    const html = await htmlResponse?.text();

    expect(await manifest?.json()).toEqual({
      name: "Test App",
      short_name: "Test",
      start_url: "/app",
      scope: "/app/",
      display: "minimal-ui",
      background_color: "#f3f4f6",
      theme_color: "#242424",
      icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
    });
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml" sizes="any" />');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-180x180.png" />');
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Test" />');
    expect(html).toContain('<meta name="theme-color" content="#242424" />');
    expect(html?.indexOf('<link rel="manifest"')).toBeLessThan(html?.indexOf("</head>") ?? -1);
  });

  test("keeps explicit public manifest route precedence over generated PWA manifest", async () => {
    const app = createWebAppServer({
      appName: "Generated",
      envPrefix: "TEST_PWA_PRECEDENCE",
      index: "<html><head></head><body>index</body></html>",
      store: testStore("pwa-precedence"),
      auth: { passkeys: false },
      publicRoutes: {
        "/manifest.webmanifest": {
          headers: { "content-type": "application/manifest+json" },
          GET: JSON.stringify({ name: "Explicit" }),
        },
      },
      routes: defineRoutes({}),
    });

    const manifest = await app.handleRequest(new Request("http://localhost/manifest.webmanifest"));

    expect(await manifest?.json()).toEqual({ name: "Explicit" });
  });

  test("does not duplicate existing PWA head tags", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_PWA_DUPLICATES",
      index: '<html><head><link rel="manifest" href="/custom.webmanifest" /><meta name="theme-color" content="#000000" /></head><body>index</body></html>',
      store: testStore("pwa-duplicates"),
      auth: { passkeys: false },
      pwa: { shortName: "Duplicate Test", icons: [{ src: "/icon.png", sizes: "96x96", type: "image/png" }] },
      routes: defineRoutes({}),
    });

    const response = await app.handleRequest(new Request("http://localhost/"));
    const html = await response?.text();

    expect(html?.match(/rel="manifest"/g)).toHaveLength(1);
    expect(html?.match(/name="theme-color"/g)).toHaveLength(1);
    expect(html).toContain('<link rel="icon" href="/icon.png" type="image/png" sizes="96x96" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Duplicate Test" />');
  });

  test("started server serves public routes before static index catchall", async () => {
    const portPrevious = process.env["TEST_PUBLIC_STATIC_INDEX_PORT"];
    const hostPrevious = process.env["TEST_PUBLIC_STATIC_INDEX_HOST"];
    process.env["TEST_PUBLIC_STATIC_INDEX_PORT"] = "0";
    process.env["TEST_PUBLIC_STATIC_INDEX_HOST"] = "127.0.0.1";
    let stopServer: (() => void) | undefined;
    try {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_PUBLIC_STATIC_INDEX",
        index: staticIndex,
        store: testStore("public-static-index"),
        auth: { passkeys: false },
        publicRoutes: {
          "/manifest.webmanifest": {
            headers: { "content-type": "application/manifest+json" },
            GET: JSON.stringify({ name: "Static Index Test" }),
          },
        },
        routes: defineRoutes({}),
      });
      const server = app.start();
      stopServer = () => server.stop(true);
      const manifest = await fetch(new URL("/manifest.webmanifest", server.url));
      const fallback = await fetch(new URL("/anything-else", server.url));

      expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
      expect(await manifest.json()).toEqual({ name: "Static Index Test" });
      expect(fallback.headers.get("content-type")).toContain("text/html");
      expect(await fallback.text()).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    } finally {
      stopServer?.();
      if (portPrevious === undefined) {
        delete process.env["TEST_PUBLIC_STATIC_INDEX_PORT"];
      } else {
        process.env["TEST_PUBLIC_STATIC_INDEX_PORT"] = portPrevious;
      }
      if (hostPrevious === undefined) {
        delete process.env["TEST_PUBLIC_STATIC_INDEX_HOST"];
      } else {
        process.env["TEST_PUBLIC_STATIC_INDEX_HOST"] = hostPrevious;
      }
    }
  });

  test("app routes can perform public websocket upgrades", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_UPGRADE_ROUTE",
      index: "<html></html>",
      store: testStore("upgrade-route"),
      auth: { passkeys: false },
      routes: defineRoutes({
        "/terminal": {
          auth: "public",
          sameOrigin: "never",
          GET: (_req, ctx) => ctx.server?.upgrade(_req, { data: { webappSocketHandler: "terminal" } }) ? undefined : new Response("failed", { status: 400 }),
        },
      }),
    });
    const upgrades: unknown[] = [];
    const response = await app.handleRequest(new Request("http://localhost/terminal"), {
      upgrade: (_req: Request, options?: unknown) => {
        upgrades.push(options);
        return true;
      },
    } as never);

    expect(response).toBeUndefined();
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]).toMatchObject({ data: { webappSocketHandler: "terminal" } });
  });

  test("sqlite store migrates legacy single-user data to owner-owned records", () => {
    const dataDir = `.cache/tests/legacy-single-user-${crypto.randomUUID()}`;
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(`${dataDir}/webapp.sqlite`);
    const now = new Date().toISOString();
    db.exec(`
      CREATE TABLE webapp_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE webapp_passkeys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        transports TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE webapp_api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT
      );
      CREATE TABLE webapp_device_auth_requests (
        device_code_hash TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE webapp_refresh_sessions (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
    `);
    db.query("INSERT INTO webapp_preferences (key, value, updated_at) VALUES (?, ?, ?)").run("passkey.secret", "secret", now);
    db.query("INSERT INTO webapp_preferences (key, value, updated_at) VALUES (?, ?, ?)").run("theme", "dark", now);
    db.query(`
      INSERT INTO webapp_passkeys
      (id, name, credential_id, public_key, counter, device_type, backed_up, transports, created_at, updated_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("passkey-id", "Primary passkey", "credential-id", new Uint8Array([1, 2, 3]), 4, "singleDevice", 1, JSON.stringify(["internal"]), now, now, now);
    db.query("INSERT INTO webapp_api_keys (id, name, prefix, token_hash, scopes, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("api-key-id", "Legacy key", "wapp", "token-hash", JSON.stringify(["*"]), now, now, null);
    db.query("INSERT INTO webapp_device_auth_requests (device_code_hash, user_code, client_id, scope, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("device-hash", "ABCD-EFGH", "cli", "todos:read", "approved", now, now, now);
    db.query("INSERT INTO webapp_refresh_sessions (id, family_id, client_id, scope, refresh_token_hash, created_at, updated_at, expires_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("refresh-id", "family-id", "cli", "todos:read", "refresh-hash", now, now, now, null, null);
    db.close();

    const store = sqliteWebAppStore({ dataDir });
    store.initialize();
    const owner = store.getOwnerUser();

    expect(owner?.username).toBe("owner");
    expect(owner?.passkeyConfigured).toBe(true);
    expect(store.getPreference("passkey.secret")).toBe("secret");
    expect(store.getThemePreference(owner!.id)).toBe("dark");
    expect(store.listPasskeys(owner!.id)).toHaveLength(1);
    expect(store.listApiKeys(owner!.id)).toHaveLength(1);
    expect(store.getDeviceAuthByUserCode("ABCD-EFGH")?.approvedByUserId).toBe(owner!.id);
    expect(store.listRefreshSessions(owner!.id)).toHaveLength(1);

    store.initialize();
    expect(store.countUsers()).toBe(1);
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
    let stopServer: (() => void) | undefined;
    try {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_DEVICE_ROUTE",
        index: "<html></html>",
        store: testStore("device-route-disabled"),
        auth: { deviceAuth: false },
        routes: defineRoutes({}),
      });
      const server = app.start();
      stopServer = () => server.stop(true);
      const response = await fetch(new URL("/device", server.url));
      expect(response.status).toBe(404);
    } finally {
      stopServer?.();
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

  test("route handler generic errors return sanitized server errors", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_ROUTE_ERROR",
      index: "<html></html>",
      store: testStore("route-handler-error"),
      auth: { passkeys: false },
      routes: defineRoutes({
        "/api/boom": {
          auth: "public",
          GET: () => {
            throw new Error("secret database detail");
          },
        },
      }),
    });

    const loggedErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => loggedErrors.push(args.map(String).join(" "));
    let response: Response | undefined;
    try {
      response = await app.handleRequest(new Request("http://localhost/api/boom"));
    } finally {
      console.error = originalError;
    }
    const body = await responseJson<{ error: string; message: string }>(response);

    expect(response?.status).toBe(500);
    expect(body).toEqual({ error: "request_failed", message: "Request failed" });
    expect(loggedErrors.some((message) => message.includes("secret database detail"))).toBe(true);
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

  test("expired API keys are not listed and are purged", async () => {
    const store = testStore("api-key-expired-hidden");
    store.initialize();
    const owner = configuredUser(store);
    const activeKey = createApiKey(store, currentUser(owner), { name: "active key", scopes: ["*"], expiresAt: isoOffset(3600) });
    const expiredKey = createApiKey(store, currentUser(owner), { name: "expired key", scopes: ["*"], expiresAt: isoOffset(-3600) });
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_API_KEY_EXPIRED",
      index: "<html></html>",
      store,
      auth: { apiKeys: true },
      routes: defineRoutes({}),
    });

    const listed = await responseJson<Array<{ id: string }>>(await app.handleRequest(new Request("http://localhost/api/api-keys", {
      headers: { authorization: `Bearer ${activeKey.token}` },
    })));

    expect(listed.map((key) => key.id)).toEqual([activeKey.key.id]);
    expect(store.listApiKeys(owner.id).map((key) => key.id)).not.toContain(expiredKey.key.id);
  });

  test("auth session list only returns active sessions for the authenticated user", async () => {
    const store = testStore("auth-sessions-active-only");
    store.initialize();
    const owner = configuredUser(store);
    const alice = configuredUser(store, "alice", "user");
    const ownerKey = createApiKey(store, currentUser(owner), { name: "owner key", scopes: ["*"] });
    const now = new Date().toISOString();
    const activeSession = {
      id: crypto.randomUUID(),
      userId: owner.id,
      familyId: crypto.randomUUID(),
      clientId: "active-client",
      scope: "*",
      refreshTokenHash: sha256("active-refresh"),
      createdAt: now,
      updatedAt: now,
      expiresAt: isoOffset(3600),
    };
    const revokedSession = {
      id: crypto.randomUUID(),
      userId: owner.id,
      familyId: crypto.randomUUID(),
      clientId: "revoked-client",
      scope: "*",
      refreshTokenHash: sha256("revoked-refresh"),
      createdAt: now,
      updatedAt: now,
      expiresAt: isoOffset(3600),
      revokedAt: now,
    };
    const expiredSession = {
      id: crypto.randomUUID(),
      userId: owner.id,
      familyId: crypto.randomUUID(),
      clientId: "expired-client",
      scope: "*",
      refreshTokenHash: sha256("expired-refresh"),
      createdAt: now,
      updatedAt: now,
      expiresAt: isoOffset(-3600),
    };
    const otherUserSession = {
      id: crypto.randomUUID(),
      userId: alice.id,
      familyId: crypto.randomUUID(),
      clientId: "alice-client",
      scope: "*",
      refreshTokenHash: sha256("alice-refresh"),
      createdAt: now,
      updatedAt: now,
      expiresAt: isoOffset(3600),
    };
    store.saveRefreshSession(activeSession);
    store.saveRefreshSession(revokedSession);
    store.saveRefreshSession(expiredSession);
    store.saveRefreshSession(otherUserSession);
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_AUTH_SESSIONS_ACTIVE",
      index: "<html></html>",
      store,
      auth: { apiKeys: true, deviceAuth: true },
      routes: defineRoutes({}),
    });

    const listed = await responseJson<Array<{ id: string; active: boolean; clientId: string }>>(await app.handleRequest(new Request("http://localhost/api/auth/sessions", {
      headers: { authorization: `Bearer ${ownerKey.token}` },
    })));

    expect(listed.map((session) => ({ id: session.id, active: session.active, clientId: session.clientId })))
      .toEqual([{ id: activeSession.id, active: true, clientId: "active-client" }]);
    expect(store.listRefreshSessions(owner.id).map((session) => session.id)).not.toContain(expiredSession.id);
    expect(store.listRefreshSessions(owner.id).map((session) => session.id)).toContain(revokedSession.id);
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
