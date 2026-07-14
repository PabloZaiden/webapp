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
import { setLogLevel } from "./logger";
import { createWebDocumentProvider, htmlResponse } from "./web-document";
import { createPublicRouteDispatcher } from "./public-route-dispatch";
import { createRouteDispatcher } from "./route-dispatch";
import { notFound, withSecurityHeaders } from "./responses";

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
  const config = readRuntimeConfig({ appName: input.appName, envPrefix: input.envPrefix });
  const store = input.store ?? sqliteWebAppStore({ dataDir: config.dataDir });
  store.initialize();
  const savedLogLevel = store.getLogLevelPreference();
  const activeLogLevel = resolveEffectiveLogLevel(config, savedLogLevel);
  setLogLevel(activeLogLevel);
  input.logLevel?.onChange?.(activeLogLevel);
  const realtime = createRealtimeBus<TEvent>();
  const version = input.version ?? "0.0.0-development";
  const wsPath = input.realtime?.path ?? "/api/ws";
  const routes = input.routes ?? {};
  const publicRoutes = input.publicRoutes ?? {};
  const appWebsockets = input.websockets ?? {};
  const passkeysEnabled = input.auth?.passkeys !== false;
  const apiKeysEnabled = input.auth?.apiKeys ?? false;
  const deviceAuthEnabled = input.auth?.deviceAuth ?? false;
  const documentProvider = createWebDocumentProvider(config, input.web, publicRoutes);
  const ensureWebDocument = () => documentProvider.ensure();
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
    ensureWebDocument,
  });
  const publicRouteDispatcher = createPublicRouteDispatcher({
    publicRoutes,
    generatedRoutePaths: documentProvider.generatedRoutePaths,
    ensureWebDocument,
  });
  const routeDispatcher = createRouteDispatcher({
    config,
    routes,
    authentication,
    realtime,
  });

  async function handleRequest(req: Request, server?: Server<WebAppWebSocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const publicRoute = await publicRouteDispatcher(req);
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
    return htmlResponse(await ensureWebDocument(), req);
  }

  const lifecycle = createServerLifecycle({
    config,
    version,
    deviceAuthEnabled,
    publicRoutes,
    appWebsockets,
    realtime,
    ensureWebDocument,
    documentProvider,
    handleRequest,
  });

  return { config, store, realtime, handleRequest, ...lifecycle };
}
