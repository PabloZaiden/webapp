import type { Server } from "bun";
import { sqliteWebAppStore } from "./auth/sqlite-store";
import { createRealtimeBus } from "./realtime/bus";
import { readRuntimeConfig, resolveEffectiveLogLevel } from "./runtime-config";
import {
  WEBAPP_SOCKET_HANDLER,
  type WebAppServer,
  type WebAppServerConfig,
  type WebAppWebSocketData,
} from "./server-types";
import { createAuthentication } from "./authentication";
import { createFrameworkEndpointHandler } from "./framework-endpoints";
import { createServerLifecycle } from "./server-lifecycle";
import {
  resetServerLogStorage,
  serverLogStorage,
  setLogLevel,
  setServerLogStorageEnabled,
  type ServerLogStorage,
} from "./logger";
import { createWebDocumentProvider, htmlResponse } from "./web-document";
import { createPublicRouteDispatcher } from "./public-route-dispatch";
import { createRouteDispatcher } from "./route-dispatch";
import { compileRouteTable } from "./routes";
import { errorResponse, notFound, responseForRequest, withSecurityHeaders } from "./responses";
import type { DelegatedDispatchOptions } from "./delegation";
import type { AuthenticatedDispatchOptions } from "./authenticated-dispatch";
import { toCurrentUser } from "./auth/users";
import { createOAuthService } from "./auth/oauth";
import { clientPreflight, withClientCors } from "./client-cors";
import { authErrorResponse } from "./authentication";
import { createLogger } from "./logger";
import { serverForRewrittenRequest } from "./rewritten-request-server";
import { CLIENT_TICKET_PARAMETER } from "./auth/client-tickets";
import { AuthError } from "./auth/types";
import { createRouteCatalog } from "./route-catalog";

export const MAX_SERVER_IDLE_TIMEOUT_SECONDS = 255;
export const DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS = MAX_SERVER_IDLE_TIMEOUT_SECONDS;

export function resolveServerIdleTimeout(value: number | undefined): number {
  const idleTimeout = value ?? DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS;
  if (
    !Number.isInteger(idleTimeout)
    || idleTimeout < 0
    || idleTimeout > MAX_SERVER_IDLE_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `server.idleTimeout must be an integer between 0 and ${String(MAX_SERVER_IDLE_TIMEOUT_SECONDS)}; received "${String(value)}"`,
    );
  }
  return idleTimeout;
}

export type {
  PublicRouteAsset,
  PublicRouteDefinition,
  PublicRouteHandler,
  PublicRouteValue,
  WebAppDocumentConfig,
  WebAppIconConfig,
  WebAppIconsConfig,
  WebAppPwaConfig,
  WebAppServer,
  WebAppServerConfig,
  WebAppServerLifecycleHooks,
  WebAppServerOptions,
  WebAppRequestFilter,
  WebAppWebSocketData,
} from "./server-types";
export { WEBAPP_SOCKET_HANDLER };

function secureDynamicResponse(response: Response): Response {
  return response instanceof Response ? withSecurityHeaders(response) : response;
}

function restoreServerLogStorage(enabled: boolean, phase: string, resetFirst = false): void {
  try {
    if (resetFirst) {
      resetServerLogStorage();
    }
    setServerLogStorageEnabled(enabled);
  } catch (error) {
    console.error(
      `[webapp] Unable to initialize temporary server log capture during ${phase}; continuing with capture disabled.`,
      error,
    );
    try {
      resetServerLogStorage();
    } catch (cleanupError) {
      console.error("[webapp] Unable to reset temporary server log capture after initialization failed.", cleanupError);
    }
  }
}

function canUseSpaFallback(req: Request): boolean {
  return req.method === "GET" || req.method === "HEAD";
}

