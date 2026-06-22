import type { ApiKeySummary, LogLevelName, ThemePreference } from "../../contracts";

export interface StoredPasskey {
  id: string;
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
  tokenHash: string;
}

export interface DeviceAuthRequestRecord {
  deviceCodeHash: string;
  userCode: string;
  clientId: string;
  scope: string;
  status: "pending" | "approved" | "denied" | "consumed";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface RefreshSessionRecord {
  id: string;
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
  getPreference(key: string): string | undefined;
  setPreference(key: string, value: string): void;
  deletePreference(key: string): void;

  getThemePreference(): ThemePreference | undefined;
  setThemePreference(value: ThemePreference): void;
  getLogLevelPreference(): LogLevelName | undefined;
  setLogLevelPreference(value: LogLevelName): void;

  listPasskeys(): StoredPasskey[];
  getPasskeyByCredentialId(credentialId: string): StoredPasskey | undefined;
  savePasskey(passkey: StoredPasskey): void;
  updatePasskeyUsage(credentialId: string, counter: number, lastUsedAt: string): void;
  deleteAllPasskeys(): void;

  listApiKeys(): ApiKeyRecord[];
  getApiKeyByHash(tokenHash: string): ApiKeyRecord | undefined;
  saveApiKey(record: ApiKeyRecord): void;
  touchApiKey(id: string, lastUsedAt: string): void;
  deleteApiKey(id: string): boolean;

  saveDeviceAuthRequest(record: DeviceAuthRequestRecord): void;
  getDeviceAuthByUserCode(userCode: string): DeviceAuthRequestRecord | undefined;
  getDeviceAuthByDeviceCodeHash(deviceCodeHash: string): DeviceAuthRequestRecord | undefined;
  updateDeviceAuthStatus(userCode: string, status: DeviceAuthRequestRecord["status"], updatedAt: string): void;
  deleteExpiredDeviceAuthRequests(nowIso: string): void;

  getSigningKey(): SigningKeyRecord | undefined;
  saveSigningKey(record: SigningKeyRecord): void;

  saveRefreshSession(record: RefreshSessionRecord): void;
  getRefreshSessionByHash(refreshTokenHash: string): RefreshSessionRecord | undefined;
  listRefreshSessions(): RefreshSessionRecord[];
  rotateRefreshSession(oldHash: string, next: RefreshSessionRecord, nowIso: string): RefreshSessionRecord | undefined;
  revokeRefreshSession(id: string, revokedAt: string): boolean;
  revokeRefreshFamily(familyId: string, revokedAt: string): void;
}
