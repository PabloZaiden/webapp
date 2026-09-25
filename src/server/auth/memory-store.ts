/**
 * Process-local WebAppStore for servers that deliberately use volatile state.
 */

import type {
  LogLevelName,
  ThemePreference,
  WebAppUserRole,
} from "../../contracts";
import type {
  AccountDisableResult,
  ApiKeyRecord,
  AuditEventRecord,
  DeviceAuthApprovalResult,
  DeviceAuthDenialResult,
  DeviceAuthExchangeCandidate,
  DeviceAuthExchangeResult,
  DeviceAuthRequestRecord,
  PasskeyPersistenceResult,
  RefreshSessionRecord,
  RefreshSessionRotationResult,
  SetupLinkCompletionResult,
  SigningKeyRecord,
  StoredPasskey,
  UserRecord,
  UserSetupLinkRecord,
  WebAppStore,
} from "./store";

const MAX_MEMORY_AUDIT_EVENTS = 1_000;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortByCreatedAt<T extends { createdAt: string }>(
  records: Iterable<T>,
  direction: "asc" | "desc",
  tieDirection: "asc" | "desc" = "asc",
): T[] {
  return [...records]
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const createdAt = compareText(left.record.createdAt, right.record.createdAt);
      if (createdAt !== 0) {
        return direction === "asc" ? createdAt : -createdAt;
      }
      const insertionOrder = left.index - right.index;
      return tieDirection === "asc" ? insertionOrder : -insertionOrder;
    })
    .map(({ record }) => clone(record));
}

function assertUnique(condition: boolean): void {
  if (condition) {
    throw new Error("Store record violates a uniqueness constraint.");
  }
}

/**
 * Create an in-memory store. State belongs to this store instance and is lost
 * when the instance or process is discarded.
 */
