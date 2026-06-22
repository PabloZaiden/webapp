export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error";

export type ThemePreference = "system" | "light" | "dark";

export interface PasskeyAuthStatusResponse {
  enabled: boolean;
  passkeyConfigured: boolean;
  passkeyDisabled: boolean;
  passkeyRequired: boolean;
  authenticated: boolean;
}

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
  active: boolean;
}

export interface WebAppConfigResponse {
  appName: string;
  version: string;
  passkeyAuth: PasskeyAuthStatusResponse;
  logLevel: {
    level: LogLevelName;
    fromEnv: boolean;
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
