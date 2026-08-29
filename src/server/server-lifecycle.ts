import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { createLogger } from "./logger";
import type { RealtimeBus } from "./realtime/bus";
import type {
  WebAppServerLifecycleHooks,
  WebAppWebSocketData,
  WebAppServerConfig,
} from "./server-types";
import type { RuntimeConfig } from "./runtime-config";
import type { WebDocument, WebDocumentProvider } from "./web-document";

export interface ServerLifecycleDependencies<TEvent = unknown> {
  config: RuntimeConfig;
  deviceAuthEnabled: boolean;
  hooks?: WebAppServerLifecycleHooks;
  idleTimeout: number;
  publicRoutes: Readonly<Record<string, unknown>>;
  appWebsockets: NonNullable<WebAppServerConfig["websockets"]>;
  realtime: RealtimeBus<TEvent>;
  ensurePublicAssetPaths: () => Promise<ReadonlySet<string>>;
  ensureWebDocument: () => Promise<WebDocument>;
  documentProvider: WebDocumentProvider;
  handleRequest: (req: Request, server?: Server<WebAppWebSocketData>) => Promise<Response | undefined>;
}

const log = createLogger("webapp:server");

export function createServerLifecycle<TEvent = unknown>(dependencies: ServerLifecycleDependencies<TEvent>) {
  const {
    config,
    deviceAuthEnabled,
    hooks,
    idleTimeout,
    publicRoutes,
    appWebsockets,
    realtime,
    ensurePublicAssetPaths,
    ensureWebDocument,
    documentProvider,
    handleRequest,
  } = dependencies;
  let activeServer: Server<WebAppWebSocketData> | undefined;
  let stopPromise: Promise<void> | undefined;

  function customHandler(socket: ServerWebSocket<WebAppWebSocketData>): Partial<WebSocketHandler<WebAppWebSocketData>> | undefined {
    const handlerName = socket.data.webappSocketHandler;
    return handlerName ? appWebsockets[handlerName] : undefined;
  }

  async function start(): Promise<Server<WebAppWebSocketData>> {
    if (activeServer) {
      throw new Error("The web app server is already running");
    }
    await hooks?.beforeStart?.();
    const webDocument = await ensureWebDocument();
    const publicAssetPaths = await ensurePublicAssetPaths();
    const dynamicHandler = (req: Request, server: Server<WebAppWebSocketData>) => handleRequest(req, server);
    const publicRoutePaths = new Set([
      ...Object.keys(webDocument.generatedPublicRoutes),
      ...Object.keys(publicRoutes),
      ...publicAssetPaths,
    ]);
    const publicRouteHandlers = Object.fromEntries(
      Array.from(publicRoutePaths, (path) => [path, dynamicHandler]),
    );
    const spaFallbackRoute = {
      GET: dynamicHandler,
      HEAD: dynamicHandler,
      POST: dynamicHandler,
      PUT: dynamicHandler,
      PATCH: dynamicHandler,
      DELETE: dynamicHandler,
      OPTIONS: dynamicHandler,
    };
    // Bun only transforms HTMLBundle modules/HMR when the bundle is mounted directly.
    // Wrapping it in a handler or Response, or adding route-level headers, serves
    // untransformed module paths and breaks generated document routes.
    const spaDocumentRoute = webDocument.bundle ? {
      ...spaFallbackRoute,
      GET: webDocument.bundle as never,
      HEAD: webDocument.bundle as never,
    } : spaFallbackRoute;
    const entryRoute = webDocument.bundle ? { [webDocument.entryPublicPath]: webDocument.bundle as never } : {};
    const server = Bun.serve<WebAppWebSocketData>({
      hostname: config.host,
      port: config.port,
      idleTimeout,
      routes: {
        ...publicRouteHandlers,
        ...entryRoute,
        "/api/*": dynamicHandler,
        "/.well-known/*": dynamicHandler,
        "/device": deviceAuthEnabled ? spaDocumentRoute : dynamicHandler,
        "/setup": spaDocumentRoute,
        "/*": spaDocumentRoute,
      },
      websocket: {
        open(socket) {
          const handler = customHandler(socket);
          if (handler?.open) {
            handler.open(socket);
            return;
          }
          realtime.add(socket);
        },
        message(socket, message) {
          const handler = customHandler(socket);
          if (handler?.message) {
            handler.message(socket, message);
            return;
          }
          if (message === "ping") {
            socket.send(JSON.stringify({ type: "pong" }));
          }
        },
        close(socket, code, reason) {
          const handler = customHandler(socket);
          if (handler?.close) {
            handler.close(socket, code, reason);
            return;
          }
          realtime.remove(socket);
        },
        drain(socket) {
          customHandler(socket)?.drain?.(socket);
        },
      },
      development: config.development,
    });
    const originalStop = server.stop.bind(server);
    activeServer = server;
    server.stop = ((closeActiveConnections?: boolean) => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const errors: unknown[] = [];
        try {
          if (hooks?.beforeStop) {
            try {
              await hooks.beforeStop(server);
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            await originalStop(closeActiveConnections);
          } catch (error) {
            errors.push(error);
          }
          try {
            documentProvider.dispose(webDocument);
          } catch (error) {
            errors.push(error);
          }
          if (hooks?.afterStop) {
            try {
              await hooks.afterStop(server);
            } catch (error) {
              errors.push(error);
            }
          }
        } finally {
          activeServer = undefined;
          stopPromise = undefined;
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Web app server cleanup failed");
        }
      })();
      return stopPromise;
    }) as typeof server.stop;
    log.info(`${config.appName} server running`, { url: String(server.url) });
    try {
      await hooks?.afterStart?.(server);
      return server;
    } catch (error) {
      try {
        await server.stop(true);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "The afterStart hook failed and server cleanup also failed",
        );
      }
      throw error;
    }
  }

  async function stop(closeActiveConnections?: boolean): Promise<void> {
    if (!activeServer) return;
    await activeServer.stop(closeActiveConnections);
  }

  return { start, stop };
}
