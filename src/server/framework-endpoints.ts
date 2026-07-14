import type { Server } from "bun";
import type { CurrentUser, LogLevelName, WebAppConfigResponse } from "../contracts";
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
} from "./auth/api-keys";
import {
  approveDevice,
  createDeviceAuthorization,
  denyDevice,
  discovery,
  exchangeDeviceCode,
  exchangeRefreshToken,
  getDeviceVerificationDetails,
  jwks,
  listAuthSessions,
  revokeAuthSession,
  revokeRefreshToken,
} from "./auth/device-auth";
import {
  beginAuthentication,
  beginBootstrapRegistration,
  beginOwnerPasskeySetup,
  beginSetupRegistration,
  completeAuthentication,
  completeBootstrapRegistration,
  completeOwnerPasskeySetup,
  completeSetupRegistration,
  deletePasskey,
  getSetupDetails,
  isPasskeyAuthRequired,
  logoutHeaders,
  passkeyStatus,
} from "./auth/passkeys";
import { audit, assertValidUsername, createSetupLinkRecord, createUserRecord, summarizeUser } from "./auth/users";
import { nowIso, randomToken } from "./auth/crypto";
import type { WebAppStore } from "./auth/store";
import { getRequestBaseUrl } from "./auth/request-origin";
import type { Authentication } from "./authentication";
import { authErrorResponse, tokenError } from "./authentication";
import { checkSameOrigin } from "./same-origin";
import type { WebAppServerConfig } from "./server-types";
import { htmlResponse, type WebDocument } from "./web-document";
import {
  authenticationResponseSchema,
  createApiKeyRequestSchema,
  createUserRequestSchema,
  deviceAuthorizationRequestSchema,
  deviceCodeActionRequestSchema,
  logLevelPreferenceRequestSchema,
  passkeyBootstrapOptionsSchema,
  refreshTokenRequestSchema,
  registrationResponseSchema,
  revokeRefreshTokenRequestSchema,
  setupOptionsSchema,
  setupVerificationSchema,
  themePreferenceRequestSchema,
  tokenRequestSchema,
  userRoleRequestSchema,
} from "./request-schemas";
import { resolveEffectiveLogLevel, type RuntimeConfig } from "./runtime-config";
import { setLogLevel } from "./logger";
import { errorResponse, jsonResponse, notFound, parseJson, successResponse } from "./responses";
import type { WebSocketData } from "./realtime/bus";

export interface FrameworkEndpointDependencies {
  config: RuntimeConfig;
  store: WebAppStore;
  authentication: Authentication;
  version: string;
  wsPath: string;
  passkeysEnabled: boolean;
  apiKeysEnabled: boolean;
  deviceAuthEnabled: boolean;
  configResponse?: WebAppServerConfig["configResponse"];
  onLogLevelChange?: (level: LogLevelName) => void;
  ensureWebDocument: () => Promise<WebDocument>;
}

function addHeaders(response: Response, headers: Headers): Response {
  for (const [name, value] of headers) {
    response.headers.append(name, value);
  }
  return response;
}

