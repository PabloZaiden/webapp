import type { Server } from "bun";
import type { ApiKeySummary, LogLevelName, ThemePreference, WebAppConfigResponse } from "../contracts";
import { authenticateApiKey, assertScopes, createApiKey, deleteApiKey, listApiKeys } from "./auth/api-keys";
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
  verifyAccessToken,
} from "./auth/device-auth";
import {
  beginAuthentication,
  beginRegistration,
  completeAuthentication,
  completeRegistration,
  deletePasskey,
  hasPasskeySession,
  isPasskeyAuthRequired,
  logoutHeaders,
  passkeyStatus,
} from "./auth/passkeys";
import { sqliteWebAppStore } from "./auth/sqlite-store";
import type { WebAppStore } from "./auth/store";
import { AuthError, type AuthenticatedRequestState } from "./auth/types";
import { createLogger, setLogLevel } from "./logger";
import { createRealtimeBus, type RealtimeBus, type WebSocketData } from "./realtime/bus";
import { readRuntimeConfig, safeRuntimeConfig, type RuntimeConfig } from "./runtime-config";
import { matchRoute, type RouteTable } from "./routes";
import { checkSameOrigin } from "./same-origin";
import { errorResponse, jsonResponse, methodNotAllowed, notFound, parseJson, successResponse, withSecurityHeaders } from "./responses";

export interface WebAppServerConfig<TEvent = unknown> {
  appName: string;
  envPrefix: string;
  index: unknown;
  version?: string;
  store?: WebAppStore;
  routes?: RouteTable<TEvent>;
  auth?: {
    passkeys?: boolean | { rpName?: string; userName?: string; userDisplayName?: string };
    apiKeys?: boolean;
    deviceAuth?: boolean;
  };
  realtime?: {
    path?: string;
  };
}

export interface WebAppServer<TEvent = unknown> {
  config: RuntimeConfig;
  store: WebAppStore;
  realtime: RealtimeBus<TEvent>;
  handleRequest(req: Request, server?: Server<WebSocketData>): Promise<Response | undefined>;
  start(): Server<WebSocketData>;
  runFromCli(argv?: string[]): Promise<void>;
}

const log = createLogger("webapp:server");

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization")?.trim();
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

function method(req: Request): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined {
  const value = req.method.toUpperCase();
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE" ? value : undefined;
}

function tokenError(error: unknown): Response {
  if (error instanceof AuthError) {
    return jsonResponse({ error: error.code, error_description: error.message }, { status: error.status });
  }
  return jsonResponse({ error: "server_error", error_description: "An unexpected auth error occurred" }, { status: 500 });
}

function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (error instanceof Error) {
    return errorResponse(400, "request_failed", error.message);
  }
  return errorResponse(500, "request_failed", "Request failed");
}

function addHeaders(response: Response, headers: Headers): Response {
  for (const [name, value] of headers) {
    response.headers.append(name, value);
  }
  return response;
}

function htmlResponse(index: unknown): Response {
  if (index instanceof Response) {
    return withSecurityHeaders(index);
  }
  if (typeof index === "string") {
    return withSecurityHeaders(new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } }));
  }
  if (index instanceof Blob) {
    return withSecurityHeaders(new Response(index));
  }
  return index as Response;
}

function canRespondWithIndex(index: unknown): boolean {
  return index instanceof Response || typeof index === "string" || index instanceof Blob;
}

function scopesFromBearer(claims: { scope: string }): string[] {
  return claims.scope.split(/\s+/).filter(Boolean);
}

