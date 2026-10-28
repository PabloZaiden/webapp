import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { sqliteWebAppStore, type RuntimeConfig } from "@pablozaiden/webapp/server";
import { createBrowserSessionHeaders } from "../src/server/auth/passkeys";
import { randomToken, sha256 } from "../src/server/auth/crypto";

test("OAuth consent, code, refresh and revocation persist across real server process restarts", async () => {
  const directory = resolve(".cache/tests", `oauth-process-${crypto.randomUUID()}`);
  const script = resolve("tests/fixtures/oauth-server.ts");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let base = "";
  let port = 0;
  async function stop() {
    if (!child) return;
    child.kill("SIGTERM");
    await child.exited;
    child = undefined;
  }
  async function start() {
    await stop();
    const subprocess = Bun.spawn([process.execPath, script, directory, String(port)], {
      stdout: "pipe", stderr: "pipe",
    });
    child = subprocess;
    const reader = subprocess.stdout.getReader();
    const chunk = await reader.read();
    reader.releaseLock();
    const ready = JSON.parse(new TextDecoder().decode(chunk.value).trim()) as { base: string; port: number };
    base = ready.base;
    port = ready.port;
    expect((await fetch(`${base}/.well-known/oauth-authorization-server/identity`)).status).toBe(200);
  }
  async function form(endpoint: string, parameters: Record<string, string>) {
    return await fetch(`${base}/identity/api/oauth/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
    });
  }
  try {
    await start();
    const store = sqliteWebAppStore({ dataDir: directory });
    store.initialize();
    const user = store.getUserByUsername("human")!;
    const runtime: RuntimeConfig = {
      appName: "Restart", envPrefix: "OAUTH_RESTART_TEST", host: "127.0.0.1", port,
      dataDir: directory, logLevel: "error", logLevelFromEnv: false,
      passkeyDisabled: false, sameOriginDisabled: false,
      trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
    };
    const cookie = createBrowserSessionHeaders(new Request(base), store, runtime, user).get("set-cookie")!.split(";", 1)[0]!;
    const verifier = randomToken(48);
    const redirect = "http://127.0.0.1:7777/callback";
    const resource = `${base}/mcp`;
    const authorize = await fetch(`${base}/identity/api/oauth/authorize?${new URLSearchParams({
      client_id: "desktop", redirect_uri: redirect, response_type: "code", resource,
      scope: "control", code_challenge_method: "S256", code_challenge: sha256(verifier),
    })}`, { redirect: "manual" });
    const request = new URL(authorize.headers.get("location")!).searchParams.get("request")!;
    await start();
    const review = await fetch(`${base}/identity/api/oauth/consent?request=${request}`, { headers: { cookie } });
    expect(review.status).toBe(200);
    const approve = await fetch(`${base}/identity/api/oauth/consent`, {
      method: "POST", headers: { cookie, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ request, decision: "approve" }),
    });
    const callback = new URL((await approve.json() as { redirectUri: string }).redirectUri);
    expect(callback.searchParams.get("iss")).toBe(`${base}/identity`);
    const code = callback.searchParams.get("code")!;
    await start();
    const exchange = await form("token", {
      grant_type: "authorization_code", client_id: "desktop", code, code_verifier: verifier,
      resource, redirect_uri: redirect,
    });
    expect(exchange.status).toBe(200);
    const tokens = await exchange.json() as { access_token: string; refresh_token: string };
    await start();
    expect((await fetch(resource, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(200);
    const refresh = await form("token", {
      grant_type: "refresh_token", client_id: "desktop", refresh_token: tokens.refresh_token, resource,
    });
    expect(refresh.status).toBe(200);
    const rotated = await refresh.json() as { access_token: string; refresh_token: string };
    expect((await form("revoke", { client_id: "desktop", token: rotated.refresh_token })).status).toBe(200);
    await start();
    expect((await fetch(resource, { headers: { authorization: `Bearer ${rotated.access_token}` } })).status).toBe(401);
    expect((await form("token", {
      grant_type: "refresh_token", client_id: "desktop", refresh_token: rotated.refresh_token, resource,
    })).status).toBe(400);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