export function createWebAppServer<TEvent = unknown>(input: WebAppServerConfig<TEvent>): WebAppServer<TEvent> {
  if (input.requestFilter && input.web !== false) {
    throw new Error("requestFilter requires web: false");
  }
  const config = input.runtimeConfig ?? readRuntimeConfig({
    appName: input.appName,
    envPrefix: input.envPrefix,
    appDirectoryName: input.appDirectoryName,
  });
  if (config.appName !== input.appName || config.envPrefix !== input.envPrefix) {
    throw new Error("runtimeConfig appName and envPrefix must match the createWebAppServer inputs");
  }
  const authOnlyWeb = input.web !== false && input.web?.mode === "auth";
  const log = createLogger("webapp:requests");
  const store = input.store ?? sqliteWebAppStore({ dataDir: config.dataDir });
  store.initialize();
  let serverLogsEnabled = store.getServerLogsEnabledPreference() ?? false;
  restoreServerLogStorage(serverLogsEnabled, "server configuration", true);
  const serverLogs: ServerLogStorage = {
    isEnabled: serverLogStorage.isEnabled,
    setEnabled(enabled) {
      serverLogStorage.setEnabled(enabled);
      serverLogsEnabled = enabled;
    },
    getEntries: serverLogStorage.getEntries,
    reset() {
      serverLogStorage.reset();
    },
  };
  const savedLogLevel = store.getLogLevelPreference();
  const activeLogLevel = resolveEffectiveLogLevel(config, savedLogLevel);
  setLogLevel(activeLogLevel);
  input.logLevel?.onChange?.(activeLogLevel);
  const realtime = createRealtimeBus<TEvent>(input.realtime);
  const version = input.version ?? "0.0.0-development";
  const wsPath = input.realtime?.path ?? "/api/ws";
  const publicRoutes = input.publicRoutes ?? {};
  const appWebsockets = input.websockets ?? {};
  const idleTimeout = resolveServerIdleTimeout(input.server?.idleTimeout);
  const passkeysEnabled = input.auth?.passkeys !== false;
  const apiKeysEnabled = input.auth?.apiKeys ?? false;
  const deviceAuthEnabled = input.auth?.deviceAuth ?? false;
  const documentProvider = input.web === false
    ? undefined
    : createWebDocumentProvider(config, input.web, publicRoutes);
  const ensureWebDocument = documentProvider
    ? () => documentProvider.ensure()
    : undefined;
  const authentication = createAuthentication({
    store,
    config,
    passkeysEnabled,
    apiKeysEnabled,
    deviceAuthEnabled,
    realtimePath: wsPath,
  });
  if (input.auth?.oauth && !passkeysEnabled) {
    throw new Error("OAuth consent requires framework browser authentication");
  }
  const oauth = input.auth?.oauth ? createOAuthService(input.auth.oauth, store, config) : undefined;
  const frameworkEndpoints = createFrameworkEndpointHandler({
    config,
    store,
    authentication,
    version,
    wsPath,
    passkeysEnabled,
    apiKeysEnabled,
    deviceAuthEnabled,
    webMode: input.web === false ? "disabled" : authOnlyWeb ? "auth" : "app",
    configResponse: input.configResponse,
    onLogLevelChange: input.logLevel?.onChange,
    serverLogs,
    ensureWebDocument,
  });
  const routeTable = { ...input.routes, ...frameworkEndpoints.routes };
  const routes = compileRouteTable(routeTable);
  const routeCatalog = createRouteCatalog(routeTable);
  const publicRouteDispatcher = createPublicRouteDispatcher({
    publicRoutes,
    generatedRoutePaths: documentProvider?.generatedRoutePaths ?? new Set(),
    ensureWebDocument: async () => {
      if (!ensureWebDocument) {
        throw new Error("The web document is disabled");
      }
      return await ensureWebDocument();
    },
  });
  const routeDispatcher = createRouteDispatcher({
    config,
    routes,
    authentication,
    realtime,
    middleware: input.routeMiddleware,
  });

  async function dispatchDelegated<TAuthorization extends object>(
    req: Request,
    options: DelegatedDispatchOptions<TAuthorization>,
  ): Promise<Response | undefined> {
    if (input.requestFilter && !await input.requestFilter(req)) {
      return withSecurityHeaders(notFound());
    }
    const result = await routeDispatcher.dispatch(req, undefined, options);
    return result.matched ? result.response : withSecurityHeaders(notFound());
  }

  async function dispatchAuthenticated<TAuthorization extends object>(
    req: Request,
    options: AuthenticatedDispatchOptions<TAuthorization>,
  ): Promise<Response | undefined> {
    if (input.requestFilter && !await input.requestFilter(req)) {
      return responseForRequest(req, withSecurityHeaders(notFound()));
    }
    const user = store.getUserById(options.userId);
    if (!user || user.disabledAt) {
      return responseForRequest(req, withSecurityHeaders(errorResponse(403, "authentication_required", "An enabled account is required")));
    }
    const result = await routeDispatcher.dispatch(req, undefined, undefined, {
      ...options, actor: Object.freeze(toCurrentUser(user)),
      validateActor() {
        const current = store.getUserById(user.id);
        return Boolean(current && !current.disabledAt && current.authVersion === user.authVersion && current.role === user.role);
      },
    });
    return result.matched ? result.response : responseForRequest(req, withSecurityHeaders(notFound()));
  }

  async function dispatchRequest(req: Request, server?: Server<WebAppWebSocketData>): Promise<Response | undefined> {
    if (input.requestFilter && !await input.requestFilter(req)) {
      return withSecurityHeaders(notFound());
    }

    const url = new URL(req.url);
    const oauthResponse = await oauth?.handleRequest(req);
    if (oauthResponse) return secureDynamicResponse(oauthResponse);
    const publicRoute = await publicRouteDispatcher.dispatch(req);
    if (publicRoute) {
      return publicRoute;
    }
    if (url.pathname === wsPath || url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/") || url.pathname === "/device") {
      const builtIn = await frameworkEndpoints.handleBuiltIn(req, server);
      if (builtIn) {
        return secureDynamicResponse(builtIn);
      }
      const routeResult = await routeDispatcher.dispatch(req, server);
      if (!routeResult.matched) {
        return withSecurityHeaders(notFound());
      }
      return routeResult.response;
    }
    const routeResult = await routeDispatcher.dispatch(req, server);
    if (routeResult.matched) {
      return routeResult.response;
    }
    if (!canUseSpaFallback(req)) {
      return withSecurityHeaders(notFound());
    }
    if (!ensureWebDocument) {
      return withSecurityHeaders(notFound());
    }
    if (authOnlyWeb && !["/", "/login", "/setup", "/device", "/account", oauth?.consentPath].includes(url.pathname)) {
      return withSecurityHeaders(notFound());
    }
    return htmlResponse(await ensureWebDocument(), req);
  }

  async function handleRequest(req: Request, server?: Server<WebAppWebSocketData>): Promise<Response | undefined> {
    let response: Response | undefined;
    try {
      response = clientPreflight(req);
      if (!response) {
        const prepared = await authentication.prepareRequest(req);
        response = await dispatchRequest(prepared, serverForRewrittenRequest(server, req, prepared));
      }
    } catch (error) {
      if (error instanceof AuthError) {
        response = authErrorResponse(error);
      } else {
        log.error("Unhandled request error", { error: String(error) });
        response = errorResponse(500, "request_failed", "Request failed");
      }
    }
    if (!response) return undefined;
    if (new URL(req.url).searchParams.has(CLIENT_TICKET_PARAMETER)) {
      response.headers.set("cache-control", "private, no-store");
      response.headers.set("referrer-policy", "no-referrer");
    }
    return withClientCors(req, withSecurityHeaders(response));
  }

  const lifecycle = createServerLifecycle({
    config,
    oauth,
    deviceAuthEnabled,
    hooks: {
      ...(input.lifecycle ?? {}),
      beforeStart: async () => {
        serverLogsEnabled = store.getServerLogsEnabledPreference() ?? false;
        restoreServerLogStorage(serverLogsEnabled, "server startup");
        await input.lifecycle?.beforeStart?.();
      },
      afterStop: async (server) => {
        const errors: unknown[] = [];
        realtime.dispose();
        authentication.clearClientTickets();
        try {
          await input.lifecycle?.afterStop?.(server);
        } catch (error) {
          errors.push(error);
        }
        try {
          resetServerLogStorage();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Web app server cleanup failed");
        }
      },
    },
    idleTimeout,
    tls: input.server?.tls,
    publicRoutes,
    appWebsockets,
    wsPath,
    realtime,
    ensurePublicAssetPaths: publicRouteDispatcher.ensurePublicAssetPaths,
    ensureWebDocument,
    documentProvider,
    authOnlyWeb,
    handleRequest,
  });

  async function stop(closeActiveConnections?: boolean): Promise<void> {
    const errors: unknown[] = [];
    try {
      await lifecycle.stop(closeActiveConnections);
    } catch (error) {
      errors.push(error);
    }
    realtime.dispose();
    authentication.clearClientTickets();
    try {
      resetServerLogStorage();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Web app server cleanup failed");
    }
  }

  return { config, store, realtime, oauth, routeCatalog, handleRequest, dispatchDelegated, dispatchAuthenticated, ...lifecycle, stop };
}
