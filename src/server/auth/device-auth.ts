import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import type { AuthSessionSummary, CurrentUser, DeviceAuthorizationResponse, DeviceVerificationDetails, TokenResponse } from "../../contracts";
import type { RuntimeConfig } from "../runtime-config";
import type { RefreshSessionRecord, WebAppStore } from "./store";
import { addSeconds, isExpired, nowIso, randomToken, sha256 } from "./crypto";
import { getRequestOriginInfo } from "./request-origin";
import { AuthError, type AccessTokenClaims } from "./types";
import { toCurrentUser } from "./users";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 10;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEVICE_CODE_TTL_SECONDS = 60 * 10;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface SigningKeyPair {
  alg: string;
  kid: string;
  publicJwk: JWK;
  privateJwk: JWK;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

function generateUserCode(): string {
  const chars: string[] = [];
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const byte of bytes) {
    chars.push(USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]!);
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function getPublicBaseUrl(req: Request, config: RuntimeConfig): string {
  return config.publicBaseUrl ?? getRequestOriginInfo(req).origin;
}

async function createSigningKey(): Promise<SigningKeyPair> {
  try {
    const pair = await generateKeyPair("EdDSA", { extractable: true });
    const publicJwk = await exportJWK(pair.publicKey);
    const privateJwk = await exportJWK(pair.privateKey);
    const kid = crypto.randomUUID();
    return { alg: "EdDSA", kid, publicJwk, privateJwk, publicKey: pair.publicKey, privateKey: pair.privateKey };
  } catch {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(pair.publicKey);
    const privateJwk = await exportJWK(pair.privateKey);
    const kid = crypto.randomUUID();
    return { alg: "ES256", kid, publicJwk, privateJwk, publicKey: pair.publicKey, privateKey: pair.privateKey };
  }
}

async function getSigningKey(store: WebAppStore): Promise<SigningKeyPair> {
  const stored = store.getSigningKey();
  if (stored) {
    return {
      alg: stored.alg,
      kid: stored.kid,
      publicJwk: stored.publicJwk as JWK,
      privateJwk: stored.privateJwk as JWK,
      publicKey: await importJWK(stored.publicJwk as JWK, stored.alg) as CryptoKey,
      privateKey: await importJWK(stored.privateJwk as JWK, stored.alg) as CryptoKey,
    };
  }
  const created = await createSigningKey();
  store.saveSigningKey({
    alg: created.alg,
    kid: created.kid,
    publicJwk: created.publicJwk as Record<string, unknown>,
    privateJwk: created.privateJwk as Record<string, unknown>,
    createdAt: nowIso(),
  });
  return created;
}

function issuer(config: RuntimeConfig): string {
  return config.authIssuer || `urn:${config.envPrefix.toLowerCase()}:webapp`;
}

async function issueAccessToken(store: WebAppStore, config: RuntimeConfig, input: {
  sessionId: string;
  user: CurrentUser;
  clientId: string;
  scope: string;
}): Promise<{ accessToken: string; jti: string }> {
  const key = await getSigningKey(store);
  const jti = crypto.randomUUID();
  const token = await new SignJWT({
    sid: input.sessionId,
    clientId: input.clientId,
    scope: input.scope,
    username: input.user.username,
    role: input.user.role,
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setSubject(input.user.id)
    .setJti(jti)
    .setIssuer(issuer(config))
    .setAudience(`${config.envPrefix.toLowerCase()}-api`)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key.privateKey);
  return { accessToken: token, jti };
}

function tokenSet(accessToken: string, refreshToken: string, scope: string): TokenResponse {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
  };
}

export function createDeviceAuthorization(req: Request, store: WebAppStore, config: RuntimeConfig, input: { clientId?: string; scope?: string } = {}): DeviceAuthorizationResponse {
  store.deleteExpiredDeviceAuthRequests(nowIso());
  const deviceCode = randomToken(32);
  let userCode = generateUserCode();
  while (store.getDeviceAuthByUserCode(userCode)) {
    userCode = generateUserCode();
  }
  const baseUrl = getPublicBaseUrl(req, config);
  const record = {
    deviceCodeHash: sha256(deviceCode),
    userCode,
    clientId: input.clientId?.trim() || `${config.envPrefix.toLowerCase()}-cli`,
    scope: input.scope?.trim() || "*",
    status: "pending" as const,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt: addSeconds(DEVICE_CODE_TTL_SECONDS),
  };
  store.saveDeviceAuthRequest(record);
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${baseUrl}/device`,
    verification_uri_complete: `${baseUrl}/device?user_code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  };
}

