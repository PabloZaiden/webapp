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
import { inMemoryLogStorage, resetInMemoryLogStorage, setInMemoryLogStorageEnabled, setLogLevel } from "./logger";
import { createWebDocumentProvider, htmlResponse } from "./web-document";
import { createPublicRouteDispatcher } from "./public-route-dispatch";
import { createRouteDispatcher } from "./route-dispatch";
import { compileRouteTable } from "./routes";
import { notFound, withSecurityHeaders } from "./responses";

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
  const routes = compileRouteTable(input.routes ?? {});
  resetInMemoryLogStorage();
  setInMemoryLogStorageEnabled(config.inMemoryLogsEnabled);
  const store = input.store ?? sqliteWebAppStore({ dataDir: config.dataDir });
  store.initialize();
  const savedLogLevel = store.getLogLevelPreference();
  const activeLogLevel = resolveEffectiveLogLevel(config, savedLogLevel);
  setLogLevel(activeLogLevel);
  input.logLevel?.onChange?.(activeLogLevel);
  const realtime = createRealtimeBus<TEvent>();
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
  });
  const frameworkEndpoints = createFrameworkEndpointHandler({
    config,
    store,
    authentication,
    version,
    wsPath,
    passkeysEnabled,
    apiKeysEnabled,
    deviceAuthEnabled,
    configResponse: input.configResponse,
    onLogLevelChange: input.logLevel?.onChange,
    inMemoryLogs: inMemoryLogStorage,
    ensureWebDocument,
  });
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
  });

  async function handleRequest(req: Request, server?: Server<WebAppWebSocketData>): Promise<Response | undefined> {
    if (input.requestFilter && !await input.requestFilter(req)) {
      return withSecurityHeaders(notFound());
    }
    const url = new URL(req.url);
    const publicRoute = await publicRouteDispatcher.dispatch(req);
    if (publicRoute) {
      return publicRoute;
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/") || url.pathname === "/device") {
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
    return htmlResponse(await ensureWebDocument(), req);
  }

  const lifecycle = createServerLifecycle({
    config,
    deviceAuthEnabled,
    hooks: input.lifecycle,
    idleTimeout,
    publicRoutes,
    appWebsockets,
    realtime,
    ensurePublicAssetPaths: publicRouteDispatcher.ensurePublicAssetPaths,
    ensureWebDocument,
    documentProvider,
    handleRequest,
  });

  return { config, store, realtime, handleRequest, ...lifecycle };
}
