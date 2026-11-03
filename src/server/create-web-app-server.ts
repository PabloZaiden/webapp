import type { Server } from "bun";
import { createRealtimeBus, type RealtimeConnectionOptions } from "./realtime/bus";
import { readRuntimeConfig } from "./runtime-config";
import type { WebAppServer, WebAppServerConfig, WebAppWebSocketData } from "./server-types";
import { createServerLifecycle } from "./server-lifecycle";
import { createLogger, setLogLevel } from "./logger";
import { createWebDocumentProvider, htmlResponse } from "./web-document";
import { createPublicRouteDispatcher } from "./public-route-dispatch";
import { createRouteDispatcher } from "./route-dispatch";
import { compileRouteTable } from "./routes";
import { errorResponse, jsonResponse, notFound, requestBodyErrorResponse, responseForRequest, withSecurityHeaders } from "./responses";
import { createRouteCatalog } from "./route-catalog";
import { checkSameOrigin } from "./same-origin";
import { getRequestOriginInfo } from "./request-origin";
import type { WebAppConfigResponse } from "../contracts";

export const MAX_SERVER_IDLE_TIMEOUT_SECONDS = 255;
export const DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS = MAX_SERVER_IDLE_TIMEOUT_SECONDS;

export function resolveServerIdleTimeout(value: number | undefined): number {
  const idleTimeout = value ?? DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS;
  if (!Number.isInteger(idleTimeout) || idleTimeout < 0 || idleTimeout > MAX_SERVER_IDLE_TIMEOUT_SECONDS) {
    throw new Error(`server.idleTimeout must be an integer between 0 and ${String(MAX_SERVER_IDLE_TIMEOUT_SECONDS)}`);
  }
  return idleTimeout;
}

export * from "./server-types";

