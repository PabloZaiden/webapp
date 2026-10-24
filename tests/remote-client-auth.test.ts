import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  createApiKey,
  createWebAppServer,
  defineRoutes,
  jsonResponse,
  memoryWebAppStore,
  type RuntimeConfig,
} from "@pablozaiden/webapp/server";
import type { ClientTicketResponse, DeviceAuthorizationResponse, TokenResponse, WebAppConfigResponse } from "@pablozaiden/webapp/contracts";

const CLIENT = "https://client.example";
const OTHER_CLIENT = "https://other.example";

async function bounded<T>(promise: Promise<T>, condition: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${condition}`)), 5_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function remoteFixture(authOnly = false) {
  const directory = resolve(".cache/tests", `remote-client-${crypto.randomUUID()}`);
  const store = memoryWebAppStore();
  store.initialize();
  const now = new Date().toISOString();
  const owner = {
    id: crypto.randomUUID(), username: "owner", role: "owner" as const,
    authVersion: 1, passkeyConfigured: true, createdAt: now, updatedAt: now,
  };
  store.createUser(owner);
  const key = createApiKey(store, { ...owner, isAdmin: true, isOwner: true }, { name: "Owner login", scopes: ["*"] });
  const config: RuntimeConfig = {
    appName: "Remote auth", envPrefix: "TEST_REMOTE_AUTH",
    host: "127.0.0.1", port: 0, dataDir: directory,
    logLevel: "error", logLevelFromEnv: false,
    passkeyDisabled: false, sameOriginDisabled: false,
    clientOrigins: [CLIENT, OTHER_CLIENT],
    trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
  };
  const app = createWebAppServer({
    appName: config.appName, envPrefix: config.envPrefix, runtimeConfig: config, store,
    web: authOnly ? { mode: "auth", entry: new URL("./fixtures/web/main.tsx", import.meta.url) } : false,
    auth: { passkeys: true, apiKeys: true, deviceAuth: true },
    routes: defineRoutes({
      "/api/file": {
        auth: "user", sameOrigin: "always", scopes: ["files"],
        GET(req, ctx) {
          ctx.requireUser();
          const range = req.headers.get("range");
          return new Response(range ? "doc" : "document", {
            status: range ? 206 : 200,
            headers: {
              etag: '"document-v1"', "content-disposition": 'attachment; filename="document.txt"',
              "x-clanky-partial": "true",
              ...(range ? { "content-range": "bytes 0-2/8" } : {}),
            },
          });
        },
        POST(_req, ctx) {
          return jsonResponse({ username: ctx.requireUser().username });
        },
      },
      "/api/raw": {
        auth: "user", sameOrigin: "always", scopes: ["files"],
        GET(req, ctx) {
          const channel = new URL(req.url).searchParams.get("channel");
          return ctx.server?.upgrade(req, {
            data: { userId: ctx.requireUser().id, webappSocketHandler: "raw", channel },
          }) ? undefined : new Response(null, { status: 400 });
        },
      },
      "/api/admin-file": {
        auth: "user", sameOrigin: "always", scopes: ["admin"],
        GET: () => new Response("administrative document"),
      },
    }),
    websockets: {
      raw: {
        message(socket, message) {
          socket.send(`${String(socket.data["channel"])}:${String(message)}`);
        },
      },
    },
  });
  const server = await app.start();
  const base = server.url.origin;
  const sockets: WebSocket[] = [];
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
  }
  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return await request(path, {
      method: "POST", headers: { "content-type": "application/json", origin: CLIENT, ...headers },
      body: JSON.stringify(body),
    });
  }
  const login = await post("/api/passkey-auth/api-key", { apiKey: key.token }, { origin: base });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  return {
    base, owner, request, post, cookie,
    async authorize(): Promise<TokenResponse> {
      const created = await post("/api/auth/device", { client_id: "static-client", scope: "files" });
      expect(created.status).toBe(200);
      const device = await created.json() as DeviceAuthorizationResponse;
      expect(new URL(device.verification_uri).origin).toBe(base);
      expect((await post("/api/auth/device/approve", { user_code: device.user_code }, { origin: base, cookie })).status).toBe(200);
      const exchanged = await post("/api/auth/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code, client_id: "static-client",
      });
      expect(exchanged.status).toBe(200);
      return await exchanged.json() as TokenResponse;
    },
    async ticket(token: string, url: string, kind: "resource" | "websocket"): Promise<ClientTicketResponse> {
      const response = await post("/api/auth/client-ticket", { url, kind }, { authorization: `Bearer ${token}` });
      expect(response.status).toBe(200);
      return await response.json() as ClientTicketResponse;
    },
    async connect(path: string, origin = CLIENT): Promise<{ socket: WebSocket; message: Promise<string> }> {
      const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
      const socket = new Socket(`${base.replace("http:", "ws:")}${path}`, { headers: { origin } });
      sockets.push(socket);
      const open = Promise.withResolvers<void>();
      const message = Promise.withResolvers<string>();
      socket.onopen = () => open.resolve();
      socket.onerror = () => open.reject(new Error("WebSocket connection denied"));
      socket.onmessage = (event) => message.resolve(String(event.data));
      await bounded(open.promise, "WebSocket connection");
      return { socket, message: bounded(message.promise, "WebSocket response") };
    },
    async close() {
      await app.stop(true);
      for (const socket of sockets) socket.close();
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

// Required workflow: a detached browser authorizes on the API origin, then uses
// private HTTP, downloadable resources and both WebSocket transports. These real
// listeners verify the credential/origin/capability boundary, not browser layout.
test("detached device session uses trusted HTTP, scoped downloads and realtime/raw sockets", async () => {
  const fixture = await remoteFixture();
  try {
    const preflight = await fixture.request("/api/file", {
      method: "OPTIONS",
      headers: {
        origin: CLIENT, "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, x-application-context",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(CLIENT);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(preflight.headers.has("access-control-allow-credentials")).toBe(false);
    const deniedPreflight = await fixture.request("/api/file", {
      method: "OPTIONS", headers: { origin: "https://untrusted.example", "access-control-request-method": "POST" },
    });
    expect(deniedPreflight.status).toBe(403);
    expect(deniedPreflight.headers.has("access-control-allow-origin")).toBe(false);

    const credentials = await fixture.authorize();
    const authorization = `Bearer ${credentials.access_token}`;
    const config = await fixture.request("/api/config", { headers: { origin: CLIENT, authorization } });
    const state = await config.json() as WebAppConfigResponse;
    expect(state.currentUser?.id).toBe(fixture.owner.id);
    expect(state.passkeyAuth.authenticated).toBe(true);
    expect(state.passkeyAuth.passkeyRequired).toBe(false);
    const anonymous = await fixture.request("/api/config", { headers: { origin: CLIENT } });
    expect((await anonymous.json() as WebAppConfigResponse).currentUser).toBeUndefined();
    const invalid = await fixture.request("/api/config", { headers: { origin: CLIENT, authorization: "Bearer invalid" } });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("access-control-allow-origin")).toBe(CLIENT);
    const missing = await fixture.request("/api/missing", { headers: { origin: CLIENT, authorization } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(CLIENT);
    expect((await fixture.post("/api/file", {}, { authorization })).status).toBe(200);
    expect((await fixture.post("/api/file", {}, { cookie: fixture.cookie })).status).toBe(403);
    expect((await fixture.post("/api/auth/client-ticket", { url: "/api/file", kind: "resource" }, {
      origin: fixture.base, cookie: fixture.cookie,
    })).status).toBe(401);

    const download = await fixture.request("/api/file", { headers: { origin: CLIENT, authorization } });
    expect(await download.text()).toBe("document");
    const exposed = download.headers.get("access-control-expose-headers");
    for (const header of ["etag", "content-disposition", "x-clanky-partial"]) expect(exposed).toContain(header);
    const resource = await fixture.ticket(credentials.access_token, "/api/file?version=1", "resource");
    expect(resource.expiresAt).toBeGreaterThan(Date.now());
    const navigation = await fixture.request(resource.url);
    expect(navigation.status).toBe(200);
    expect(navigation.headers.get("referrer-policy")).toBe("no-referrer");
    expect(navigation.headers.get("cache-control")).toContain("no-store");
    expect(await navigation.text()).toBe("document");
    const range = await fixture.request(resource.url, { headers: { range: "bytes=0-2" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("doc");
    expect((await fixture.request(resource.url.replace("version=1", "version=2"))).status).toBe(401);
    expect((await fixture.post(resource.url, {})).status).toBe(401);
    const restricted = await fixture.ticket(credentials.access_token, "/api/admin-file", "resource");
    expect((await fixture.request(restricted.url)).status).toBe(403);
    for (const target of ["https://untrusted.example/api/file", "/api/../private", "/api/file?webapp_ticket=existing"]) {
      expect((await fixture.post("/api/auth/client-ticket", { url: target, kind: "resource" }, { authorization })).status).toBe(400);
    }

    const realtime = await fixture.ticket(credentials.access_token, "/api/ws", "websocket");
    await expect(fixture.connect(realtime.url, OTHER_CLIENT)).rejects.toThrow();
    const connected = await fixture.connect(realtime.url);
    connected.socket.send(JSON.stringify({ type: "ping" }));
    expect(JSON.parse(await connected.message)).toEqual({ type: "pong" });
    await expect(fixture.connect(realtime.url)).rejects.toThrow();
    const raw = await fixture.ticket(credentials.access_token, "/api/raw?channel=terminal", "websocket");
    const terminal = await fixture.connect(raw.url);
    terminal.socket.send("hello");
    expect(await terminal.message).toBe("terminal:hello");

    const revoked = await fixture.post("/api/auth/revoke", { refreshToken: credentials.refresh_token });
    expect(revoked.status).toBe(200);
    expect((await fixture.request(resource.url)).status).toBe(401);
    expect((await fixture.request("/api/file", { headers: { origin: CLIENT, authorization } })).status).toBe(401);
  } finally {
    await fixture.close();
  }
});

test("auth-only serving retains server-origin sign-in pages without an application fallback", async () => {
  const fixture = await remoteFixture(true);
  try {
    for (const path of ["/", "/login", "/setup", "/device", "/account"]) {
      const response = await fixture.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      await response.text();
    }
    expect((await fixture.request("/application")).status).toBe(404);
    expect((await fixture.request("/api/health")).status).toBe(200);
    const config = await fixture.request("/api/config");
    expect((await config.json() as WebAppConfigResponse).web?.mode).toBe("auth");
  } finally {
    await fixture.close();
  }
});
