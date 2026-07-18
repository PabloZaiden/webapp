export const VALID_LOG_LEVELS = ["silly", "trace", "debug", "info", "warn", "error", "fatal"] as const;

export type LogLevelName = typeof VALID_LOG_LEVELS[number];

export const LOG_LEVELS: Record<LogLevelName, number> = {
  silly: 0,
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
  fatal: 6,
};

export const LOG_LEVEL_NAMES: Record<number, LogLevelName> = {
  0: "silly",
  1: "trace",
  2: "debug",
  3: "info",
  4: "warn",
  5: "error",
  6: "fatal",
};

export const DEFAULT_LOG_LEVEL: LogLevelName = "info";

export type ThemePreference = "system" | "light" | "dark";

export type WebAppUserRole = "owner" | "admin" | "user";

export interface CurrentUser {
  id: string;
  username: string;
  role: WebAppUserRole;
  isOwner: boolean;
  isAdmin: boolean;
}

export interface WebAppUserSummary {
  id: string;
  username: string;
  role: WebAppUserRole;
  passkeyConfigured: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface UserSetupLinkResponse {
  url: string;
  expiresAt: string;
}

export interface CreatedUserResponse {
  user: WebAppUserSummary;
  setupLink: UserSetupLinkResponse;
}

export interface UserSetupDetails {
  username: string;
  role: WebAppUserRole;
  kind: "invite" | "reset";
  expiresAt: string;
}

export interface AuditEventSummary {
  id: string;
  eventType: string;
  actorUserId?: string;
  targetUserId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PasskeyAuthStatusResponse {
  enabled: boolean;
  passkeyConfigured: boolean;
  passkeyDisabled: boolean;
  passkeyRequired: boolean;
  authenticated: boolean;
  bootstrapRequired: boolean;
  ownerPasskeySetupRequired: boolean;
}

export type ApiKeyKind = "user" | "managed";

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export interface CreatedApiKeyResponse {
  key: ApiKeySummary;
  token: string;
}

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceVerificationDetails {
  userCode: string;
  clientId: string;
  scope: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  expiresAt: string;
  passkeyRequired: boolean;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface AuthSessionSummary {
  id: string;
  clientId: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  /** Built-in session lists only expose active sessions; retained for API compatibility. */
  active: boolean;
}

export interface ServerLogEntry {
  timestamp: string;
  level: LogLevelName;
  scope: string;
  message: string;
  line: string;
}

export interface WebAppConfigResponse {
  appName: string;
  version: string;
  currentUser?: CurrentUser;
  passkeyAuth: PasskeyAuthStatusResponse;
  userManagement: {
    enabled: boolean;
    canManageUsers: boolean;
  };
  logLevel: {
    level: LogLevelName;
    fromEnv: boolean;
  };
  inMemoryLogs: {
    enabled: boolean;
  };
  deviceAuth: {
    enabled: boolean;
  };
  apiKeys: {
    enabled: boolean;
  };
}

export interface WebAppErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}
