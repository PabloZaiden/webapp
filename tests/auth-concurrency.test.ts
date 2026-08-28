import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceAuthorization, exchangeDeviceCode, exchangeRefreshToken } from "../src/server/auth/device-auth";
import { addSeconds, nowIso, sha256 } from "../src/server/auth/crypto";
import { AuthError } from "../src/server/auth/types";
import { sqliteWebAppStore } from "../src/server/auth/sqlite-store";
import type { DeviceAuthRequestRecord, RefreshSessionRecord, StoredPasskey, UserRecord } from "../src/server/auth/store";
import { readRuntimeConfig } from "../src/server/runtime-config";

function createDataDir(name: string): string {
  return join(tmpdir(), `webapp-auth-concurrency-${name}-${crypto.randomUUID()}`);
}

function createStore(dataDir: string) {
  const store = sqliteWebAppStore({ dataDir });
  store.initialize();
  return store;
}

function createUser(store: ReturnType<typeof createStore>, username: string, role: UserRecord["role"] = "user"): UserRecord {
  const timestamp = nowIso();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username,
    role,
    authVersion: 1,
    passkeyConfigured: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.createUser(user);
  return user;
}

function createPasskey(userId: string, credentialId = crypto.randomUUID()): StoredPasskey {
  const timestamp = nowIso();
  return {
    id: crypto.randomUUID(),
    userId,
    name: "Concurrency test passkey",
    credentialId,
    publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    transports: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createRefreshSession(userId: string, clientId: string, familyId: string = crypto.randomUUID(), refreshTokenHash: string = crypto.randomUUID()): RefreshSessionRecord {
  const timestamp = nowIso();
  return {
    id: crypto.randomUUID(),
    userId,
    familyId,
    clientId,
    scope: "todos:read",
    refreshTokenHash,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: addSeconds(600),
  };
}

test("new device authorizations clean up expired requests and preserve active requests", () => {
  const dataDir = createDataDir("device-cleanup");
  try {
    const store = createStore(dataDir);
    const expiredAt = new Date(Date.now() - 1_000).toISOString();
    const activeAt = addSeconds(600);
    store.saveDeviceAuthRequest({
      deviceCodeHash: "expired-device-code",
      userCode: "EXPR-2345",
      clientId: "test-cli",
      scope: "todos:read",
      status: "consumed",
      createdAt: expiredAt,
      updatedAt: expiredAt,
      expiresAt: expiredAt,
    });
    store.saveDeviceAuthRequest({
      deviceCodeHash: "active-device-code",
      userCode: "ACTV-2345",
      clientId: "test-cli",
      scope: "todos:read",
      status: "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: activeAt,
    });

    const config = readRuntimeConfig({ appName: "Auth concurrency", envPrefix: "AUTH_CONCURRENCY" });
    createDeviceAuthorization(new Request("http://localhost"), store, config, { clientId: "test-cli" });

    expect(store.getDeviceAuthByDeviceCodeHash("expired-device-code")).toBeUndefined();
    expect(store.getDeviceAuthByDeviceCodeHash("active-device-code")?.status).toBe("pending");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

async function concurrently<T>(operations: Array<() => T>): Promise<T[]> {
  return Promise.all(operations.map(async (operation) => {
    await Promise.resolve();
    return operation();
  }));
}

test("separate stores allow one device approval and one device-code exchange winner", async () => {
  const dataDir = createDataDir("device");
  try {
    const store = createStore(dataDir);
    const firstApprover = createUser(store, "first-approver", "admin");
    const secondApprover = createUser(store, "second-approver", "admin");
    const request: DeviceAuthRequestRecord = {
      deviceCodeHash: "device-code-hash",
      userCode: "ABCD-2345",
      clientId: "test-cli",
      scope: "todos:read",
      status: "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: addSeconds(600),
    };
    store.saveDeviceAuthRequest(request);

    const firstConnection = createStore(dataDir);
    const secondConnection = createStore(dataDir);
    const approvals = await concurrently([
      () => firstConnection.approveDeviceAuth(request.userCode, firstApprover.id, nowIso()),
      () => secondConnection.approveDeviceAuth(request.userCode, secondApprover.id, nowIso()),
    ]);
    expect(approvals.filter((result) => result.kind === "approved")).toHaveLength(1);
    expect(approvals.filter((result) => result.kind === "conflict")).toHaveLength(1);
    const winner = store.getDeviceAuthByUserCode(request.userCode);
    expect(winner?.status).toBe("approved");
    if (!winner?.approvedByUserId) {
      throw new Error("Device approval did not retain an approver");
    }
    expect([firstApprover.id, secondApprover.id]).toContain(winner.approvedByUserId);

    const exchangeAt = nowIso();
    const winnerId = winner.approvedByUserId;
    const exchangeCandidates = [createRefreshSession(winnerId, request.clientId), createRefreshSession(winnerId, request.clientId)];
    const exchanges = await concurrently([
      () => firstConnection.exchangeDeviceAuth(request.deviceCodeHash, request.clientId, exchangeCandidates[0]!, exchangeAt),
      () => secondConnection.exchangeDeviceAuth(request.deviceCodeHash, request.clientId, exchangeCandidates[1]!, exchangeAt),
    ]);
    expect(exchanges.filter((result) => result.kind === "exchanged")).toHaveLength(1);
    expect(exchanges.filter((result) => result.kind === "consumed")).toHaveLength(1);
    expect(store.getDeviceAuthByUserCode(request.userCode)?.status).toBe("consumed");
    expect(store.listRefreshSessions(winnerId)).toHaveLength(1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("separate stores complete a setup link and passkey transition once", async () => {
  const dataDir = createDataDir("setup");
  try {
    const store = createStore(dataDir);
    const user = createUser(store, "setup-user");
    store.createSetupLink({
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash: "setup-token-hash",
      kind: "invite",
      createdAt: nowIso(),
      expiresAt: addSeconds(600),
    });
    const firstConnection = createStore(dataDir);
    const secondConnection = createStore(dataDir);
    const completionAt = nowIso();
    const completions = await concurrently([
      () => firstConnection.completeSetupLink("setup-token-hash", user.id, createPasskey(user.id), completionAt),
      () => secondConnection.completeSetupLink("setup-token-hash", user.id, createPasskey(user.id), completionAt),
    ]);

    expect(completions.filter((result) => result.kind === "completed")).toHaveLength(1);
    expect(completions.filter((result) => result.kind === "consumed")).toHaveLength(1);
    expect(store.getSetupLinkByTokenHash("setup-token-hash")?.consumedAt).toBe(completionAt);
    expect(store.listPasskeys(user.id)).toHaveLength(1);
    expect(store.getUserById(user.id)?.authVersion).toBe(user.authVersion + 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("separate stores rotate one refresh token and replay-revoke its family", async () => {
  const dataDir = createDataDir("refresh");
  try {
    const store = createStore(dataDir);
    const user = createUser(store, "refresh-user");
    const familyId = crypto.randomUUID();
    const previous = createRefreshSession(user.id, "test-cli", familyId, "old-refresh-token");
    store.saveRefreshSession(previous);
    const firstConnection = createStore(dataDir);
    const secondConnection = createStore(dataDir);
    const next = [createRefreshSession(user.id, previous.clientId, familyId), createRefreshSession(user.id, previous.clientId, familyId)];
    const rotated = await concurrently([
      () => firstConnection.rotateRefreshSession(previous.refreshTokenHash, next[0]!, nowIso(), previous.clientId),
      () => secondConnection.rotateRefreshSession(previous.refreshTokenHash, next[1]!, nowIso(), previous.clientId),
    ]);

    expect(rotated.filter((result) => result.kind === "rotated")).toHaveLength(1);
    expect(rotated.filter((result) => result.kind === "replayed")).toHaveLength(1);
    const sessions = store.listRefreshSessions(user.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.id === next[0]!.id || session.id === next[1]!.id)).toHaveLength(1);
    expect(sessions.every((session) => session.revokedAt)).toBe(true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("separate stores get one durable signing key during first use", async () => {
  const dataDir = createDataDir("signing-key");
  try {
    const store = createStore(dataDir);
    const firstConnection = createStore(dataDir);
    const secondConnection = createStore(dataDir);
    const keys = await concurrently([
      () => firstConnection.getOrCreateSigningKey({
        alg: "EdDSA",
        kid: crypto.randomUUID(),
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "first" },
        privateJwk: { kty: "OKP", crv: "Ed25519", x: "first", d: "first" },
        createdAt: nowIso(),
      }),
      () => secondConnection.getOrCreateSigningKey({
        alg: "EdDSA",
        kid: crypto.randomUUID(),
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "second" },
        privateJwk: { kty: "OKP", crv: "Ed25519", x: "second", d: "second" },
        createdAt: nowIso(),
      }),
    ]);

    expect(keys[0]?.kid).toBe(keys[1]?.kid);
    expect(store.getSigningKey()?.kid).toBe(keys[0]?.kid);
    const restarted = createStore(dataDir);
    expect(restarted.getSigningKey()?.kid).toBe(keys[0]?.kid);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("disabling a user revokes sessions and blocks device exchange and refresh", async () => {
  const dataDir = createDataDir("disabled");
  try {
    const store = createStore(dataDir);
    const user = createUser(store, "disabled-user");
    const refresh = createRefreshSession(user.id, "test-cli", crypto.randomUUID(), "disabled-refresh-token");
    store.saveRefreshSession(refresh);
    const deviceCode = "disabled-device-code";
    store.saveDeviceAuthRequest({
      deviceCodeHash: sha256(deviceCode),
      userCode: "WXYZ-2345",
      clientId: "test-cli",
      scope: "todos:read",
      status: "approved",
      approvedByUserId: user.id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: addSeconds(600),
    });

    const disabled = store.disableUser(user.id, nowIso());
    expect(disabled.kind).toBe("disabled");
    expect(store.getUserById(user.id)?.disabledAt).toBeTruthy();
    expect(store.getUserById(user.id)?.authVersion).toBe(user.authVersion + 1);
    expect(store.listRefreshSessions(user.id).every((session) => session.revokedAt)).toBe(true);

    const config = readRuntimeConfig({ appName: "Auth concurrency", envPrefix: "AUTH_CONCURRENCY" });
    let deviceError: unknown;
    try {
      await exchangeDeviceCode(store, config, deviceCode, "test-cli");
    } catch (error) {
      deviceError = error;
    }
    expect(deviceError).toBeInstanceOf(AuthError);
    expect(deviceError).toMatchObject({ code: "invalid_grant", status: 400 });
    expect(store.listRefreshSessions(user.id)).toHaveLength(1);

    let refreshError: unknown;
    try {
      await exchangeRefreshToken(store, config, "disabled-refresh-token", "test-cli");
    } catch (error) {
      refreshError = error;
    }
    expect(refreshError).toBeInstanceOf(AuthError);
    expect(refreshError).toMatchObject({ code: "invalid_grant", status: 400 });
    expect(store.listRefreshSessions(user.id)).toHaveLength(1);
    expect(store.disableUser(user.id, nowIso()).kind).toBe("already_disabled");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