export function createFrameworkEndpointHandler(dependencies: FrameworkEndpointDependencies) {
  const {
    config,
    store,
    authentication,
    version,
    wsPath,
    passkeysEnabled,
    apiKeysEnabled,
    deviceAuthEnabled,
    configResponse: extendConfigResponse,
    onLogLevelChange,
    ensureWebDocument,
  } = dependencies;

  function configResponse(req: Request): WebAppConfigResponse & Record<string, unknown> {
    const user = authentication.configUser(req);
    const base = {
      appName: config.appName,
      version,
      currentUser: user,
      passkeyAuth: passkeyStatus(req, store, config, passkeysEnabled),
      userManagement: {
        enabled: passkeysEnabled,
        canManageUsers: Boolean(user?.isAdmin),
      },
      logLevel: {
        level: resolveEffectiveLogLevel(config, store.getLogLevelPreference()),
        fromEnv: config.logLevelFromEnv,
      },
      apiKeys: { enabled: Boolean(apiKeysEnabled) },
      deviceAuth: { enabled: Boolean(deviceAuthEnabled) },
    } satisfies WebAppConfigResponse;
    return { ...(extendConfigResponse?.(req, base) ?? {}), ...base };
  }

  function setupUrl(req: Request, token: string): string {
    const url = new URL(`${getRequestBaseUrl(req, config)}/setup`);
    url.search = `?token=${encodeURIComponent(token)}`;
    url.hash = "";
    return url.toString();
  }

  function createSetupLink(req: Request, userId: string, kind: "invite" | "reset" | "owner-reset", actorUserId?: string) {
    const token = randomToken(32);
    const record = createSetupLinkRecord({ userId, token, kind, createdByUserId: actorUserId });
    store.createSetupLink(record);
    return { url: setupUrl(req, token), expiresAt: record.expiresAt };
  }

  function ensureAdmin(auth: Parameters<Authentication["currentUser"]>[0]): CurrentUser {
    return authentication.requireAdmin(auth);
  }

  async function handleBuiltIn(req: Request, server?: Server<WebSocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/api/health" && req.method === "GET") {
        return successResponse({ ok: true, version });
      }
      if (path === "/api/config" && req.method === "GET") {
        return jsonResponse(configResponse(req));
      }
      if (path === wsPath) {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "always");
        if (originFailure) return originFailure;
        if (!server) return errorResponse(400, "websocket_unavailable", "WebSocket server is unavailable");
        const filters = Object.fromEntries(url.searchParams.entries());
        const upgraded = server.upgrade(req, { data: { filters, userId: authentication.currentUser(auth)?.id } });
        return upgraded ? undefined : errorResponse(400, "websocket_upgrade_failed", "WebSocket upgrade failed");
      }
      if (path === "/api/auth/status" && req.method === "GET") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const user = authentication.currentUser(auth);
        return jsonResponse({
          authenticated: auth.kind !== "anonymous",
          authKind: auth.kind,
          subject: user?.id ?? null,
          clientId: auth.kind === "bearer" ? auth.claims.clientId : null,
          scope: auth.kind === "bearer" ? auth.claims.scope : null,
        });
      }
      if (path === "/api/passkey-auth/status" && req.method === "GET") {
        return jsonResponse(passkeyStatus(req, store, config, passkeysEnabled));
      }
      if (passkeysEnabled && path === "/api/passkey-auth/bootstrap/options" && req.method === "POST") {
        const body = await parseJson(req, passkeyBootstrapOptionsSchema);
        const result = await beginBootstrapRegistration(req, store, config, body.username ?? "");
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/bootstrap/verify" && req.method === "POST") {
        const headers = await completeBootstrapRegistration(req, store, config, await parseJson(req, registrationResponseSchema));
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/owner-setup/options" && req.method === "POST") {
        const result = await beginOwnerPasskeySetup(req, store, config);
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/owner-setup/verify" && req.method === "POST") {
        const headers = await completeOwnerPasskeySetup(req, store, config, await parseJson(req, registrationResponseSchema));
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/user-setup" && req.method === "GET") {
        const token = url.searchParams.get("token") ?? "";
        return jsonResponse(getSetupDetails(store, token));
      }
      if (passkeysEnabled && path === "/api/user-setup/options" && req.method === "POST") {
        const body = await parseJson(req, setupOptionsSchema);
        const result = await beginSetupRegistration(req, store, config, body.token ?? "");
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/user-setup/verify" && req.method === "POST") {
        const body = await parseJson(req, setupVerificationSchema);
        const headers = await completeSetupRegistration(req, store, config, body.token, body.response);
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/authentication/options" && req.method === "POST") {
        const result = await beginAuthentication(req, store, config);
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/authentication/verify" && req.method === "POST") {
        const headers = await completeAuthentication(req, store, config, await parseJson(req, authenticationResponseSchema));
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/logout" && req.method === "POST") {
        return addHeaders(successResponse(), logoutHeaders(req, config));
      }
      if (passkeysEnabled && path === "/api/passkey-auth/passkey" && req.method === "DELETE") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        return addHeaders(successResponse(), deletePasskey(req, store, config, authentication.requireUser(auth).id));
      }
      if (apiKeysEnabled && path === "/api/api-keys" && req.method === "GET") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        return jsonResponse(listApiKeys(store, authentication.requireUser(auth).id));
      }
      if (apiKeysEnabled && path === "/api/api-keys" && req.method === "POST") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        return jsonResponse(createApiKey(store, authentication.requireUser(auth), await parseJson(req, createApiKeyRequestSchema)));
      }
      const apiKeyDelete = /^\/api\/api-keys\/([^/]+)$/.exec(path);
      if (apiKeysEnabled && apiKeyDelete && req.method === "DELETE") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        deleteApiKey(store, authentication.requireUser(auth).id, decodeURIComponent(apiKeyDelete[1]!));
        return successResponse();
      }
      if (deviceAuthEnabled && path === "/api/auth/device" && req.method === "POST") {
        const body = await parseJson(req, deviceAuthorizationRequestSchema);
        return jsonResponse(createDeviceAuthorization(req, store, config, body));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/verification" && req.method === "GET") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const userCode = url.searchParams.get("user_code")?.trim();
        if (!userCode) return errorResponse(400, "invalid_user_code", "user_code is required");
        return jsonResponse(getDeviceVerificationDetails(store, userCode, passkeysEnabled && isPasskeyAuthRequired(store, config)));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/approve" && req.method === "POST") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson(req, deviceCodeActionRequestSchema);
        return jsonResponse(approveDevice(store, body.userCode, authentication.requireUser(auth).id));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/deny" && req.method === "POST") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson(req, deviceCodeActionRequestSchema);
        return jsonResponse(denyDevice(store, body.userCode));
      }
      if (deviceAuthEnabled && path === "/api/auth/refresh" && req.method === "POST") {
        const body = await parseJson(req, refreshTokenRequestSchema);
        try {
          return jsonResponse(await exchangeRefreshToken(store, config, body.refresh_token, body.client_id));
        } catch (error) {
          return tokenError(error);
        }
      }
      if (deviceAuthEnabled && path === "/api/auth/token" && req.method === "POST") {
        const body = await parseJson(req, tokenRequestSchema);
        try {
          if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code" || body.device_code) {
            return jsonResponse(await exchangeDeviceCode(store, config, body.device_code ?? "", body.client_id));
          }
          return jsonResponse(await exchangeRefreshToken(store, config, body.refresh_token ?? "", body.client_id));
        } catch (error) {
          return tokenError(error);
        }
      }
      if (deviceAuthEnabled && path === "/api/auth/revoke" && req.method === "POST") {
        const body = await parseJson(req, revokeRefreshTokenRequestSchema);
        revokeRefreshToken(store, body.refreshToken);
        return successResponse();
      }
      if (deviceAuthEnabled && path === "/api/auth/sessions" && req.method === "GET") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        return jsonResponse(listAuthSessions(store, authentication.requireUser(auth).id));
      }
      const sessionDelete = /^\/api\/auth\/sessions\/([^/]+)$/.exec(path);
      if (deviceAuthEnabled && sessionDelete && req.method === "DELETE") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        return revokeAuthSession(store, authentication.requireUser(auth).id, decodeURIComponent(sessionDelete[1]!)) ? successResponse() : notFound();
      }
      if (deviceAuthEnabled && path === "/.well-known/jwks.json" && req.method === "GET") {
        return jsonResponse(await jwks(store));
      }
      if (deviceAuthEnabled && path === "/.well-known/openid-configuration" && req.method === "GET") {
        return jsonResponse(discovery(req, config));
      }
      if (passkeysEnabled && path === "/api/users" && req.method === "GET") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        ensureAdmin(auth);
        return jsonResponse(store.listUsers().map(summarizeUser));
      }
      if (passkeysEnabled && path === "/api/users" && req.method === "POST") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const actor = ensureAdmin(auth);
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson(req, createUserRequestSchema);
        const username = assertValidUsername(body.username ?? "");
        if (store.getUserByUsername(username)) {
          return errorResponse(409, "username_exists", "Username already exists");
        }
        const user = createUserRecord({ username, role: body.role ?? "user" });
        store.createUser(user);
        const setupLink = createSetupLink(req, user.id, "invite", actor.id);
        audit(store, { eventType: "user_created", actorUserId: actor.id, targetUserId: user.id, metadata: { role: user.role } });
        return jsonResponse({ user: summarizeUser(store.getUserById(user.id) ?? user), setupLink }, { status: 201 });
      }
      const userRolePatch = /^\/api\/users\/([^/]+)\/role$/.exec(path);
      if (passkeysEnabled && userRolePatch && req.method === "PATCH") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const actor = ensureAdmin(auth);
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const userId = decodeURIComponent(userRolePatch[1]!);
        const target = store.getUserById(userId);
        if (!target) return notFound();
        if (target.role === "owner") return errorResponse(409, "owner_immutable", "Owner role cannot be changed");
        const body = await parseJson(req, userRoleRequestSchema);
        const role = body.role;
        store.setUserRole(userId, role, nowIso());
        audit(store, { eventType: "user_role_changed", actorUserId: actor.id, targetUserId: userId, metadata: { role } });
        return jsonResponse(summarizeUser(store.getUserById(userId) ?? target));
      }
      const userReset = /^\/api\/users\/([^/]+)\/reset$/.exec(path);
      if (passkeysEnabled && userReset && req.method === "POST") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const actor = ensureAdmin(auth);
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const userId = decodeURIComponent(userReset[1]!);
        const target = store.getUserById(userId);
        if (!target) return notFound();
        if (target.role === "owner") return errorResponse(409, "owner_immutable", "Owner cannot be reset");
        const timestamp = nowIso();
        store.deletePendingSetupLinksForUser(userId, timestamp);
        store.deletePasskeysForUser(userId);
        store.deleteApiKeysForUser(userId);
        store.revokeRefreshSessionsForUser(userId, timestamp);
        store.incrementUserAuthVersion(userId, timestamp);
        const setupLink = createSetupLink(req, userId, "reset", actor.id);
        audit(store, { eventType: "user_reset", actorUserId: actor.id, targetUserId: userId });
        return jsonResponse({ user: summarizeUser(store.getUserById(userId) ?? target), setupLink });
      }
      const userDelete = /^\/api\/users\/([^/]+)$/.exec(path);
      if (passkeysEnabled && userDelete && req.method === "DELETE") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const actor = ensureAdmin(auth);
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const userId = decodeURIComponent(userDelete[1]!);
        const target = store.getUserById(userId);
        if (!target) return notFound();
        if (target.role === "owner") return errorResponse(409, "owner_immutable", "Owner cannot be deleted");
        if (!store.deleteUser(userId)) return notFound();
        audit(store, { eventType: "user_deleted", actorUserId: actor.id, metadata: { deletedUserId: userId, username: target.username } });
        return successResponse();
      }
      if (passkeysEnabled && path === "/api/audit-events" && req.method === "GET") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        ensureAdmin(auth);
        return jsonResponse(store.listAuditEvents(100));
      }
      if (path === "/api/preferences/theme") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        const user = authentication.requireUser(auth);
        if (req.method === "GET") {
          return jsonResponse({ theme: store.getThemePreference(user.id) ?? "system" });
        }
        if (req.method === "PUT") {
          const originFailure = checkSameOrigin(req, config, auth, "mutations");
          if (originFailure) return originFailure;
          const body = await parseJson(req, themePreferenceRequestSchema);
          store.setThemePreference(body.theme, user.id);
          return successResponse({ theme: body.theme });
        }
      }
      if (path === "/api/preferences/log-level") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        ensureAdmin(auth);
        if (req.method === "GET") {
          return jsonResponse({
            level: resolveEffectiveLogLevel(config, store.getLogLevelPreference()),
            fromEnv: config.logLevelFromEnv,
          });
        }
        if (req.method === "PUT") {
          const originFailure = checkSameOrigin(req, config, auth, "mutations");
          if (originFailure) return originFailure;
          if (config.logLevelFromEnv) return errorResponse(409, "log_level_from_env", "Log level is controlled by environment");
          const body = await parseJson(req, logLevelPreferenceRequestSchema);
          store.setLogLevelPreference(body.level);
          setLogLevel(body.level);
          onLogLevelChange?.(body.level);
          return successResponse({ level: body.level });
        }
      }
      if (path === "/api/server/kill" && req.method === "POST") {
        const auth = await authentication.authorize(req, true);
        if (auth instanceof Response) return auth;
        ensureAdmin(auth);
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        setTimeout(() => process.exit(0), 100);
        return successResponse({ success: true, message: "Server is shutting down" });
      }
      if (deviceAuthEnabled && path === "/device" && req.method === "GET") {
        return htmlResponse(await ensureWebDocument(), req);
      }
    } catch (error) {
      return authErrorResponse(error);
    }
    return undefined;
  }

  return { handleBuiltIn };
}