export function createWebAppServer<TEvent = unknown>(input: WebAppServerConfig<TEvent>): WebAppServer<TEvent> {
  const config = readRuntimeConfig({ appName: input.appName, envPrefix: input.envPrefix });
  const store = input.store ?? sqliteWebAppStore({ dataDir: config.dataDir });
  store.initialize();
  const savedLogLevel = store.getLogLevelPreference();
  setLogLevel(config.logLevelFromEnv ? config.logLevel : savedLogLevel ?? config.logLevel);
  const realtime = createRealtimeBus<TEvent>();
  const version = input.version ?? "0.0.0-development";
  const wsPath = input.realtime?.path ?? "/api/ws";
  const routes = input.routes ?? {};
  const passkeysEnabled = input.auth?.passkeys !== false;
  const apiKeysEnabled = input.auth?.apiKeys ?? false;
  const deviceAuthEnabled = input.auth?.deviceAuth ?? false;

  async function authorize(req: Request, required: boolean): Promise<AuthenticatedRequestState | Response> {
    const token = bearerToken(req);
    if (token) {
      if (deviceAuthEnabled) {
        try {
          const claims = await verifyAccessToken(store, config, token);
          return { kind: "bearer", claims };
        } catch {
          // Fall through to API keys. Both use Bearer by design.
        }
      }
      if (apiKeysEnabled) {
        const apiKey = authenticateApiKey(store, token);
        if (apiKey) {
          return { kind: "api-key", ...apiKey };
        }
      }
      return errorResponse(401, "invalid_token", "Bearer token is invalid");
    }
    if (passkeysEnabled && isPasskeyAuthRequired(store, config)) {
      if (!hasPasskeySession(req, store)) {
        return required ? errorResponse(401, "authentication_required", "Passkey authentication is required", undefined, {
          headers: { "x-webapp-passkey-required": "true" },
        }) : { kind: "anonymous" };
      }
      return { kind: "passkey" };
    }
    return { kind: "anonymous" };
  }

  function configResponse(req: Request): WebAppConfigResponse {
    return {
      appName: config.appName,
      version,
      passkeyAuth: passkeyStatus(req, store, config, passkeysEnabled),
      logLevel: {
        level: (config.logLevelFromEnv ? config.logLevel : store.getLogLevelPreference() ?? config.logLevel) as LogLevelName,
        fromEnv: config.logLevelFromEnv,
      },
      apiKeys: { enabled: Boolean(apiKeysEnabled) },
      deviceAuth: { enabled: Boolean(deviceAuthEnabled) },
    };
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
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "always");
        if (originFailure) return originFailure;
        if (!server) return errorResponse(400, "websocket_unavailable", "WebSocket server is unavailable");
        const filters = Object.fromEntries(url.searchParams.entries());
        const upgraded = server.upgrade(req, { data: { filters } });
        return upgraded ? undefined : errorResponse(400, "websocket_upgrade_failed", "WebSocket upgrade failed");
      }
      if (path === "/api/passkey-auth/status" && req.method === "GET") {
        return jsonResponse(passkeyStatus(req, store, config, passkeysEnabled));
      }
      if (passkeysEnabled && path === "/api/passkey-auth/registration/options" && req.method === "POST") {
        const result = await beginRegistration(req, store, config);
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/registration/verify" && req.method === "POST") {
        const headers = await completeRegistration(req, store, config, await parseJson(req));
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/authentication/options" && req.method === "POST") {
        const result = await beginAuthentication(req, store, config);
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/authentication/verify" && req.method === "POST") {
        const headers = await completeAuthentication(req, store, config, await parseJson(req));
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/logout" && req.method === "POST") {
        return addHeaders(successResponse(), logoutHeaders(req, config));
      }
      if (passkeysEnabled && path === "/api/passkey-auth/passkey" && req.method === "DELETE") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        return addHeaders(successResponse(), deletePasskey(req, store, config));
      }
      if (apiKeysEnabled && path === "/api/api-keys" && req.method === "GET") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        return jsonResponse(listApiKeys(store));
      }
      if (apiKeysEnabled && path === "/api/api-keys" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        return jsonResponse(createApiKey(store, await parseJson(req)));
      }
      const apiKeyDelete = /^\/api\/api-keys\/([^/]+)$/.exec(path);
      if (apiKeysEnabled && apiKeyDelete && req.method === "DELETE") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        deleteApiKey(store, decodeURIComponent(apiKeyDelete[1]!));
        return successResponse();
      }
      if (deviceAuthEnabled && path === "/api/auth/device" && req.method === "POST") {
        const body = await parseJson<{ client_id?: string; clientId?: string; scope?: string }>(req).catch((): { client_id?: string; clientId?: string; scope?: string } => ({}));
        return jsonResponse(createDeviceAuthorization(req, store, config, { clientId: body.client_id ?? body.clientId, scope: body.scope }));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/verification" && req.method === "GET") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const userCode = url.searchParams.get("user_code")?.trim();
        if (!userCode) return errorResponse(400, "invalid_user_code", "user_code is required");
        return jsonResponse(getDeviceVerificationDetails(store, userCode, passkeysEnabled && isPasskeyAuthRequired(store, config)));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/approve" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson<{ userCode?: string; user_code?: string }>(req);
        return jsonResponse(approveDevice(store, body.userCode ?? body.user_code ?? ""));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/deny" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson<{ userCode?: string; user_code?: string }>(req);
        return jsonResponse(denyDevice(store, body.userCode ?? body.user_code ?? ""));
      }
      if (deviceAuthEnabled && (path === "/api/auth/token" || path === "/api/auth/refresh") && req.method === "POST") {
        const body = await parseJson<{ grant_type?: string; device_code?: string; refresh_token?: string; client_id?: string }>(req);
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
        const body = await parseJson<{ refreshToken?: string; refresh_token?: string }>(req);
        revokeRefreshToken(store, body.refreshToken ?? body.refresh_token ?? "");
        return successResponse();
      }
      if (deviceAuthEnabled && path === "/api/auth/sessions" && req.method === "GET") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        return jsonResponse(listAuthSessions(store));
      }
      const sessionDelete = /^\/api\/auth\/sessions\/([^/]+)$/.exec(path);
      if (deviceAuthEnabled && sessionDelete && req.method === "DELETE") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        return revokeAuthSession(store, decodeURIComponent(sessionDelete[1]!)) ? successResponse() : notFound();
      }
      if (deviceAuthEnabled && path === "/.well-known/jwks.json" && req.method === "GET") {
        return jsonResponse(await jwks(store));
      }
      if (deviceAuthEnabled && path === "/.well-known/openid-configuration" && req.method === "GET") {
        return jsonResponse(discovery(req, config));
      }
      if (path === "/api/preferences/theme") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        if (req.method === "GET") {
          return jsonResponse({ theme: store.getThemePreference() ?? "system" });
        }
        if (req.method === "PUT") {
          const originFailure = checkSameOrigin(req, config, auth, "mutations");
          if (originFailure) return originFailure;
          const body = await parseJson<{ theme: ThemePreference }>(req);
          store.setThemePreference(body.theme);
          return successResponse({ theme: body.theme });
        }
      }
      if (path === "/api/preferences/log-level") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        if (req.method === "GET") {
          return jsonResponse({ level: store.getLogLevelPreference() ?? config.logLevel, fromEnv: config.logLevelFromEnv });
        }
        if (req.method === "PUT") {
          const originFailure = checkSameOrigin(req, config, auth, "mutations");
          if (originFailure) return originFailure;
          if (config.logLevelFromEnv) return errorResponse(409, "log_level_from_env", "Log level is controlled by environment");
          const body = await parseJson<{ level: LogLevelName }>(req);
          store.setLogLevelPreference(body.level);
          setLogLevel(body.level);
          return successResponse({ level: body.level });
        }
      }
      if (path === "/api/server/kill" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        setTimeout(() => process.exit(0), 100);
        return successResponse({ success: true, message: "Server is shutting down" });
      }
      if (deviceAuthEnabled && path === "/device" && req.method === "GET") {
        return htmlResponse(input.index);
      }
    } catch (error) {
      return authErrorResponse(error);
    }
    return undefined;
  }

  async function handleRequest(req: Request, server?: Server<WebSocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/") || url.pathname === "/device") {
      const builtIn = await handleBuiltIn(req, server);
      if (builtIn) {
        return withSecurityHeaders(builtIn);
      }
      const matched = matchRoute(routes, url.pathname);
      if (!matched) {
        return withSecurityHeaders(notFound());
      }
      const handler = matched.route[method(req) ?? "GET"];
      if (!handler) {
        return withSecurityHeaders(methodNotAllowed());
      }
      const required = (matched.route.auth ?? "required") === "required";
      const auth = await authorize(req, required);
      if (auth instanceof Response) {
        return withSecurityHeaders(auth);
      }
      try {
        if ((matched.route.auth ?? "required") !== "public" && (auth.kind === "api-key" || auth.kind === "bearer")) {
          assertScopes(auth.kind === "api-key" ? auth.scopes : scopesFromBearer(auth.claims), matched.route.scopes ?? []);
        }
      } catch (error) {
        return withSecurityHeaders(authErrorResponse(error));
      }
      const originFailure = checkSameOrigin(req, config, auth, matched.route.sameOrigin ?? "mutations");
      if (originFailure) {
        return withSecurityHeaders(originFailure);
      }
      return withSecurityHeaders(await handler(req, { params: matched.params, auth, realtime, server }));
    }
    return htmlResponse(input.index);
  }

  function start(): Server<WebSocketData> {
    const dynamicHandler = (req: Request, server: Server<WebSocketData>) => handleRequest(req, server);
    const server = Bun.serve<WebSocketData>({
      hostname: config.host,
      port: config.port,
      routes: {
        "/api/*": dynamicHandler,
        "/.well-known/*": dynamicHandler,
        "/device": dynamicHandler,
        "/*": canRespondWithIndex(input.index) ? dynamicHandler : input.index as never,
      },
      websocket: {
        open(socket) {
          realtime.add(socket);
        },
        message(socket, message) {
          if (message === "ping") {
            socket.send(JSON.stringify({ type: "pong" }));
          }
        },
        close(socket) {
          realtime.remove(socket);
        },
      },
      development: config.development,
    });
    log.info(`${config.appName} server running`, { url: String(server.url) });
    return server;
  }

  async function runFromCli(argv = Bun.argv.slice(2)): Promise<void> {
    const command = argv[0] ?? "serve";
    if (command === "serve") {
      start();
      return await new Promise(() => undefined);
    }
    if (command === "version") {
      console.log(version);
      return;
    }
    if (command === "config") {
      console.log(JSON.stringify(safeRuntimeConfig(config), null, 2));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  }

  return { config, store, realtime, handleRequest, start, runFromCli };
}
