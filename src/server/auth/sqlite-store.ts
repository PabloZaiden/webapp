import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { ApiKeyRecord, DeviceAuthRequestRecord, RefreshSessionRecord, SigningKeyRecord, StoredPasskey, WebAppStore } from "./store";
import type { LogLevelName, ThemePreference } from "../../contracts";

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function sqliteWebAppStore(options: { dataDir?: string; fileName?: string } = {}): WebAppStore {
  const dataDir = options.dataDir ?? process.env["WEBAPP_DATA_DIR"] ?? "./data";
  const dbPath = join(dataDir, options.fileName ?? "webapp.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  function initialize(): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webapp_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webapp_passkeys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        transports TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS webapp_api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS webapp_device_auth_requests (
        device_code_hash TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webapp_signing_keys (
        kid TEXT PRIMARY KEY,
        alg TEXT NOT NULL,
        public_jwk TEXT NOT NULL,
        private_jwk TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webapp_refresh_sessions (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
    `);
  }

  function getPreference(key: string): string | undefined {
    const row = db.query("SELECT value FROM webapp_preferences WHERE key = ?").get(key) as Row | null;
    return optionalText(row?.["value"]);
  }

  function setPreference(key: string, value: string): void {
    db.query(`
      INSERT INTO webapp_preferences (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, nowIso());
  }

  function deletePreference(key: string): void {
    db.query("DELETE FROM webapp_preferences WHERE key = ?").run(key);
  }

  function mapPasskey(row: Row): StoredPasskey {
    return {
      id: text(row["id"]),
      name: text(row["name"]),
      credentialId: text(row["credential_id"]),
      publicKey: new Uint8Array(row["public_key"] as ArrayBuffer) as Uint8Array<ArrayBuffer>,
      counter: Number(row["counter"] ?? 0),
      deviceType: text(row["device_type"]),
      backedUp: Number(row["backed_up"] ?? 0) === 1,
      transports: json<string[]>(row["transports"], []),
      createdAt: text(row["created_at"]),
      updatedAt: text(row["updated_at"]),
      lastUsedAt: optionalText(row["last_used_at"]),
    };
  }

  function mapApiKey(row: Row): ApiKeyRecord {
    return {
      id: text(row["id"]),
      name: text(row["name"]),
      prefix: text(row["prefix"]),
      tokenHash: text(row["token_hash"]),
      scopes: json<string[]>(row["scopes"], []),
      createdAt: text(row["created_at"]),
      lastUsedAt: optionalText(row["last_used_at"]),
      expiresAt: optionalText(row["expires_at"]),
      revokedAt: optionalText(row["revoked_at"]),
    };
  }

  function mapDevice(row: Row): DeviceAuthRequestRecord {
    return {
      deviceCodeHash: text(row["device_code_hash"]),
      userCode: text(row["user_code"]),
      clientId: text(row["client_id"]),
      scope: text(row["scope"]),
      status: text(row["status"]) as DeviceAuthRequestRecord["status"],
      createdAt: text(row["created_at"]),
      updatedAt: text(row["updated_at"]),
      expiresAt: text(row["expires_at"]),
    };
  }

  function mapRefresh(row: Row): RefreshSessionRecord {
    return {
      id: text(row["id"]),
      familyId: text(row["family_id"]),
      clientId: text(row["client_id"]),
      scope: text(row["scope"]),
      refreshTokenHash: text(row["refresh_token_hash"]),
      createdAt: text(row["created_at"]),
      updatedAt: text(row["updated_at"]),
      expiresAt: text(row["expires_at"]),
      lastUsedAt: optionalText(row["last_used_at"]),
      revokedAt: optionalText(row["revoked_at"]),
    };
  }

  return {
    initialize,
    getPreference,
    setPreference,
    deletePreference,
    getThemePreference: () => getPreference("theme") as ThemePreference | undefined,
    setThemePreference: (value) => setPreference("theme", value),
    getLogLevelPreference: () => getPreference("logLevel") as LogLevelName | undefined,
    setLogLevelPreference: (value) => setPreference("logLevel", value),
    listPasskeys: () => (db.query("SELECT * FROM webapp_passkeys ORDER BY created_at ASC").all() as Row[]).map(mapPasskey),
    getPasskeyByCredentialId: (credentialId) => {
      const row = db.query("SELECT * FROM webapp_passkeys WHERE credential_id = ?").get(credentialId) as Row | null;
      return row ? mapPasskey(row) : undefined;
    },
    savePasskey: (passkey) => {
      db.query(`
        INSERT INTO webapp_passkeys
        (id, name, credential_id, public_key, counter, device_type, backed_up, transports, created_at, updated_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        passkey.id,
        passkey.name,
        passkey.credentialId,
        passkey.publicKey,
        passkey.counter,
        passkey.deviceType,
        passkey.backedUp ? 1 : 0,
        JSON.stringify(passkey.transports),
        passkey.createdAt,
        passkey.updatedAt,
        passkey.lastUsedAt ?? null,
      );
    },
    updatePasskeyUsage: (credentialId, counter, lastUsedAt) => {
      db.query("UPDATE webapp_passkeys SET counter = ?, last_used_at = ?, updated_at = ? WHERE credential_id = ?")
        .run(counter, lastUsedAt, lastUsedAt, credentialId);
    },
    deleteAllPasskeys: () => {
      db.query("DELETE FROM webapp_passkeys").run();
    },
    listApiKeys: () => (db.query("SELECT * FROM webapp_api_keys ORDER BY created_at DESC").all() as Row[]).map(mapApiKey),
    getApiKeyByHash: (tokenHash) => {
      const row = db.query("SELECT * FROM webapp_api_keys WHERE token_hash = ?").get(tokenHash) as Row | null;
      return row ? mapApiKey(row) : undefined;
    },
    saveApiKey: (record) => {
      db.query(`
        INSERT INTO webapp_api_keys (id, name, prefix, token_hash, scopes, created_at, last_used_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.name, record.prefix, record.tokenHash, JSON.stringify(record.scopes), record.createdAt, record.lastUsedAt ?? null, record.expiresAt ?? null);
    },
    touchApiKey: (id, lastUsedAt) => {
      db.query("UPDATE webapp_api_keys SET last_used_at = ? WHERE id = ?").run(lastUsedAt, id);
    },
    deleteApiKey: (id) => {
      const result = db.query("DELETE FROM webapp_api_keys WHERE id = ?").run(id);
      return result.changes > 0;
    },
    saveDeviceAuthRequest: (record) => {
      db.query(`
        INSERT INTO webapp_device_auth_requests (device_code_hash, user_code, client_id, scope, status, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.deviceCodeHash, record.userCode, record.clientId, record.scope, record.status, record.createdAt, record.updatedAt, record.expiresAt);
    },
    getDeviceAuthByUserCode: (userCode) => {
      const row = db.query("SELECT * FROM webapp_device_auth_requests WHERE user_code = ?").get(userCode) as Row | null;
      return row ? mapDevice(row) : undefined;
    },
    getDeviceAuthByDeviceCodeHash: (deviceCodeHash) => {
      const row = db.query("SELECT * FROM webapp_device_auth_requests WHERE device_code_hash = ?").get(deviceCodeHash) as Row | null;
      return row ? mapDevice(row) : undefined;
    },
    updateDeviceAuthStatus: (userCode, status, updatedAt) => {
      db.query("UPDATE webapp_device_auth_requests SET status = ?, updated_at = ? WHERE user_code = ?").run(status, updatedAt, userCode);
    },
    deleteExpiredDeviceAuthRequests: (now) => {
      db.query("DELETE FROM webapp_device_auth_requests WHERE expires_at <= ?").run(now);
    },
    getSigningKey: () => {
      const row = db.query("SELECT * FROM webapp_signing_keys ORDER BY created_at DESC LIMIT 1").get() as Row | null;
      return row
        ? {
            alg: text(row["alg"]),
            kid: text(row["kid"]),
            publicJwk: json<Record<string, unknown>>(row["public_jwk"], {}),
            privateJwk: json<Record<string, unknown>>(row["private_jwk"], {}),
            createdAt: text(row["created_at"]),
          }
        : undefined;
    },
    saveSigningKey: (record) => {
      db.query("INSERT INTO webapp_signing_keys (kid, alg, public_jwk, private_jwk, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(record.kid, record.alg, JSON.stringify(record.publicJwk), JSON.stringify(record.privateJwk), record.createdAt);
    },
    saveRefreshSession: (record) => {
      db.query(`
        INSERT INTO webapp_refresh_sessions (id, family_id, client_id, scope, refresh_token_hash, created_at, updated_at, expires_at, last_used_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.familyId, record.clientId, record.scope, record.refreshTokenHash, record.createdAt, record.updatedAt, record.expiresAt, record.lastUsedAt ?? null, record.revokedAt ?? null);
    },
    getRefreshSessionByHash: (refreshTokenHash) => {
      const row = db.query("SELECT * FROM webapp_refresh_sessions WHERE refresh_token_hash = ?").get(refreshTokenHash) as Row | null;
      return row ? mapRefresh(row) : undefined;
    },
    listRefreshSessions: () => (db.query("SELECT * FROM webapp_refresh_sessions ORDER BY created_at DESC").all() as Row[]).map(mapRefresh),
    rotateRefreshSession: (oldHash, next, now) => {
      const transaction = db.transaction(() => {
        const old = db.query("SELECT * FROM webapp_refresh_sessions WHERE refresh_token_hash = ?").get(oldHash) as Row | null;
        if (!old) {
          return undefined;
        }
        db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE refresh_token_hash = ?").run(now, now, oldHash);
        db.query(`
          INSERT INTO webapp_refresh_sessions (id, family_id, client_id, scope, refresh_token_hash, created_at, updated_at, expires_at, last_used_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(next.id, next.familyId, next.clientId, next.scope, next.refreshTokenHash, next.createdAt, next.updatedAt, next.expiresAt, next.lastUsedAt ?? null, next.revokedAt ?? null);
        return mapRefresh(old);
      });
      return transaction();
    },
    revokeRefreshSession: (id, revokedAt) => {
      const result = db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL").run(revokedAt, revokedAt, id);
      return result.changes > 0;
    },
    revokeRefreshFamily: (familyId, revokedAt) => {
      db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE family_id = ? AND revoked_at IS NULL").run(revokedAt, revokedAt, familyId);
    },
  };
}