export function createWebAppServer<TEvent = unknown, TIdentity = unknown>(
  input: WebAppServerConfig<TEvent, TIdentity>,
): WebAppServer<TEvent> {
  const config = input.runtimeConfig ?? readRuntimeConfig(input);
  if (config.appName !== input.appName || config.envPrefix !== input.envPrefix) {
    throw new Error("runtimeConfig appName and envPrefix must match the createWebAppServer inputs");
  }
  const log = createLogger("webapp:requests");
  setLogLevel(config.logLevel);
  input.logLevel?.onChange?.(config.logLevel);
  const realtime = createRealtimeBus<TEvent>(input.realtime);
  const wsPath = input.realtime?.path ?? "/api/ws";
  const publicRoutes = input.publicRoutes ?? {};
  const documentProvider = input.web === false ? undefined : createWebDocumentProvider(config, input.web, publicRoutes);
  const ensureWebDocument = documentProvider ? () => documentProvider.ensure() : undefined;
  const publicRouteDispatcher = createPublicRouteDispatcher({
    publicRoutes,
    generatedRoutePaths: documentProvider?.generatedRoutePaths ?? new Set(),
    ensureWebDocument: async () => {
      if (!ensureWebDocument) throw new Error("The web document is disabled");
      return await ensureWebDocument();
    },
  });
  const routeTable = input.routes ?? {};
  const routeDispatcher = createRouteDispatcher({
    config, routes: compileRouteTable(routeTable), identity: input.identity, realtime, middleware: input.routeMiddleware,
  });
  const connectionOptions = new WeakMap<WebAppWebSocketData, RealtimeConnectionOptions<TEvent>>();

  async function dispatchRequest(req: Request, server?: Server<WebAppWebSocketData>): Promise<Response | undefined> {
    if (input.requestFilter && !await input.requestFilter(req)) return notFound();
    const publicResponse = await publicRouteDispatcher.dispatch(req);
    if (publicResponse) return publicResponse;
    let upgraded = false;
    // App-owned dispatch can use Bun's normal upgrade API without a second protocol.
    const appServer = server && new Proxy(server, {
      get(target, property) {
        if (property === "upgrade") return (request: Request, options: Parameters<typeof server.upgrade>[1]) => {
          const result = target.upgrade(request, options);
          upgraded ||= result;
          return result;
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const applicationResponse = await input.request?.(req, appServer);
    if (upgraded || applicationResponse) return applicationResponse;
    const url = new URL(req.url);
    if (url.pathname === wsPath && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!server) return errorResponse(400, "upgrade_required", "A WebSocket listener is required");
      const admission = input.realtime?.authenticate
        ? await input.realtime.authenticate(req)
        : input.realtime?.access === "public" ? {} : undefined;
      if (!admission) return errorResponse(401, "authentication_required", "Realtime access was not granted");
      const originFailure = checkSameOrigin(req, config, { credential: admission.credential ?? "ambient" });
      if (originFailure) return originFailure;
      const data = { ...admission.data };
      connectionOptions.set(data, admission.options ?? {});
      if (server.upgrade(req, { data })) return undefined;
      connectionOptions.delete(data);
      return errorResponse(400, "upgrade_failed", "Unable to upgrade the connection");
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if (url.pathname === "/api/health") return jsonResponse({ ok: true, version: input.version ?? "0.0.0-development" });
      if (url.pathname === "/api/config") {
        const base: WebAppConfigResponse = {
          appName: input.appName,
          version: input.version ?? "0.0.0-development",
          publicBasePath: getRequestOriginInfo(req, config).pathPrefix,
          realtime: { path: wsPath },
          logLevel: { level: config.logLevel, fromEnv: config.logLevelFromEnv },
        };
        return jsonResponse({ ...base, ...input.configResponse?.(req, base) }, { headers: { "cache-control": "no-store" } });
      }
    }
    const result = await routeDispatcher.dispatch(req, server);
    if (result.matched) return result.response;
    const web = input.web;
    if (url.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method)
      || !ensureWebDocument || (web && web.paths && !web.paths.includes(url.pathname))) return notFound();
    const document = await ensureWebDocument();
    if (server && document.bundle && document.entryPublicPath) {
      // Bun only transforms HTML bundles on its native routes, not Server.fetch.
      // Native development documents therefore use this server's public bundle
      // route after app admission; compiled documents need no internal request.
      return await fetch(new URL(document.entryPublicPath, server.url), {
        headers: { accept: "text/html" },
        redirect: "error",
        ...(server.url.protocol === "https:" ? { tls: { rejectUnauthorized: false } } : {}),
      });
    }
    return await htmlResponse(document, req);
  }

  async function handleRequest(req: Request, server?: Server<WebAppWebSocketData>): Promise<Response | undefined> {
    let response: Response | undefined;
    try {
      response = await dispatchRequest(req, server);
    } catch (error) {
      response = requestBodyErrorResponse(error);
      if (!response) {
        log.error("Unhandled request error", { error: String(error) });
        response = errorResponse(500, "request_failed", "Request failed");
      }
    }
    return response ? responseForRequest(req, withSecurityHeaders(response)) : undefined;
  }

  const lifecycle = createServerLifecycle({
    config,
    hooks: {
      ...input.lifecycle,
      afterStop: async (server) => {
        realtime.dispose();
        await input.lifecycle?.afterStop?.(server);
      },
    },
    idleTimeout: resolveServerIdleTimeout(input.server?.idleTimeout),
    tls: input.server?.tls,
    publicRoutes,
    appWebsockets: input.websockets ?? {},
    wsPath,
    realtime,
    connectionOptions,
    ensurePublicAssetPaths: publicRouteDispatcher.ensurePublicAssetPaths,
    ensureWebDocument,
    documentProvider,
    documentPaths: input.web ? input.web.paths : undefined,
    handleRequest,
  });
  return {
    config, realtime, routeCatalog: createRouteCatalog(routeTable), handleRequest, ...lifecycle,
    async stop(closeActiveConnections) {
      try { await lifecycle.stop(closeActiveConnections); } finally { realtime.dispose(); }
    },
  };
}
