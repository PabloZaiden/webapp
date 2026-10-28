import { afterEach, expect, setSystemTime, test } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  authenticateApiKey, createManagedApiKey, createOAuthClientSecret, createWebAppServer, jsonResponse, parseOAuthClients,
  memoryWebAppStore, sqliteWebAppStore,
  type OAuthAuthorizationContext, type OAuthConfig, type RuntimeConfig, type WebAppServer, type WebAppStore,
} from "@pablozaiden/webapp/server";
import { createBrowserSessionHeaders } from "../src/server/auth/passkeys";
import { createUserRecord, toCurrentUser } from "../src/server/auth/users";
import { randomToken, sha256 } from "../src/server/auth/crypto";

afterEach(() => setSystemTime());

async function fixture(kind: "memory" | "sqlite" = "memory", options?: (store: WebAppStore) => Partial<OAuthConfig>) {
  const directory = resolve(".cache/tests", `oauth-${crypto.randomUUID()}`);
  const store = kind === "memory" ? memoryWebAppStore() : sqliteWebAppStore({ dataDir: directory });
  store.initialize();
  const user = createUserRecord({ username: "human", role: "user" });
  const other = createUserRecord({ username: "other", role: "user" });
  store.createUser(user);
  store.createUser(other);
  let app: WebAppServer | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async request => await app?.handleRequest(request) ?? new Response(null, { status: 503 }),
  });
  const base = server.url.origin;
  const runtime: RuntimeConfig = {
    appName: "OAuth", envPrefix: "OAUTH_TEST", host: "127.0.0.1", port: server.port!,
    dataDir: directory, logLevel: "error", logLevelFromEnv: false,
    passkeyDisabled: false, sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
  };
  const secret = createOAuthClientSecret();
  const redirect = "http://127.0.0.1:7777/callback";
  let grantActive = true;
  const config: OAuthConfig = {
    issuer: base, resource: `${base}/mcp`,
    scopes: { control: "Use application control", general: "General account control" },
    resourceScopes: ["control"],
    clients: [
      { clientId: "desktop", clientName: "Desktop", redirectUris: [redirect], grantTypes: ["authorization_code", "refresh_token"] },
      { clientId: "confidential", clientName: "Confidential", redirectUris: [redirect],
        tokenEndpointAuthMethod: "client_secret_basic", clientSecretHash: secret.secretHash,
        grantTypes: ["authorization_code", "refresh_token"] },
    ],
    consentPath: "/consent",
    async getConsentContext(): Promise<OAuthAuthorizationContext> {
      return { choices: [
        { mode: "workspace", workspaceId: "one", label: "Workspace One" },
        { mode: "general", label: "General account access" },
      ] };
    },
    resolveScopes: scopes => Object.fromEntries(scopes.filter(scope => scope === "workspace:one").map(scope => [scope, "Workspace One"])),
    authorizeConsent({ approval, scopes }): false | { scopes: readonly string[]; authorizationContext: OAuthAuthorizationContext } {
      if (approval["mode"] === "general") return { scopes, authorizationContext: { mode: "general" } };
      if (approval["workspace"] !== "one") return false;
      return { scopes, authorizationContext: { workspaceId: "one", grant: "approved-by-human" } };
    },
    validateAuthorization: () => grantActive,
    handleResource: (_request, result) => jsonResponse({
      userId: result.user.id, resource: result.resource, clientId: result.clientId,
      scopes: result.scopes, authorizationContext: result.authorizationContext,
    }),
    ...options?.(store),
  };
  function makeApp(accounts: WebAppStore = store) {
    return createWebAppServer({
      appName: runtime.appName, envPrefix: runtime.envPrefix, runtimeConfig: runtime,
      store: accounts, web: false, auth: { apiKeys: true, deviceAuth: true, oauth: config },
      routes: {
        "/api/private": { auth: "user", scopes: ["private"], GET: (_request, context) => jsonResponse({ userId: context.requireUser().id }) },
      },
    });
  }
  app = makeApp();
  function cookie(userRecord = user) {
    return createBrowserSessionHeaders(new Request(base), store, runtime, userRecord).get("set-cookie")!.split(";", 1)[0]!;
  }
  const browserCookie = cookie();
  const otherCookie = cookie(other);
  async function begin(overrides: Record<string, string> = {}) {
    const verifier = randomToken(48);
    const parameters = new URLSearchParams({
      client_id: "desktop", redirect_uri: redirect, response_type: "code",
      resource: config.resource, scope: "control workspace:one",
      code_challenge_method: "S256", code_challenge: sha256(verifier), state: "opaque-client-state",
      ...overrides,
    });
    const response = await fetch(`${base}/api/oauth/authorize?${parameters}`, { redirect: "manual" });
    const location = response.headers.get("location");
    const target = location ? new URL(location) : undefined;
    const handle = target?.searchParams.get("request") ?? null;
    return { verifier, parameters, response, handle };
  }
  async function consent(handle: string, extra: RequestInit = {}) {
    return await fetch(`${base}/api/oauth/consent`, {
      method: "POST",
      headers: { cookie: browserCookie, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ request: handle, decision: "approve", approval: { workspace: "one" } }),
      ...extra,
    });
  }
  async function approve(overrides: Record<string, string> = {}) {
    const started = await begin(overrides);
    expect(started.handle).toBeString();
    const details = await fetch(`${base}/api/oauth/consent?request=${started.handle}`, { headers: { cookie: browserCookie } });
    expect(details.status).toBe(200);
    const decision = await consent(started.handle!);
    expect(decision.status).toBe(200);
    const callback = new URL((await decision.json() as { redirectUri: string }).redirectUri);
    expect(callback.searchParams.get("iss")).toBe(base);
    expect(callback.searchParams.get("state")).toBe("opaque-client-state");
    const code = callback.searchParams.get("code")!;
    return { ...started, code, details: await details.json() as unknown };
  }
  async function form(endpoint: string, parameters: Record<string, string>, headers: HeadersInit = {}) {
    return await fetch(`${base}/api/oauth/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(parameters),
    });
  }
  async function exchange(code: string, verifier: string, overrides: Record<string, string> = {}, headers: HeadersInit = {}) {
    return await form("token", {
      grant_type: "authorization_code", client_id: "desktop", code, code_verifier: verifier,
      redirect_uri: redirect, resource: config.resource, ...overrides,
    }, headers);
  }
  async function resource(access: string, path = "/mcp") {
    return await fetch(`${base}${path}`, {
      method: path === "/mcp" ? "POST" : "GET",
      headers: { authorization: `Bearer ${access}` },
    });
  }
  return {
    base, store, user, other, config, runtime, directory, browserCookie, otherCookie, secret,
    begin, consent, approve, form, exchange, resource,
    revokeApplicationGrant() { grantActive = false; },
    async restart(overrides: Partial<OAuthConfig> = {}) {
      await app!.stop(true);
      Object.assign(config, overrides);
      app = makeApp(sqliteWebAppStore({ dataDir: directory }));
    },
    async close() {
      await app!.stop(true);
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type TokenResponse = { access_token: string; refresh_token: string; scope: string };

test("OAuth base scopes retain the human's workspace or general choice in application context", async () => {
  const configured: unknown = JSON.parse('[{"clientId":"desktop","clientName":"Desktop","redirectUris":["http://127.0.0.1:7777/callback"],"grantTypes":["authorization_code","refresh_token"]}]');
  const f = await fixture("memory", () => ({
    consentPath: "/#/oauth-consent", clients: parseOAuthClients(configured),
  }));
  try {
    for (const approval of [{ mode: "workspace", workspace: "one" }, { mode: "general" }]) {
      const started = await f.begin({ scope: "control" });
      const location = new URL(started.response.headers.get("location")!);
      expect(location.hash).toBe("#/oauth-consent");
      expect(location.searchParams.get("request")).toBe(started.handle);
      const details = await fetch(`${f.base}/api/oauth/consent?request=${started.handle}`, { headers: { cookie: f.browserCookie } });
      expect(details.status).toBe(200);
      expect(await details.json()).toMatchObject({
        scopes: [{ scope: "control" }],
        consentContext: { choices: [
          { mode: "workspace", workspaceId: "one", label: "Workspace One" },
          { mode: "general", label: "General account access" },
        ] },
      });
      const decision = await f.consent(started.handle!, {
        body: JSON.stringify({ request: started.handle, decision: "approve", approval }),
      });
      const redirect = new URL((await decision.json() as { redirectUri: string }).redirectUri);
      const exchanged = await f.exchange(redirect.searchParams.get("code")!, started.verifier);
      expect(exchanged.status).toBe(200);
      const tokens = await exchanged.json() as TokenResponse;
      expect(tokens.scope).toBe("control");
      const result = await f.resource(tokens.access_token);
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        scopes: ["control"],
        authorizationContext: approval.mode === "workspace" ? { workspaceId: "one" } : { mode: "general" },
      });
    }
  } finally { await f.close(); }
});

test("one OAuth resource composes independently verified limited service admission without REST escalation", async () => {
  const approvedKeys = new Set<string>();
  const f = await fixture("memory", store => ({
    admitResource(request) {
      const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token) return undefined;
      const service = authenticateApiKey(store, token);
      if (!service) return undefined;
      if (!service.scopes.includes("control") || service.scopes.includes("*") || !approvedKeys.has(service.apiKeyId)) {
        return jsonResponse({ error: "service_grant_required" }, { status: 403 });
      }
      return jsonResponse({ admission: "service", userId: service.user.id });
    },
  }));
  try {
    const service = createManagedApiKey(f.store, toCurrentUser(f.user), { managedBy: "resource", scopes: ["control"] });
    const unbound = createManagedApiKey(f.store, toCurrentUser(f.user), { managedBy: "resource", scopes: ["control"] });
    approvedKeys.add(service.key.id);
    expect(await (await f.resource(service.token)).json()).toEqual({ admission: "service", userId: f.user.id });
    expect((await f.resource(unbound.token)).status).toBe(403);
    expect((await f.resource(service.token, "/api/private")).status).toBe(403);
    expect((await f.resource(service.token, "/api/api-keys")).status).toBe(403);
    const approval = await f.approve({ scope: "control" });
    const tokens = await (await f.exchange(approval.code, approval.verifier)).json() as TokenResponse;
    expect((await f.resource(tokens.access_token)).status).toBe(200);
    expect((await f.resource(tokens.access_token, "/api/private")).status).toBe(401);
    approvedKeys.delete(service.key.id);
    expect((await f.resource(service.token)).status).toBe(403);
    f.store.deleteApiKey(service.key.id, f.user.id);
    expect((await f.resource(service.token)).status).toBe(401);
  } finally { await f.close(); }
});

test.each(["memory", "sqlite"] as const)("OAuth HTTP consent and resource isolation (%s)", async kind => {
  const f = await fixture(kind);
  try {
    const challenge = await fetch(`${f.base}/mcp`, { method: "POST" });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain('scope="control"');
    const metadata = await fetch(`${f.base}/.well-known/oauth-protected-resource/mcp`);
    expect(await metadata.json()).toMatchObject({ resource: f.config.resource, authorization_servers: [f.base], scopes_supported: ["control"] });
    const as = await fetch(`${f.base}/.well-known/oauth-authorization-server`);
    expect(await as.json()).toMatchObject({
      issuer: f.base, code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    const invalidRequests: Record<string, string>[] = [
      { code_challenge_method: "plain" }, { code_challenge: "" }, { resource: `${f.base}/other` },
      { scope: "*" }, { scope: "workspace:unknown" }, { response_type: "token" },
      { scope: "toString" }, { scope: "constructor" }, { scope: "__proto__" },
    ];
    for (const overrides of invalidRequests) {
      const invalid = await f.begin(overrides);
      expect(invalid.response.status).toBe(303);
      expect(new URL(invalid.response.headers.get("location")!).searchParams.has("error")).toBe(true);
      expect(invalid.handle).toBeNull();
      if (overrides["scope"]) {
        expect(new URL(invalid.response.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
      }
    }
    const unknownClient = await f.begin({ client_id: "unregistered" });
    expect(unknownClient.response.status).toBe(401);
    const unregisteredRedirect = await f.begin({ redirect_uri: "https://attacker.invalid/callback" });
    expect(unregisteredRedirect.response.status).toBe(400);
    expect(unregisteredRedirect.response.headers.has("location")).toBe(false);
    const started = await f.begin();
    expect((await fetch(`${f.base}/api/oauth/consent?request=${started.handle}`)).status).toBe(401);
    const managed = createManagedApiKey(f.store, toCurrentUser(f.user), { scopes: ["control"], managedBy: "oauth-test" });
    expect((await fetch(`${f.base}/api/oauth/consent?request=${started.handle}`, {
      headers: { authorization: `Bearer ${managed.token}` },
    })).status).toBe(403);
    const details = await fetch(`${f.base}/api/oauth/consent?request=${started.handle}`, { headers: { cookie: f.browserCookie } });
    expect(await details.json()).toMatchObject({
      client: { clientId: "desktop", clientName: "Desktop" },
      scopes: [{ scope: "control", description: "Use application control" }, { scope: "workspace:one", description: "Workspace One" }],
    });
    expect((await fetch(`${f.base}/api/oauth/consent?request=${started.handle}`, { headers: { cookie: f.otherCookie } })).status).toBe(403);
    expect((await f.consent(started.handle!, { headers: {
      cookie: f.browserCookie, origin: "https://attacker.invalid", "content-type": "application/json",
    } })).status).toBe(403);
    const denied = await f.consent(started.handle!, {
      body: JSON.stringify({ request: started.handle, decision: "approve", approval: { workspace: "unapproved" } }),
    });
    expect(new URL((await denied.json() as { redirectUri: string }).redirectUri).searchParams.get("error")).toBe("access_denied");

    const approved = await f.approve();
    expect((await f.consent(approved.handle!)).status).toBe(403);
    expect((await f.exchange(approved.code, randomToken(48))).status).toBe(400);
    expect((await f.exchange(approved.code, approved.verifier, { redirect_uri: "http://127.0.0.1:7778/callback" })).status).toBe(400);
    expect((await f.exchange(approved.code, approved.verifier, { resource: `${f.base}/other` })).status).toBe(400);
    const response = await f.exchange(approved.code, approved.verifier);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const tokens = await response.json() as TokenResponse;
    expect((await f.resource(tokens.access_token)).status).toBe(200);
    expect(await (await f.resource(tokens.access_token)).json()).toMatchObject({
      userId: f.user.id, scopes: ["control", "workspace:one"],
      authorizationContext: { workspaceId: "one", grant: "approved-by-human" },
    });
    expect((await f.resource(tokens.access_token, "/api/private")).status).toBe(401);
    expect((await f.resource(tokens.access_token, "/api/api-keys")).status).toBe(401);
    expect((await f.resource(managed.token)).status).toBe(401);
    expect((await f.resource(tokens.refresh_token)).status).toBe(401);
    expect((await fetch(`${f.base}/mcp?access_token=${tokens.access_token}`, { method: "POST" })).status).toBe(400);
    expect((await f.exchange(approved.code, approved.verifier)).status).toBe(400);
    expect((await f.resource(tokens.access_token)).status).toBe(401);
    for (const elapsed of [61 * 1000, 11 * 60 * 1000]) {
      const replayed = await f.approve();
      const original = await (await f.exchange(replayed.code, replayed.verifier)).json() as TokenResponse;
      setSystemTime(new Date(Date.now() + elapsed));
      const refresh = await f.form("token", {
        grant_type: "refresh_token", client_id: "desktop", refresh_token: original.refresh_token,
        resource: f.config.resource,
      });
      expect(refresh.status).toBe(200);
      const rotated = await refresh.json() as TokenResponse;
      expect((await f.begin()).response.status).toBe(303);
      if (kind === "sqlite") await f.restart();
      expect((await f.exchange(replayed.code, randomToken(48))).status).toBe(400);
      expect((await f.exchange(replayed.code, replayed.verifier, { redirect_uri: "http://127.0.0.1:7778/callback" })).status).toBe(400);
      expect((await f.resource(rotated.access_token)).status).toBe(200);
      expect((await f.exchange(replayed.code, replayed.verifier)).status).toBe(400);
      expect((await f.resource(rotated.access_token)).status).toBe(401);
      expect((await f.form("token", {
        grant_type: "refresh_token", client_id: "desktop", refresh_token: rotated.refresh_token,
        resource: f.config.resource,
      })).status).toBe(400);
      setSystemTime();
    }
    const limitedApproval = await f.approve({ scope: "workspace:one" });
    const limitedTokens = await (await f.exchange(limitedApproval.code, limitedApproval.verifier)).json() as TokenResponse;
    const insufficient = await f.resource(limitedTokens.access_token);
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  } finally { await f.close(); }
});

test("OAuth rotation, revocation, expiration and application/account grant invalidation", async () => {
  let allowExpandedScopes = true;
  const f = await fixture("memory", () => ({
    validateAuthorization: principal => allowExpandedScopes || !principal.scopes.includes("workspace:one"),
  }));
  async function issued() {
    const approval = await f.approve();
    return await (await f.exchange(approval.code, approval.verifier)).json() as TokenResponse;
  }
  async function refresh(token: string, overrides: Record<string, string> = {}) {
    return await f.form("token", {
      grant_type: "refresh_token", client_id: "desktop", refresh_token: token,
      resource: f.config.resource, ...overrides,
    });
  }
  try {
    const expiredRequest = await f.begin();
    setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
    expect((await fetch(`${f.base}/api/oauth/consent?request=${expiredRequest.handle}`, {
      headers: { cookie: f.browserCookie },
    })).status).toBe(400);
    setSystemTime();
    const expiredCode = await f.approve();
    setSystemTime(new Date(Date.now() + 61 * 1000));
    expect((await f.exchange(expiredCode.code, expiredCode.verifier)).status).toBe(400);
    setSystemTime();
    const first = await issued();
    expect((await refresh(first.refresh_token, { scope: "control general" })).status).toBe(400);
    const rotated = await (await refresh(first.refresh_token, { scope: "control" })).json() as TokenResponse;
    expect(rotated.scope).toBe("control");
    allowExpandedScopes = false;
    expect((await f.resource(first.access_token)).status).toBe(401);
    expect((await f.resource(rotated.access_token)).status).toBe(200);
    expect((await refresh(first.refresh_token)).status).toBe(400);
    expect((await f.resource(rotated.access_token)).status).toBe(401);
    allowExpandedScopes = true;
    const concurrent = await issued();
    const raced = await Promise.all([refresh(concurrent.refresh_token), refresh(concurrent.refresh_token)]);
    expect(raced.map(response => response.status).sort()).toEqual([200, 400]);
    const raceWinner = await raced.find(response => response.status === 200)!.json() as TokenResponse;
    expect((await f.resource(raceWinner.access_token)).status).toBe(401);

    const expiring = await issued();
    setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
    expect((await f.resource(expiring.access_token)).status).toBe(401);
    const renewedResponse = await refresh(expiring.refresh_token);
    expect(renewedResponse.status).toBe(200);
    const renewed = await renewedResponse.json() as TokenResponse;
    expect((await f.resource(renewed.access_token)).status).toBe(200);
    expect((await f.form("revoke", { client_id: "desktop", token: renewed.refresh_token })).status).toBe(200);
    expect((await f.resource(renewed.access_token)).status).toBe(401);
    const reset = await issued();
    f.store.incrementUserAuthVersion(f.user.id, new Date().toISOString());
    expect((await f.resource(reset.access_token)).status).toBe(401);
    expect((await refresh(reset.refresh_token)).status).toBe(400);
  } finally { await f.close(); }

  const disabled = await fixture();
  try {
    const approval = await disabled.approve();
    const tokens = await (await disabled.exchange(approval.code, approval.verifier)).json() as TokenResponse;
    disabled.store.disableUser(disabled.user.id, new Date().toISOString());
    expect((await disabled.resource(tokens.access_token)).status).toBe(401);
    expect((await disabled.form("token", { grant_type: "refresh_token", client_id: "desktop", resource: disabled.config.resource, refresh_token: tokens.refresh_token })).status).toBe(400);
  } finally { await disabled.close(); }
  const revoked = await fixture();
  try {
    const approval = await revoked.approve();
    const tokens = await (await revoked.exchange(approval.code, approval.verifier)).json() as TokenResponse;
    revoked.revokeApplicationGrant();
    expect((await revoked.resource(tokens.access_token)).status).toBe(401);
    expect((await revoked.form("token", { grant_type: "refresh_token", client_id: "desktop", resource: revoked.config.resource, refresh_token: tokens.refresh_token })).status).toBe(400);
  } finally { await revoked.close(); }
});

test("OAuth confidential client binding and durable consent survive server reconstruction", async () => {
  const f = await fixture("sqlite");
  try {
    const started = await f.begin({ client_id: "confidential" });
    await f.restart();
    const details = await fetch(`${f.base}/api/oauth/consent?request=${started.handle}`, { headers: { cookie: f.browserCookie } });
    expect(details.status).toBe(200);
    const approval = await f.consent(started.handle!);
    const code = new URL((await approval.json() as { redirectUri: string }).redirectUri).searchParams.get("code")!;
    await f.restart();
    expect((await f.exchange(code, started.verifier, { client_id: "confidential" })).status).toBe(401);
    const response = await f.exchange(code, started.verifier, { client_id: "confidential" }, {
      authorization: `Basic ${Buffer.from(`confidential:${f.secret.secret}`).toString("base64")}`,
    });
    expect(response.status).toBe(200);
    const tokens = await response.json() as TokenResponse;
    await f.restart();
    expect((await f.resource(tokens.access_token)).status).toBe(200);
    const originalResource = f.config.resource;
    await f.restart({ resource: `${f.base}/another-resource` });
    expect((await f.resource(tokens.access_token, "/another-resource")).status).toBe(401);
    await f.restart({ resource: originalResource });
    const list = await fetch(`${f.base}/api/oauth/grants`, { headers: { cookie: f.browserCookie } });
    expect(list.status).toBe(200);
    const grant = (await list.json() as { grants: { id: string; authorizationContext: OAuthAuthorizationContext }[] }).grants[0]!;
    expect(grant.authorizationContext).toEqual({ workspaceId: "one", grant: "approved-by-human" });
    expect(await (await fetch(`${f.base}/api/oauth/grants`, { headers: { cookie: f.otherCookie } })).json()).toEqual({ grants: [] });
    expect((await fetch(`${f.base}/api/oauth/grants`, { headers: {
      authorization: `Bearer ${tokens.access_token}`,
    } })).status).toBe(403);
    expect((await fetch(`${f.base}/api/oauth/grants?id=${grant.id}`, {
      method: "DELETE", headers: { cookie: f.otherCookie, origin: f.base },
    })).status).toBe(200);
    expect((await f.resource(tokens.access_token)).status).toBe(200);
    expect((await fetch(`${f.base}/api/oauth/grants?id=${grant.id}`, {
      method: "DELETE", headers: { cookie: f.browserCookie, origin: f.base },
    })).status).toBe(200);
    await f.restart();
    expect((await f.resource(tokens.access_token)).status).toBe(401);
  } finally { await f.close(); }
});

test.each(["app", "auth"] as const)("OAuth resource admission precedes native document routing (%s)", async mode => {
  const runtime: RuntimeConfig = {
    appName: "Native OAuth", envPrefix: "NATIVE_OAUTH_TEST", host: "127.0.0.1", port: 0,
    dataDir: ".cache/tests/native-oauth", logLevel: "error", logLevelFromEnv: false,
    passkeyDisabled: false, sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
  };
  const app = createWebAppServer({
    appName: runtime.appName, envPrefix: runtime.envPrefix, runtimeConfig: runtime,
    store: memoryWebAppStore(), web: { mode, entry: new URL("./fixtures/web/main.tsx", import.meta.url) },
    auth: { oauth: {
      issuer: "http://127.0.0.1/identity", resource: "http://127.0.0.1/mcp",
      scopes: { control: "Control" }, clients: [], consentPath: "/consent",
      authorizeConsent: () => false, handleResource: () => jsonResponse({ admitted: true }),
    } },
  });
  const server = await app.start();
  try {
    const resource = await fetch(new URL("/mcp", server.url));
    expect(resource.status).toBe(401);
    expect(resource.headers.has("www-authenticate")).toBe(true);
    expect((await fetch(new URL("/mcp", server.url), { method: "POST" })).status).toBe(401);
    expect((await fetch(new URL("/identity/api/oauth/authorize", server.url))).status).toBe(401);
    const consent = await fetch(new URL("/consent", server.url));
    expect(consent.status).toBe(200);
    expect(consent.headers.get("content-type")).toContain("text/html");
  } finally { await app.stop(true); }
});