export function getDeviceVerificationDetails(store: WebAppStore, userCode: string, passkeyRequired: boolean): DeviceVerificationDetails {
  store.deleteExpiredDeviceAuthRequests(nowIso());
  const record = store.getDeviceAuthByUserCode(userCode);
  if (!record || isExpired(record.expiresAt)) {
    throw new AuthError("invalid_user_code", "Device authorization code is invalid or expired", 404);
  }
  return {
    userCode: record.userCode,
    clientId: record.clientId,
    scope: record.scope,
    status: record.status,
    expiresAt: record.expiresAt,
    passkeyRequired,
  };
}

export function approveDevice(store: WebAppStore, userCode: string, userId: string): DeviceVerificationDetails {
  const record = store.getDeviceAuthByUserCode(userCode);
  if (!record || isExpired(record.expiresAt)) {
    throw new AuthError("invalid_user_code", "Device authorization code is invalid or expired", 404);
  }
  if (record.status !== "pending" && record.status !== "approved") {
    throw new AuthError("invalid_request", "Device authorization can no longer be approved", 400);
  }
  store.updateDeviceAuthStatus(userCode, "approved", nowIso(), userId);
  return getDeviceVerificationDetails(store, userCode, false);
}

export function denyDevice(store: WebAppStore, userCode: string): DeviceVerificationDetails {
  const record = store.getDeviceAuthByUserCode(userCode);
  if (!record || isExpired(record.expiresAt)) {
    throw new AuthError("invalid_user_code", "Device authorization code is invalid or expired", 404);
  }
  store.updateDeviceAuthStatus(userCode, "denied", nowIso());
  return getDeviceVerificationDetails(store, userCode, false);
}

function createRefreshRecord(userId: string, clientId: string, scope: string, familyId: string = crypto.randomUUID()): { token: string; record: RefreshSessionRecord } {
  const token = randomToken(32);
  const createdAt = nowIso();
  const id = crypto.randomUUID();
  return {
    token,
    record: {
      id,
      userId,
      familyId,
      clientId,
      scope,
      refreshTokenHash: sha256(token),
      createdAt,
      updatedAt: createdAt,
      expiresAt: addSeconds(REFRESH_TOKEN_TTL_SECONDS),
    },
  };
}

function revokeExistingClientSessions(store: WebAppStore, userId: string, clientId: string, revokedAt: string): void {
  for (const session of store.listRefreshSessions(userId)) {
    if (session.clientId === clientId && !session.revokedAt && !isExpired(session.expiresAt)) {
      store.revokeRefreshSession(session.id, revokedAt, userId);
    }
  }
}

