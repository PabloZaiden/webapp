import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isIP } from "node:net";
import type { PasskeyAuthStatusResponse } from "../../contracts";
import type { RuntimeConfig } from "../runtime-config";
import type { UserRecord, WebAppStore } from "./store";
import { hmacSha256, isExpired, nowIso, randomToken, secureEqual, sha256 } from "./crypto";
import { getCookiePath, getRequestOriginInfo } from "./request-origin";
import { AuthError } from "./types";
import { assertValidUsername, audit, createUserRecord, toCurrentUser } from "./users";

const SESSION_COOKIE = "webapp_passkey_session";
const CHALLENGE_COOKIE = "webapp_passkey_challenge";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_TTL_SECONDS = 60 * 10;
const SECRET_KEY = "passkey.secret";

interface SignedCookiePayload {
  expiresAt: number;
}

interface ChallengePayload extends SignedCookiePayload {
  challenge: string;
  type: "bootstrap" | "owner-reset" | "setup" | "authentication";
  userId?: string;
  username?: string;
  setupTokenHash?: string;
}

interface SessionPayload extends SignedCookiePayload {
  nonce: string;
  userId: string;
  authVersion: number;
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

function setSessionHeaders(req: Request, store: WebAppStore, config: RuntimeConfig, user: UserRecord): Headers {
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const secret = getSecret(store);
  const payload: SessionPayload = {
    nonce: randomToken(16),
    userId: user.id,
    authVersion: user.authVersion,
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

function registrationUserId(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(userId)) as Uint8Array<ArrayBuffer>;
}

function webauthnRpId(hostname: string): string {
  if (isIP(hostname)) {
    throw new AuthError("invalid_passkey_host", "Passkeys require a hostname such as localhost, not an IP address", 400);
  }
  return hostname;
}

async function beginRegistrationForUser(req: Request, store: WebAppStore, config: RuntimeConfig, user: { id: string; username: string }, type: ChallengePayload["type"], setupTokenHash?: string) {
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const rpID = webauthnRpId(origin.hostname);
  const options = await generateRegistrationOptions({
    rpName: config.appName,
    rpID,
    userID: registrationUserId(user.id),
    userName: user.username,
    userDisplayName: user.username,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  } as Parameters<typeof generateRegistrationOptions>[0]);
  return { options, headers: setChallengeHeaders(req, store, config, { challenge: options.challenge, type, userId: user.id, username: user.username, setupTokenHash }) };
}

async function verifyAndSavePasskey(req: Request, store: WebAppStore, config: RuntimeConfig, response: RegistrationResponseJSON, user: UserRecord, challenge: ChallengePayload): Promise<Headers> {
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const rpID = webauthnRpId(origin.hostname);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin.origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new AuthError("registration_failed", "Passkey registration failed", 400);
  }
  const info = verification.registrationInfo;
  const timestamp = nowIso();
  store.savePasskey({
    id: crypto.randomUUID(),
    userId: user.id,
    name: "Primary passkey",
    credentialId: info.credential.id,
    publicKey: new Uint8Array(info.credential.publicKey) as Uint8Array<ArrayBuffer>,
    counter: info.credential.counter,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    transports: info.credential.transports ?? response.response.transports ?? [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.incrementUserAuthVersion(user.id, timestamp);
  const updatedUser = store.getUserById(user.id) ?? user;
  return setSessionHeaders(req, store, config, updatedUser);
}

export function getPasskeySessionUser(req: Request, store: WebAppStore, config: RuntimeConfig) {
  if (config.passkeyDisabled) {
    const owner = store.getOwnerUser();
    return owner ? toCurrentUser(owner) : undefined;
  }
  const secret = store.getPreference(SECRET_KEY);
  if (!secret) {
    return undefined;
  }
  const session = decodeSigned<SessionPayload>(getCookie(req, SESSION_COOKIE), secret);
  if (!session || session.expiresAt <= Date.now()) {
    return undefined;
  }
  const user = store.getUserById(session.userId);
  if (!user || user.disabledAt || user.authVersion !== session.authVersion) {
    return undefined;
  }
  return toCurrentUser(user);
}

export function hasPasskeySession(req: Request, store: WebAppStore, config: RuntimeConfig): boolean {
  return Boolean(getPasskeySessionUser(req, store, config));
}

export function isPasskeyAuthRequired(store: WebAppStore, config: RuntimeConfig): boolean {
  return !config.passkeyDisabled && store.countUsers() > 0;
}

export function passkeyStatus(req: Request, store: WebAppStore, config: RuntimeConfig, enabled = true): PasskeyAuthStatusResponse {
  const users = store.countUsers();
  const owner = store.getOwnerUser();
  const passkeyConfigured = store.listPasskeys().length > 0;
  const ownerPasskeySetupRequired = users > 0 && Boolean(owner && !owner.passkeyConfigured);
  return {
    enabled,
    passkeyConfigured,
    passkeyDisabled: config.passkeyDisabled,
    passkeyRequired: enabled && users > 0 && !config.passkeyDisabled,
    authenticated: !enabled || Boolean(getPasskeySessionUser(req, store, config)),
    bootstrapRequired: enabled && users === 0,
    ownerPasskeySetupRequired,
  };
}

export async function beginBootstrapRegistration(req: Request, store: WebAppStore, config: RuntimeConfig, username: string) {
  if (store.countUsers() > 0) {
    throw new AuthError("owner_exists", "Owner user is already configured", 409);
  }
  const normalized = assertValidUsername(username);
  return beginRegistrationForUser(req, store, config, { id: crypto.randomUUID(), username: normalized }, "bootstrap");
}

export async function completeBootstrapRegistration(req: Request, store: WebAppStore, config: RuntimeConfig, response: RegistrationResponseJSON) {
  if (store.countUsers() > 0) {
    throw new AuthError("owner_exists", "Owner user is already configured", 409);
  }
  const challenge = readChallenge(req, store, "bootstrap");
  if (!challenge.userId || !challenge.username) {
    throw new AuthError("challenge_invalid", "Passkey challenge is invalid or expired", 400);
  }
  const owner = createUserRecord({ username: challenge.username, role: "owner" });
  owner.id = challenge.userId;
  store.createUser(owner);
  const headers = await verifyAndSavePasskey(req, store, config, response, owner, challenge);
  audit(store, { eventType: "owner_created", targetUserId: owner.id });
  return headers;
}

export async function beginOwnerPasskeySetup(req: Request, store: WebAppStore, config: RuntimeConfig) {
  const owner = store.getOwnerUser();
  if (!owner || owner.passkeyConfigured) {
    throw new AuthError("owner_setup_unavailable", "Owner passkey setup is not available", 409);
  }
  return beginRegistrationForUser(req, store, config, owner, "owner-reset");
}

export async function completeOwnerPasskeySetup(req: Request, store: WebAppStore, config: RuntimeConfig, response: RegistrationResponseJSON) {
  const challenge = readChallenge(req, store, "owner-reset");
  const owner = challenge.userId ? store.getUserById(challenge.userId) : undefined;
  if (!owner || owner.role !== "owner" || owner.passkeyConfigured) {
    throw new AuthError("owner_setup_unavailable", "Owner passkey setup is not available", 409);
  }
  const headers = await verifyAndSavePasskey(req, store, config, response, owner, challenge);
  audit(store, { eventType: "owner_passkey_configured", targetUserId: owner.id });
  return headers;
}

export function getSetupDetails(store: WebAppStore, token: string) {
  const link = store.getSetupLinkByTokenHash(sha256(token));
  if (!link || link.consumedAt || isExpired(link.expiresAt)) {
    throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
  }
  const user = store.getUserById(link.userId);
  if (!user) {
    throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
  }
  return {
    username: user.username,
    role: user.role,
    kind: link.kind === "reset" ? "reset" as const : "invite" as const,
    expiresAt: link.expiresAt,
  };
}

export async function beginSetupRegistration(req: Request, store: WebAppStore, config: RuntimeConfig, token: string) {
  const tokenHash = sha256(token);
  const link = store.getSetupLinkByTokenHash(tokenHash);
  if (!link || link.consumedAt || isExpired(link.expiresAt)) {
    throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
  }
  const user = store.getUserById(link.userId);
  if (!user) {
    throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
  }
  return beginRegistrationForUser(req, store, config, user, "setup", tokenHash);
}

export async function completeSetupRegistration(req: Request, store: WebAppStore, config: RuntimeConfig, token: string, response: RegistrationResponseJSON) {
  const tokenHash = sha256(token);
  const challenge = readChallenge(req, store, "setup");
  if (challenge.setupTokenHash !== tokenHash || !challenge.userId) {
    throw new AuthError("challenge_invalid", "Passkey challenge is invalid or expired", 400);
  }
  const link = store.getSetupLinkByTokenHash(tokenHash);
  const user = link ? store.getUserById(link.userId) : undefined;
  if (!link || !user || link.consumedAt || isExpired(link.expiresAt) || user.id !== challenge.userId) {
    throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
  }
  const headers = await verifyAndSavePasskey(req, store, config, response, user, challenge);
  store.consumeSetupLink(link.id, nowIso());
  audit(store, { eventType: link.kind === "reset" ? "user_reset_completed" : "user_invite_completed", targetUserId: user.id });
  return headers;
}

export async function beginAuthentication(req: Request, store: WebAppStore, config: RuntimeConfig) {
  const passkeys = store.listPasskeys();
  if (passkeys.length === 0) {
    throw new AuthError("passkey_missing", "No passkey is configured", 409);
  }
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const rpID = webauthnRpId(origin.hostname);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports as AuthenticatorTransport[],
    })),
    userVerification: "preferred",
  } as Parameters<typeof generateAuthenticationOptions>[0]);
  return { options, headers: setChallengeHeaders(req, store, config, { challenge: options.challenge, type: "authentication" }) };
}

