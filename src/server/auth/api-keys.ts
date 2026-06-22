import type { ApiKeySummary, CreatedApiKeyResponse, CurrentUser } from "../../contracts";
import type { WebAppStore } from "./store";
import { nowIso, randomToken, sha256, secureEqual, isExpired } from "./crypto";
import { AuthError } from "./types";

function summarize(record: { tokenHash?: string } & ApiKeySummary): ApiKeySummary {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
  };
}

export function listApiKeys(store: WebAppStore, userId: string): ApiKeySummary[] {
  return store.listApiKeys(userId).map(summarize);
}

export function createApiKey(store: WebAppStore, user: CurrentUser, input: { name?: string; scopes?: string[]; prefix?: string; expiresAt?: string }): CreatedApiKeyResponse {
  const prefix = input.prefix ?? "wapp";
  const token = `${prefix}_${randomToken(32)}`;
  const record = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: input.name?.trim() || "API key",
    prefix,
    tokenHash: sha256(token),
    scopes: input.scopes?.length ? input.scopes : ["*"],
    createdAt: nowIso(),
    expiresAt: input.expiresAt,
  };
  store.saveApiKey(record);
  return { key: summarize(record), token };
}

export function deleteApiKey(store: WebAppStore, userId: string, id: string): boolean {
  return store.deleteApiKey(id, userId);
}

export function authenticateApiKey(store: WebAppStore, token: string): { user: CurrentUser; apiKeyId: string; scopes: string[] } | undefined {
  const tokenHash = sha256(token);
  const record = store.getApiKeyByHash(tokenHash);
  if (!record || !secureEqual(record.tokenHash, tokenHash) || (record.expiresAt && isExpired(record.expiresAt))) {
    return undefined;
  }
  const user = store.getUserById(record.userId);
  if (!user) {
    return undefined;
  }
  store.touchApiKey(record.id, nowIso());
  return { user: { id: user.id, username: user.username, role: user.role, isOwner: user.role === "owner", isAdmin: user.role === "owner" || user.role === "admin" }, apiKeyId: record.id, scopes: record.scopes };
}

export function assertScopes(actual: string[], required: string[]): void {
  if (required.length === 0 || actual.includes("*")) {
    return;
  }
  for (const scope of required) {
    if (!actual.includes(scope)) {
      throw new AuthError("insufficient_scope", `Missing required scope: ${scope}`, 403);
    }
  }
}