export function memoryWebAppStore(): WebAppStore {
  const preferences = new Map<string, string>();
  const users = new Map<string, UserRecord>();
  const setupLinks = new Map<string, UserSetupLinkRecord>();
  const auditEvents = new Map<string, AuditEventRecord>();
  const passkeysByUserId = new Map<string, StoredPasskey>();
  const passkeyUserIdByCredentialId = new Map<string, string>();
  const apiKeysById = new Map<string, ApiKeyRecord>();
  const apiKeyIdByHash = new Map<string, string>();
  const deviceRequestsByHash = new Map<string, DeviceAuthRequestRecord>();
  const deviceCodeHashByUserCode = new Map<string, string>();
  const refreshSessionsById = new Map<string, RefreshSessionRecord>();
  const refreshSessionIdByHash = new Map<string, string>();
  let signingKey: SigningKeyRecord | undefined;

  function preferenceKey(key: string, userId?: string): string {
    return JSON.stringify([key, userId ?? ""]);
  }

  function getPreference(key: string, userId?: string): string | undefined {
    const value = preferences.get(preferenceKey(key, userId));
    return value ? value : undefined;
  }

  function setPreference(key: string, value: string, userId?: string): void {
    preferences.set(preferenceKey(key, userId), value);
  }

  function listUsers(): UserRecord[] {
    return sortByCreatedAt(users.values(), "asc")
      .map((user) => readUserById(user.id)!);
  }

  function assertUserExists(userId: string | undefined): void {
    if (userId !== undefined && !users.has(userId)) {
      throw new Error("Store record references a missing user.");
    }
  }

  function readUserById(id: string): UserRecord | undefined {
    const user = users.get(id);
    if (!user) {
      return undefined;
    }
    return clone({
      ...user,
      passkeyConfigured: passkeysByUserId.has(id),
    });
  }

  function removeApiKey(id: string): boolean {
    const record = apiKeysById.get(id);
    if (!record) {
      return false;
    }
    apiKeysById.delete(id);
    apiKeyIdByHash.delete(record.tokenHash);
    return true;
  }

  function removeRefreshSession(id: string): boolean {
    const record = refreshSessionsById.get(id);
    if (!record) {
      return false;
    }
    refreshSessionsById.delete(id);
    refreshSessionIdByHash.delete(record.refreshTokenHash);
    return true;
  }

  function assertPasskeyCanBeSaved(passkey: StoredPasskey): void {
    const credentialOwner = passkeyUserIdByCredentialId.get(passkey.credentialId);
    assertUnique(credentialOwner !== undefined && credentialOwner !== passkey.userId);
    const idOwner = [...passkeysByUserId.values()]
      .find((record) => record.id === passkey.id)?.userId;
    assertUnique(idOwner !== undefined && idOwner !== passkey.userId);
  }

  function preparePasskey(passkey: StoredPasskey): StoredPasskey {
    assertPasskeyCanBeSaved(passkey);
    const existing = passkeysByUserId.get(passkey.userId);
    return clone({
      ...passkey,
      createdAt: existing?.createdAt ?? passkey.createdAt,
    });
  }

  function commitPasskey(passkey: StoredPasskey): void {
    const existing = passkeysByUserId.get(passkey.userId);
    if (existing && existing.credentialId !== passkey.credentialId) {
      passkeyUserIdByCredentialId.delete(existing.credentialId);
    }
    passkeysByUserId.set(passkey.userId, passkey);
    passkeyUserIdByCredentialId.set(passkey.credentialId, passkey.userId);
  }

  function revokeRefreshFamily(familyId: string, revokedAt: string): void {
    for (const [id, session] of refreshSessionsById) {
      if (session.familyId === familyId && !session.revokedAt) {
        refreshSessionsById.set(id, {
          ...session,
          revokedAt,
          updatedAt: revokedAt,
        });
      }
    }
  }

  function revokeRefreshSessionsForUser(userId: string, revokedAt: string): void {
    for (const [id, session] of refreshSessionsById) {
      if (session.userId === userId && !session.revokedAt) {
        refreshSessionsById.set(id, {
          ...session,
          revokedAt,
          updatedAt: revokedAt,
        });
      }
    }
  }

  function assertRefreshSessionCanBeSaved(session: RefreshSessionRecord): void {
    assertUnique(refreshSessionsById.has(session.id));
    assertUnique(refreshSessionIdByHash.has(session.refreshTokenHash));
  }

  function commitRefreshSession(session: RefreshSessionRecord): void {
    refreshSessionsById.set(session.id, clone(session));
    refreshSessionIdByHash.set(session.refreshTokenHash, session.id);
  }

  function completeSetupLink(
    tokenHash: string,
    userId: string,
    passkey: StoredPasskey,
    completedAt: string,
  ): SetupLinkCompletionResult {
    const link = setupLinks.get(tokenHash);
    if (!link) {
      return { kind: "not_found" };
    }
    if (link.consumedAt) {
      return { kind: "consumed" };
    }
    if (link.expiresAt <= completedAt) {
      return { kind: "expired" };
    }
    if (link.userId !== userId || passkey.userId !== link.userId) {
      return { kind: "user_mismatch" };
    }
    const user = users.get(link.userId);
    if (!user) {
      return { kind: "not_found" };
    }
    const credentialOwner = passkeyUserIdByCredentialId.get(passkey.credentialId);
    if (credentialOwner !== undefined && credentialOwner !== passkey.userId) {
      return { kind: "conflict" };
    }

    const nextPasskey = preparePasskey(passkey);
    const nextLink = clone({ ...link, consumedAt: completedAt });
    const nextUser = clone({
      ...user,
      authVersion: user.authVersion + 1,
      updatedAt: completedAt,
      passkeyConfigured: true,
    });

    commitPasskey(nextPasskey);
    setupLinks.set(tokenHash, nextLink);
    users.set(user.id, nextUser);

    return {
      kind: "completed",
      link: clone(nextLink),
      user: readUserById(user.id)!,
    };
  }

  function approveDeviceAuth(
    userCode: string,
    userId: string,
    updatedAt: string,
  ): DeviceAuthApprovalResult {
    const deviceCodeHash = deviceCodeHashByUserCode.get(userCode);
    const record = deviceCodeHash
      ? deviceRequestsByHash.get(deviceCodeHash)
      : undefined;
    if (!record) {
      return { kind: "not_found" };
    }
    if (record.expiresAt <= updatedAt) {
      return { kind: "expired" };
    }
    if (record.status === "approved") {
      return record.approvedByUserId === userId
        ? { kind: "already_approved", record: clone(record) }
        : { kind: "conflict" };
    }
    if (record.status === "denied") {
      return { kind: "denied" };
    }
    if (record.status === "consumed") {
      return { kind: "consumed" };
    }

    assertUserExists(userId);
    const updated = clone({
      ...record,
      status: "approved" as const,
      approvedByUserId: userId,
      updatedAt,
    });
    deviceRequestsByHash.set(record.deviceCodeHash, updated);
    return { kind: "approved", record: clone(updated) };
  }

  function denyDeviceAuth(
    userCode: string,
    updatedAt: string,
  ): DeviceAuthDenialResult {
    const deviceCodeHash = deviceCodeHashByUserCode.get(userCode);
    const record = deviceCodeHash
      ? deviceRequestsByHash.get(deviceCodeHash)
      : undefined;
    if (!record) {
      return { kind: "not_found" };
    }
    if (record.expiresAt <= updatedAt) {
      return { kind: "expired" };
    }
    if (record.status === "denied") {
      return { kind: "already_denied", record: clone(record) };
    }
    if (record.status === "approved") {
      return { kind: "approved" };
    }
    if (record.status === "consumed") {
      return { kind: "consumed" };
    }

    const updated = clone({
      ...record,
      status: "denied" as const,
      updatedAt,
    });
    deviceRequestsByHash.set(record.deviceCodeHash, updated);
    return { kind: "denied", record: clone(updated) };
  }

  function exchangeDeviceAuth(
    deviceCodeHash: string,
    clientId: string | undefined,
    next: DeviceAuthExchangeCandidate,
    now: string,
  ): DeviceAuthExchangeResult {
    const record = deviceRequestsByHash.get(deviceCodeHash);
    if (!record) {
      return { kind: "not_found" };
    }
    if (record.expiresAt <= now) {
      return { kind: "expired" };
    }
    if (clientId && record.clientId !== clientId) {
      return { kind: "client_mismatch" };
    }
    if (record.status === "pending") {
      return { kind: "pending" };
    }
    if (record.status === "denied") {
      return { kind: "denied" };
    }
    if (record.status === "consumed") {
      return { kind: "consumed" };
    }
    if (!record.approvedByUserId) {
      return { kind: "conflict" };
    }
    const user = readUserById(record.approvedByUserId);
    if (!user) {
      return { kind: "missing_user" };
    }
    if (user.disabledAt) {
      return { kind: "disabled_user" };
    }
    if (
      (next.userId && next.userId !== user.id)
      || next.clientId !== record.clientId
      || next.scope !== record.scope
    ) {
      return { kind: "conflict" };
    }

    const session: RefreshSessionRecord = {
      ...clone(next),
      userId: user.id,
    };
    if (
      refreshSessionsById.has(session.id)
      || refreshSessionIdByHash.has(session.refreshTokenHash)
    ) {
      return { kind: "conflict" };
    }

    const consumed = clone({
      ...record,
      status: "consumed" as const,
      updatedAt: now,
    });
    deviceRequestsByHash.set(deviceCodeHash, consumed);
    for (const [id, existing] of refreshSessionsById) {
      if (
        existing.userId === user.id
        && existing.clientId === record.clientId
        && !existing.revokedAt
        && existing.expiresAt > now
      ) {
        refreshSessionsById.set(id, {
          ...existing,
          revokedAt: now,
          updatedAt: now,
        });
      }
    }
    commitRefreshSession(session);

    return {
      kind: "exchanged",
      request: clone(consumed),
      user,
      session: clone(session),
    };
  }

  function rotateRefreshSession(
    oldHash: string,
    next: RefreshSessionRecord,
    now: string,
    clientId?: string,
  ): RefreshSessionRotationResult {
    const oldId = refreshSessionIdByHash.get(oldHash);
    const previousRecord = oldId
      ? refreshSessionsById.get(oldId)
      : undefined;
    if (!previousRecord) {
      return { kind: "not_found" };
    }
    const previous = clone(previousRecord);
    if (previous.revokedAt) {
      revokeRefreshFamily(previous.familyId, now);
      return {
        kind: "replayed",
        familyId: previous.familyId,
        userId: previous.userId,
      };
    }
    if (previous.expiresAt <= now) {
      return { kind: "expired" };
    }
    if (clientId && previous.clientId !== clientId) {
      return { kind: "client_mismatch" };
    }
    const user = readUserById(previous.userId);
    if (!user) {
      revokeRefreshFamily(previous.familyId, now);
      return {
        kind: "missing_user",
        familyId: previous.familyId,
        userId: previous.userId,
      };
    }
    if (user.disabledAt) {
      revokeRefreshFamily(previous.familyId, now);
      return {
        kind: "disabled_user",
        familyId: previous.familyId,
        userId: previous.userId,
      };
    }
    if (
      next.userId !== previous.userId
      || next.familyId !== previous.familyId
      || next.clientId !== previous.clientId
      || next.scope !== previous.scope
    ) {
      return { kind: "conflict" };
    }
    if (
      refreshSessionsById.has(next.id)
      || refreshSessionIdByHash.has(next.refreshTokenHash)
    ) {
      return { kind: "conflict" };
    }

    const updatedPrevious = clone({
      ...previousRecord,
      revokedAt: now,
      updatedAt: now,
    });
    const updatedNext = clone(next);
    refreshSessionsById.set(updatedPrevious.id, updatedPrevious);
    commitRefreshSession(updatedNext);
    return {
      kind: "rotated",
      previous,
      session: clone(updatedNext),
      user,
    };
  }

  function disableUser(id: string, disabledAt: string): AccountDisableResult {
    const existing = readUserById(id);
    if (!existing) {
      return { kind: "not_found" };
    }
    if (existing.role === "owner") {
      return { kind: "owner_immutable" };
    }
    if (existing.disabledAt) {
      return { kind: "already_disabled", user: existing };
    }

    const user = users.get(id)!;
    users.set(id, {
      ...user,
      disabledAt,
      authVersion: user.authVersion + 1,
      updatedAt: disabledAt,
    });
    revokeRefreshSessionsForUser(id, disabledAt);
    const updated = readUserById(id);
    return updated
      ? { kind: "disabled", user: updated }
      : { kind: "conflict" };
  }

  function deleteUser(id: string): boolean {
    const user = users.get(id);
    if (!user || user.role === "owner") {
      return false;
    }
    users.delete(id);

    const passkey = passkeysByUserId.get(id);
    if (passkey) {
      passkeysByUserId.delete(id);
      passkeyUserIdByCredentialId.delete(passkey.credentialId);
    }
    for (const [keyId, key] of apiKeysById) {
      if (key.userId === id) {
        removeApiKey(keyId);
      }
    }
    for (const [tokenHash, link] of setupLinks) {
      if (link.userId === id) {
        setupLinks.delete(tokenHash);
      } else if (link.createdByUserId === id) {
        const updated = clone(link);
        delete updated.createdByUserId;
        setupLinks.set(tokenHash, updated);
      }
    }
    for (const [deviceCodeHash, request] of deviceRequestsByHash) {
      if (request.approvedByUserId === id) {
        const updated = clone(request);
        delete updated.approvedByUserId;
        deviceRequestsByHash.set(deviceCodeHash, updated);
      }
    }
    for (const [sessionId, session] of refreshSessionsById) {
      if (session.userId === id) {
        removeRefreshSession(sessionId);
      }
    }
    for (const [eventId, event] of auditEvents) {
      if (event.actorUserId === id || event.targetUserId === id) {
        const updated = clone(event);
        if (updated.actorUserId === id) {
          delete updated.actorUserId;
        }
        if (updated.targetUserId === id) {
          delete updated.targetUserId;
        }
        auditEvents.set(eventId, updated);
      }
    }
    return true;
  }

  const store: WebAppStore = {
    initialize(): void {},
    getPreference,
    setPreference,
    deletePreference(key: string, userId?: string): void {
      preferences.delete(preferenceKey(key, userId));
    },
    getThemePreference(userId?: string): ThemePreference | undefined {
      return getPreference("theme", userId) as ThemePreference | undefined;
    },
    setThemePreference(value: ThemePreference, userId?: string): void {
      setPreference("theme", value, userId);
    },
    getLogLevelPreference(): LogLevelName | undefined {
      return getPreference("logLevel") as LogLevelName | undefined;
    },
    setLogLevelPreference(value: LogLevelName): void {
      setPreference("logLevel", value);
    },

    countUsers(): number {
      return users.size;
    },
    listUsers,
    createUser(user: UserRecord): void {
      assertUnique(users.has(user.id));
      assertUnique([...users.values()].some((existing) => existing.username === user.username));
      users.set(user.id, clone(user));
    },
    getUserById(id: string): UserRecord | undefined {
      return readUserById(id);
    },
    getUserByUsername(username: string): UserRecord | undefined {
      const normalized = username.toLowerCase();
      const user = [...users.values()].find(
        (candidate) => candidate.username.toLowerCase() === normalized,
      );
      return user ? readUserById(user.id) : undefined;
    },
    getOwnerUser(): UserRecord | undefined {
      return listUsers().find((user) => user.role === "owner");
    },
    setUserRole(id: string, role: WebAppUserRole, updatedAt: string): boolean {
      const user = users.get(id);
      if (!user) {
        return false;
      }
      users.set(id, { ...user, role, updatedAt });
      return true;
    },
    markUserLogin(id: string, lastLoginAt: string): void {
      const user = users.get(id);
      if (user) {
        users.set(id, { ...user, lastLoginAt, updatedAt: lastLoginAt });
      }
    },
    incrementUserAuthVersion(id: string, updatedAt: string): void {
      const user = users.get(id);
      if (user) {
        users.set(id, {
          ...user,
          authVersion: user.authVersion + 1,
          updatedAt,
        });
      }
    },
    deleteUser,

    createSetupLink(record: UserSetupLinkRecord): void {
      assertUnique(setupLinks.has(record.tokenHash));
      assertUnique([...setupLinks.values()].some((link) => link.id === record.id));
      assertUserExists(record.userId);
      assertUserExists(record.createdByUserId);
      setupLinks.set(record.tokenHash, clone(record));
    },
    getSetupLinkByTokenHash(tokenHash: string): UserSetupLinkRecord | undefined {
      const record = setupLinks.get(tokenHash);
      return record ? clone(record) : undefined;
    },
    completeSetupLink,
    deletePendingSetupLinksForUser(userId: string, nowIso: string): void {
      for (const [tokenHash, link] of setupLinks) {
        if (link.userId === userId && !link.consumedAt) {
          setupLinks.set(tokenHash, { ...link, consumedAt: nowIso });
        }
      }
    },

    saveAuditEvent(record: AuditEventRecord): void {
      assertUnique(auditEvents.has(record.id));
      assertUserExists(record.actorUserId);
      assertUserExists(record.targetUserId);
      auditEvents.set(record.id, clone(record));
      if (auditEvents.size > MAX_MEMORY_AUDIT_EVENTS) {
        const oldestId = auditEvents.keys().next().value;
        if (oldestId !== undefined) {
          auditEvents.delete(oldestId);
        }
      }
    },
    listAuditEvents(limit = 100): AuditEventRecord[] {
      const records = sortByCreatedAt(auditEvents.values(), "desc", "desc");
      return limit < 0 ? records : records.slice(0, limit);
    },

    listPasskeys(userId?: string): StoredPasskey[] {
      const records = userId
        ? [...passkeysByUserId.values()].filter((record) => record.userId === userId)
        : passkeysByUserId.values();
      return sortByCreatedAt(records, "asc");
    },
    getPasskeyByUserId(userId: string): StoredPasskey | undefined {
      const record = passkeysByUserId.get(userId);
      return record ? clone(record) : undefined;
    },
    getPasskeyByCredentialId(credentialId: string): StoredPasskey | undefined {
      const userId = passkeyUserIdByCredentialId.get(credentialId);
      const record = userId ? passkeysByUserId.get(userId) : undefined;
      return record ? clone(record) : undefined;
    },
    savePasskey(passkey: StoredPasskey): void {
      assertUserExists(passkey.userId);
      commitPasskey(preparePasskey(passkey));
    },
    savePasskeyAndIncrementUserAuthVersion(
      passkey: StoredPasskey,
      updatedAt: string,
    ): PasskeyPersistenceResult {
      const user = users.get(passkey.userId);
      if (!user) {
        return { kind: "missing_user" };
      }
      const credentialOwner = passkeyUserIdByCredentialId.get(passkey.credentialId);
      if (credentialOwner !== undefined && credentialOwner !== passkey.userId) {
        return { kind: "credential_conflict" };
      }
      const nextPasskey = preparePasskey(passkey);
      commitPasskey(nextPasskey);
      users.set(user.id, {
        ...user,
        authVersion: user.authVersion + 1,
        updatedAt,
        passkeyConfigured: true,
      });
      const updatedUser = readUserById(user.id);
      return updatedUser
        ? { kind: "saved", user: updatedUser }
        : { kind: "conflict" };
    },
    updatePasskeyUsage(credentialId: string, counter: number, lastUsedAt: string): void {
      const userId = passkeyUserIdByCredentialId.get(credentialId);
      const passkey = userId ? passkeysByUserId.get(userId) : undefined;
      if (userId && passkey) {
        passkeysByUserId.set(userId, {
          ...passkey,
          counter,
          lastUsedAt,
          updatedAt: lastUsedAt,
        });
      }
    },
    deletePasskeysForUser(userId: string): void {
      const passkey = passkeysByUserId.get(userId);
      if (passkey) {
        passkeysByUserId.delete(userId);
        passkeyUserIdByCredentialId.delete(passkey.credentialId);
      }
    },

    listApiKeys(userId?: string): ApiKeyRecord[] {
      const records = userId
        ? [...apiKeysById.values()].filter((record) => record.userId === userId)
        : apiKeysById.values();
      return sortByCreatedAt(records, "desc", "desc");
    },
    getApiKeyByHash(tokenHash: string): ApiKeyRecord | undefined {
      const id = apiKeyIdByHash.get(tokenHash);
      const record = id ? apiKeysById.get(id) : undefined;
      return record ? clone(record) : undefined;
    },
    saveApiKey(record: ApiKeyRecord): void {
      assertUnique(apiKeysById.has(record.id));
      assertUnique(apiKeyIdByHash.has(record.tokenHash));
      assertUserExists(record.userId);
      const saved = clone(record);
      apiKeysById.set(saved.id, saved);
      apiKeyIdByHash.set(saved.tokenHash, saved.id);
    },
    touchApiKey(id: string, lastUsedAt: string): void {
      const record = apiKeysById.get(id);
      if (record) {
        apiKeysById.set(id, { ...record, lastUsedAt });
      }
    },
    deleteApiKey(id: string, userId?: string): boolean {
      const record = apiKeysById.get(id);
      if (!record || (userId && record.userId !== userId)) {
        return false;
      }
      return removeApiKey(id);
    },
    deleteApiKeysForUser(userId: string): void {
      for (const [id, record] of apiKeysById) {
        if (record.userId === userId) {
          removeApiKey(id);
        }
      }
    },
    deleteExpiredApiKeys(nowIso: string): void {
      for (const [id, record] of apiKeysById) {
        if (record.expiresAt !== undefined && record.expiresAt <= nowIso) {
          removeApiKey(id);
        }
      }
    },

    saveDeviceAuthRequest(record: DeviceAuthRequestRecord): void {
      assertUnique(deviceRequestsByHash.has(record.deviceCodeHash));
      assertUnique(deviceCodeHashByUserCode.has(record.userCode));
      assertUserExists(record.approvedByUserId);
      const saved = clone(record);
      deviceRequestsByHash.set(saved.deviceCodeHash, saved);
      deviceCodeHashByUserCode.set(saved.userCode, saved.deviceCodeHash);
    },
    getDeviceAuthByUserCode(userCode: string): DeviceAuthRequestRecord | undefined {
      const hash = deviceCodeHashByUserCode.get(userCode);
      const record = hash ? deviceRequestsByHash.get(hash) : undefined;
      return record ? clone(record) : undefined;
    },
    getDeviceAuthByDeviceCodeHash(deviceCodeHash: string): DeviceAuthRequestRecord | undefined {
      const record = deviceRequestsByHash.get(deviceCodeHash);
      return record ? clone(record) : undefined;
    },
    approveDeviceAuth,
    denyDeviceAuth,
    exchangeDeviceAuth,
    deleteExpiredDeviceAuthRequests(nowIso: string): void {
      for (const [hash, record] of deviceRequestsByHash) {
        if (record.expiresAt <= nowIso) {
          deviceRequestsByHash.delete(hash);
          deviceCodeHashByUserCode.delete(record.userCode);
        }
      }
    },

    getSigningKey(): SigningKeyRecord | undefined {
      return signingKey ? clone(signingKey) : undefined;
    },
    getOrCreateSigningKey(candidate: SigningKeyRecord): SigningKeyRecord {
      signingKey ??= clone(candidate);
      return clone(signingKey);
    },

    saveRefreshSession(record: RefreshSessionRecord): void {
      assertUserExists(record.userId);
      assertRefreshSessionCanBeSaved(record);
      commitRefreshSession(record);
    },
    getRefreshSessionByHash(refreshTokenHash: string): RefreshSessionRecord | undefined {
      const id = refreshSessionIdByHash.get(refreshTokenHash);
      const record = id ? refreshSessionsById.get(id) : undefined;
      return record ? clone(record) : undefined;
    },
    listRefreshSessions(userId?: string): RefreshSessionRecord[] {
      const records = userId
        ? [...refreshSessionsById.values()].filter((record) => record.userId === userId)
        : refreshSessionsById.values();
      return sortByCreatedAt(records, "desc");
    },
    rotateRefreshSession,
    revokeRefreshSession(id: string, revokedAt: string, userId?: string): boolean {
      const record = refreshSessionsById.get(id);
      if (
        !record
        || record.revokedAt
        || (userId && record.userId !== userId)
      ) {
        return false;
      }
      refreshSessionsById.set(id, {
        ...record,
        revokedAt,
        updatedAt: revokedAt,
      });
      return true;
    },
    revokeRefreshFamily,
    revokeRefreshSessionsForUser,
    deleteExpiredRefreshSessions(nowIso: string): void {
      for (const [id, session] of refreshSessionsById) {
        if (session.expiresAt <= nowIso) {
          removeRefreshSession(id);
        }
      }
    },
    disableUser,
  };

  return store;
}
