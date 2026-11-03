import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  AuthBonusError, createBrowserSessions, createPasskeyAuth, createPasswordAuth,
  type AuthenticationResponseJSON, type PasskeyChallenge, type PasskeyCredential, type RegistrationResponseJSON,
} from "@pablozaiden/webapp/auth";
import { createWebAppServer, errorResponse, jsonResponse, parseJson, readRuntimeConfig } from "@pablozaiden/webapp/server";

const file = process.env["BONUS_STATE"]!;
const origin = process.env["BONUS_ORIGIN"]!;
interface State {
  secret: string;
  version: number;
  password?: { identityId: string; hash: string; version: number };
  credentials: Array<Omit<PasskeyCredential, "publicKey"> & { publicKey: string }>;
  challenges: PasskeyChallenge[];
  revoked: string[];
}
let state: State;
try { state = JSON.parse(readFileSync(file, "utf8")) as State; }
catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  state = { secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"), version: 0, credentials: [], challenges: [], revoked: [] };
}
function save() {
  writeFileSync(`${file}.next`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${file}.next`, file);
}
save();
const identity = () => ({ id: "member", username: "Member", userHandle: new TextEncoder().encode("member"), version: state.version });
const sessions = createBrowserSessions({
  origin, secret: new Uint8Array(Buffer.from(state.secret, "base64url")), cookie: { name: "bonus_session" },
  getIdentity: id => id === "member" ? identity() : undefined,
  getVersion: value => value.version,
  isSessionValid: value => !state.revoked.includes(value.id),
  onRevoke: value => { state.revoked.push(value.id); save(); },
});
const passwords = createPasswordAuth({
  origin,
  getCredential: username => username === "member" ? state.password : undefined,
  getCredentialByIdentity: id => id === "member" ? state.password : undefined,
  setCredential(id, expected, next) {
    if (id !== "member" || state.password?.version !== expected) return false;
    state.password = { identityId: id, ...next };
    state.version++;
    save();
    return true;
  },
  allowAttempt: attempt => attempt.request.headers.get("x-deny-attempt") !== "true",
});
function credential(value: State["credentials"][number]): PasskeyCredential {
  return { ...value, publicKey: new Uint8Array(Buffer.from(value.publicKey, "base64url")) };
}
const passkeys = createPasskeyAuth({
  origin, rpID: new URL(origin).hostname, rpName: "Bonus fixture",
  getIdentity: id => id === "member" ? identity() : undefined,
  listCredentials: id => state.credentials.filter(value => id === undefined || value.identityId === id).map(credential),
  getCredential: id => { const found = state.credentials.find(value => value.credentialId === id); return found && credential(found); },
  saveChallenge: value => { state.challenges.push(value); save(); },
  consumeChallenge(id, purpose) {
    const value = state.challenges.find(record => record.id === id && record.purpose === purpose && record.expiresAt > Date.now());
    state.challenges = state.challenges.filter(record => record.id !== id);
    save();
    return value;
  },
  saveCredential(value, expected) {
    if (expected !== state.version || state.credentials.some(record => record.credentialId === value.credentialId)) return false;
    state.credentials.push({ ...value, publicKey: Buffer.from(value.publicKey).toString("base64url") });
    state.version++;
    save();
    return state.version;
  },
  updateCredential(expected, counter, version) {
    const found = state.credentials.find(value => value.credentialId === expected.credentialId);
    if (!found || version !== state.version || found.counter !== expected.counter) return false;
    found.counter = counter;
    save();
    return true;
  },
  allowAttempt: () => true,
});
const passwordInput = z.object({ password: z.string() });
const changeInput = z.object({ current: z.string(), next: z.string() });
const passkeyInput = z.object({ challengeId: z.string(), response: z.record(z.string(), z.unknown()) });
const config = readRuntimeConfig({ appName: "Bonus", envPrefix: "BONUS" });
const app = createWebAppServer({
  appName: "Bonus", envPrefix: "BONUS", runtimeConfig: config, web: false,
  async request(req) {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/private") {
        const current = await sessions.authenticate(req);
        return current ? jsonResponse({ identity: current.identity.id }) : errorResponse(401, "authentication_required", "Sign in");
      }
      if (req.method !== "POST") return undefined;
      if ((path === "/enroll" || path.startsWith("/passkeys/register")) && req.headers.get("x-enroll") !== "authorized") return new Response(null, { status: 403 });
      if (path === "/enroll") {
        const body = await parseJson(req, passwordInput);
        await passwords.enroll(req, "member", body.password);
        return jsonResponse({ ok: true });
      }
      if (path === "/login") {
        const body = await parseJson(req, passwordInput);
        const expectedVersion = state.version;
        const found = await passwords.verify(req, "member", body.password);
        if (!found) return new Response(null, { status: 401 });
        const created = await sessions.create(found.identityId, { expectedVersion });
        return jsonResponse({ ok: true }, { headers: { "set-cookie": created.cookie } });
      }
      if (path === "/password") {
        if (!await sessions.authenticate(req)) return new Response(null, { status: 401 });
        const body = await parseJson(req, changeInput);
        await passwords.change(req, "member", body.current, body.next);
        return jsonResponse({ ok: true });
      }
      if (path === "/logout") return jsonResponse({ ok: true }, { headers: { "set-cookie": await sessions.logout(req) } });
      if (path === "/passkeys/register/options") return jsonResponse(await passkeys.beginRegistration(req, "member"));
      if (path === "/passkeys/register") {
        const body = await parseJson(req, passkeyInput);
        await passkeys.finishRegistration(req, "member", body.challengeId, body.response as unknown as RegistrationResponseJSON);
        return jsonResponse({ ok: true });
      }
      if (path === "/passkeys/login/options") return jsonResponse(await passkeys.beginAuthentication(req));
      if (path === "/passkeys/login") {
        const body = await parseJson(req, passkeyInput);
        const found = await passkeys.finishAuthentication(req, body.challengeId, body.response as unknown as AuthenticationResponseJSON);
        const created = await sessions.create(found.identity.id, { expectedVersion: found.identity.version });
        return jsonResponse({ ok: true }, { headers: { "set-cookie": created.cookie } });
      }
      return undefined;
    } catch (error) {
      if (error instanceof AuthBonusError) return errorResponse(error.status, error.code, error.message);
      throw error;
    }
  },
});
await app.start();
console.log("BONUS_READY");