export async function completeAuthentication(req: Request, store: WebAppStore, config: RuntimeConfig, response: AuthenticationResponseJSON) {
  const challenge = readChallenge(req, store, "authentication");
  const passkey = store.getPasskeyByCredentialId(response.id);
  const user = passkey ? store.getUserById(passkey.userId) : undefined;
  if (!passkey || !user) {
    throw new AuthError("passkey_not_found", "Passkey credential is not registered", 404);
  }
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const rpID = webauthnRpId(origin.hostname);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin.origin,
    expectedRPID: rpID,
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
  const timestamp = nowIso();
  store.updatePasskeyUsage(passkey.credentialId, verification.authenticationInfo.newCounter, timestamp);
  store.markUserLogin(user.id, timestamp);
  audit(store, { eventType: "user_login", actorUserId: user.id });
  return setSessionHeaders(req, store, config, user);
}

export function logoutHeaders(req: Request, config: RuntimeConfig): Headers {
  const origin = getRequestOriginInfo(req, config.publicBaseUrl);
  const headers = new Headers();
  headers.append("set-cookie", expiredCookie(req, SESSION_COOKIE, origin.secure));
  headers.append("set-cookie", expiredCookie(req, CHALLENGE_COOKIE, origin.secure));
  return headers;
}

export function deletePasskey(req: Request, store: WebAppStore, config: RuntimeConfig, userId: string): Headers {
  const timestamp = nowIso();
  store.deletePasskeysForUser(userId);
  store.incrementUserAuthVersion(userId, timestamp);
  store.deleteApiKeysForUser(userId);
  store.revokeRefreshSessionsForUser(userId, timestamp);
  audit(store, { eventType: "passkey_deleted", actorUserId: userId, targetUserId: userId });
  return logoutHeaders(req, config);
}
