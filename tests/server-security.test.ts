import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { RealtimeBus, createWebAppServer, defineRoutes, jsonResponse, sqliteWebAppStore, type ResourceRealtimeEvent } from "@pablozaiden/webapp/server";
import { createApiKey } from "../src/server/auth/api-keys";
import { sha256 } from "../src/server/auth/crypto";
import { readRuntimeConfig, safeRuntimeConfig } from "../src/server/runtime-config";
import type { UserRecord, WebAppStore } from "../src/server/auth/store";

const testWeb = { entry: new URL("./fixtures/web/main.tsx", import.meta.url) };
const testIcon = new URL("./fixtures/web/icon.svg", import.meta.url);
const fixedViewportTokens = ["width=device-width", "initial-scale=1", "maximum-scale=1", "user-scalable=no", "viewport-fit=cover"] as const;

function testStore(name: string) {
  return sqliteWebAppStore({ dataDir: `.cache/tests/${name}-${crypto.randomUUID()}` });
}

function expectFixedViewportMetadata(html: string | undefined): void {
  const viewportTags = html?.match(/<meta\b(?=[^>]*\bname\s*=\s*["']viewport["'])[^>]*>/gi) ?? [];
  expect(viewportTags).toHaveLength(1);
  const viewportContent = viewportTags[0]?.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
  const viewportTokens = viewportContent.split(",").map((token) => token.trim()).filter(Boolean);
  for (const token of fixedViewportTokens) {
    expect(viewportTokens).toContain(token);
  }
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

async function withEnv<T>(values: Record<string, string>, callback: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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
      store: testStore("passkey-enabled-config"),
      auth: { passkeys: true },
      routes: defineRoutes({}),
    });
    const enabledConfig = await responseJson<{ passkeyAuth: { enabled: boolean; passkeyConfigured: boolean; passkeyRequired: boolean } }>(await enabledApp.handleRequest(new Request("http://localhost/api/config")));
    expect(enabledConfig.passkeyAuth).toMatchObject({ enabled: true, passkeyConfigured: false, passkeyRequired: false });

    const disabledApp = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST",
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
      web: testWeb,
      store: testStore("public-routes"),
      auth: { passkeys: false },
      publicRoutes: {
        "/missing-public": () => undefined,
      },
      routes: defineRoutes({}),
    });

    const manifest = await app.handleRequest(new Request("http://localhost/site.webmanifest"));
    const manifestHead = await app.handleRequest(new Request("http://localhost/site.webmanifest", { method: "HEAD" }));
    const manifestPost = await app.handleRequest(new Request("http://localhost/site.webmanifest", { method: "POST" }));
    const defaultIcon = await app.handleRequest(new Request("http://localhost/webapp-icon.svg"));
    const missingPublic = await app.handleRequest(new Request("http://localhost/missing-public"));
    const missingApi = await app.handleRequest(new Request("http://localhost/api/missing"));
    const spa = await app.handleRequest(new Request("http://localhost/projects"));
    const spaHead = await app.handleRequest(new Request("http://localhost/projects", { method: "HEAD" }));
    const spaPost = await app.handleRequest(new Request("http://localhost/projects", { method: "POST" }));

    expect(manifest?.headers.get("content-type")).toContain("application/manifest+json");
    expect(await manifest?.json()).toMatchObject({ name: "Test", display: "standalone" });
    expect(manifestHead?.status).toBe(200);
    expect(manifestHead?.headers.get("content-type")).toContain("application/manifest+json");
    expect(await manifestHead?.text()).toBe("");
    expect(manifestPost?.status).toBe(405);
    expect(manifestPost?.headers.get("x-frame-options")).toBe("DENY");
    expect(missingPublic?.status).toBe(404);
    expect(missingPublic?.headers.get("x-frame-options")).toBe("DENY");
    expect(missingApi?.status).toBe(404);
    const spaHtml = await spa?.text();
    expect(spaHtml).toContain('<div id="root"></div>');
    expect(spaHtml).toContain('manifest.href = "/site.webmanifest"');
    expect(await defaultIcon?.text()).toContain('fill="#111827"');
    expect(spaHead?.status).toBe(200);
    expect(spaPost?.status).toBe(404);
    expect(spaPost?.headers.get("content-type")).toContain("application/json");
    expect(await spaPost?.json()).toMatchObject({ error: "not_found" });
  });

  test("generates framework-owned manifest routes and HTML metadata", async () => {
    const app = createWebAppServer({
      appName: "Test App",
      envPrefix: "TEST_NATIVE_MANIFEST",
      web: {
        ...testWeb,
        shortName: "Test",
        icons: {
          favicon: { src: testIcon, type: "image/svg+xml", sizes: "any" },
          appleTouch: { src: testIcon, type: "image/svg+xml", sizes: "any" },
          manifest: [{ src: testIcon, type: "image/svg+xml", sizes: "any", purpose: "any maskable" }],
        },
      },
      store: testStore("native-manifest"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    });

    const manifest = await app.handleRequest(new Request("http://localhost/manifest.webmanifest"));
    const favicon = await app.handleRequest(new Request("http://localhost/webapp-favicon.svg"));
    const htmlResponse = await app.handleRequest(new Request("http://localhost/app", { headers: { accept: "text/html" } }));

    expect(manifest?.headers.get("content-type")).toContain("application/manifest+json");
    expect(await manifest?.json()).toMatchObject({
      name: "Test App",
      short_name: "Test",
      icons: [{ src: "./webapp-icon-1.svg", type: "image/svg+xml", sizes: "any" }],
    });
    expect(favicon?.headers.get("content-type")).toContain("image/svg+xml");
    const html = await htmlResponse?.text();
    expectFixedViewportMetadata(html);
    expect(html).toContain("<title>Test App</title>");
    expect(html).toContain('manifest.href = "/site.webmanifest"');
    expect(html).toContain("webapp.theme");
    expect(html).toContain('<script type="module"');
  });

  test("keeps fixed viewport metadata when PWA is disabled", async () => {
    const app = createWebAppServer({
      appName: "No PWA Test",
      envPrefix: "TEST_NO_PWA_VIEWPORT",
      web: { ...testWeb, pwa: false },
      auth: { passkeys: false },
      routes: defineRoutes({}),
    });

    const htmlResponse = await app.handleRequest(new Request("http://localhost/", { headers: { accept: "text/html" } }));
    expectFixedViewportMetadata(await htmlResponse?.text());
  });

  test("compiled client documents preserve renderer script order and serve assets", async () => {
    const compiledClientSymbol = Symbol.for("webapp.compiledClient");
    const globalWithCompiledClient = globalThis as Record<symbol, unknown>;
    globalWithCompiledClient[compiledClientSymbol] = {
      packageRoot: process.cwd(),
      assets: [
        {
          path: "/webapp-compiled/webapp-client-entry.js",
          contentType: "text/javascript; charset=utf-8",
          role: "script",
          scriptOrder: 1,
          body: Buffer.from("import '/webapp-compiled/chunk.js';\nwindow.__clientLoaded = true;\n").toString("base64"),
        },
        {
          path: "/webapp-compiled/webapp-renderer-prelude.js",
          contentType: "text/javascript; charset=utf-8",
          role: "script",
          scriptOrder: 0,
          body: Buffer.from("window.__rendererConfigured = true;\n").toString("base64"),
        },
        {
          path: "/webapp-compiled/chunk.js",
          contentType: "text/javascript; charset=utf-8",
          role: "asset",
          body: Buffer.from("export const chunk = true;\n").toString("base64"),
        },
        {
          path: "/webapp-compiled/webapp-client-entry.css",
          contentType: "text/css; charset=utf-8",
          role: "style",
          body: Buffer.from(".compiled { color: red; }\n").toString("base64"),
        },
      ],
    };
    try {
      const app = createWebAppServer({
        appName: "Compiled Test",
        envPrefix: "TEST_COMPILED_CLIENT",
        auth: { passkeys: false },
        routes: defineRoutes({}),
      });

      const htmlResponse = await app.handleRequest(new Request("http://localhost/"));
      const html = await htmlResponse?.text();
      expectFixedViewportMetadata(html);
      expect(html).toContain('<link rel="stylesheet" href="/webapp-compiled/webapp-client-entry.css" />');
      const rendererIndex = html?.indexOf('<script type="module" src="/webapp-compiled/webapp-renderer-prelude.js"></script>') ?? -1;
      const clientIndex = html?.indexOf('<script type="module" src="/webapp-compiled/webapp-client-entry.js"></script>') ?? -1;
      expect(rendererIndex).toBeGreaterThanOrEqual(0);
      expect(clientIndex).toBeGreaterThan(rendererIndex);

      const prelude = await app.handleRequest(new Request("http://localhost/webapp-compiled/webapp-renderer-prelude.js"));
      expect(prelude?.status).toBe(200);
      expect(prelude?.headers.get("content-type")).toContain("text/javascript");
      expect(await prelude?.text()).toContain("__rendererConfigured");

      const chunk = await app.handleRequest(new Request("http://localhost/webapp-compiled/chunk.js"));
      expect(chunk?.status).toBe(200);
      expect(await chunk?.text()).toContain("chunk = true");
    } finally {
      delete globalWithCompiledClient[compiledClientSymbol];
    }
  });

  test("embeds theme colors as JavaScript string literals", async () => {
    const app = createWebAppServer({
      appName: "Theme Test",
      envPrefix: "TEST_THEME_LITERAL",
      web: {
        ...testWeb,
        themeColor: String.raw`#123";\nwindow.__bad=true;//`,
      },
      store: testStore("theme-literal"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    });

    const htmlResponse = await app.handleRequest(new Request("http://localhost/app", { headers: { accept: "text/html" } }));
    const manifestResponse = await app.handleRequest(new Request("http://localhost/site.webmanifest"));
    const html = await htmlResponse?.text();
    const manifest = await manifestResponse?.json() as Record<string, unknown>;

    expect(html).toContain(JSON.stringify(String.raw`#123";\nwindow.__bad=true;//`));
    expect(html).toContain('name="theme-color"');
    expect(manifest.theme_color).toBe(String.raw`#123";\nwindow.__bad=true;//`);
    expect(html).not.toContain('content = resolved === "dark" ? "#123";\\nwindow.__bad=true;//"');
  });

  test("uses a sanitized temp cache path for generated documents", async () => {
    expect(() => createWebAppServer({
      appName: "Bad Cache Test",
      envPrefix: "TEST/../CACHE PREFIX",
      web: testWeb,
      store: testStore("bad-cache-path"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    })).toThrow("envPrefix must match");

    const envPrefix = "TEST_CACHE_PREFIX";
    const sanitized = "test_cache_prefix";
    const app = createWebAppServer({
      appName: "Cache Test",
      envPrefix,
      web: testWeb,
      store: testStore("cache-path"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    });

    const server = await app.start();
    try {
      const root = join(tmpdir(), "webapp", sanitized);
      expect(existsSync(root)).toBe(true);
      expect(readdirSync(root).some((entry) => entry.startsWith("webapp-document-"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("rejects non-local web document entry and icon URLs", () => {
    expect(() => createWebAppServer({
      appName: "Remote Entry",
      envPrefix: "TEST_REMOTE_ENTRY",
      web: { entry: new URL("https://example.com/main.tsx") },
      store: testStore("remote-entry"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    })).toThrow("web.entry must be a local file path or file: URL");

    expect(() => createWebAppServer({
      appName: "Remote Icon",
      envPrefix: "TEST_REMOTE_ICON",
      web: { ...testWeb, icons: { favicon: { src: new URL("https://example.com/icon.png") } } },
      store: testStore("remote-icon"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    })).toThrow("web.icons src must be a local file path or file: URL");
  });

  test("started server serves framework document and public routes before SPA catchall", async () => {
    const portPrevious = process.env["TEST_PUBLIC_STATIC_INDEX_PORT"];
    const hostPrevious = process.env["TEST_PUBLIC_STATIC_INDEX_HOST"];
    process.env["TEST_PUBLIC_STATIC_INDEX_PORT"] = "0";
    process.env["TEST_PUBLIC_STATIC_INDEX_HOST"] = "127.0.0.1";
    let stopServer: (() => void) | undefined;
    try {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_PUBLIC_STATIC_INDEX",
        web: testWeb,
        store: testStore("public-static-index"),
        auth: { passkeys: false, deviceAuth: true },
        publicRoutes: {
          "/diagnostics.json": {
            headers: { "content-type": "application/json" },
            GET: JSON.stringify({ ok: true }),
          },
        },
        routes: defineRoutes({}),
      });
      const server = await app.start();
      stopServer = () => server.stop(true);
      const diagnostics = await fetch(new URL("/diagnostics.json", server.url));
      const manifest = await fetch(new URL("/site.webmanifest", server.url));
      const fallback = await fetch(new URL("/anything-else", server.url));
      const devicePage = await fetch(new URL("/device", server.url));
      const postFallback = await fetch(new URL("/anything-else", server.url), { method: "POST" });

      expect(diagnostics.headers.get("content-type")).toContain("application/json");
      expect(await diagnostics.json()).toEqual({ ok: true });
      expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
      expect(await manifest.json()).toMatchObject({ name: "Test" });
      expect(fallback.headers.get("content-type")).toContain("text/html");
      const html = await fallback.text();
      expect(html).toContain('<div id="root"></div>');
      const clientScript = html.match(/src="([^"]*\/_bun\/client\/[^"]+\.js)"/)?.[1];
      expect(clientScript).toBeTruthy();
      const generatedEntry = await fetch(new URL(clientScript!, server.url));
      expect(generatedEntry.headers.get("content-type")).toContain("javascript");
      expect(devicePage.headers.get("content-type")).toContain("text/html");
      const deviceHtml = await devicePage.text();
      expect(deviceHtml).toContain(clientScript!);
      expect(deviceHtml).not.toContain('src="webapp-prelude.ts"');
      expect(postFallback.status).toBe(404);
      expect(postFallback.headers.get("content-type")).toContain("application/json");
      expect(await postFallback.json()).toMatchObject({ error: "not_found" });
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

  test("runtime config disables forwarded-header trust by default", () => {
    const config = readRuntimeConfig({ appName: "Test", envPrefix: "TEST_RUNTIME_TRUST_DEFAULT" });
    expect(config.trustProxy).toEqual({ enabled: false, headers: [], chain: "first" });
    expect(safeRuntimeConfig(config).trustProxy).toEqual({ enabled: false, headers: [], chain: "first" });
  });

  test("runtime config parses the explicit trust-proxy policy", () => {
    const keys = [
      "TEST_RUNTIME_TRUST_ENABLED_TRUST_PROXY",
      "TEST_RUNTIME_TRUST_ENABLED_TRUST_PROXY_HEADERS",
      "TEST_RUNTIME_TRUST_ENABLED_TRUST_PROXY_CHAIN",
    ] as const;
    const previous = keys.map((key) => process.env[key]);
    process.env[keys[0]] = "yes";
    process.env[keys[1]] = "proto, host";
    process.env[keys[2]] = "last";
    try {
      const config = readRuntimeConfig({ appName: "Test", envPrefix: "TEST_RUNTIME_TRUST_ENABLED" });
      expect(config.trustProxy).toEqual({ enabled: true, headers: ["proto", "host"], chain: "last" });
      expect(safeRuntimeConfig(config).trustProxy).toEqual({ enabled: true, headers: ["proto", "host"], chain: "last" });
    } finally {
      keys.forEach((key, index) => {
        const value = previous[index];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    }
  });

  test("runtime config rejects invalid trust-proxy values", () => {
    const invalidCases = [
      {
        key: "TEST_RUNTIME_TRUST_INVALID_HEADER_TRUST_PROXY_HEADERS",
        value: "proto,forwarded",
        message: "TEST_RUNTIME_TRUST_INVALID_HEADER_TRUST_PROXY_HEADERS",
        envPrefix: "TEST_RUNTIME_TRUST_INVALID_HEADER",
      },
      {
        key: "TEST_RUNTIME_TRUST_INVALID_CHAIN_TRUST_PROXY_CHAIN",
        value: "nearest",
        message: "TEST_RUNTIME_TRUST_INVALID_CHAIN_TRUST_PROXY_CHAIN",
        envPrefix: "TEST_RUNTIME_TRUST_INVALID_CHAIN",
      },
      {
        key: "TEST_RUNTIME_TRUST_INVALID_BOOLEAN_TRUST_PROXY",
        value: "sometimes",
        message: "TEST_RUNTIME_TRUST_INVALID_BOOLEAN_TRUST_PROXY",
        envPrefix: "TEST_RUNTIME_TRUST_INVALID_BOOLEAN",
      },
    ] as const;
    for (const testCase of invalidCases) {
      const previous = process.env[testCase.key];
      process.env[testCase.key] = testCase.value;
      try {
        expect(() => readRuntimeConfig({ appName: "Test", envPrefix: testCase.envPrefix })).toThrow(testCase.message);
      } finally {
        if (previous === undefined) {
          delete process.env[testCase.key];
        } else {
          process.env[testCase.key] = previous;
        }
      }
    }
  });

  test("ignores forwarded origin and prefix headers by default", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_PROXY_DEFAULT_BEHAVIOR",
      store: testStore("proxy-default-behavior"),
      auth: { passkeys: true },
      routes: defineRoutes({
        "/api/proxy-origin": {
          auth: "public",
          POST: () => jsonResponse({ ok: true }),
        },
      }),
    });
    const forwardedHeaders = {
      origin: "http://localhost",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "attacker.example.test",
      "x-forwarded-prefix": "/attacker",
    };
    const routeResponse = await app.handleRequest(new Request("http://localhost/api/proxy-origin", {
      method: "POST",
      headers: forwardedHeaders,
    }));
    expect(routeResponse?.status).toBe(200);

    const optionsResponse = await app.handleRequest(new Request("http://localhost/api/passkey-auth/bootstrap/options", {
      method: "POST",
      headers: { ...forwardedHeaders, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner" }),
    }));
    const options = await responseJson<{ rp?: { id?: string } }>(optionsResponse);
    const cookie = optionsResponse?.headers.get("set-cookie") ?? "";
    expect(options.rp?.id).toBe("localhost");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Path=/attacker");
    expect(cookie).not.toMatch(/(?:^|; )Secure(?:;|$)/);
  });

  test("uses the configured forwarded origin and prefix in trusted mode", async () => {
    await withEnv({
      TEST_PROXY_TRUSTED_TRUST_PROXY: "true",
      TEST_PROXY_TRUSTED_TRUST_PROXY_HEADERS: "proto,host,prefix",
      TEST_PROXY_TRUSTED_TRUST_PROXY_CHAIN: "first",
    }, async () => {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_PROXY_TRUSTED",
        store: testStore("proxy-trusted"),
        auth: { passkeys: true },
        routes: defineRoutes({
          "/api/proxy-origin": {
            auth: "public",
            POST: () => jsonResponse({ ok: true }),
          },
        }),
      });
      const forwardedHeaders = {
        origin: "https://app.example.test",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.example.test",
        "x-forwarded-prefix": "/proxy/",
      };
      const routeResponse = await app.handleRequest(new Request("http://internal.example.test/api/proxy-origin", {
        method: "POST",
        headers: forwardedHeaders,
      }));
      expect(routeResponse?.status).toBe(200);

      const optionsResponse = await app.handleRequest(new Request("http://internal.example.test/api/passkey-auth/bootstrap/options", {
        method: "POST",
        headers: { ...forwardedHeaders, "content-type": "application/json" },
        body: JSON.stringify({ username: "owner" }),
      }));
      const options = await responseJson<{ rp?: { id?: string } }>(optionsResponse);
      const cookie = optionsResponse?.headers.get("set-cookie") ?? "";
      expect(options.rp?.id).toBe("app.example.test");
      expect(cookie).toContain("Path=/proxy");
      expect(cookie).toMatch(/(?:^|; )Secure(?:;|$)/);
    });
  });

  test("selects the documented forwarded chain value", async () => {
    const route = defineRoutes({
      "/api/proxy-chain": {
        auth: "public",
        POST: () => jsonResponse({ ok: true }),
      },
    });
    const headers = {
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "first.example.test, last.example.test",
    };

    await withEnv({
      TEST_PROXY_CHAIN_FIRST_TRUST_PROXY: "true",
      TEST_PROXY_CHAIN_FIRST_TRUST_PROXY_HEADERS: "proto,host",
      TEST_PROXY_CHAIN_FIRST_TRUST_PROXY_CHAIN: "first",
    }, async () => {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_PROXY_CHAIN_FIRST",
        store: testStore("proxy-chain-first"),
        auth: { passkeys: false },
        routes: route,
      });
      const response = await app.handleRequest(new Request("http://internal.example.test/api/proxy-chain", {
        method: "POST",
        headers: { ...headers, origin: "https://first.example.test" },
      }));
      expect(response?.status).toBe(200);
    });

    await withEnv({
      TEST_PROXY_CHAIN_LAST_TRUST_PROXY: "true",
      TEST_PROXY_CHAIN_LAST_TRUST_PROXY_HEADERS: "proto,host",
      TEST_PROXY_CHAIN_LAST_TRUST_PROXY_CHAIN: "last",
    }, async () => {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_PROXY_CHAIN_LAST",
        store: testStore("proxy-chain-last"),
        auth: { passkeys: false },
        routes: route,
      });
      const response = await app.handleRequest(new Request("http://internal.example.test/api/proxy-chain", {
        method: "POST",
        headers: { ...headers, origin: "http://last.example.test" },
      }));
      expect(response?.status).toBe(200);
    });
  });

  test("falls back to direct values for malformed trusted headers", async () => {
    await withEnv({
      TEST_PROXY_INVALID_REQUEST_TRUST_PROXY: "true",
      TEST_PROXY_INVALID_REQUEST_TRUST_PROXY_HEADERS: "proto,host,prefix",
      TEST_PROXY_INVALID_REQUEST_TRUST_PROXY_CHAIN: "first",
    }, async () => {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_PROXY_INVALID_REQUEST",
        store: testStore("proxy-invalid-request"),
        auth: { passkeys: true },
        routes: defineRoutes({
          "/api/proxy-invalid": {
            auth: "public",
            POST: () => jsonResponse({ ok: true }),
          },
        }),
      });
      const headers = {
        origin: "http://localhost",
        "x-forwarded-proto": "javascript",
        "x-forwarded-host": "evil.example.test/path",
        "x-forwarded-prefix": "relative",
      };
      const routeResponse = await app.handleRequest(new Request("http://localhost/api/proxy-invalid", {
        method: "POST",
        headers,
      }));
      expect(routeResponse?.status).toBe(200);

      const optionsResponse = await app.handleRequest(new Request("http://localhost/api/passkey-auth/bootstrap/options", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ username: "owner" }),
      }));
      const options = await responseJson<{ rp?: { id?: string } }>(optionsResponse);
      const cookie = optionsResponse?.headers.get("set-cookie") ?? "";
      expect(options.rp?.id).toBe("localhost");
      expect(cookie).toContain("Path=/");
      expect(cookie).not.toMatch(/(?:^|; )Secure(?:;|$)/);
    });
  });

  test("keeps publicBaseUrl authoritative for origin, WebSocket checks, and public URLs", async () => {
    await withEnv({
      TEST_PROXY_PUBLIC_BASE_TRUST_PROXY: "true",
      TEST_PROXY_PUBLIC_BASE_TRUST_PROXY_HEADERS: "proto,host,prefix",
      TEST_PROXY_PUBLIC_BASE_TRUST_PROXY_CHAIN: "first",
      TEST_PROXY_PUBLIC_BASE_PUBLIC_BASE_URL: "https://public.example.test",
    }, async () => {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_PROXY_PUBLIC_BASE",
        store: testStore("proxy-public-base"),
        auth: { passkeys: false, deviceAuth: true },
        routes: defineRoutes({
          "/api/proxy-public-base": {
            auth: "public",
            POST: () => jsonResponse({ ok: true }),
          },
        }),
      });
      const forwarded = {
        "x-forwarded-proto": "http",
        "x-forwarded-host": "attacker.example.test",
        "x-forwarded-prefix": "/proxy",
      };
      const originResponse = await app.handleRequest(new Request("http://internal.example.test/api/proxy-public-base", {
        method: "POST",
        headers: { ...forwarded, origin: "https://public.example.test" },
      }));
      expect(originResponse?.status).toBe(200);

      const websocketRejected = await app.handleRequest(new Request("http://internal.example.test/api/ws", {
        headers: { ...forwarded, origin: "https://attacker.example.test", upgrade: "websocket" },
      }));
      expect(websocketRejected?.status).toBe(403);

      const websocketAccepted = await app.handleRequest(new Request("http://internal.example.test/api/ws", {
        headers: { ...forwarded, origin: "https://public.example.test", upgrade: "websocket" },
      }));
      expect(websocketAccepted?.status).toBe(400);

      const device = await responseJson<{ verification_uri: string }>(await app.handleRequest(new Request("http://internal.example.test/api/auth/device", {
        method: "POST",
        headers: { ...forwarded, "content-type": "application/json" },
        body: "{}",
      })));
      expect(device.verification_uri).toBe("https://public.example.test/proxy/device");

      const passkeyApp = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_PROXY_PUBLIC_BASE",
        store: testStore("proxy-public-base-passkey"),
        auth: { passkeys: true },
        routes: defineRoutes({}),
      });
      const passkeyResponse = await passkeyApp.handleRequest(new Request("http://internal.example.test/api/passkey-auth/bootstrap/options", {
        method: "POST",
        headers: { ...forwarded, "content-type": "application/json" },
        body: JSON.stringify({ username: "owner" }),
      }));
      const passkeyOptions = await responseJson<{ rp?: { id?: string } }>(passkeyResponse);
      const passkeyCookie = passkeyResponse?.headers.get("set-cookie") ?? "";
      expect(passkeyOptions.rp?.id).toBe("public.example.test");
      expect(passkeyCookie).toMatch(/(?:^|; )Secure(?:;|$)/);
    });
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
        store: testStore("device-route-disabled"),
        auth: { deviceAuth: false },
        routes: defineRoutes({}),
      });
      const server = await app.start();
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

  test("invalid bearer tokens return a stable error without echoing the token", async () => {
    const token = "not-a-real-token";
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_INVALID_TOKEN",
      store: testStore("invalid-token"),
      auth: { passkeys: false, apiKeys: false, deviceAuth: false },
      routes: defineRoutes({
        "/api/protected": {
          auth: "required",
          GET: () => jsonResponse({ ok: true }),
        },
      }),
    });

    const response = await app.handleRequest(new Request("http://localhost/api/protected", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(response?.status).toBe(401);
    const body = await responseJson<{ error: string; message: string }>(response);
    expect(body).toEqual({ error: "invalid_token", message: "Invalid authentication token" });
    expect(JSON.stringify(body)).not.toContain(token);
  });

  test("route auth helpers return auth errors instead of server errors", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST",
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
    const duplicateActiveSession = {
      id: crypto.randomUUID(),
      userId: owner.id,
      familyId: crypto.randomUUID(),
      clientId: "active-client",
      scope: "*",
      refreshTokenHash: sha256("duplicate-active-refresh"),
      createdAt: isoOffset(-60),
      updatedAt: isoOffset(-60),
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
    store.saveRefreshSession(duplicateActiveSession);
    store.saveRefreshSession(revokedSession);
    store.saveRefreshSession(expiredSession);
    store.saveRefreshSession(otherUserSession);
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_AUTH_SESSIONS_ACTIVE",
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
    expect(store.listRefreshSessions(owner.id).find((session) => session.id === duplicateActiveSession.id)?.revokedAt).toBeTruthy();
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
    const user = configuredUser(store);
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_DEVICE_FLOW",
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

    const refreshedAgain = await responseJson<{ access_token: string; refresh_token: string }>(await app.handleRequest(new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshed.refresh_token, client_id: "test-cli" }),
    })));
    expect(refreshedAgain.refresh_token).not.toBe(refreshed.refresh_token);

    const sessionsResponse = await app.handleRequest(new Request("http://localhost/api/auth/sessions", {
      headers: { authorization: `Bearer ${refreshedAgain.access_token}` },
    }));
    expect(sessionsResponse?.status).toBe(200);
    const sessions = await responseJson<Array<{ id: string; active: boolean; clientId: string }>>(sessionsResponse);
    expect(sessions.map((session) => ({ active: session.active, clientId: session.clientId })))
      .toEqual([{ active: true, clientId: "test-cli" }]);
    expect(store.listRefreshSessions(user.id).filter((session) => !session.revokedAt)).toHaveLength(1);

    const secondDevice = await responseJson<{ device_code: string; user_code: string }>(await app.handleRequest(new Request("http://localhost/api/auth/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "test-cli", scope: "write" }),
    })));
    const secondApproval = await app.handleRequest(new Request("http://localhost/api/auth/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ user_code: secondDevice.user_code }),
    }));
    expect(secondApproval?.status).toBe(200);
    const secondToken = await responseJson<{ access_token: string; refresh_token: string }>(await app.handleRequest(new Request("http://localhost/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: secondDevice.device_code, client_id: "test-cli" }),
    })));
    expect(secondToken.refresh_token).not.toBe(refreshedAgain.refresh_token);
    const replacedSessionsResponse = await app.handleRequest(new Request("http://localhost/api/auth/sessions", {
      headers: { authorization: `Bearer ${secondToken.access_token}` },
    }));
    expect(replacedSessionsResponse?.status).toBe(200);
    const replacedSessions = await responseJson<Array<{ id: string; active: boolean; clientId: string }>>(replacedSessionsResponse);
    expect(replacedSessions.map((session) => ({ active: session.active, clientId: session.clientId })))
      .toEqual([{ active: true, clientId: "test-cli" }]);
    expect(store.listRefreshSessions(user.id).filter((session) => !session.revokedAt)).toHaveLength(1);

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
