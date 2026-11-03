import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AuthBonusError, createBrowserSessions, createPasswordAuth } from "@pablozaiden/webapp/auth";
import { ensurePrivateDirectory, errorResponse, jsonResponse, parseJson, securePrivateFile, type RuntimeConfig } from "@pablozaiden/webapp/server";

const passwordInput = z.object({ password: z.string().max(1024) });
const changeInput = z.object({ currentPassword: z.string().max(1024), nextPassword: z.string().max(1024) });
const stored = z.object({ hash: z.string(), version: z.number().int().nonnegative() });

function authenticationOrigin(config: RuntimeConfig): string {
  if (config.publicBaseUrl) return new URL(config.publicBaseUrl).origin;
  const host = config.host === "::1" ? "[::1]" : config.host;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    throw new Error("Password-enabled Notes requires NOTES_TODO_PUBLIC_BASE_URL when not bound to loopback.");
  }
  return new URL(`http://${host}:${config.port}`).origin;
}

/** Explicit sample app persistence and identity policy, never imported by the core. */
export function createNotesAuth(dataDir: string, config: RuntimeConfig) {
  if (process.env["NOTES_TODO_AUTH"] !== "password") return undefined;
  const origin = authenticationOrigin(config);
  ensurePrivateDirectory(dataDir);
  const path = join(dataDir, "example-auth.sqlite");
  if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  securePrivateFile(path);
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE IF NOT EXISTS auth_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const read = (key: string) => (db.query("SELECT value FROM auth_state WHERE key = ?").get(key) as { value: string } | null)?.value;
  const write = (key: string, value: string) => db.query("INSERT INTO auth_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  let encodedSecret = read("secret");
  if (!encodedSecret) { encodedSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"); write("secret", encodedSecret); }
  const identity = () => ({ id: "example", version: Number(read("epoch") ?? 0) });
  const getCredential = () => {
    const raw = read("password");
    return raw ? { identityId: "example", ...stored.parse(JSON.parse(raw)) } : undefined;
  };
  let attempts = 0;
  let resetAt = 0;
  const passwords = createPasswordAuth({
    origin,
    getCredential: username => username === "example" ? getCredential() : undefined,
    getCredentialByIdentity: id => id === "example" ? getCredential() : undefined,
    setCredential: db.transaction((id, expected, next) => {
      if (id !== "example" || getCredential()?.version !== expected) return false;
      write("password", JSON.stringify(next));
      write("epoch", String(identity().version + 1));
      return true;
    }),
    allowAttempt: () => {
      const now = Date.now();
      if (now >= resetAt) { resetAt = now + 60_000; attempts = 0; }
      return ++attempts <= 30;
    },
  });
  const sessions = createBrowserSessions({
    origin, secret: new Uint8Array(Buffer.from(encodedSecret, "base64url")),
    cookie: { name: "notes_example_session" },
    getIdentity: id => id === "example" ? identity() : undefined,
    getVersion: value => value.version,
    onRevoke: () => { write("epoch", String(identity().version + 1)); },
  });
  return {
    sessions,
    async enroll() {
      if (getCredential()) return;
      const value = process.env["NOTES_TODO_ENROLL_PASSWORD"];
      if (!value) throw new Error("First password-enabled startup requires NOTES_TODO_ENROLL_PASSWORD (12+ characters); no public enrollment exists.");
      await passwords.enroll(new Request(`${origin}/`, { method: "POST", headers: { origin } }), "example", value);
    },
    async authenticate(req: Request) {
      const current = await sessions.authenticate(req);
      return current ? { identity: current.identity, credential: "ambient" as const } : undefined;
    },
    async realtime(req: Request) {
      const current = await sessions.authenticate(req);
      if (!current) return undefined;
      return { data: { userId: "example" }, options: { authorize: () => identity().version === current.session.version && Date.now() < current.session.expiresAt } };
    },
    async request(req: Request): Promise<Response | undefined> {
      const path = new URL(req.url).pathname;
      if (!path.startsWith("/api/example/auth/")) return undefined;
      try {
        if (path === "/api/example/auth/status" && req.method === "GET") return jsonResponse({ enabled: true, authenticated: Boolean(await sessions.authenticate(req)) });
        if (path === "/api/example/auth/login" && req.method === "POST") {
          const body = await parseJson(req, passwordInput);
          const expectedVersion = identity().version;
          const result = await passwords.verify(req, "example", body.password);
          if (!result) return errorResponse(401, "invalid_credentials", "Invalid credentials.");
          const session = await sessions.create(result.identityId, { expectedVersion });
          return jsonResponse({ ok: true }, { headers: { "set-cookie": session.cookie, "cache-control": "no-store" } });
        }
        if (path === "/api/example/auth/logout" && req.method === "POST") return jsonResponse({ ok: true }, { headers: { "set-cookie": await sessions.logout(req) } });
        if (path === "/api/example/auth/password" && req.method === "PUT") {
          if (!await sessions.authenticate(req)) return errorResponse(401, "authentication_required", "Sign in first.");
          const body = await parseJson(req, changeInput);
          await passwords.change(req, "example", body.currentPassword, body.nextPassword);
          return jsonResponse({ ok: true });
        }
        return errorResponse(404, "not_found", "Not found");
      } catch (error) {
        if (error instanceof AuthBonusError) return errorResponse(error.status, error.code, error.message);
        throw error;
      }
    },
    close: () => db.close(),
  };
}
