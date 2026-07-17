import type { ApiKeyKind, ApiKeySummary, AuditEventSummary, LogLevelName, ThemePreference, WebAppUserRole, WebAppUserSummary } from "../../contracts";

export interface UserRecord extends WebAppUserSummary {
  authVersion: number;
  disabledAt?: string;
}

export interface UserSetupLinkRecord {
  id: string;
  userId: string;
  tokenHash: string;
  kind: "invite" | "reset" | "owner-reset";
  createdByUserId?: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface AuditEventRecord extends AuditEventSummary {}

export interface StoredPasskey {
  id: string;
  userId: string;
  name: string;
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface ApiKeyRecord extends ApiKeySummary {
  userId: string;
  tokenHash: string;
  kind: ApiKeyKind;
  managedBy?: string;
}

export interface DeviceAuthRequestRecord {
  deviceCodeHash: string;
  userCode: string;
  clientId: string;
  scope: string;
  status: "pending" | "approved" | "denied" | "consumed";
  approvedByUserId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface RefreshSessionRecord {
  id: string;
  userId: string;
  familyId: string;
  clientId: string;
  scope: string;
  refreshTokenHash: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface SigningKeyRecord {
  alg: string;
  kid: string;
  publicJwk: Record<string, unknown>;
  privateJwk: Record<string, unknown>;
  createdAt: string;
}

export interface WebAppStore {
  initialize(): void;
  getPreference(key: string, userId?: string): string | undefined;
  setPreference(key: string, value: string, userId?: string): void;
  deletePreference(key: string, userId?: string): void;

  getThemePreference(userId?: string): ThemePreference | undefined;
  setThemePreference(value: ThemePreference, userId?: string): void;
  getLogLevelPreference(): LogLevelName | undefined;
  setLogLevelPreference(value: LogLevelName): void;

  countUsers(): number;
  listUsers(): UserRecord[];
  createUser(user: UserRecord): void;
  getUserById(id: string): UserRecord | undefined;
  getUserByUsername(username: string): UserRecord | undefined;
  getOwnerUser(): UserRecord | undefined;
  setUserRole(id: string, role: WebAppUserRole, updatedAt: string): boolean;
  markUserLogin(id: string, lastLoginAt: string): void;
  incrementUserAuthVersion(id: string, updatedAt: string): void;
  deleteUser(id: string): boolean;

  createSetupLink(record: UserSetupLinkRecord): void;
  getSetupLinkByTokenHash(tokenHash: string): UserSetupLinkRecord | undefined;
  consumeSetupLink(id: string, consumedAt: string): void;
  deletePendingSetupLinksForUser(userId: string, nowIso: string): void;

  saveAuditEvent(record: AuditEventRecord): void;
  listAuditEvents(limit?: number): AuditEventRecord[];

  listPasskeys(userId?: string): StoredPasskey[];
  getPasskeyByUserId(userId: string): StoredPasskey | undefined;
  getPasskeyByCredentialId(credentialId: string): StoredPasskey | undefined;
  savePasskey(passkey: StoredPasskey): void;
  updatePasskeyUsage(credentialId: string, counter: number, lastUsedAt: string): void;
  deletePasskeysForUser(userId: string): void;

  listApiKeys(userId?: string): ApiKeyRecord[];
  getApiKeyByHash(tokenHash: string): ApiKeyRecord | undefined;
  saveApiKey(record: ApiKeyRecord): void;
  touchApiKey(id: string, lastUsedAt: string): void;
  deleteApiKey(id: string, userId?: string): boolean;
  deleteApiKeysForUser(userId: string): void;
  deleteExpiredApiKeys?(nowIso: string): void;

  saveDeviceAuthRequest(record: DeviceAuthRequestRecord): void;
  getDeviceAuthByUserCode(userCode: string): DeviceAuthRequestRecord | undefined;
  getDeviceAuthByDeviceCodeHash(deviceCodeHash: string): DeviceAuthRequestRecord | undefined;
  updateDeviceAuthStatus(userCode: string, status: DeviceAuthRequestRecord["status"], updatedAt: string, approvedByUserId?: string): void;
  deleteExpiredDeviceAuthRequests(nowIso: string): void;

  getSigningKey(): SigningKeyRecord | undefined;
  saveSigningKey(record: SigningKeyRecord): void;

  saveRefreshSession(record: RefreshSessionRecord): void;
  getRefreshSessionByHash(refreshTokenHash: string): RefreshSessionRecord | undefined;
  listRefreshSessions(userId?: string): RefreshSessionRecord[];
  rotateRefreshSession(oldHash: string, next: RefreshSessionRecord, nowIso: string): RefreshSessionRecord | undefined;
  revokeRefreshSession(id: string, revokedAt: string, userId?: string): boolean;
  revokeRefreshFamily(familyId: string, revokedAt: string): void;
  revokeRefreshSessionsForUser(userId: string, revokedAt: string): void;
  deleteExpiredRefreshSessions?(nowIso: string): void;
}
