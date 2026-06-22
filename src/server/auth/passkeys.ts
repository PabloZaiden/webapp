import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { PasskeyAuthStatusResponse } from "../../contracts";
import type { RuntimeConfig } from "../runtime-config";
import type { WebAppStore } from "./store";
import { hmacSha256, nowIso, randomToken, secureEqual } from "./crypto";
import { getCookiePath, getRequestOriginInfo } from "./request-origin";
import { AuthError } from "./types";

const SESSION_COOKIE = "webapp_passkey_session";
const CHALLENGE_COOKIE = "webapp_passkey_challenge";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_TTL_SECONDS = 60 * 10;
const SECRET_KEY = "passkey.secret";
const VERSION_KEY = "passkey.version";

interface SignedCookiePayload {
  expiresAt: number;
}

interface ChallengePayload extends SignedCookiePayload {
  challenge: string;
  type: "registration" | "authentication";
}

interface SessionPayload extends SignedCookiePayload {
  nonce: string;
  version: number;
}

function getSecret(store: WebAppStore): string {
  const existing = store.getPreference(SECRET_KEY);
  if (existing) {
    return existing;
  }
  const secret = randomToken();
  store.setPreference(SECRET_KEY, secret);
  return secret;
}

function getVersion(store: WebAppStore): number {
  const raw = store.getPreference(VERSION_KEY);
  const version = raw ? Number(raw) : 1;
  if (!Number.isInteger(version) || version <= 0) {
    store.setPreference(VERSION_KEY, "1");
    return 1;
  }
  if (!raw) {
    store.setPreference(VERSION_KEY, "1");
  }
  return version;
}

function bumpVersion(store: WebAppStore): void {
  store.setPreference(VERSION_KEY, String(getVersion(store) + 1));
}

function encodeSigned(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmacSha256(body, secret)}`;
}

function decodeSigned<T>(value: string | undefined, secret: string): T | undefined {
  if (!value) {
    return undefined;
  }
  const [body, signature] = value.split(".", 2);
  if (!body || !signature || !secureEqual(signature, hmacSha256(body, secret))) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function getCookie(req: Request, name: string): string | undefined {
  const cookie = req.headers.get("cookie");
  if (!cookie) {
    return undefined;
  }
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return rawValue.join("=");
    }
  }
  return undefined;
}

function cookieHeader(req: Request, name: string, value: string, maxAge: number, secure: boolean): string {
  return [
    `${name}=${value}`,
    `Path=${getCookiePath(req)}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function expiredCookie(req: Request, name: string, secure: boolean): string {
  return cookieHeader(req, name, "", 0, secure);
}

function setSessionHeaders(req: Request, store: WebAppStore, config: RuntimeConfig): Headers {
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const secret = getSecret(store);
  const payload: SessionPayload = {
    nonce: randomToken(16),
    version: getVersion(store),
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader(req, SESSION_COOKIE, encodeSigned(payload, secret), SESSION_TTL_SECONDS, origin.secure));
  headers.append("set-cookie", expiredCookie(req, CHALLENGE_COOKIE, origin.secure));
  return headers;
}

function setChallengeHeaders(req: Request, store: WebAppStore, config: RuntimeConfig, payload: Omit<ChallengePayload, "expiresAt">): Headers {
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const secret = getSecret(store);
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader(req, CHALLENGE_COOKIE, encodeSigned({
    ...payload,
    expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
  }, secret), CHALLENGE_TTL_SECONDS, origin.secure));
  return headers;
}

function readChallenge(req: Request, store: WebAppStore, type: ChallengePayload["type"]): ChallengePayload {
  const secret = getSecret(store);
  const challenge = decodeSigned<ChallengePayload>(getCookie(req, CHALLENGE_COOKIE), secret);
  if (!challenge || challenge.type !== type || challenge.expiresAt <= Date.now()) {
    throw new AuthError("challenge_invalid", "Passkey challenge is invalid or expired", 400);
  }
  return challenge;
}

export function hasPasskeySession(req: Request, store: WebAppStore): boolean {
  const secret = store.getPreference(SECRET_KEY);
  if (!secret) {
    return false;
  }
  const session = decodeSigned<SessionPayload>(getCookie(req, SESSION_COOKIE), secret);
  return Boolean(session && session.expiresAt > Date.now() && session.version === getVersion(store));
}