function activeRefreshSessions(store: WebAppStore, userId: string): RefreshSessionRecord[] {
  return store.listRefreshSessions(userId)
    .filter((session) => !session.revokedAt && !isExpired(session.expiresAt))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function uniqueActiveClientSessions(store: WebAppStore, userId: string): RefreshSessionRecord[] {
  const seenClientIds = new Set<string>();
  const sessions: RefreshSessionRecord[] = [];
  const duplicateRevokedAt = nowIso();
  for (const session of activeRefreshSessions(store, userId)) {
    if (seenClientIds.has(session.clientId)) {
      store.revokeRefreshSession(session.id, duplicateRevokedAt, userId);
    } else {
      seenClientIds.add(session.clientId);
      sessions.push(session);
    }
  }
  return sessions;
}

export async function exchangeDeviceCode(store: WebAppStore, config: RuntimeConfig, deviceCode: string, clientId?: string): Promise<TokenResponse> {
  store.deleteExpiredDeviceAuthRequests(nowIso());
  const record = store.getDeviceAuthByDeviceCodeHash(sha256(deviceCode));
  if (!record) {
    throw new AuthError("invalid_grant", "Device code is invalid", 400);
  }
  if (isExpired(record.expiresAt)) {
    throw new AuthError("expired_token", "Device code has expired", 400);
  }
  if (clientId && clientId !== record.clientId) {
    throw new AuthError("invalid_client", "client_id does not match device authorization", 400);
  }
  if (record.status === "pending") {
    throw new AuthError("authorization_pending", "Device authorization is still pending", 400);
  }
  if (record.status === "denied") {
    throw new AuthError("access_denied", "Device authorization was denied", 400);
  }
  if (record.status === "consumed") {
    throw new AuthError("invalid_grant", "Device code has already been used", 400);
  }
  if (!record.approvedByUserId) {
    throw new AuthError("invalid_grant", "Device authorization was not approved by a user", 400);
  }
  const userRecord = store.getUserById(record.approvedByUserId);
  if (!userRecord) {
    throw new AuthError("invalid_grant", "Approving user no longer exists", 400);
  }
  const user = toCurrentUser(userRecord);
  revokeExistingClientSessions(store, user.id, record.clientId, nowIso());
  const refresh = createRefreshRecord(user.id, record.clientId, record.scope);
  store.saveRefreshSession(refresh.record);
  const access = await issueAccessToken(store, config, {
    sessionId: refresh.record.id,
    user,
    clientId: record.clientId,
    scope: record.scope,
  });
  store.updateDeviceAuthStatus(record.userCode, "consumed", nowIso());
  return tokenSet(access.accessToken, refresh.token, record.scope);
}

export async function exchangeRefreshToken(store: WebAppStore, config: RuntimeConfig, refreshToken: string, clientId?: string): Promise<TokenResponse> {
  const hash = sha256(refreshToken);
  const session = store.getRefreshSessionByHash(hash);
  if (!session) {
    throw new AuthError("invalid_grant", "Refresh token is invalid", 400);
  }
  if (session.revokedAt) {
    store.revokeRefreshFamily(session.familyId, nowIso());
    throw new AuthError("invalid_grant", "Refresh token has been revoked", 400);
  }
  if (isExpired(session.expiresAt)) {
    throw new AuthError("invalid_grant", "Refresh token has expired", 400);
  }
  if (clientId && clientId !== session.clientId) {
    throw new AuthError("invalid_client", "client_id does not match refresh session", 400);
  }
  const userRecord = store.getUserById(session.userId);
  if (!userRecord) {
    store.revokeRefreshFamily(session.familyId, nowIso());
    throw new AuthError("invalid_grant", "Refresh token user no longer exists", 400);
  }
  const user = toCurrentUser(userRecord);
  const next = createRefreshRecord(session.userId, session.clientId, session.scope, session.familyId);
  const rotated = store.rotateRefreshSession(hash, next.record, nowIso());
  if (!rotated) {
    throw new AuthError("invalid_grant", "Refresh token is invalid", 400);
  }
  const access = await issueAccessToken(store, config, {
    sessionId: next.record.id,
    user,
    clientId: next.record.clientId,
    scope: next.record.scope,
  });
  return tokenSet(access.accessToken, next.token, next.record.scope);
}

export async function verifyAccessToken(store: WebAppStore, config: RuntimeConfig, token: string): Promise<AccessTokenClaims> {
  const key = await getSigningKey(store);
  const result = await jwtVerify(token, key.publicKey, {
    issuer: issuer(config),
    audience: `${config.envPrefix.toLowerCase()}-api`,
  });
  const payload = result.payload;
  return {
    sub: payload.sub ?? "",
    username: typeof payload["username"] === "string" ? payload["username"] : undefined,
    role: typeof payload["role"] === "string" ? payload["role"] : undefined,
    jti: payload.jti ?? "",
    sid: String(payload["sid"] ?? ""),
    clientId: String(payload["clientId"] ?? ""),
    scope: String(payload["scope"] ?? ""),
  };
}

export function listAuthSessions(store: WebAppStore, userId: string): AuthSessionSummary[] {
  store.deleteExpiredRefreshSessions?.(nowIso());
  return uniqueActiveClientSessions(store, userId)
    .map((session) => ({
      id: session.id,
      clientId: session.clientId,
      scope: session.scope,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      lastUsedAt: session.lastUsedAt,
      revokedAt: session.revokedAt,
      active: true,
    }));
}

export function revokeAuthSession(store: WebAppStore, userId: string, id: string): boolean {
  return store.revokeRefreshSession(id, nowIso(), userId);
}

export function revokeRefreshToken(store: WebAppStore, refreshToken: string): boolean {
  const session = store.getRefreshSessionByHash(sha256(refreshToken));
  return session ? store.revokeRefreshSession(session.id, nowIso()) : false;
}

export async function jwks(store: WebAppStore) {
  const key = await getSigningKey(store);
  return {
    keys: [{
      ...key.publicJwk,
      kid: key.kid,
      alg: key.alg,
      use: "sig",
    }],
  };
}

export function discovery(req: Request, config: RuntimeConfig) {
  const base = getPublicBaseUrl(req, config);
  return {
    issuer: issuer(config),
    jwks_uri: `${base}/.well-known/jwks.json`,
    device_authorization_endpoint: `${base}/api/auth/device`,
    token_endpoint: `${base}/api/auth/token`,
    revocation_endpoint: `${base}/api/auth/revoke`,
  };
}