export function isPasskeyAuthRequired(store: WebAppStore, config: RuntimeConfig): boolean {
  return !config.passkeyDisabled && store.listPasskeys().length > 0;
}

export function passkeyStatus(req: Request, store: WebAppStore, config: RuntimeConfig, enabled = true): PasskeyAuthStatusResponse {
  const passkeyConfigured = store.listPasskeys().length > 0;
  return {
    enabled,
    passkeyConfigured,
    passkeyDisabled: config.passkeyDisabled,
    passkeyRequired: enabled && passkeyConfigured && !config.passkeyDisabled,
    authenticated: !enabled || config.passkeyDisabled || hasPasskeySession(req, store),
  };
}

export async function beginRegistration(req: Request, store: WebAppStore, config: RuntimeConfig) {
  if (store.listPasskeys().length > 0) {
    throw new AuthError("passkey_exists", "A passkey is already configured", 409);
  }
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const options = await generateRegistrationOptions({
    rpName: config.appName,
    rpID: origin.hostname,
    userID: new Uint8Array(Buffer.from(config.envPrefix.toLowerCase())),
    userName: config.envPrefix.toLowerCase(),
    userDisplayName: config.appName,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  return { options, headers: setChallengeHeaders(req, store, config, { challenge: options.challenge, type: "registration" }) };
}

export async function completeRegistration(req: Request, store: WebAppStore, config: RuntimeConfig, response: RegistrationResponseJSON) {
  if (store.listPasskeys().length > 0) {
    throw new AuthError("passkey_exists", "A passkey is already configured", 409);
  }
  const challenge = readChallenge(req, store, "registration");
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin.origin,
    expectedRPID: origin.hostname,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new AuthError("registration_failed", "Passkey registration failed", 400);
  }
  const info = verification.registrationInfo;
  store.savePasskey({
    id: crypto.randomUUID(),
    name: "Primary passkey",
    credentialId: info.credential.id,
    publicKey: new Uint8Array(info.credential.publicKey) as Uint8Array<ArrayBuffer>,
    counter: info.credential.counter,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    transports: info.credential.transports ?? response.response.transports ?? [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  bumpVersion(store);
  return setSessionHeaders(req, store, config);
}

export async function beginAuthentication(req: Request, store: WebAppStore, config: RuntimeConfig) {
  const passkeys = store.listPasskeys();
  if (passkeys.length === 0) {
    throw new AuthError("passkey_missing", "No passkey is configured", 409);
  }
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const options = await generateAuthenticationOptions({
    rpID: origin.hostname,
    allowCredentials: passkeys.map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports as AuthenticatorTransport[],
    })),
    userVerification: "preferred",
  });
  return { options, headers: setChallengeHeaders(req, store, config, { challenge: options.challenge, type: "authentication" }) };
}

export async function completeAuthentication(req: Request, store: WebAppStore, config: RuntimeConfig, response: AuthenticationResponseJSON) {
  const challenge = readChallenge(req, store, "authentication");
  const passkey = store.getPasskeyByCredentialId(response.id);
  if (!passkey) {
    throw new AuthError("passkey_not_found", "Passkey credential is not registered", 404);
  }
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin.origin,
    expectedRPID: origin.hostname,
    credential: {
      id: passkey.credentialId,
      publicKey: passkey.publicKey,
      counter: passkey.counter,
      transports: passkey.transports as AuthenticatorTransport[],
    },
    requireUserVerification: false,
  });
  if (!verification.verified) {
    throw new AuthError("authentication_failed", "Passkey authentication failed", 401);
  }
  store.updatePasskeyUsage(passkey.credentialId, verification.authenticationInfo.newCounter, nowIso());
  return setSessionHeaders(req, store, config);
}

export function logoutHeaders(req: Request, config: RuntimeConfig): Headers {
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const headers = new Headers();
  headers.append("set-cookie", expiredCookie(req, SESSION_COOKIE, origin.secure));
  headers.append("set-cookie", expiredCookie(req, CHALLENGE_COOKIE, origin.secure));
  return headers;
}

export function deletePasskey(req: Request, store: WebAppStore, config: RuntimeConfig): Headers {
  store.deleteAllPasskeys();
  bumpVersion(store);
  return logoutHeaders(req, config);
}
